/**
 * HTTP API boundaries without a chain: operator and relayer authentication,
 * what anonymous live-event subscribers can see, input validation, and the
 * static file server. (Flows that need contracts run in test/e2e.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Protocol } from "@qorvex/shared";
import { createServer, routeTable } from "../../src/server/api.ts";
import { Store, hashToken } from "../../src/store/store.ts";
import { openDb } from "../../src/db/db.ts";
import { createAuth, trustedOriginsFor } from "../../src/auth/auth.ts";
import { Tenancy } from "../../src/tenancy/tenancy.ts";
import { NearAiClient } from "../../src/ai/client.ts";
import { Alerter } from "../../src/alerts/alerts.ts";

const ADMIN = "operator-token-0123456789";
const RELAYER_TOKEN = "qrx_relayer-secret";
let server: http.Server;
let base: string;
let store: Store;
let tenancy: Tenancy;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qorvex-api-"));

function protocol(id: string, published: boolean): Protocol {
  return { id, name: id, network: "sandbox", contractId: `${id}.test.near`, status: "connected", published, createdAt: new Date().toISOString() };
}

async function call(method: string, p: string, o: { token?: string; body?: string | object; cookie?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) },
    body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, body: json };
}

/** Subscribe to /api/events, collect events for `ms`, then disconnect. */
async function collectEvents(query: string, during: () => void, ms = 300): Promise<{ status: number; events: any[] }> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events${query}`, { signal: ac.signal });
  if (res.status !== 200) return { status: res.status, events: [] };
  const events: any[] = [];
  const reader = res.body!.getReader();
  const pump = (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  during();
  await new Promise((r) => setTimeout(r, ms));
  ac.abort();
  await pump;
  return { status: 200, events };
}

beforeAll(async () => {
  const db = openDb(path.join(dir, "qorvex.db"));
  store = new Store(path.join(dir, "store"), db);
  tenancy = new Tenancy(db);
  const auth = createAuth({ db, publicUrl: "http://127.0.0.1", dataDir: dir, rpcFor: () => undefined, email: { send: async () => {} } });
  await auth.migrate();
  store.upsertProtocol(protocol("prt_public", true));
  store.upsertProtocol(protocol("prt_private", false));
  store.putRelayer({ id: "rly_1", name: "r", tokenHash: hashToken(RELAYER_TOKEN), budgets: [], failMode: "closed", updatedAt: new Date().toISOString() });
  const web = path.join(dir, "web");
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><title>app</title>");
  fs.writeFileSync(path.join(web, "assets", "app.js"), "console.log(1)");
  fs.writeFileSync(path.join(dir, "secret.txt"), "do not serve");
  server = createServer({
    store,
    networks: new Map(),
    ai: new NearAiClient({ baseUrl: "http://127.0.0.1:1", mode: "replay", draftModel: "m", explainModel: "m", fallbackModels: [], thinking: false, fixturesDir: path.join(dir, "fx") }),
    alerter: new Alerter([]),
    adminToken: ADMIN,
    auth,
    tenancy,
    singleTenant: true,
    webDir: web,
    backtestDays: () => 1,
    backtestSamples: () => 2,
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("operator authentication", () => {
  it("rejects operator routes without a token or with a wrong one", async () => {
    for (const [m, p] of [["GET", "/api/protocols"], ["GET", "/api/protocols/prt_private"], ["POST", "/api/relayers"], ["GET", "/api/networks"], ["GET", "/api/protocols/prt_private/status"]]) {
      expect((await call(m, p)).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, { token: "wrong" })).status, `${m} ${p}`).toBe(401);
    }
  });

  it("accepts the operator token", async () => {
    const r = await call("GET", "/api/protocols", { token: ADMIN });
    expect(r.status).toBe(200);
    expect(r.body.map((p: Protocol) => p.id).sort()).toEqual(["prt_private", "prt_public"]);
  });

  it("serves public data only for published protocols", async () => {
    const list = await call("GET", "/api/public/protocols");
    expect(list.body.map((p: Protocol) => p.id)).toEqual(["prt_public"]);
    expect((await call("GET", "/api/status/prt_private")).status).toBe(404);
  });

  it("sets security headers", async () => {
    const r = await call("GET", "/api/health");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("relayer authentication", () => {
  it("needs the relayer's own token for the SDK endpoints", async () => {
    expect((await call("GET", "/api/relayers/rly_1/budgets")).status).toBe(401);
    expect((await call("GET", "/api/relayers/rly_1/budgets", { token: ADMIN })).status).toBe(401);
    expect((await call("GET", "/api/relayers/rly_1/budgets", { token: RELAYER_TOKEN })).status).toBe(200);
  });

  it("never returns token hashes", async () => {
    const list = await call("GET", "/api/relayers", { token: ADMIN });
    expect(JSON.stringify(list.body)).not.toContain(hashToken(RELAYER_TOKEN));
    const created = await call("POST", "/api/relayers", { token: ADMIN, body: { name: "new" } });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^qrx_[0-9a-f]{48}$/);
    expect(created.body.relayer.tokenHash).toBeUndefined();
  });

  it("stores only well-formed decisions, with bounded fields", async () => {
    const good = { id: "d1", at: Date.now(), beneficiary: "dao.near", action: "storage_deposit", cost: "100", allow: false, reason: "x".repeat(5_000), basis: "budget" };
    const r = await call("POST", "/api/relayers/rly_1/decisions", {
      token: RELAYER_TOKEN,
      body: { decisions: [good, { id: "bad" }, { ...good, id: "d2", cost: "not-a-number", basis: "made-up", at: "yesterday" }, "junk"] },
    });
    expect(r.body).toEqual({ ok: true, stored: 1 });
    const stored = store.decisions("rly_1");
    expect(stored.map((d) => d.id)).toEqual(["d1"]);
    expect(stored[0].reason.length).toBe(500);
  });

  it("validates budgets", async () => {
    const r = await call("PUT", "/api/relayers/rly_1/budgets", { token: ADMIN, body: { budgets: [{ beneficiary: "*", window_sec: 0.5 }] } });
    expect(r.status).toBe(400);
    expect(r.body.details.errors[0]).toMatch(/window_sec/);
  });
});

describe("live events", () => {
  const emitAll = () => {
    store.emit({ type: "block", data: { network: "sandbox", height: 1 } });
    store.emit({ type: "evaluation", protocolId: "prt_public", data: { owed: "1" } });
    store.emit({ type: "evaluation", protocolId: "prt_private", data: { owed: "2" } });
    store.emit({ type: "decisions", relayerId: "rly_1" });
  };

  it("anonymous subscribers see blocks and published protocols only", async () => {
    const { events } = await collectEvents("", emitAll);
    expect(events.map((e) => [e.type, e.protocolId ?? e.relayerId ?? null])).toEqual([
      ["block", null],
      ["evaluation", "prt_public"],
    ]);
    expect(events[1].public).toBe(true);
  });

  it("operators (token in the query string) see everything", async () => {
    const { events } = await collectEvents(`?token=${ADMIN}`, emitAll);
    expect(events.map((e) => e.protocolId ?? e.relayerId ?? e.type)).toEqual(["block", "prt_public", "prt_private", "rly_1"]);
  });

  it("refuses a wrong token instead of silently downgrading", async () => {
    expect((await collectEvents("?token=wrong", () => {})).status).toBe(401);
  });
});

describe("input validation", () => {
  it("rejects malformed bodies", async () => {
    expect((await call("POST", "/api/protocols", { token: ADMIN, body: "{not json" })).status).toBe(400);
    expect((await call("POST", "/api/protocols", { token: ADMIN, body: "[1,2]" })).status).toBe(400);
    expect((await call("POST", "/api/protocols", { token: ADMIN, body: { network: "sandbox", contractId: "x" } })).status).toBe(400);
  });

  it("rejects contract ids that are not NEAR account ids", async () => {
    // No network is enabled in this test server, so a valid id fails on the network instead.
    for (const contractId of ["UPPER.near", "a..b.near", ".lead.near", "x", "a".repeat(65), "bad/../path"]) {
      const r = await call("POST", "/api/protocols", { token: ADMIN, body: { network: "sandbox", contractId } });
      expect(r.status).toBe(400);
    }
    const r = await call("POST", "/api/protocols", { token: ADMIN, body: { network: "sandbox", contractId: "ledger.test.near" } });
    expect(r.body.error).toMatch(/not enabled/);
  });

  it("limits the body size", async () => {
    const r = await call("POST", "/api/protocols", { token: ADMIN, body: JSON.stringify({ pad: "x".repeat(2_100_000) }) });
    expect(r.status).toBe(413);
  });

  it("answers unknown API paths with 404 JSON", async () => {
    const r = await call("GET", "/api/nope");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("not found");
  });
});

describe("static frontend", () => {
  it("serves assets, falls back to index.html for client routes, and blocks traversal", async () => {
    const asset = await call("GET", "/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    const route = await call("GET", "/assets/prt_x/policies");
    expect(route.body).toContain("<title>app</title>");
    // Contract ids contain dots: they are client routes, not missing files.
    expect((await call("GET", "/c/mainnet/intents.near")).body).toContain("<title>app</title>");
    expect((await call("GET", "/assets/missing.js")).status).toBe(404);
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const r = await fetch(`${base}${p}`);
      expect(await r.text(), p).not.toContain("do not serve");
    }
  });
});

// --------------------------------------------------------- multi-tenancy

async function signUp(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "a long enough password", name: email.split("@")[0] }) });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

describe("workspaces", () => {
  let alice: string;
  let bob: string;
  let aliceWs: string;

  beforeAll(async () => {
    alice = await signUp("alice@example.com");
    bob = await signUp("bob@example.com");
    const a = await call("POST", "/api/workspaces", { cookie: alice, body: { name: "Alice Labs" } });
    expect(a.status).toBe(201);
    aliceWs = a.body.workspace.id;
    expect((await call("POST", "/api/workspaces", { cookie: bob, body: { name: "Bob DAO" } })).status).toBe(201);
    store.upsertProtocol({ ...protocol("prt_alice", false), workspaceId: aliceWs });
    store.putRule("prt_alice", { id: "r1", type: "outflow_rate", token: "near", max: "1", window_sec: 60, explain: "test rule for alice only", response: "alert", status: "draft", origin: { kind: "human", author: "t" } });
    store.putRelayer({ id: "rly_alice", workspaceId: aliceWs, name: "alice relayer", tokenHash: hashToken("qrx_alice"), budgets: [], failMode: "closed", updatedAt: new Date().toISOString() });
  });

  it("a user sees only their own workspace's records", async () => {
    const a = await call("GET", "/api/protocols", { cookie: alice });
    expect(a.body.map((p: Protocol) => p.id)).toEqual(["prt_alice"]);
    const b = await call("GET", "/api/protocols", { cookie: bob });
    expect(b.status).toBe(200);
    expect(b.body).toEqual([]);
    // The admin token's "default" workspace does not see workspace records either.
    const adm = await call("GET", "/api/protocols", { token: ADMIN });
    expect(adm.body.map((p: Protocol) => p.id)).not.toContain("prt_alice");
  });

  it("every workspace route denies another workspace's user (generated from the route table)", async () => {
    const routes = routeTable(server).filter(([, , access]) => access !== "public" && access !== "relayer" && access !== "user");
    expect(routes.length).toBeGreaterThan(30);
    for (const [method, re] of routes) {
      const p = re.source
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\\\//g, "/")
        .replace("protocols/([\\w-]+)", "protocols/prt_alice")
        .replace("relayers/([\\w-]+)", "relayers/rly_alice")
        .replace("rules/([\\w.:-]+)", "rules/r1")
        .replace("(approve|reject)", "approve")
        .replace(/\([^)]*\)/g, "x");
      const r = await call(method, p, { cookie: bob, body: method === "GET" ? undefined : {} });
      // Routes naming Alice's records must refuse; collection routes answer with Bob's own (empty) data.
      if (p.includes("_alice")) expect([400, 401, 403, 404, 409, 428], `${method} ${p} answered ${r.status}`).toContain(r.status);
      expect(JSON.stringify(r.body), `${method} ${p} leaked data`).not.toContain("prt_alice.test.near");
      // The owner gets past the authorisation layer on the same route (not 401/403).
      if (!p.includes("demo") && !p.includes("sign-demo")) {
        const own = await call(method, p, { cookie: alice, body: method === "GET" ? undefined : {} });
        // A 403 for the owner may only come from the on-chain authority guard, never from the role/workspace layer.
        if (own.status === 403) expect(own.body.error, `${method} ${p} denied its owner`).toMatch(/on-chain authority/);
        else expect(own.status, `${method} ${p} denied its owner: ${JSON.stringify(own.body)}`).not.toBe(401);
      }
    }
  });

  it("/api/me answers 200 'anonymous' when signed out (no console error on public pages)", async () => {
    const r = await call("GET", "/api/me");
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("anonymous");
    expect((await call("GET", "/api/me", { cookie: alice })).body.kind).toBe("user");
    expect((await call("GET", "/api/me", { token: ADMIN })).body.kind).toBe("admin");
  });

  it("explains a cross-site refusal", async () => {
    const r = await call("POST", "/api/relayers", { cookie: alice, headers: { origin: "https://evil.example" }, body: { name: "x" } });
    expect(r.body.error).toMatch(/evil\.example.*public address is http:\/\/127\.0\.0\.1/);
  });

  it("anonymous callers get 401 on workspace routes", async () => {
    for (const [m, p] of [["GET", "/api/protocols"], ["GET", "/api/claims"], ["GET", "/api/apikeys"], ["GET", "/api/audit"], ["POST", "/api/claims"]]) {
      const r = await call(m, p, { body: m === "GET" ? undefined : {} });
      expect(r.status, `${m} ${p}`).toBe(401);
      // Detailed text for developers, a code for the web app's plain-language message.
      expect(r.body.code).toBe("SIGN_IN_REQUIRED");
      expect(r.body.error).toMatch(/sign in/);
    }
  });

  it("roles: a viewer can read but not change anything", async () => {
    const bobId = (await call("GET", "/api/me", { cookie: bob })).body.user.id;
    tenancy.db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m_v', ?, ?, 'viewer', ?)").run(aliceWs, bobId, new Date().toISOString());
    const h = { "x-qorvex-workspace": aliceWs };
    expect((await call("GET", "/api/protocols", { cookie: bob, headers: h })).body.map((p: Protocol) => p.id)).toEqual(["prt_alice"]);
    expect((await call("POST", "/api/relayers", { cookie: bob, headers: h, body: { name: "x" } })).status).toBe(403);
    expect((await call("POST", "/api/protocols/prt_alice/publish", { cookie: bob, headers: h, body: {} })).status).toBe(403);
    expect((await call("GET", "/api/demo", { cookie: alice })).status).toBe(403);
  });

  it("signed-in writes from another site are refused", async () => {
    const r = await call("POST", "/api/relayers", { cookie: alice, headers: { origin: "https://evil.example" }, body: { name: "x" } });
    expect(r.status).toBe(403);
    const signIn = await call("POST", "/api/auth/sign-in/email", { headers: { origin: "https://evil.example" }, body: { email: "alice@example.com", password: "a long enough password" } });
    expect(signIn.status).toBe(403);
    // The Vite dev server (npm run dev:web) proxies the API: its origin is trusted on a local server.
    const dev = await call("POST", "/api/auth/sign-in/email", { headers: { origin: "http://localhost:5173" }, body: { email: "alice@example.com", password: "a long enough password" } });
    expect(dev.status).toBe(200);
  });

  it("publishing an official page needs a verified claim", async () => {
    const r = await call("POST", "/api/protocols/prt_alice/publish", { cookie: alice, body: {} });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/claim/);
  });

  it("step-up actions ask for a wallet signature", async () => {
    const r = await call("POST", "/api/apikeys", { cookie: alice, body: { name: "ci", scopes: ["contracts:read"] } });
    expect(r.status).toBe(428);
    expect(r.body.details.stepUp.action).toBe("apikey.create");
  });

  it("relayer checks are decided on the server against one shared history", async () => {
    const rel = store.relayer("rly_alice")!;
    rel.budgets = [{ beneficiary: "*", window_sec: 3600, max_count: { storage_deposit: 3 } }];
    store.putRelayer(rel);
    const one = () => call("POST", "/api/relayers/rly_alice/check", { token: "qrx_alice", body: { beneficiary: "dao.near", action: "storage_deposit", cost: "1250000000000000000000" } });
    // Two "instances" racing: 6 concurrent checks, exactly 3 allowed.
    const out = await Promise.all(Array.from({ length: 6 }, one));
    expect(out.every((x) => x.status === 200)).toBe(true);
    expect(out.filter((x) => x.body.allow).length).toBe(3);
    expect((await call("POST", "/api/relayers/rly_alice/check", { token: RELAYER_TOKEN, body: { beneficiary: "a", action: "b", cost: "1" } })).status).toBe(401);
  });

  it("the public contract check is rate limited per address", async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call("POST", "/api/public/check", { body: { network: "sandbox", contractId: "x.test" } })).status;
    expect(last).toBe(429);
  });
});

describe("@qorvex/relayer-sdk against the server", () => {
  it("checks through the server, and falls back to the local cap only when unreachable", async () => {
    const { Qorvex } = await import("../../../sdk/src/index.ts");
    const rel = store.relayer("rly_1")!;
    rel.budgets = [{ beneficiary: "*", window_sec: 3600, max_cost_yocto: "1000" }];
    store.putRelayer(rel);
    const q = new Qorvex({ url: base, relayerId: "rly_1", token: RELAYER_TOKEN });
    expect((await q.check({ beneficiary: "b.near", action: "payout", cost: 600n })).allow).toBe(true);
    const second = await q.check({ beneficiary: "b.near", action: "payout", cost: "600" });
    expect(second.allow).toBe(false);
    expect(second.reason).toMatch(/spend cap/);
    // A wrong token is a configuration bug: it throws instead of silently failing closed.
    await expect(new Qorvex({ url: base, relayerId: "rly_1", token: "qrx_wrong" }).check({ beneficiary: "b", action: "a", cost: 1n })).rejects.toThrow(/401/);
    const down = new Qorvex({ url: "http://127.0.0.1:1", relayerId: "rly_1", token: RELAYER_TOKEN, timeoutMs: 300, whenUnreachable: { failOpenBelow: 10n, localCap: 15n } });
    const a = await down.check({ beneficiary: "b", action: "gas", cost: 8n });
    const b = await down.check({ beneficiary: "b", action: "gas", cost: 8n });
    const big = await down.check({ beneficiary: "b", action: "gas", cost: 11n });
    expect([a.allow, a.basis, b.allow, big.allow]).toEqual([true, "fail-open", false, false]);
    expect((await new Qorvex({ url: "http://127.0.0.1:1", relayerId: "r", token: "t", timeoutMs: 300 }).check({ beneficiary: "b", action: "gas", cost: 1n })).basis).toBe("fail-closed");
  });
});

describe("trusted origins", () => {
  it("trusts the dev server only for a local public URL", () => {
    expect(trustedOriginsFor("http://localhost:8787")).toEqual(expect.arrayContaining(["http://localhost:8787", "http://127.0.0.1:8787", "http://localhost:5173"]));
    expect(trustedOriginsFor("https://app.example.com")).toEqual(["https://app.example.com"]);
    expect(trustedOriginsFor("https://app.example.com", ["https://staging.example.com"])).toEqual(["https://app.example.com", "https://staging.example.com"]);
  });
});
