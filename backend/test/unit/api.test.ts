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
import { createServer } from "../../src/server/api.ts";
import { Store, hashToken } from "../../src/store/store.ts";
import { NearAiClient } from "../../src/ai/client.ts";
import { Alerter } from "../../src/alerts/alerts.ts";

const ADMIN = "operator-token-0123456789";
const RELAYER_TOKEN = "qrx_relayer-secret";
let server: http.Server;
let base: string;
let store: Store;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qorvex-api-"));

function protocol(id: string, published: boolean): Protocol {
  return { id, name: id, network: "sandbox", contractId: `${id}.test.near`, status: "connected", published, createdAt: new Date().toISOString() };
}

async function call(method: string, p: string, o: { token?: string; body?: string | object } = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
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
  store = new Store(path.join(dir, "store"));
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
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const r = await fetch(`${base}${p}`);
      expect(await r.text(), p).not.toContain("do not serve");
    }
  });
});
