/**
 * HTTP API and static pages.
 *
 * Public (no auth):   status pages, status JSON, raw-read evidence, SSE events.
 * Operator (Bearer QORVEX_ADMIN_TOKEN): connect, draft, approve, guardian, publish, relayers.
 * Relayer SDK (Bearer <relayer token>): pull budgets, push decisions.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Decision, DraftRule, GuardStatus, Health, NetworkId, NetworkInfo, PauseRecord, Protocol, ProtocolDetail, RelayerView, Rule, StatusView, TokenMeta } from "@qorvex/shared";
import { bigintReplacer, hashToken, newId, type Store, type StoreEvent } from "../store/store.ts";
import type { NetworkRuntime } from "./runtime.ts";
import { isAccountId, validateDraftShape } from "../rules/validate.ts";
import { evaluateSolvency } from "../rules/evaluate.ts";
import { backtestRule } from "../backtest/backtest.ts";
import { collectInputs, type SourceFile } from "../ai/inputs.ts";
import { draftRules, validateDraft } from "../ai/drafter.ts";
import { FixtureMissingError, type NearAiClient } from "../ai/client.ts";
import { validateBudget } from "../relayer/budgets.ts";
import type { Alerter } from "../alerts/alerts.ts";
import { firewallRole, verifyFirewallPolicy } from "../firewall/policy.ts";
import { humanizePolicy } from "../firewall/humanize.ts";
import { cachedTokenMeta } from "../near/tokens.ts";
import { HttpError, MAX_SSE_CLIENTS, SECURITY_HEADERS, body, num, obj, send, str } from "./http.ts";
import { allowed, actorOf, bearer, resolvePrincipal, type Principal } from "./principal.ts";
import type { Action } from "../auth/access.ts";
import type { QorvexAuth } from "../auth/auth.ts";
import { consumeStepUp, NearAuthError, type StepUpProof } from "../auth/near-plugin.ts";
import type { AuthorityClaim } from "@qorvex/shared";
import { DEFAULT_WORKSPACE, type Tenancy } from "../tenancy/tenancy.ts";
import { saasRoutes } from "./saas-routes.ts";
import { toNodeHandler } from "better-auth/node";

export interface ApiDeps {
  store: Store;
  networks: Map<NetworkId, NetworkRuntime>;
  ai: NearAiClient;
  alerter: Alerter;
  adminToken: string;
  /** Better Auth (sessions, workspaces, API keys, NEAR sign-in). Absent only in narrow unit tests. */
  auth?: QorvexAuth;
  tenancy: Tenancy;
  /** QORVEX_SINGLE_TENANT: the admin token acts as Owner of the "default" workspace (self-hosting, demo, tests). */
  singleTenant: boolean;
  /** Re-read the chain and update this workspace's claim on the contract (see tenancy/claims.ts). */
  reverifyClaim?: (workspaceId: string, network: NetworkId, contractId: string) => Promise<AuthorityClaim | undefined>;
  webDir: string;
  /** Sandbox demo hooks (only present when the local demo world is loaded). */
  demo?: {
    signSetGuardian(protocol: Protocol): Promise<string>;
    /** The DAO's council proposes and approves adding the firewall role (sandbox only). */
    signFirewallRole(protocol: Protocol, role: unknown): Promise<string>;
    ghost(target: string, amountUsdc: number): Promise<string>;
    trezu(mode: "guarded" | "unguarded", receivers: number): Promise<unknown>;
    /** Firewall/DAO demo actors: propose, council-approve, dao-unpause, relay-vote. */
    action(name: string, params: Record<string, unknown>): Promise<unknown>;
    info(): unknown;
  };
  backtestDays: (network: NetworkId) => number;
  backtestSamples: (network: NetworkId) => number;
  log: (s: string) => void;
}

/** Keep a relayer-submitted decision only if it has the logged shape; bound its strings. */
function sanitizeDecision(x: unknown): Decision | null {
  if (!x || typeof x !== "object") return null;
  const d = x as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.allow !== "boolean" || typeof d.at !== "number" || !Number.isFinite(d.at)) return null;
  if (typeof d.beneficiary !== "string" || typeof d.action !== "string") return null;
  const basis = ["budget", "no-budget", "fail-open", "fail-closed", "proposal-policy"].includes(d.basis as string) ? (d.basis as Decision["basis"]) : "budget";
  return {
    id: d.id.slice(0, 64),
    at: d.at,
    beneficiary: d.beneficiary.slice(0, 128),
    action: d.action.slice(0, 64),
    cost: typeof d.cost === "string" && /^\d{1,40}$/.test(d.cost) ? d.cost : "0",
    receiver: str(d.receiver, 128),
    allow: d.allow,
    reason: str(d.reason, 500) ?? "",
    basis,
    meta: d.meta && typeof d.meta === "object" && JSON.stringify(d.meta).length <= 2_000 ? (d.meta as Record<string, unknown>) : undefined,
  };
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Per-request context for authorised routes: who is calling, and the workspace they act in. */
export interface Ctx {
  p: Principal;
  ws: string;
}

/** Route access: "public" (no auth), "relayer" (the relayer's own token, checked in the handler), "user" (any signed-in user), or a matrix action. */
export type Access = "public" | "relayer" | "user" | Action;
export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, m: RegExpMatchArray, url: URL, ctx: Ctx) => Promise<void>;
export type Route = [string, RegExp, Access, Handler];

/** A record's workspace (records from before multi-tenancy belong to "default"). */
export const wsOf = (x: { workspaceId?: string }) => x.workspaceId ?? DEFAULT_WORKSPACE;

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".map": "application/json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };

export function createServer(d: ApiDeps): http.Server {
  // Live events. A signed-in principal gets every event of its own workspace. Anyone gets events
  // about published protocols and network-wide block events, never relayer or unpublished data.
  const sse = new Map<http.ServerResponse, { ws: string | null }>();
  /** Source uploaded for drafting, kept in memory only (re-upload after a restart). */
  const uploads = new Map<string, SourceFile[]>();
  d.store.on((e: StoreEvent) => {
    const prot = e.protocolId ? d.store.protocol(e.protocolId) : undefined;
    const pub = !!prot?.published;
    const anonymousOk = pub || (!e.protocolId && !e.relayerId);
    const owner = prot ? wsOf(prot) : e.relayerId ? wsOf(d.store.relayer(e.relayerId) ?? {}) : null;
    const payload = `data: ${JSON.stringify({ ...e, public: pub }, bigintReplacer)}\n\n`;
    for (const [r, c] of sse) if (anonymousOk || (c.ws && c.ws === owner)) r.write(payload);
  });

  const principalDeps = { auth: d.auth, tenancy: d.tenancy, singleTenant: d.singleTenant, adminToken: d.adminToken };
  const net = (id: NetworkId) => {
    const n = d.networks.get(id);
    if (!n) throw new HttpError(400, `network ${id} is not enabled on this server (QORVEX_NETWORKS)`);
    return n;
  };
  /** A protocol of the caller's workspace; another workspace's id answers 404, exactly like an unknown one. */
  const getProtocol = (id: string, ctx: Ctx) => {
    const p = d.store.protocol(id);
    if (!p || wsOf(p) !== ctx.ws) throw new HttpError(404, "protocol not found");
    return p;
  };
  const getRelayer = (id: string, ctx: Ctx) => {
    const r = d.store.relayer(id);
    if (!r || wsOf(r) !== ctx.ws) throw new HttpError(404, "relayer not found");
    return r;
  };
  /**
   * Step-up guard: sessions must attach a fresh NEP-413 signature bound to this
   * action, target and parameters (header x-qorvex-step-up, base64 JSON). The
   * single-tenant admin token and API keys do not sign; the audit log records how.
   */
  const stepUp = async (req: http.IncomingMessage, ctx: Ctx, action: Action, target: string, params: unknown, allowAccount?: (network: NetworkId, accountId: string) => boolean) => {
    if (ctx.p.kind !== "session") return undefined;
    if (!d.auth) throw new HttpError(500, "auth is not configured");
    const h = req.headers["x-qorvex-step-up"];
    if (typeof h !== "string" || !h) throw new HttpError(428, "this action needs a fresh wallet signature", { stepUp: { action, target, params } });
    let proof: StepUpProof;
    try {
      proof = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    } catch {
      throw new HttpError(400, "x-qorvex-step-up must be base64 JSON {nonce, accountId, publicKey, signature}");
    }
    try {
      return await consumeStepUp(d.auth.nearOptions, ctx.p.userId, { action, target, params }, proof, allowAccount);
    } catch (e) {
      if (e instanceof NearAuthError) throw new HttpError(e.code === "RPC" ? 503 : 401, e.message, { code: `NEAR_${e.code}` });
      throw e;
    }
  };
  const audit = (ctx: Ctx, action: string, target?: string, detail?: unknown, signedMessage?: unknown) =>
    d.tenancy.audit({ workspaceId: ctx.ws, ...actorOf(ctx.p), action, target, detail, signedMessage });
  const getRule = (p: Protocol, rid: string) => {
    const r = d.store.rule(p.id, rid);
    if (!r) throw new HttpError(404, "rule not found");
    return r;
  };
  const runBacktest = async (p: Protocol, rule: Rule) => {
    const n = net(p.network);
    const b = await backtestRule(rule, p.contractId, {
      network: p.network,
      rpc: n.rpc,
      archive: n.archive,
      days: d.backtestDays(p.network),
      samples: d.backtestSamples(p.network),
      neardataUrl: n.neardataUrl,
      outflowBlocks: p.network === "sandbox" ? 200 : 300,
    });
    d.store.putBacktest(p.id, b);
    return b;
  };

  const routes: Route[] = [
    // ------------------------------------------------------------ public
    ["GET", /^\/api\/health$/, "public", async (_q, res) => send(res, 200, { ok: true, networks: [...d.networks.keys()], ai: { mode: d.ai.cfg.mode, draftModel: d.ai.cfg.draftModel, explainModel: d.ai.cfg.explainModel, live: d.ai.canCallLive }, alerts: d.alerter.configured, demo: !!d.demo } satisfies Health)],
    ["GET", /^\/api\/public\/protocols$/, "public", async (_q, res) => send(res, 200, d.store.protocols().filter((p) => p.published).map((p) => ({ id: p.id, name: p.name, network: p.network, contractId: p.contractId, unofficial: !!p.unofficial })))],
    ["GET", /^\/api\/status\/([\w-]+)$/, "public", async (_q, res, m) => send(res, 200, await statusView(d, getPublished(d, m[1])))],
    ["GET", /^\/api\/reads\/([\w-]+)$/, "public", async (_q, res, m) => {
      const r = d.store.read(m[1]);
      if (!r || !d.store.protocol(r.protocolId)?.published) throw new HttpError(404, "read not found");
      send(res, 200, r);
    }],
    ["GET", /^\/api\/events$/, "public", async (req, res, _m, url) => {
      // EventSource cannot send headers, so a token may come as ?token=; browsers send the session cookie.
      const token = bearer(req) || url.searchParams.get("token") || "";
      const p = await resolvePrincipal(principalDeps, req, token || undefined);
      if (token && p.kind === "anonymous") throw new HttpError(401, "token rejected");
      if (sse.size >= MAX_SSE_CLIENTS) throw new HttpError(503, "too many live-event subscribers; retry later");
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": ok\n\n");
      const ws = p.kind === "anonymous" ? null : p.kind === "session" ? p.workspaceId : p.workspaceId;
      sse.set(res, { ws: ws && allowed(p, "dashboard.read") ? ws : null });
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        sse.delete(res);
      });
    }],

    // --------------------------------------------------------- operator
    ["GET", /^\/api\/protocols$/, "dashboard.read", async (_q, res, _m, _url, ctx) => {
      send(res, 200, d.store.protocols().filter((p) => wsOf(p) === ctx.ws));
    }],
    ["POST", /^\/api\/protocols$/, "contract.watch", async (q, res, _m, _url, ctx) => {
      const b = obj(await body(q), "body");
      if (typeof b.network !== "string") throw new HttpError(400, "network is required");
      const network = b.network as NetworkId;
      const n = net(network);
      if (!isAccountId(b.contractId)) throw new HttpError(400, "contractId must be a NEAR account id");
      let account;
      try {
        account = await n.rpc.viewAccount(b.contractId);
      } catch (e) {
        throw new HttpError(400, `cannot read ${b.contractId} on ${network}: ${(e as Error).message}`);
      }
      if (account.code_hash === "11111111111111111111111111111111") throw new HttpError(400, `${b.contractId} has no contract deployed`);
      let meta: any;
      try {
        meta = (await n.rpc.view(b.contractId, "contract_source_metadata", {})).value;
      } catch {
        meta = undefined;
      }
      // A Sputnik DAO answers get_policy with roles: it gets the proposal firewall and can be a council.
      let daoPolicy: any;
      try {
        daoPolicy = (await n.rpc.view<any>(b.contractId, "get_policy", {})).value;
      } catch {
        daoPolicy = undefined;
      }
      // Each workspace keeps its own private watch of a contract; another workspace's watch is never reused.
      const existing = d.store.protocols().find((p) => p.network === network && p.contractId === b.contractId && wsOf(p) === ctx.ws);
      if (b.unofficial === true && ctx.p.kind !== "admin") throw new HttpError(403, "unofficial public pages are created by the Qorvex operator only");
      const p: Protocol = existing ?? {
        id: newId("prt"),
        ...(ctx.ws === DEFAULT_WORKSPACE ? {} : { workspaceId: ctx.ws }),
        name: (typeof b.name === "string" && b.name.trim().slice(0, 80)) || b.contractId,
        network,
        contractId: b.contractId,
        status: "connected",
        published: false,
        createdAt: new Date().toISOString(),
      };
      if (b.unofficial === true) {
        // Read-only page built from public data: no guardian, alert-only rules.
        p.unofficial = true;
        p.guardianId = undefined;
      } else {
        p.guardianId = n.guardianId ?? p.guardianId;
      }
      p.kind = Array.isArray(daoPolicy?.roles) ? "dao" : "contract";
      if (meta?.link) p.source = { kind: "nep330", link: meta.link, files: [], fetchedAt: new Date().toISOString() };
      d.store.upsertProtocol(p);
      if (!existing) audit(ctx, "contract.watch", `${network}:${b.contractId}`, { protocolId: p.id });
      send(res, existing ? 200 : 201, { protocol: p, nep330: meta ?? null, needsUpload: !meta?.link && p.kind !== "dao", dao: p.kind === "dao" ? { roles: daoPolicy.roles.map((r: any) => r.name) } : null });
    }],
    ["GET", /^\/api\/protocols\/([\w-]+)$/, "dashboard.read", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = d.networks.get(p.network);
      const rules = await Promise.all(
        d.store.rules(p.id).map(async (r) => ({
          rule: r,
          evaluation: d.store.evaluation(p.id, r.id),
          backtest: d.store.backtest(p.id, r.id),
          lastPassed: d.store.lastPassed(p.id, r.id),
          limits: r.type === "proposal_policy" && n ? await humanizePolicy(n.rpc, r).catch(() => undefined) : undefined,
        })),
      );
      send(res, 200, { protocol: p, rules, drafts: d.store.drafts(p.id), breaches: d.store.breaches(p.id).slice(-20).reverse() } satisfies ProtocolDetail);
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/source$/, "rule.draft", async (q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const b = obj(await body(q), "body");
      const files: SourceFile[] = Array.isArray(b.files) ? b.files.filter((f: any) => typeof f?.path === "string" && f.path.length <= 300 && typeof f?.content === "string").slice(0, 50) : [];
      if (!files.length) throw new HttpError(400, "files: [{path, content}] required");
      uploads.set(p.id, files);
      p.source = { kind: "upload", files: files.map((f) => ({ path: f.path, bytes: f.content.length })), fetchedAt: new Date().toISOString() };
      d.store.upsertProtocol(p);
      send(res, 200, { ok: true, files: p.source.files });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/draft$/, "rule.draft", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = net(p.network);
      const inputs = await collectInputs(n.rpc, p.network, p.contractId, { upload: uploads.get(p.id), neardataUrl: n.neardataUrl, recentBlockCount: p.network === "sandbox" ? 200 : 60 });
      const methods = new Set(inputs.methods.map((x) => x.name));
      try {
        const out = await draftRules(d.ai, d.store, p.id, inputs, { rpc: n.rpc, contractId: p.contractId, methods, backtest: (r) => runBacktest(p, r) }, d.log);
        for (const r of out.rules) d.store.putRule(p.id, r);
        send(res, 200, { draft: out.run, rules: out.rules.map((r) => r.id), notes: out.notes, inputs: summariseInputs(inputs) });
      } catch (e) {
        if (e instanceof FixtureMissingError) throw new HttpError(409, e.message, { inputs: summariseInputs(inputs), aiMode: d.ai.cfg.mode });
        throw e;
      }
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules$/, "rule.draft", async (q, res, m, _url, ctx) => {
      // A human writes a rule by hand. It goes through the same validator and backtest as AI drafts.
      const p = getProtocol(m[1], ctx);
      const b = obj(await body(q), "body");
      const n = net(p.network);
      const v = await validateDraft(b.rule, { rpc: n.rpc, contractId: p.contractId, methods: new Set(), backtest: (r) => runBacktest(p, r) });
      if (v.errors.length || !v.rule) throw new HttpError(400, "rule failed validation", { errors: v.errors });
      if (d.store.rule(p.id, v.rule.id)) throw new HttpError(409, "a rule with this id exists");
      const rule: Rule = { ...v.rule, status: "draft", origin: { kind: "human", author: typeof b.author === "string" ? b.author.slice(0, 80) : "operator" } };
      d.store.putRule(p.id, rule);
      send(res, 201, { rule, backtest: v.backtest, live: v.live });
    }],
    ["PATCH", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)$/, "rule.draft", async (q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const rule = getRule(p, m[2]);
      const b = obj(await body(q), "body");
      const { status: _s, origin: _o, response: _r, approvedBy: _ab, approvedAt: _at, ...current } = rule;
      // Only rule fields can be edited: lifecycle fields in the edit are dropped by the shape check below.
      const edited = { ...current, ...obj(b.rule ?? {}, "rule"), id: rule.id } as DraftRule;
      const shapeErrors = validateDraftShape(edited);
      if (shapeErrors.length) throw new HttpError(400, "edited rule is invalid", { errors: shapeErrors });
      const n = net(p.network);
      const v = await validateDraft(edited, { rpc: n.rpc, contractId: p.contractId, methods: new Set(), backtest: (r) => runBacktest(p, r) });
      if (v.errors.length) throw new HttpError(400, "edited rule failed validation", { errors: v.errors });
      // Any edit sends the rule back to draft: it needs approval again.
      const next = { ...edited, status: "draft", response: rule.response, origin: rule.origin } as Rule;
      d.store.putRule(p.id, next);
      send(res, 200, { rule: next, backtest: v.backtest });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)\/(approve|reject)$/, "rule.approve", async (q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const rule = getRule(p, m[2]);
      const b = obj(await body(q), "body");
      if (m[3] === "reject") {
        d.store.putRule(p.id, { ...rule, status: "rejected" });
        return send(res, 200, { ok: true });
      }
      const response = b.response === "pause" ? "pause" : b.response === "reject" ? "reject" : "alert";
      if (response !== "alert" && p.unofficial) throw new HttpError(409, "read-only (unofficial) protocols can only have alert-only rules");
      if (response === "reject" && rule.type !== "proposal_policy") throw new HttpError(400, "only proposal_policy rules can reject proposals");
      if (response === "pause" && rule.type === "proposal_policy") throw new HttpError(400, "proposal_policy rules reject proposals; choose reject or alert");
      const bt = d.store.backtest(p.id, rule.id);
      if (!bt) throw new HttpError(409, "run the backtest before approving");
      if (response === "pause" && bt.fires > 0) throw new HttpError(409, `this rule fired ${bt.fires} times in its backtest; it can only be approved as alert-only`);
      // Approving a rule that can pause or vote is a step-up action for signed-in users.
      const signed = response === "alert" ? undefined : await stepUp(q, ctx, "rule.approve", `${p.network}:${p.contractId}`, { protocolId: p.id, ruleId: rule.id, response });
      const by = ctx.p.kind === "session" ? ctx.p.name : typeof b.approvedBy === "string" ? b.approvedBy.slice(0, 80) : "operator";
      const approved: Rule = { ...rule, status: "approved", response, approvedBy: by, approvedAt: new Date().toISOString() };
      d.store.putRule(p.id, approved);
      audit(ctx, "rule.approve", `${p.network}:${p.contractId}`, { ruleId: rule.id, response }, signed);
      send(res, 200, { rule: approved });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)\/backtest$/, "rule.draft", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      send(res, 200, await runBacktest(p, getRule(p, m[2])));
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)\/evaluate$/, "rule.draft", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const rule = getRule(p, m[2]);
      if (rule.type !== "solvency") throw new HttpError(400, "only solvency rules have a live value");
      const ev = await evaluateSolvency(net(p.network).rpc, rule, p.contractId, { finality: "final" });
      d.store.recordEvaluation(p.id, ev);
      send(res, 200, ev);
    }],
    ["GET", /^\/api\/protocols\/([\w-]+)\/guardian$/, "dashboard.read", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = net(p.network);
      if (!n.guardianId) throw new HttpError(409, `no guardian configured for ${p.network} (QORVEX_${p.network.toUpperCase()}_GUARDIAN)`);
      const args = { guardian_id: n.guardianId };
      send(res, 200, {
        guardianId: n.guardianId,
        watcherAccount: n.watcherAccount,
        transaction: { receiverId: p.contractId, actions: [{ type: "FunctionCall", method: "set_guardian", args, deposit: "1 yoctoNEAR", gas: "60 Tgas" }] },
        nearCli: `near contract call-function as-transaction ${p.contractId} set_guardian json-args '${JSON.stringify(args)}' prepaid-gas '60.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER_ACCOUNT> network-config ${p.network === "sandbox" ? "<sandbox>" : p.network} sign-with-keychain send`,
        explains: "One transaction, signed by the contract owner: sets the contract's pause role to the Qorvex guardian contract and registers the contract with that guardian (the contract calls guardian.register_target itself, attaching 0.01 NEAR for storage). Qorvex then reads both settings back.",
        demoSigning: !!d.demo && p.network === "sandbox",
      });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/guardian\/sign-demo$/, "demo.run", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      if (!d.demo || p.network !== "sandbox") throw new HttpError(403, "demo signing exists only for the local sandbox demo");
      send(res, 200, { txHash: await d.demo.signSetGuardian(p) });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/guardian\/verify$/, "contract.watch", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = net(p.network);
      if (!n.guardianId) throw new HttpError(409, "no guardian configured");
      const result: Record<string, unknown> = { guardianId: n.guardianId };
      try {
        const gs = await n.rpc.view<any>(p.contractId, "guard_status", {});
        result.contractGuardian = gs.value.guardian;
        result.contractGuardianRead = gs.raw;
      } catch (e) {
        result.contractGuardian = null;
        result.contractGuardianError = `contract has no guard_status view (qorvex-guard): ${(e as Error).message.slice(0, 160)}`;
      }
      const t = await n.rpc.view<any>(n.guardianId, "get_target", { target: p.contractId });
      result.registration = t.value;
      result.registrationRead = t.raw;
      if (n.watcherAccount) {
        result.watcherApproved = (await n.rpc.view<boolean>(n.guardianId, "is_watcher", { account_id: n.watcherAccount })).value;
        if (n.watcherPublicKey) {
          try {
            const k = await n.rpc.viewAccessKey(n.watcherAccount, n.watcherPublicKey);
            result.watcherKeyPermission = k.result.permission;
            const fc = k.result.permission?.FunctionCall;
            result.watcherKeyScopeOk = !!fc && fc.receiver_id === n.guardianId && JSON.stringify(fc.method_names) === JSON.stringify(["pause"]);
          } catch (e) {
            result.watcherKeyError = (e as Error).message;
          }
        }
      }
      const ok = result.contractGuardian === n.guardianId && !!result.registration;
      p.guardianId = n.guardianId;
      p.guardianVerified = { at: new Date().toISOString(), guardianSet: (result.contractGuardian as string) ?? null, registered: !!result.registration, council: (result.registration as any)?.council };
      if (ok) p.status = "protected";
      d.store.upsertProtocol(p);
      send(res, 200, { ok, ...result });
    }],
    ["GET", /^\/api\/protocols\/([\w-]+)\/firewall$/, "dashboard.read", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      if (p.kind !== "dao") throw new HttpError(409, "the proposal firewall is for Sputnik DAOs");
      const n = net(p.network);
      if (!n.firewallAccount) throw new HttpError(409, `no firewall account configured for ${p.network} (QORVEX_${p.network.toUpperCase()}_FIREWALL_ACCOUNT)`);
      const role = firewallRole(n.firewallAccount);
      const proposal = { description: "Add the Qorvex proposal firewall: it can only vote to reject transfer and function-call proposals that break the DAO's Qorvex policy. It cannot approve anything. Remove it with a policy proposal.", kind: { ChangePolicyAddOrUpdateRole: { role } } };
      send(res, 200, {
        dao: p.contractId,
        firewallAccount: n.firewallAccount,
        keyLoaded: n.rejecters.has(p.contractId),
        role,
        transaction: { receiverId: p.contractId, actions: [{ type: "FunctionCall", method: "add_proposal", args: { proposal }, deposit: "the DAO's proposal_bond", gas: "100 Tgas" }] },
        nearCli: `near contract call-function as-transaction ${p.contractId} add_proposal json-args '${JSON.stringify({ proposal })}' prepaid-gas '100.0 Tgas' attached-deposit '<proposal_bond>' sign-as <COUNCIL_MEMBER> network-config ${p.network === "sandbox" ? "<sandbox>" : p.network} sign-with-keychain send`,
        explains: "The DAO votes on one ChangePolicyAddOrUpdateRole proposal that adds a role holding only transfer:VoteReject and call:VoteReject, with Qorvex's firewall account as its only member and a threshold of one vote. Sputnik counts votes per role, so one firewall vote rejects a proposal, and the role cannot approve. The DAO removes it the same way.",
        demoSigning: !!d.demo && p.network === "sandbox",
      });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/firewall\/sign-demo$/, "demo.run", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = net(p.network);
      if (!d.demo || p.network !== "sandbox" || !n.firewallAccount) throw new HttpError(403, "demo signing exists only for the local sandbox demo");
      send(res, 200, { txHash: await d.demo.signFirewallRole(p, firewallRole(n.firewallAccount)) });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/firewall\/verify$/, "contract.watch", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const n = net(p.network);
      if (!n.firewallAccount) throw new HttpError(409, "no firewall account configured");
      const pol = await n.rpc.view<any>(p.contractId, "get_policy", {});
      const v = verifyFirewallPolicy(pol.value, n.firewallAccount);
      const result: Record<string, unknown> = { ...v, policyRead: pol.raw };
      const ex = n.rejecters.get(p.contractId);
      if (!ex) v.problems.push(`no firewall key loaded for ${p.contractId}`);
      else {
        try {
          const k = await n.rpc.viewAccessKey(n.firewallAccount, ex.publicKey);
          const fc = k.result.permission?.FunctionCall;
          result.firewallKeyPermission = k.result.permission;
          result.firewallKeyScopeOk = !!fc && fc.receiver_id === p.contractId && JSON.stringify(fc.method_names) === JSON.stringify(["act_proposal"]);
          if (!result.firewallKeyScopeOk) v.problems.push("firewall key is not limited to act_proposal on this DAO");
        } catch (e) {
          v.problems.push(`cannot read the firewall key: ${(e as Error).message.slice(0, 120)}`);
        }
      }
      const ok = v.problems.length === 0;
      p.firewallVerified = { at: new Date().toISOString(), ok, role: v.role, problems: v.problems };
      if (ok) p.status = "protected";
      d.store.upsertProtocol(p);
      send(res, 200, { ...result, ok, problems: v.problems });
    }],
    // Read-only operator views used by the console (same data as the public page, for unpublished protocols too).
    ["GET", /^\/api\/protocols\/([\w-]+)\/status$/, "dashboard.read", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      send(res, 200, await statusView(d, p));
    }],
    ["GET", /^\/api\/networks$/, "dashboard.read", async (_q, res, _m, _url, _ctx) => {
      send(res, 200, [...d.networks.values()].map((n): NetworkInfo => ({
        id: n.id,
        rpcUrls: n.rpcUrls,
        stream: n.stream,
        guardianId: n.guardianId ?? null,
        watcherAccount: n.watcherAccount ?? null,
        watcherKeyLoaded: !!(n.guardianId && n.executors.has(n.guardianId)),
        firewallAccount: n.firewallAccount ?? null,
        firewallDaos: [...n.rejecters.keys()],
        progress: d.store.watcherProgress(n.id) ?? null,
      })));
    }],
    ["GET", /^\/api\/protocols\/([\w-]+)\/proposals$/, "dashboard.read", async (_q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      send(res, 200, d.store.proposals(p.id).slice(-100).reverse());
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/publish$/, "status.publish", async (q, res, m, _url, ctx) => {
      const p = getProtocol(m[1], ctx);
      const b = obj(await body(q), "body");
      const publish = b.published !== false;
      if (publish && ctx.p.kind !== "admin") {
        // An official public page needs verified on-chain authority, re-checked now.
        const claim = await d.reverifyClaim?.(ctx.ws, p.network, p.contractId);
        if (!claim || claim.status !== "verified") throw new HttpError(403, "publishing a status page needs verified on-chain authority over this contract: claim it first");
        if (!d.tenancy.claimCanonical(p.network, p.contractId, ctx.ws)) throw new HttpError(409, "another workspace holds the verified public page for this contract");
      }
      p.published = publish;
      d.store.upsertProtocol(p);
      audit(ctx, publish ? "status.publish" : "status.unpublish", `${p.network}:${p.contractId}`);
      send(res, 200, { ok: true, url: `/status/${p.id}` });
    }],

    // --------------------------------------------------------- relayers
    ["GET", /^\/api\/relayers$/, "dashboard.read", async (_q, res, _m, _url, ctx) => {
      send(res, 200, d.store.relayers().filter((r) => wsOf(r) === ctx.ws).map(relayerView));
    }],
    ["POST", /^\/api\/relayers$/, "relayer.manage", async (q, res, _m, _url, ctx) => {
      const b = obj(await body(q), "body");
      const token = `qrx_${crypto.randomBytes(24).toString("hex")}`;
      const r = { id: newId("rly"), ...(ctx.ws === DEFAULT_WORKSPACE ? {} : { workspaceId: ctx.ws }), name: String(b.name ?? "relayer").slice(0, 80), tokenHash: hashToken(token), budgets: [], failMode: b.failMode === "open" ? ("open" as const) : ("closed" as const), updatedAt: new Date().toISOString() };
      d.store.putRelayer(r);
      audit(ctx, "relayer.create", r.id, { name: r.name });
      send(res, 201, { relayer: relayerView(r), token, note: "The token is shown once. Put it in the relayer's environment (QORVEX_RELAYER_TOKEN)." });
    }],
    ["GET", /^\/api\/relayers\/([\w-]+)\/admin$/, "dashboard.read", async (_q, res, m, _url, ctx) => {
      const r = getRelayer(m[1], ctx);
      send(res, 200, { relayer: relayerView(r), decisions: d.store.decisions(r.id).slice(-300).reverse() });
    }],
    ["PUT", /^\/api\/relayers\/([\w-]+)\/budgets$/, "relayer.manage", async (q, res, m, _url, ctx) => {
      const r = getRelayer(m[1], ctx);
      const b = obj(await body(q), "body");
      if (!Array.isArray(b.budgets) || b.budgets.length > 100) throw new HttpError(400, "budgets must be a list (at most 100)");
      const errors = b.budgets.flatMap((x: unknown, i: number) => validateBudget(x).map((e) => `budgets[${i}]: ${e}`));
      if (errors.length) throw new HttpError(400, "invalid budgets", { errors });
      if (b.proposalPolicy !== undefined && b.proposalPolicy !== null) {
        const policy = { id: "relayer-policy", explain: "Relayer proposal policy", ...obj(b.proposalPolicy, "proposalPolicy"), type: "proposal_policy" as const };
        const pe = validateDraftShape(policy);
        if (pe.length) throw new HttpError(400, "invalid proposalPolicy", { errors: pe });
        r.proposalPolicy = policy as NonNullable<typeof r.proposalPolicy>;
      } else if (b.proposalPolicy === null) {
        r.proposalPolicy = undefined;
      }
      r.budgets = b.budgets;
      if (b.failMode === "open" || b.failMode === "closed") r.failMode = b.failMode;
      r.updatedAt = new Date().toISOString();
      d.store.putRelayer(r);
      send(res, 200, { relayer: relayerView(r) });
    }],
    // SDK endpoints: authenticated with the relayer's own token
    ["GET", /^\/api\/relayers\/([\w-]+)\/budgets$/, "relayer", async (q, res, m) => {
      const r = relayerAuth(d, q, m[1]);
      send(res, 200, { budgets: r.budgets, failMode: r.failMode, proposalPolicy: r.proposalPolicy, updatedAt: r.updatedAt });
    }],
    ["POST", /^\/api\/relayers\/([\w-]+)\/decisions$/, "relayer", async (q, res, m) => {
      const r = relayerAuth(d, q, m[1]);
      const b = obj(await body(q), "body");
      const ds = (Array.isArray(b.decisions) ? b.decisions.slice(0, 500) : []).map(sanitizeDecision).filter((x): x is Decision => x !== null);
      d.store.addDecisions(r.id, ds);
      await maybeAlertRefusals(d, r.id, r.name);
      send(res, 200, { ok: true, stored: ds.length });
    }],

    // ------------------------------------------------------------- demo
    ["GET", /^\/api\/demo$/, "demo.run", async (_q, res, _m, _url, _ctx) => {
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      send(res, 200, d.demo.info());
    }],
    ["POST", /^\/api\/demo\/ghost$/, "demo.run", async (q, res, _m, _url, _ctx) => {
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      const b = obj(await body(q), "body");
      if (typeof b.target !== "string") throw new HttpError(400, "target is required");
      send(res, 200, { txHash: await d.demo.ghost(b.target, num(b.amount, "amount", 40_000, 1, 1_000_000)) });
    }],
    ["POST", /^\/api\/demo\/action\/([a-z-]+)$/, "demo.run", async (q, res, m, _url, _ctx) => {
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      send(res, 200, await d.demo.action(m[1], obj(await body(q), "body")));
    }],
    ["POST", /^\/api\/demo\/trezu$/, "demo.run", async (q, res, _m, _url, _ctx) => {
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      const b = obj(await body(q), "body");
      send(res, 200, await d.demo.trezu(b.mode === "unguarded" ? "unguarded" : "guarded", Math.round(num(b.receivers, "receivers", 100, 1, 200))));
    }],
  ];


  routes.push(...saasRoutes({ d, net, getProtocol, getRelayer, audit, stepUp, runBacktest, principalOf: (req) => resolvePrincipal(principalDeps, req) }));
  const authHandler = d.auth ? toNodeHandler(d.auth.auth) : undefined;
  const origins = new Set(d.auth?.trustedOrigins ?? []);
  /** Browsers send Origin on every cross-origin and same-origin POST; refuse ones that are not ours. */
  const originOk = (req: http.IncomingMessage) => {
    const o = req.headers.origin;
    if (typeof o === "string") return origins.has(o);
    return req.headers["sec-fetch-site"] !== "cross-site";
  };
  const refuseCrossSite = (req: http.IncomingMessage) =>
    new HttpError(
      403,
      `cross-site request refused: this page is on ${typeof req.headers.origin === "string" ? req.headers.origin : "another site"}, but this server's public address is ${d.auth?.origin ?? "unset"}. Open the app at that address (or set PUBLIC_URL / QORVEX_TRUSTED_ORIGINS).`,
    );

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (url.pathname.startsWith("/api/auth/")) {
        if (!authHandler) throw new HttpError(404, "sign-in is not configured on this server");
        // Better Auth skips its own origin check on requests without a cookie (sign-in, sign-up).
        if (req.method !== "GET" && !originOk(req)) throw refuseCrossSite(req);
        return await authHandler(req, res);
      }
      for (const [method, re, access, h] of routes) {
        const m = url.pathname.match(re);
        if (!m || req.method !== method) continue;
        let ctx: Ctx = { p: { kind: "anonymous" }, ws: "" };
        if (access !== "public" && access !== "relayer") {
          const p = await resolvePrincipal(principalDeps, req);
          if (p.kind === "anonymous") throw new HttpError(401, d.singleTenant ? "sign in, or send Authorization: Bearer <QORVEX_ADMIN_TOKEN>" : "sign in required");
          if (p.kind === "session" && req.method !== "GET" && !originOk(req)) throw refuseCrossSite(req);
          if (access === "user") {
            ctx = { p, ws: p.kind === "session" ? (p.workspaceId ?? "") : p.workspaceId };
          } else {
            if (p.kind === "session" && !p.workspaceId) throw new HttpError(409, "choose or create a workspace first");
            if (!allowed(p, access)) throw new HttpError(403, `your role in this workspace cannot do this (${access})`);
            ctx = { p, ws: (p as { workspaceId: string }).workspaceId };
          }
        }
        return await h(req, res, m, url, ctx);
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(d.webDir, url.pathname, res);
      throw new HttpError(404, "not found");
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(500, (e as Error).message);
      if (he.status >= 500) d.log(`HTTP ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      // The rest of an oversized body is still unread: close the socket so it is not reused.
      if (he.status === 413 && !res.headersSent) res.setHeader("connection", "close");
      if (!res.headersSent) send(res, he.status, { error: he.message, ...(he.extra ? { details: he.extra } : {}) });
      else res.end();
    }
  });
  // The route table, for the cross-workspace test matrix (test/unit/api.test.ts).
  ROUTES.set(server, routes);
  return server;
}

const ROUTES = new WeakMap<http.Server, Route[]>();
export const routeTable = (s: http.Server): Route[] => ROUTES.get(s) ?? [];

function getPublished(d: ApiDeps, id: string): Protocol {
  const p = d.store.protocol(id);
  if (!p || !p.published) throw new HttpError(404, "no published status page with this id");
  return p;
}

export function relayerAuth(d: ApiDeps, req: http.IncomingMessage, id: string) {
  const r = d.store.relayer(id);
  const t = bearer(req);
  if (!r || !t || !safeEqual(hashToken(t), r.tokenHash)) throw new HttpError(401, "relayer token required");
  return r;
}

const refusalAlerted = new Map<string, number>();
export async function maybeAlertRefusals(d: ApiDeps, relayerId: string, name: string) {
  const now = Date.now();
  const recent = d.store.decisions(relayerId).filter((x) => !x.allow && x.at >= now - 60_000);
  const byBen = new Map<string, number>();
  for (const x of recent) byBen.set(x.beneficiary, (byBen.get(x.beneficiary) ?? 0) + 1);
  for (const [ben, n] of byBen) {
    const k = `${relayerId}/${ben}`;
    if (n >= 5 && now - (refusalAlerted.get(k) ?? 0) > 10 * 60_000) {
      refusalAlerted.set(k, now);
      const last = recent.filter((x) => x.beneficiary === ben).at(-1);
      await d.alerter.send(`Relayer ${name}: repeated refusals`, `Relayer ${name} refused ${n} sponsored actions for ${ben} in the last minute. Last reason: ${last?.reason}. Review the log and keep or raise the limit.`, { relayerId, beneficiary: ben, count: n });
    }
  }
}

function summariseInputs(i: Awaited<ReturnType<typeof collectInputs>>) {
  return {
    contractId: i.contractId,
    codeHash: i.codeHash,
    source: { kind: i.source.kind, link: i.source.link, files: i.source.files.map((f) => f.path) },
    abiAvailable: i.abiAvailable,
    methods: i.methods,
    stateReads: i.stateReads.map((r) => ({ method: r.method, value: JSON.stringify(r.value).slice(0, 200) })),
    recentReceipts: i.recentReceipts.length,
  };
}

export function relayerView({ tokenHash: _hash, ...r }: { tokenHash: string } & RelayerView): RelayerView {
  return r;
}

/** Public status view for one protocol (S1). */
async function statusView(d: ApiDeps, p: Protocol): Promise<StatusView> {
  const n = d.networks.get(p.network);
  let paused: boolean | null = null;
  let pauseHistory: PauseRecord[] = [];
  let pausedRead: StatusView["pausedRead"];
  if (n) {
    try {
      const r = await n.rpc.view<boolean>(p.contractId, "is_paused", {}, { finality: "final" });
      paused = r.value;
      pausedRead = r.raw;
    } catch {
      paused = null; // contract has no is_paused view (e.g. read-only mainnet pages)
    }
    if (p.guardianId) {
      try {
        pauseHistory = (await n.rpc.view<PauseRecord[]>(p.guardianId, "pause_history", { target: p.contractId }, { finality: "final" })).value ?? [];
      } catch {
        pauseHistory = [];
      }
    }
  }
  const checks = d.store
    .rules(p.id)
    .filter((r) => r.status === "approved")
    .map((r) => {
      const ev = d.store.evaluation(p.id, r.id);
      return {
        id: r.id,
        type: r.type,
        explain: r.explain,
        response: r.response,
        rule: r,
        evaluation: ev
          ? ev.type === "solvency"
            ? { ok: ev.ok, blockHeight: ev.blockHeight, owed: ev.owed, held: ev.held, marginBps: ev.marginBps, at: ev.at, reads: ev.reads.map((x) => ({ id: x.id, label: x.label, contract: x.contract, view: x.view, args: x.args, value: x.value, provider: x.raw.provider })) }
            : ev.type === "outflow_rate"
              ? { ok: ev.ok, blockHeight: ev.blockHeight, total: ev.total, max: ev.max, windowSec: ev.windowSec, count: ev.count, at: ev.at }
              : { ok: ev.ok, blockHeight: ev.blockHeight, proposalId: ev.proposalId, summary: ev.summary, violations: ev.violations, at: ev.at }
          : null,
        lastPassed: d.store.lastPassed(p.id, r.id) ?? null,
        backtest: d.store.backtest(p.id, r.id) ?? null,
      };
    });
  const breaches = d.store
    .breaches(p.id)
    .slice(-10)
    .reverse()
    .map((b) => ({ id: b.id, ruleId: b.ruleId, explain: b.rule.explain, triggerBlock: b.triggerBlock, detectedAt: b.detectedAt, evaluation: b.evaluation, pause: b.pause, vote: b.vote, triggerReceipts: b.triggerReceipts, explanation: b.explanation, evidenceHash: b.evidenceHash }));
  // The qorvex-guard state, when the contract embeds it (public on-chain data).
  let guard: GuardStatus | null = null;
  if (n && p.kind !== "dao") {
    try {
      guard = (await n.rpc.view<GuardStatus>(p.contractId, "guard_status", {}, { finality: "final" })).value;
    } catch {
      guard = null; // no guard_status view: the crate is not embedded
    }
  }
  // Symbol and decimals of the tokens the checks measure (ft_metadata), so pages can show plain units.
  const tokens: Record<string, TokenMeta> = {};
  if (n) {
    const ids = new Set<string>();
    for (const r of d.store.rules(p.id)) if ((r.type === "solvency" || r.type === "outflow_rate") && r.token !== "near") ids.add(r.token);
    await Promise.all([...ids].map(async (t) => (tokens[t] = await cachedTokenMeta(n.rpc, t))));
  }
  return {
    tokens,
    guard,
    protocol: { id: p.id, name: p.name, network: p.network, contractId: p.contractId, kind: p.kind ?? "contract", unofficial: !!p.unofficial, guardianId: p.guardianId ?? null, status: p.status, published: p.published },
    paused,
    pausedRead,
    pauseHistory,
    checks,
    breaches,
    proposals: p.kind === "dao" ? d.store.proposals(p.id).slice(-25).reverse().map((x) => ({ id: x.proposalId, proposer: x.proposer, kind: x.kindLabel, summary: x.summary, ok: x.ok, violations: x.violations, at: x.at })) : [],
    firewall: p.kind === "dao" ? p.firewallVerified ?? null : null,
    watcher: d.store.watcherProgress(p.network) ?? null,
    scope:
      "Checks run in an outside watcher on every block that touches the contract. A drain completed inside a single transaction is out of the watcher's reach; that is what in-contract limits (qorvex-guard) are for. Only the checks listed here are monitored.",
  };
}

/**
 * Serves the built React app (frontend/dist). Files are served as-is (hashed assets are
 * cached for a year); any other GET path is a client-side route and gets index.html.
 */
function serveStatic(dir: string, pathname: string, res: http.ServerResponse) {
  const index = path.join(dir, "index.html");
  if (!fs.existsSync(index)) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    return res.end("The Qorvex frontend is not built. Run `npm run build:web` (or `npm start` / `npm run demo`, which build it), then reload.");
  }
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("bad path");
  }
  const full = path.resolve(dir, rel);
  const inside = full.startsWith(path.resolve(dir) + path.sep);
  if (rel && inside && fs.existsSync(full) && fs.statSync(full).isFile()) {
    const immutable = rel.startsWith("assets/");
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[path.extname(full)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
    return fs.createReadStream(full).pipe(res);
  }
  // A missing asset is a 404; other dotted paths are client routes (contract ids such as /c/mainnet/intents.near).
  if ((rel.startsWith("assets/") && path.extname(rel)) || path.extname(rel) in MIME) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[".html"], "cache-control": "no-cache" });
  fs.createReadStream(index).pipe(res);
}
