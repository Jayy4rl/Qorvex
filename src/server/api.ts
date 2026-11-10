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
import type { NetworkId } from "../config.ts";
import { hashToken, newId, type Protocol, type Store, type StoreEvent } from "../store/store.ts";
import type { NetworkRuntime } from "./runtime.ts";
import { validateDraftShape, type Rule, type DraftRule } from "../rules/types.ts";
import { evaluateSolvency } from "../rules/evaluate.ts";
import { backtestRule } from "../backtest/backtest.ts";
import { collectInputs, type SourceFile } from "../ai/inputs.ts";
import { draftRules, validateDraft } from "../ai/drafter.ts";
import { FixtureMissingError, type NearAiClient } from "../ai/client.ts";
import { validateBudget, type Decision } from "../relayer/budgets.ts";
import type { Alerter } from "../alerts/alerts.ts";
import { firewallRole, verifyFirewallPolicy } from "../firewall/policy.ts";
import { humanizePolicy } from "../firewall/humanize.ts";

export interface ApiDeps {
  store: Store;
  networks: Map<NetworkId, NetworkRuntime>;
  ai: NearAiClient;
  alerter: Alerter;
  adminToken: string;
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

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: unknown,
  ) {
    super(message);
  }
}

const MAX_BODY = 2_000_000;

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function send(res: http.ServerResponse, status: number, data: unknown): void {
  const s = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export function createServer(d: ApiDeps): http.Server {
  const sse = new Set<http.ServerResponse>();
  d.store.on((e: StoreEvent) => {
    const pub = e.protocolId ? d.store.protocol(e.protocolId) : undefined;
    const payload = `data: ${JSON.stringify({ ...e, public: !!pub?.published })}\n\n`;
    for (const r of sse) r.write(payload);
  });

  const requireAdmin = (req: http.IncomingMessage) => {
    if (!d.adminToken || !safeEqual(bearer(req), d.adminToken)) throw new HttpError(401, "operator token required (Authorization: Bearer <QORVEX_ADMIN_TOKEN>)");
  };
  const net = (id: NetworkId) => {
    const n = d.networks.get(id);
    if (!n) throw new HttpError(400, `network ${id} is not enabled on this server (QORVEX_NETWORKS)`);
    return n;
  };
  const getProtocol = (id: string) => {
    const p = d.store.protocol(id);
    if (!p) throw new HttpError(404, "protocol not found");
    return p;
  };
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

  const routes: [string, RegExp, (req: http.IncomingMessage, res: http.ServerResponse, m: RegExpMatchArray) => Promise<void>][] = [
    // ------------------------------------------------------------ public
    ["GET", /^\/api\/health$/, async (_q, res) => send(res, 200, { ok: true, networks: [...d.networks.keys()], ai: { mode: d.ai.cfg.mode, draftModel: d.ai.cfg.draftModel, explainModel: d.ai.cfg.explainModel, live: d.ai.canCallLive }, alerts: d.alerter.configured, demo: !!d.demo })],
    ["GET", /^\/api\/public\/protocols$/, async (_q, res) => send(res, 200, d.store.protocols().filter((p) => p.published).map((p) => ({ id: p.id, name: p.name, network: p.network, contractId: p.contractId, unofficial: !!p.unofficial })))],
    ["GET", /^\/api\/status\/([\w-]+)$/, async (_q, res, m) => send(res, 200, await statusView(d, getPublished(d, m[1])))],
    ["GET", /^\/api\/reads\/([\w-]+)$/, async (_q, res, m) => {
      const r = d.store.read(m[1]);
      if (!r || !d.store.protocol(r.protocolId)?.published) throw new HttpError(404, "read not found");
      send(res, 200, r);
    }],
    ["GET", /^\/api\/events$/, async (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": ok\n\n");
      sse.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        sse.delete(res);
      });
    }],

    // --------------------------------------------------------- operator
    ["GET", /^\/api\/protocols$/, async (q, res) => {
      requireAdmin(q);
      send(res, 200, d.store.protocols());
    }],
    ["POST", /^\/api\/protocols$/, async (q, res) => {
      requireAdmin(q);
      const b = await body(q);
      const network = b.network as NetworkId;
      const n = net(network);
      if (typeof b.contractId !== "string" || !/^[a-z0-9._-]{2,64}$/.test(b.contractId)) throw new HttpError(400, "contractId must be a NEAR account id");
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
      const existing = d.store.protocols().find((p) => p.network === network && p.contractId === b.contractId);
      const p: Protocol = existing ?? {
        id: newId("prt"),
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
      send(res, existing ? 200 : 201, { protocol: p, nep330: meta ?? null, needsUpload: !meta?.link && p.kind !== "dao", dao: p.kind === "dao" ? { roles: daoPolicy.roles.map((r: any) => r.name) } : null });
    }],
    ["GET", /^\/api\/protocols\/([\w-]+)$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
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
      send(res, 200, { protocol: p, rules, drafts: d.store.drafts(p.id), breaches: d.store.breaches(p.id).slice(-20).reverse() });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/source$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const b = await body(q);
      const files: SourceFile[] = Array.isArray(b.files) ? b.files.filter((f: any) => typeof f?.path === "string" && typeof f?.content === "string") : [];
      if (!files.length) throw new HttpError(400, "files: [{path, content}] required");
      uploads.set(p.id, files);
      p.source = { kind: "upload", files: files.map((f) => ({ path: f.path, bytes: f.content.length })), fetchedAt: new Date().toISOString() };
      d.store.upsertProtocol(p);
      send(res, 200, { ok: true, files: p.source.files });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/draft$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
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
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules$/, async (q, res, m) => {
      // A human writes a rule by hand. It goes through the same validator and backtest as AI drafts.
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const b = await body(q);
      const n = net(p.network);
      const v = await validateDraft(b.rule, { rpc: n.rpc, contractId: p.contractId, methods: new Set(), backtest: (r) => runBacktest(p, r) });
      if (v.errors.length || !v.rule) throw new HttpError(400, "rule failed validation", { errors: v.errors });
      if (d.store.rule(p.id, v.rule.id)) throw new HttpError(409, "a rule with this id exists");
      const rule: Rule = { ...v.rule, status: "draft", origin: { kind: "human", author: typeof b.author === "string" ? b.author.slice(0, 80) : "operator" } };
      d.store.putRule(p.id, rule);
      send(res, 201, { rule, backtest: v.backtest, live: v.live });
    }],
    ["PATCH", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const rule = getRule(p, m[2]);
      const b = await body(q);
      const { status, origin, response, approvedBy, approvedAt, ...current } = rule as any;
      void status; void origin; void response; void approvedBy; void approvedAt;
      const edited = { ...current, ...(b.rule ?? {}), id: rule.id } as DraftRule;
      const shapeErrors = validateDraftShape(edited);
      if (shapeErrors.length) throw new HttpError(400, "edited rule is invalid", { errors: shapeErrors });
      const n = net(p.network);
      const v = await validateDraft(edited, { rpc: n.rpc, contractId: p.contractId, methods: new Set(), backtest: (r) => runBacktest(p, r) });
      if (v.errors.length) throw new HttpError(400, "edited rule failed validation", { errors: v.errors });
      // Any edit sends the rule back to draft: it needs approval again.
      const next: Rule = { ...(edited as any), status: "draft", response: rule.response, origin: rule.origin };
      d.store.putRule(p.id, next);
      send(res, 200, { rule: next, backtest: v.backtest });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)\/(approve|reject)$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const rule = getRule(p, m[2]);
      const b = await body(q);
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
      const approved: Rule = { ...rule, status: "approved", response, approvedBy: typeof b.approvedBy === "string" ? b.approvedBy.slice(0, 80) : "operator", approvedAt: new Date().toISOString() };
      d.store.putRule(p.id, approved);
      send(res, 200, { rule: approved });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)\/backtest$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      send(res, 200, await runBacktest(p, getRule(p, m[2])));
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/rules\/([\w.:-]+)\/evaluate$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const rule = getRule(p, m[2]);
      if (rule.type !== "solvency") throw new HttpError(400, "only solvency rules have a live value");
      const ev = await evaluateSolvency(net(p.network).rpc, rule, p.contractId, { finality: "final" });
      d.store.recordEvaluation(p.id, ev);
      send(res, 200, ev);
    }],
    ["GET", /^\/api\/protocols\/([\w-]+)\/guardian$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
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
    ["POST", /^\/api\/protocols\/([\w-]+)\/guardian\/sign-demo$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      if (!d.demo || p.network !== "sandbox") throw new HttpError(403, "demo signing exists only for the local sandbox demo");
      send(res, 200, { txHash: await d.demo.signSetGuardian(p) });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/guardian\/verify$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
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
    ["GET", /^\/api\/protocols\/([\w-]+)\/firewall$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
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
    ["POST", /^\/api\/protocols\/([\w-]+)\/firewall\/sign-demo$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const n = net(p.network);
      if (!d.demo || p.network !== "sandbox" || !n.firewallAccount) throw new HttpError(403, "demo signing exists only for the local sandbox demo");
      send(res, 200, { txHash: await d.demo.signFirewallRole(p, firewallRole(n.firewallAccount)) });
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/firewall\/verify$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const n = net(p.network);
      if (!n.firewallAccount) throw new HttpError(409, "no firewall account configured");
      const pol = await n.rpc.view<any>(p.contractId, "get_policy", {});
      const v = verifyFirewallPolicy(pol.value, n.firewallAccount);
      const result: Record<string, unknown> = { ...v, policyRead: pol.raw };
      const ex = n.rejecters.get(p.contractId);
      if (!ex) v.problems.push(`no firewall key loaded for ${p.contractId}`);
      else {
        try {
          const { parseKey } = await import("near-kit");
          const pk = parseKey((JSON.parse(process.env[`QORVEX_${p.network.toUpperCase()}_FIREWALL_KEYS`] ?? "{}") as Record<string, string>)[p.contractId]).publicKey.toString();
          const k = await n.rpc.viewAccessKey(n.firewallAccount, pk);
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
    ["GET", /^\/api\/protocols\/([\w-]+)\/proposals$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      send(res, 200, d.store.proposals(p.id).slice(-100).reverse());
    }],
    ["POST", /^\/api\/protocols\/([\w-]+)\/publish$/, async (q, res, m) => {
      requireAdmin(q);
      const p = getProtocol(m[1]);
      const b = await body(q);
      p.published = b.published !== false;
      d.store.upsertProtocol(p);
      send(res, 200, { ok: true, url: `/status/${p.id}` });
    }],

    // --------------------------------------------------------- relayers
    ["GET", /^\/api\/relayers$/, async (q, res) => {
      requireAdmin(q);
      send(res, 200, d.store.relayers().map(({ tokenHash, ...r }) => (void tokenHash, r)));
    }],
    ["POST", /^\/api\/relayers$/, async (q, res) => {
      requireAdmin(q);
      const b = await body(q);
      const token = `qrx_${crypto.randomBytes(24).toString("hex")}`;
      const r = { id: newId("rly"), name: String(b.name ?? "relayer").slice(0, 80), tokenHash: hashToken(token), budgets: [], failMode: b.failMode === "open" ? ("open" as const) : ("closed" as const), updatedAt: new Date().toISOString() };
      d.store.putRelayer(r);
      send(res, 201, { relayer: { ...r, tokenHash: undefined }, token, note: "The token is shown once. Put it in the relayer's environment (QORVEX_RELAYER_TOKEN)." });
    }],
    ["GET", /^\/api\/relayers\/([\w-]+)\/admin$/, async (q, res, m) => {
      requireAdmin(q);
      const r = d.store.relayer(m[1]);
      if (!r) throw new HttpError(404, "relayer not found");
      send(res, 200, { relayer: { ...r, tokenHash: undefined }, decisions: d.store.decisions(r.id).slice(-300).reverse() });
    }],
    ["PUT", /^\/api\/relayers\/([\w-]+)\/budgets$/, async (q, res, m) => {
      requireAdmin(q);
      const r = d.store.relayer(m[1]);
      if (!r) throw new HttpError(404, "relayer not found");
      const b = await body(q);
      if (!Array.isArray(b.budgets)) throw new HttpError(400, "budgets must be a list");
      const errors = b.budgets.flatMap((x: unknown, i: number) => validateBudget(x).map((e) => `budgets[${i}]: ${e}`));
      if (errors.length) throw new HttpError(400, "invalid budgets", { errors });
      if (b.proposalPolicy !== undefined && b.proposalPolicy !== null) {
        const pe = validateDraftShape({ id: "relayer-policy", explain: "Relayer proposal policy", ...b.proposalPolicy, type: "proposal_policy" });
        if (pe.length) throw new HttpError(400, "invalid proposalPolicy", { errors: pe });
        r.proposalPolicy = { id: "relayer-policy", explain: "Relayer proposal policy", ...b.proposalPolicy, type: "proposal_policy" };
      } else if (b.proposalPolicy === null) {
        r.proposalPolicy = undefined;
      }
      r.budgets = b.budgets;
      if (b.failMode === "open" || b.failMode === "closed") r.failMode = b.failMode;
      r.updatedAt = new Date().toISOString();
      d.store.putRelayer(r);
      send(res, 200, { relayer: { ...r, tokenHash: undefined } });
    }],
    // SDK endpoints: authenticated with the relayer's own token
    ["GET", /^\/api\/relayers\/([\w-]+)\/budgets$/, async (q, res, m) => {
      const r = relayerAuth(d, q, m[1]);
      send(res, 200, { budgets: r.budgets, failMode: r.failMode, proposalPolicy: r.proposalPolicy, updatedAt: r.updatedAt });
    }],
    ["POST", /^\/api\/relayers\/([\w-]+)\/decisions$/, async (q, res, m) => {
      const r = relayerAuth(d, q, m[1]);
      const b = await body(q);
      const ds: Decision[] = (Array.isArray(b.decisions) ? b.decisions : []).filter((x: any) => typeof x?.id === "string" && typeof x?.allow === "boolean").slice(0, 500);
      d.store.addDecisions(r.id, ds);
      await maybeAlertRefusals(d, r.id, r.name);
      send(res, 200, { ok: true, stored: ds.length });
    }],

    // ------------------------------------------------------------- demo
    ["GET", /^\/api\/demo$/, async (q, res) => {
      requireAdmin(q);
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      send(res, 200, d.demo.info());
    }],
    ["POST", /^\/api\/demo\/ghost$/, async (q, res) => {
      requireAdmin(q);
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      const b = await body(q);
      send(res, 200, { txHash: await d.demo.ghost(String(b.target), Number(b.amount ?? 40_000)) });
    }],
    ["POST", /^\/api\/demo\/action\/([a-z-]+)$/, async (q, res, m) => {
      requireAdmin(q);
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      send(res, 200, await d.demo.action(m[1], await body(q)));
    }],
    ["POST", /^\/api\/demo\/trezu$/, async (q, res) => {
      requireAdmin(q);
      if (!d.demo) throw new HttpError(404, "no demo world loaded");
      const b = await body(q);
      send(res, 200, await d.demo.trezu(b.mode === "unguarded" ? "unguarded" : "guarded", Math.min(200, Number(b.receivers ?? 100))));
    }],
  ];

  const uploads = new Map<string, SourceFile[]>();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      for (const [method, re, h] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await h(req, res, m);
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(d.webDir, url.pathname, res);
      throw new HttpError(404, "not found");
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(500, (e as Error).message);
      if (he.status >= 500) d.log(`HTTP ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      if (!res.headersSent) send(res, he.status, { error: he.message, ...(he.extra ? { details: he.extra } : {}) });
      else res.end();
    }
  });
}

function getPublished(d: ApiDeps, id: string): Protocol {
  const p = d.store.protocol(id);
  if (!p || !p.published) throw new HttpError(404, "no published status page with this id");
  return p;
}

function relayerAuth(d: ApiDeps, req: http.IncomingMessage, id: string) {
  const r = d.store.relayer(id);
  const t = bearer(req);
  if (!r || !t || !safeEqual(hashToken(t), r.tokenHash)) throw new HttpError(401, "relayer token required");
  return r;
}

const refusalAlerted = new Map<string, number>();
async function maybeAlertRefusals(d: ApiDeps, relayerId: string, name: string) {
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

/** Public status view for one protocol (S1). */
export async function statusView(d: ApiDeps, p: Protocol) {
  const n = d.networks.get(p.network);
  let paused: unknown = null;
  let pauseHistory: unknown[] = [];
  let pausedRead: unknown;
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
        pauseHistory = (await n.rpc.view<unknown[]>(p.guardianId, "pause_history", { target: p.contractId }, { finality: "final" })).value ?? [];
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
  return {
    protocol: { id: p.id, name: p.name, network: p.network, contractId: p.contractId, kind: p.kind ?? "contract", unofficial: !!p.unofficial, guardianId: p.guardianId ?? null, status: p.status },
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

function serveStatic(dir: string, pathname: string, res: http.ServerResponse) {
  let file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (/^status\/[\w-]+$/.test(file) || /^evidence\/[\w-]+$/.test(file)) file = "status.html";
  const full = path.resolve(dir, file);
  if (!full.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(full).pipe(res);
}
