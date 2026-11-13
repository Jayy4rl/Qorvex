/**
 * Multi-tenant and onboarding routes.
 *
 * Public (no sign-in, rate limited):
 *   POST /api/public/check                          detect a contract: level, path, templates (friction item 2)
 *   GET  /api/public/contracts/:network/:contract   the last check, for shareable /c/:network/:contract pages
 * Signed in:
 *   GET  /api/me                                    user, linked NEAR accounts, workspaces
 *   POST /api/workspaces                            create a workspace (you become Owner)
 *   POST /api/workspaces/active                     switch workspace
 * Workspace (role matrix in auth/access.ts):
 *   GET  /api/claims, POST /api/claims (step-up), POST /api/claims/:id/reverify
 *   GET  /api/protocols/:id/detection
 *   GET  /api/protocols/:id/authorise               wallet transactions for the recommended path (friction item 1)
 *   POST /api/protocols/:id/authorise/verify
 *   GET  /api/protocols/:id/templates, POST /api/protocols/:id/templates/:tid   (friction item 3)
 *   GET  /api/apikeys, POST /api/apikeys (step-up), DELETE /api/apikeys/:id
 *   POST /api/invites/near
 *   GET  /api/audit
 *   PUT  /api/relayers/:id/template
 * Relayer token:
 *   POST /api/relayers/:id/check, POST /api/relayers/:id/check-proposal   (friction item 4)
 */
import type http from "node:http";
import type { AuthorityClaim, ContractCheck, NetworkId, Protocol, Rule, WorkspaceRole } from "@qorvex/shared";
import type { ApiDeps, Ctx, Route } from "./api.ts";
import type { Principal } from "./principal.ts";
import { maybeAlertRefusals, relayerAuth, relayerView, wsOf } from "./api.ts";
import { HttpError, body, obj, send } from "./http.ts";
import type { Action } from "../auth/access.ts";
import { API_KEY_SCOPES, ROLES } from "../auth/access.ts";
import { linkedNearAccounts, nearAccountKey } from "../auth/near-plugin.ts";
import { authorisationTxs, authorityFrom, detect, recoveryTxs } from "../tenancy/authority.ts";
import { DEFAULT_WORKSPACE } from "../tenancy/tenancy.ts";
import { isAccountId } from "../rules/validate.ts";
import { instantiate, relayerBudgetTemplate, templatesFor } from "../rules/templates.ts";
import { validateDraft } from "../ai/drafter.ts";
import { cachedTokenMeta } from "../near/tokens.ts";
import { serverCheck, serverCheckProposal } from "../relayer/server-check.ts";
import type { NetworkRuntime } from "./runtime.ts";
import { newId } from "../store/store.ts";

export interface SaasHelpers {
  d: ApiDeps;
  net: (id: NetworkId) => NetworkRuntime;
  getProtocol: (id: string, ctx: Ctx) => Protocol;
  getRelayer: (id: string, ctx: Ctx) => NonNullable<ReturnType<ApiDeps["store"]["relayer"]>>;
  audit: (ctx: Ctx, action: string, target?: string, detail?: unknown, signedMessage?: unknown) => void;
  stepUp: (req: http.IncomingMessage, ctx: Ctx, action: Action, target: string, params: unknown, allowAccount?: (network: NetworkId, accountId: string) => boolean) => Promise<unknown>;
  runBacktest: (p: Protocol, rule: Rule) => Promise<unknown>;
  principalOf: (req: http.IncomingMessage) => Promise<Principal>;
}

/** Detections are cached this long for the public check (they are cheap but hit public RPCs). */
const DETECTION_TTL_MS = 5 * 60_000;

/**
 * The caller's IP for rate limiting. Behind a reverse proxy (QORVEX_TRUST_PROXY=1,
 * on by default on Railway) the socket address is the proxy's, so the last
 * X-Forwarded-For entry (the address the proxy itself saw) is used instead.
 */
const TRUST_PROXY = process.env.QORVEX_TRUST_PROXY === "1" || (!!process.env.RAILWAY_ENVIRONMENT && process.env.QORVEX_TRUST_PROXY !== "0");
function ipOf(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((x) => x.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function saasRoutes(h: SaasHelpers): Route[] {
  const { d, net, getProtocol, audit } = h;
  const t = d.tenancy;

  const fresh = async (network: NetworkId, contractId: string, maxAgeMs = DETECTION_TTL_MS) => {
    const n = net(network);
    const c = t.canonical(network, contractId);
    if (c?.detection && c.detectedAt && Date.now() - c.detectedAt < maxAgeMs) return c.detection;
    const det = await detect(n.rpc, network, contractId, n.guardianId);
    t.putDetection(det);
    return det;
  };

  const contractCheck = async (network: NetworkId, contractId: string, maxAgeMs?: number): Promise<ContractCheck> => {
    const detection = await fresh(network, contractId, maxAgeMs);
    const c = t.canonical(network, contractId);
    const claimedBy = c?.claimedBy && t.claim(c.claimedBy, network, contractId)?.status === "verified" ? c.claimedBy : null;
    const page = claimedBy ? d.store.protocols().find((p) => p.published && p.network === network && p.contractId === contractId && wsOf(p) === claimedBy) : undefined;
    const unofficial = page ? undefined : d.store.protocols().find((p) => p.published && p.unofficial && p.network === network && p.contractId === contractId);
    return { detection, templates: templatesFor(detection), claimed: !!claimedBy, statusPageId: page?.id ?? unofficial?.id ?? null };
  };

  const parseTarget = (b: Record<string, unknown>) => {
    const network = b.network as NetworkId;
    if (!["mainnet", "testnet", "sandbox"].includes(network)) throw new HttpError(400, "network must be mainnet, testnet or sandbox");
    if (!isAccountId(b.contractId)) throw new HttpError(400, "contractId must be a NEAR account id");
    return { network, contractId: b.contractId };
  };

  /** The caller's NEAR accounts on a network (sessions only). */
  const nearAccounts = (ctx: Ctx, network: NetworkId): string[] =>
    ctx.p.kind === "session" ? linkedNearAccounts(t.db, ctx.p.userId).filter((a) => a.network === network).map((a) => a.accountId) : [];

  /** Starred actions: verified on-chain authority, re-checked now. The admin token is exempt (single tenant). */
  const requireAuthority = async (ctx: Ctx, p: Protocol): Promise<AuthorityClaim | undefined> => {
    if (ctx.p.kind === "admin") return undefined;
    const claim = await d.reverifyClaim?.(ctx.ws, p.network, p.contractId);
    if (!claim || claim.status !== "verified") throw new HttpError(403, "this needs verified on-chain authority over the contract: claim it first (Claims)");
    return claim;
  };

  return [
    // ----------------------------------------------------------- public
    ["POST", /^\/api\/public\/check$/, "public", async (req, res) => {
      if (!t.rateLimit(`check:${ipOf(req)}`, 20, 10 * 60_000)) throw new HttpError(429, "too many checks from this address; try again in a few minutes");
      const { network, contractId } = parseTarget(obj(await body(req), "body"));
      send(res, 200, await contractCheck(network, contractId));
    }],
    ["GET", /^\/api\/public\/contracts\/(mainnet|testnet|sandbox)\/([a-z0-9._-]{2,64})$/, "public", async (req, res, m) => {
      const network = m[1] as NetworkId;
      const c = t.canonical(network, m[2]);
      // A cached check is served to anyone; a new one counts against the caller's rate limit.
      if (!c?.detection && !t.rateLimit(`check:${ipOf(req)}`, 20, 10 * 60_000)) throw new HttpError(429, "too many checks from this address");
      send(res, 200, await contractCheck(network, m[2], c?.detection ? 24 * 3600_000 : DETECTION_TTL_MS));
    }],

    ["GET", /^\/api\/status\/([\w-]+)\/history$/, "public", async (_q, res, m) => {
      const p = d.store.protocol(m[1]);
      if (!p?.published) throw new HttpError(404, "no published status page with this id");
      send(res, 200, d.store.evaluationHistory(p.id));
    }],

    // ------------------------------------------------------- signed in
    // Public so a signed-out visitor gets 200 {kind: "anonymous"} instead of a console error.
    ["GET", /^\/api\/me$/, "public", async (req, res) => {
      const p = await h.principalOf(req);
      if (p.kind === "anonymous" || p.kind === "apiKey") return send(res, 200, { kind: "anonymous", singleTenant: d.singleTenant });
      const ctx: Ctx = { p, ws: p.kind === "session" ? (p.workspaceId ?? "") : p.workspaceId };
      if (ctx.p.kind === "admin") return send(res, 200, { kind: "admin", singleTenant: true, workspace: { id: DEFAULT_WORKSPACE, name: "Default (operator token)", role: "owner" }, workspaces: [], nearAccounts: [] });
      if (ctx.p.kind !== "session") throw new HttpError(403, "sign in with a user account");
      const workspaces = t.workspacesOf(ctx.p.userId);
      const active = workspaces.find((w) => w.id === ctx.ws) ?? null;
      const hasEmail = !ctx.p.email.endsWith(".placeholder.invalid");
      send(res, 200, {
        kind: "user",
        singleTenant: d.singleTenant,
        user: { id: ctx.p.userId, name: ctx.p.name, email: hasEmail ? ctx.p.email : null },
        nearAccounts: linkedNearAccounts(t.db, ctx.p.userId),
        workspaces,
        workspace: active,
        // Owners must keep a recoverable sign-in method (change request §2.2).
        warnings: !hasEmail && workspaces.some((w) => w.role === "owner") ? ["You own a workspace but have no email: add one so you can recover access if you lose your wallet."] : [],
      });
    }],
    ["POST", /^\/api\/workspaces$/, "user", async (req, res, _m, _u, ctx) => {
      if (ctx.p.kind !== "session" || !d.auth) throw new HttpError(403, "sign in with a user account");
      const b = obj(await body(req), "body");
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
      if (name.length < 2) throw new HttpError(400, "name must be 2-60 characters");
      const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace"}-${Math.random().toString(36).slice(2, 7)}`;
      const { fromNodeHeaders } = await import("better-auth/node");
      const org = await d.auth.auth.api.createOrganization({ body: { name, slug }, headers: fromNodeHeaders(req.headers) });
      if (!org) throw new HttpError(500, "could not create the workspace");
      t.audit({ workspaceId: org.id, actor: `user:${ctx.p.userId}`, method: "session", action: "workspace.create", target: org.id, detail: { name } });
      send(res, 201, { workspace: { id: org.id, name: org.name, slug: org.slug, role: "owner" } });
    }],
    ["POST", /^\/api\/workspaces\/active$/, "user", async (req, res, _m, _u, ctx) => {
      if (ctx.p.kind !== "session" || !d.auth) throw new HttpError(403, "sign in with a user account");
      const b = obj(await body(req), "body");
      if (typeof b.workspaceId !== "string" || !t.roleOf(ctx.p.userId, b.workspaceId)) throw new HttpError(404, "workspace not found");
      const { fromNodeHeaders } = await import("better-auth/node");
      await d.auth.auth.api.setActiveOrganization({ body: { organizationId: b.workspaceId }, headers: fromNodeHeaders(req.headers) });
      send(res, 200, { ok: true });
    }],

    // ----------------------------------------------------------- claims
    ["GET", /^\/api\/claims$/, "dashboard.read", async (_q, res, _m, _u, ctx) => send(res, 200, t.claims(ctx.ws))],
    ["POST", /^\/api\/claims$/, "contract.claim", async (req, res, _m, _u, ctx) => {
      const { network, contractId } = parseTarget(obj(await body(req), "body"));
      const n = net(network);
      // A fresh signature from the account that controls the contract (it may not be linked yet).
      const signed = (await h.stepUp(req, ctx, "contract.claim", `${network}:${contractId}`, { network, contractId }, () => true)) as { accountId: string } | undefined;
      const det = await detect(n.rpc, network, contractId, n.guardianId);
      t.putDetection(det);
      let found: ReturnType<typeof authorityFrom>;
      if (ctx.p.kind === "admin") found = { method: "admin-token", evidence: { account: "operator", detail: "single-tenant operator token" } };
      else found = authorityFrom(det, [...new Set([...(signed ? [signed.accountId] : []), ...nearAccounts(ctx, network)])]);
      if (!found) {
        throw new HttpError(403, "none of your NEAR accounts controls this contract", {
          controller: det.owner ? { account: det.owner.accountId, via: det.owner.via, isDao: det.owner.isDao, council: det.owner.council } : null,
          superAdmins: det.plugins?.superAdmins ?? [],
          hint: det.owner?.isDao ? "Sign with an account on the DAO's council." : "Sign with the owner account (or a near-plugins super-admin).",
        });
      }
      // The signer proved key control at this moment: link it to the user if it is not yet.
      if (signed && ctx.p.kind === "session" && !nearAccounts(ctx, network).includes(signed.accountId)) {
        t.db.prepare("INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'near', ?, ?, ?)").run(newId("acc"), nearAccountKey(network, signed.accountId), ctx.p.userId, new Date().toISOString(), new Date().toISOString());
      }
      const claim = t.putClaim({ workspaceId: ctx.ws, network, contractId, method: found.method, evidence: found.evidence, status: "verified", verifiedAt: new Date().toISOString() });
      // Start a private watch for this workspace if there is none.
      let watch = d.store.protocols().find((p) => p.network === network && p.contractId === contractId && wsOf(p) === ctx.ws);
      if (!watch) {
        watch = { id: newId("prt"), ...(ctx.ws === DEFAULT_WORKSPACE ? {} : { workspaceId: ctx.ws }), name: contractId, network, contractId, status: "connected", published: false, createdAt: new Date().toISOString(), kind: det.kind === "sputnik-dao" ? "dao" : "contract", guardianId: n.guardianId };
        d.store.upsertProtocol(watch);
      }
      audit(ctx, "contract.claim", `${network}:${contractId}`, { method: found.method, evidence: found.evidence }, signed);
      send(res, 201, { claim, protocolId: watch.id, detection: det });
    }],
    ["POST", /^\/api\/claims\/([\w-]+)\/reverify$/, "dashboard.read", async (_q, res, m, _u, ctx) => {
      const c = t.claims(ctx.ws).find((x) => x.id === m[1]);
      if (!c) throw new HttpError(404, "claim not found");
      send(res, 200, await d.reverifyClaim?.(ctx.ws, c.network, c.contractId));
    }],

    // ------------------------------------------- detection and authorising
    ["GET", /^\/api\/protocols\/([\w-]+)\/detection$/, "dashboard.read", async (_q, res, m, _u, ctx) => {
      const p = getProtocol(m[1], ctx);
      const det = await fresh(p.network, p.contractId, 30_000);
      send(res, 200, { detection: det, claim: t.claim(ctx.ws, p.network, p.contractId) ?? null, templates: templatesFor(det) });
    }],
    ["GET", /^\/api\/protocols\/([\w-]+)\/authorise$/, "guardian.authorise", async (_q, res, m, _u, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = net(p.network);
      if (!n.guardianId) throw new HttpError(409, `no guardian is configured for ${p.network}`);
      const claim = await requireAuthority(ctx, p);
      const det = await fresh(p.network, p.contractId, 0);
      let daoBond: string | undefined;
      if (det.recommended.viaDao && det.owner) {
        try {
          daoBond = String((await n.rpc.view<any>(det.owner.accountId, "get_policy", {})).value?.proposal_bond ?? "0");
        } catch {
          daoBond = undefined;
        }
      }
      const txs = authorisationTxs(det, n.guardianId, { daoBond });
      send(res, 200, { detection: det, claim: claim ?? null, guardianId: n.guardianId, network: p.network, transactions: txs, signer: det.recommended.signer, viaDao: det.recommended.viaDao });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/authorise\/verify$/, "contract.watch", async (_q, res, m, _u, ctx) => {
      const p = getProtocol(m[1], ctx);
      const det = await fresh(p.network, p.contractId, 0);
      const ok = !!det.guardianRegistration;
      if (ok) {
        p.status = "protected";
        p.guardianId = net(p.network).guardianId;
        d.store.upsertProtocol(p);
        audit(ctx, "guardian.authorised", `${p.network}:${p.contractId}`, { level: det.level, adapter: det.guardianRegistration?.adapter });
      }
      send(res, 200, { ok, level: det.level, registration: det.guardianRegistration, detection: det });
    }],

    // ------------------------------------------------ monitor and incidents
    ["GET", /^\/api\/protocols\/([\w-]+)\/history$/, "dashboard.read", async (_q, res, m, _u, ctx) => {
      const p = getProtocol(m[1], ctx);
      send(res, 200, d.store.evaluationHistory(p.id));
    }],
    ["GET", /^\/api\/breaches$/, "dashboard.read", async (_q, res, _m, _u, ctx) => {
      const mine = new Map(d.store.protocols().filter((p) => wsOf(p) === ctx.ws).map((p) => [p.id, p]));
      const list = d.store
        .breaches()
        .filter((b) => mine.has(b.protocolId))
        .slice(-200)
        .reverse()
        .map((b) => ({ id: b.id, protocolId: b.protocolId, contractId: mine.get(b.protocolId)!.contractId, network: mine.get(b.protocolId)!.network, ruleId: b.ruleId, explain: b.rule.explain, detectedAt: b.detectedAt, triggerBlock: b.triggerBlock, response: b.response, pause: b.pause, vote: b.vote }));
      send(res, 200, list);
    }],
    ["GET", /^\/api\/breaches\/([\w-]+)$/, "dashboard.read", async (_q, res, m, _u, ctx) => {
      const b = d.store.breach(m[1]);
      const p = b ? d.store.protocol(b.protocolId) : undefined;
      if (!b || !p || wsOf(p) !== ctx.ws) throw new HttpError(404, "incident not found");
      const n = d.networks.get(p.network);
      let recovery: ReturnType<typeof recoveryTxs> | null = null;
      let paused: boolean | null = null;
      if (n) {
        try {
          paused = (await n.rpc.view<boolean>(p.contractId, "is_paused", {})).value;
        } catch {
          paused = null;
        }
        try {
          const det = await fresh(p.network, p.contractId, 60_000);
          const reg = n.guardianId ? (await n.rpc.view<any>(n.guardianId, "get_target", { target: p.contractId }).catch(() => null))?.value : null;
          const inCooldown = !!reg && reg.last_pause_ns !== "0" && Date.now() * 1e6 - Number(reg.last_pause_ns) < 3600e9 && !reg.repeat_allowed;
          let daoBond: string | undefined;
          if (det.recommended.viaDao && det.owner) daoBond = String((await n.rpc.view<any>(det.owner.accountId, "get_policy", {}).catch(() => null))?.value?.proposal_bond ?? "0");
          recovery = recoveryTxs(det, n.guardianId, { inCooldown, daoBond });
        } catch {
          recovery = null;
        }
      }
      const token = b.rule.type !== "proposal_policy" ? b.rule.token : undefined;
      const tokenMeta = token === "near" ? { symbol: "NEAR", decimals: 24 } : token && n ? await cachedTokenMeta(n.rpc, token).catch(() => undefined) : undefined;
      send(res, 200, { breach: b, protocol: { id: p.id, name: p.name, network: p.network, contractId: p.contractId, published: p.published }, paused, recovery, tokenMeta: tokenMeta ?? null, statusUrl: p.published ? `/status/${p.id}` : null });
    }],

    // -------------------------------------------------------- templates
    ["GET", /^\/api\/protocols\/([\w-]+)\/templates$/, "dashboard.read", async (_q, res, m, _u, ctx) => {
      const p = getProtocol(m[1], ctx);
      send(res, 200, templatesFor(await fresh(p.network, p.contractId)));
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/templates\/([a-z-]+)$/, "rule.draft", async (req, res, m, _u, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = net(p.network);
      const b = obj(await body(req), "body");
      const values = Object.fromEntries(Object.entries(obj(b.values ?? {}, "values")).map(([k, v]) => [k, String(v).slice(0, 200)]));
      let draft;
      try {
        draft = await instantiate(m[2], values, { contractId: p.contractId, decimalsOf: async (tok) => {
          const dec = (await cachedTokenMeta(n.rpc, tok)).decimals;
          if (dec === undefined) throw new Error(`could not read ft_metadata of ${tok}: is it a NEP-141 token?`);
          return dec;
        } });
      } catch (e) {
        throw new HttpError(400, (e as Error).message, { code: "TEMPLATE_INVALID" });
      }
      if (d.store.rule(p.id, draft.id)) draft = { ...draft, id: `${draft.id}-${Math.random().toString(36).slice(2, 6)}` };
      const v = await validateDraft(draft, { rpc: n.rpc, contractId: p.contractId, methods: new Set(), backtest: (r) => h.runBacktest(p, r) as never });
      if (v.errors.length || !v.rule) throw new HttpError(400, "the filled template failed validation", { errors: v.errors });
      const author = ctx.p.kind === "session" ? ctx.p.name : "operator";
      const rule: Rule = { ...v.rule, status: "draft", origin: { kind: "human", author: `${author} (template ${m[2]})` } };
      d.store.putRule(p.id, rule);
      audit(ctx, "rule.from-template", `${p.network}:${p.contractId}`, { template: m[2], ruleId: rule.id });
      send(res, 201, { rule, backtest: v.backtest, live: v.live });
    }],

    // --------------------------------------------------------- API keys
    ["GET", /^\/api\/apikeys$/, "dashboard.read", async (_q, res, _m, _u, ctx) => {
      const rows = t.db.prepare("SELECT id, name, start, prefix, permissions, expiresAt, createdAt, lastRequest FROM apikey WHERE referenceId = ? ORDER BY createdAt DESC").all(ctx.ws) as any[];
      send(res, 200, rows.map((r) => ({ id: r.id, name: r.name, start: r.start, prefix: r.prefix, scopes: Object.keys(JSON.parse(r.permissions ?? "{}")), expiresAt: r.expiresAt, createdAt: r.createdAt, lastRequest: r.lastRequest })));
    }],
    ["POST", /^\/api\/apikeys$/, "apikey.create", async (req, res, _m, _u, ctx) => {
      if (!d.auth) throw new HttpError(500, "API keys need the auth module");
      if (ctx.p.kind !== "session") throw new HttpError(403, "API keys are created by a signed-in user");
      const b = obj(await body(req), "body");
      const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
      const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s): s is string => typeof s === "string" && s in API_KEY_SCOPES) : [];
      const days = Math.min(365, Math.max(1, Number(b.expiresInDays ?? 90)));
      if (!name || !scopes.length) throw new HttpError(400, `name and at least one scope (${Object.keys(API_KEY_SCOPES).join(", ")}) are required`);
      const signed = await h.stepUp(req, ctx, "apikey.create", ctx.ws, { name, scopes, days });
      const k = await d.auth.auth.api.createApiKey({ body: { organizationId: ctx.ws, userId: ctx.p.userId, name, expiresIn: days * 86_400, permissions: Object.fromEntries(scopes.map((s) => [s, ["*"]])) } });
      audit(ctx, "apikey.create", k.id, { name, scopes, days }, signed);
      send(res, 201, { id: k.id, key: k.key, note: "Shown once. Store it in your secret manager." });
    }],
    ["DELETE", /^\/api\/apikeys\/([\w-]+)$/, "apikey.create", async (_q, res, m, _u, ctx) => {
      const r = t.db.prepare("DELETE FROM apikey WHERE id = ? AND referenceId = ?").run(m[1], ctx.ws);
      if (!r.changes) throw new HttpError(404, "API key not found");
      audit(ctx, "apikey.revoke", m[1]);
      send(res, 200, { ok: true });
    }],

    // ------------------------------------------------- invites and audit
    ["POST", /^\/api\/invites\/near$/, "member.invite", async (req, res, _m, _u, ctx) => {
      const b = obj(await body(req), "body");
      const { network, contractId: accountId } = parseTarget({ network: b.network, contractId: b.accountId });
      const role = (ROLES as string[]).includes(String(b.role)) && b.role !== "owner" ? (b.role as WorkspaceRole) : "viewer";
      const id = t.inviteNear(ctx.ws, nearAccountKey(network, accountId), role, ctx.p.kind === "session" ? ctx.p.userId : "operator");
      audit(ctx, "member.invite", `${network}:${accountId}`, { role });
      send(res, 201, { id, note: `${accountId} joins as ${role} the first time it signs in with its wallet (valid 48 hours).` });
    }],
    ["GET", /^\/api\/audit$/, "dashboard.read", async (_q, res, _m, _u, ctx) => send(res, 200, t.auditLog(ctx.ws))],

    // --------------------------------------------------------- relayers
    ["PUT", /^\/api\/relayers\/([\w-]+)\/template$/, "relayer.manage", async (req, res, m, _u, ctx) => {
      const r = h.getRelayer(m[1], ctx);
      const b = obj(await body(req), "body");
      const receivers = Array.isArray(b.receivers) ? b.receivers.filter(isAccountId).slice(0, 50) : [];
      try {
        r.budgets = relayerBudgetTemplate({ dailyNear: typeof b.dailyNear === "string" ? b.dailyNear : undefined, storageDeposits: typeof b.storageDeposits === "number" ? b.storageDeposits : undefined, receivers });
      } catch (e) {
        throw new HttpError(400, (e as Error).message, { code: "BUDGET_INVALID" });
      }
      r.updatedAt = new Date().toISOString();
      d.store.putRelayer(r);
      audit(ctx, "relayer.budgets", r.id, { template: "sponsor", budgets: r.budgets });
      send(res, 200, { relayer: relayerView(r) });
    }],
    ["POST", /^\/api\/relayers\/([\w-]+)\/check$/, "relayer", async (req, res, m) => {
      const r = relayerAuth(d, req, m[1]);
      const b = obj(await body(req), "body");
      if (typeof b.beneficiary !== "string" || typeof b.action !== "string") throw new HttpError(400, "beneficiary and action are required");
      if (typeof b.cost !== "string" || !/^\d{1,40}$/.test(b.cost)) throw new HttpError(400, "cost must be a yoctoNEAR decimal string");
      const dec = serverCheck(d.store.db, r, {
        beneficiary: b.beneficiary.slice(0, 128),
        action: b.action.slice(0, 64),
        cost: b.cost,
        receiver: typeof b.receiver === "string" ? b.receiver.slice(0, 128) : undefined,
        meta: b.meta && typeof b.meta === "object" && JSON.stringify(b.meta).length <= 2000 ? (b.meta as Record<string, unknown>) : undefined,
      });
      d.store.addDecisions(r.id, [dec]);
      await maybeAlertRefusals(d, r.id, r.name);
      send(res, 200, dec);
    }],
    ["POST", /^\/api\/relayers\/([\w-]+)\/check-proposal$/, "relayer", async (req, res, m) => {
      const r = relayerAuth(d, req, m[1]);
      const b = obj(await body(req), "body");
      if (typeof b.dao !== "string" || !b.proposal || typeof b.proposal !== "object") throw new HttpError(400, "dao and proposal are required");
      const dec = serverCheckProposal(r.proposalPolicy, b.dao, b.proposal as never);
      d.store.addDecisions(r.id, [dec]);
      send(res, 200, dec);
    }],
  ];
}
