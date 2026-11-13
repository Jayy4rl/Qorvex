/**
 * NEAR sign-in (NEP-413) through the real Better Auth endpoints, with a real
 * ed25519 key and a fake RPC answering view_access_key.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { generateKey } from "near-kit";
import { toNodeHandler } from "better-auth/node";
import { openDb } from "../../src/db/db.ts";
import { createAuth } from "../../src/auth/auth.ts";
import { consumeStepUp, linkedNearAccounts } from "../../src/auth/near-plugin.ts";
import { verifyNep413 } from "../../src/auth/nep413.ts";
import { RpcError, type NearRpc } from "../../src/near/rpc.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qorvex-near-"));
const db = openDb(path.join(dir, "q.db"));
const key = generateKey();
const fcKey = generateKey();
let rpcDown = false;
/** alice.testnet holds `key` as full access and `fcKey` as a function-call key. */
const rpc = {
  async viewAccessKey(accountId: string, publicKey: string) {
    if (rpcDown) throw new RpcError("HTTP 503", "fake", undefined, "HTTP");
    if (accountId === "alice.testnet" && publicKey === key.publicKey.toString()) return { result: { permission: "FullAccess" }, raw: {} };
    if (accountId === "alice.testnet" && publicKey === fcKey.publicKey.toString()) return { result: { permission: { FunctionCall: {} } }, raw: {} };
    throw new RpcError("query: access key does not exist", "fake", undefined, "UNKNOWN_ACCESS_KEY");
  },
} as unknown as NearRpc;
const a = createAuth({ db, publicUrl: "http://127.0.0.1:9", dataDir: dir, rpcFor: (n) => (n === "testnet" ? rpc : undefined), email: { send: async () => {} } });
let server: http.Server;
let base: string;

beforeAll(async () => {
  await a.migrate();
  server = http.createServer(toNodeHandler(a.auth));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function post(p: string, body: unknown, cookie?: string) {
  const res = await fetch(`${base}/api/auth${p}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}

function sign(k: ReturnType<typeof generateKey>, n: { nonce: string; message: string; recipient: string }, recipient = n.recipient, callbackUrl?: string) {
  return k.signNep413Message!("alice.testnet", { message: n.message, recipient, nonce: Buffer.from(n.nonce, "base64"), ...(callbackUrl ? { callbackUrl } : {}) });
}

describe("NEAR sign-in", () => {
  it("signs in with a full-access key, binds the recipient to this host, and never returns the token", async () => {
    const n = (await post("/near/nonce", { network: "testnet", purpose: "sign-in" })).body;
    expect(n.recipient).toBe("127.0.0.1:9");
    expect(n.message).toContain("Sign in to Qorvex");
    const s = sign(key, n);
    const r = await post("/near/verify", { nonce: n.nonce, accountId: "alice.testnet", publicKey: s.publicKey, signature: s.signature });
    expect(r.status).toBe(200);
    expect(r.body.newUser).toBe(true);
    expect(r.body.token).toBeUndefined();
    expect(r.cookie).toMatch(/session_token/);
    // The same nonce cannot be used twice.
    const again = await post("/near/verify", { nonce: n.nonce, accountId: "alice.testnet", publicKey: s.publicKey, signature: s.signature });
    expect(again.status).toBe(401);
    // Second sign-in: same user.
    const n2 = (await post("/near/nonce", { network: "testnet", purpose: "sign-in" })).body;
    const s2 = sign(key, n2);
    const r2 = await post("/near/verify", { nonce: n2.nonce, accountId: "alice.testnet", publicKey: s2.publicKey, signature: s2.signature });
    expect(r2.body.newUser).toBe(false);
    expect(r2.body.user.id).toBe(r.body.user.id);
  });

  it("rejects a signature made for another site (recipient) — the better-near-auth 1.10.2 flaw", async () => {
    const n = (await post("/near/nonce", { network: "testnet", purpose: "sign-in" })).body;
    const s = sign(key, n, "evil.example");
    const r = await post("/near/verify", { nonce: n.nonce, accountId: "alice.testnet", publicKey: s.publicKey, signature: s.signature });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("NEAR_SIGNATURE");
  });

  it("rejects function-call keys and unknown keys, and fails closed when the RPC is down", async () => {
    for (const [k, code] of [[fcKey, "NEAR_KEY"], [generateKey(), "NEAR_KEY"]] as const) {
      const n = (await post("/near/nonce", { network: "testnet", purpose: "sign-in" })).body;
      const s = sign(k, n);
      const r = await post("/near/verify", { nonce: n.nonce, accountId: "alice.testnet", publicKey: s.publicKey, signature: s.signature });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe(code);
    }
    rpcDown = true;
    const n = (await post("/near/nonce", { network: "testnet", purpose: "sign-in" })).body;
    const s = sign(key, n);
    const r = await post("/near/verify", { nonce: n.nonce, accountId: "alice.testnet", publicKey: s.publicKey, signature: s.signature });
    rpcDown = false;
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("NEAR_RPC");
  });

  it("accepts both callbackUrl encodings (wallets that drop it, and ones that sign it)", async () => {
    const cb = "http://127.0.0.1:9/auth/near/callback";
    for (const withCb of [true, false]) {
      const n = (await post("/near/nonce", { network: "testnet", purpose: "sign-in", callbackUrl: cb })).body;
      const s = sign(key, n, n.recipient, withCb ? cb : undefined);
      const r = await post("/near/verify", { nonce: n.nonce, accountId: "alice.testnet", publicKey: s.publicKey, signature: s.signature });
      expect(r.status, `callbackUrl ${withCb ? "signed" : "dropped"}`).toBe(200);
    }
    expect((await post("/near/nonce", { network: "testnet", purpose: "sign-in", callbackUrl: "https://evil.example/cb" })).status).toBe(400);
  });

  it("step-up signatures are bound to the user, action, target and parameters", async () => {
    const n0 = (await post("/near/nonce", { network: "testnet", purpose: "sign-in" })).body;
    const s0 = sign(key, n0);
    const login = await post("/near/verify", { nonce: n0.nonce, accountId: "alice.testnet", publicKey: s0.publicKey, signature: s0.signature });
    const userId = login.body.user.id;
    expect(linkedNearAccounts(db, userId)).toEqual([{ network: "testnet", accountId: "alice.testnet" }]);
    const ask = async (params: unknown) => (await post("/near/nonce", { network: "testnet", purpose: "step-up", action: "apikey.create", target: "ws1", params }, login.cookie)).body;
    const n = await ask({ name: "ci", scopes: ["contracts:read"] });
    expect(n.message).toContain("Qorvex action: apikey.create");
    const s = sign(key, n);
    const proof = { nonce: n.nonce, accountId: "alice.testnet", publicKey: s.publicKey, signature: s.signature };
    // Different parameters than signed: refused (and the nonce is spent).
    await expect(consumeStepUp(a.nearOptions, userId, { action: "apikey.create", target: "ws1", params: { name: "ci", scopes: ["alerts:ack"] } }, proof)).rejects.toThrow(/different action/);
    const n2 = await ask({ scopes: ["contracts:read"], name: "ci" });
    const s2 = sign(key, n2);
    const ok = await consumeStepUp(a.nearOptions, userId, { action: "apikey.create", target: "ws1", params: { name: "ci", scopes: ["contracts:read"] } }, { nonce: n2.nonce, accountId: "alice.testnet", publicKey: s2.publicKey, signature: s2.signature });
    expect(ok.accountId).toBe("alice.testnet");
    expect(ok.message).toContain("params:");
    // Step-up nonces need a session.
    expect((await post("/near/nonce", { network: "testnet", purpose: "step-up", action: "x", target: "y" })).status).toBe(401);
  });

  it("verifyNep413 checks the message bytes", async () => {
    const nonce = new Uint8Array(32).fill(7);
    const s = key.signNep413Message!("alice.testnet", { message: "hello", recipient: "h", nonce });
    expect(await verifyNep413(s, { message: "hello", recipient: "h", nonce })).toBe(true);
    expect(await verifyNep413(s, { message: "hello!", recipient: "h", nonce })).toBe(false);
  });
});
