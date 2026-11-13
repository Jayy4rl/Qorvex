/**
 * Who may trigger the guardian: only the workspace with a verified claim that
 * holds the contract's official record, proven by the guardian's own council.
 */
import { describe, expect, it } from "vitest";
import type { Protocol } from "@qorvex/shared";
import { openDb } from "../../src/db/db.ts";
import { Tenancy, DEFAULT_WORKSPACE } from "../../src/tenancy/tenancy.ts";
import { mayPause } from "../../src/tenancy/claims.ts";
import { councilMatch } from "../../src/tenancy/authority.ts";
import type { NearRpc } from "../../src/near/rpc.ts";

const watch = (ws?: string): Protocol => ({ id: "p", ...(ws ? { workspaceId: ws } : {}), name: "x", network: "testnet", contractId: "vault.testnet", status: "protected", published: false, createdAt: "" });
const now = () => new Date().toISOString();

function setup() {
  const t = new Tenancy(openDb(":memory:"));
  const claim = (ws: string, matches: boolean | undefined, status: "verified" | "lapsed" = "verified") =>
    t.putClaim({
      workspaceId: ws,
      network: "testnet",
      contractId: "vault.testnet",
      method: "dao-council",
      evidence: { account: `${ws}.testnet`, detail: "test", ...(matches === undefined ? {} : { council: { council: "dao.testnet", matches, checkedAt: now() } }) },
      status,
      verifiedAt: now(),
    });
  return { t, claim };
}

describe("pause gate", () => {
  it("lets the self-hosted default workspace pause as before", () => {
    expect(mayPause(setup().t, watch()).ok).toBe(true);
    expect(DEFAULT_WORKSPACE).toBe("default");
  });

  it("refuses a workspace without a verified claim, or with a lapsed one", async () => {
    const { t, claim } = setup();
    expect(mayPause(t, watch("ws_a")).ok).toBe(false);
    claim("ws_a", true, "lapsed");
    await t.claimCanonical("testnet", "vault.testnet", "ws_a");
    expect(mayPause(t, watch("ws_a"))).toMatchObject({ ok: false, reason: expect.stringMatching(/lapsed/) });
  });

  it("refuses a verified claim whose account is not the guardian council", async () => {
    const { t, claim } = setup();
    claim("ws_a", false);
    await t.claimCanonical("testnet", "vault.testnet", "ws_a");
    expect(mayPause(t, watch("ws_a"))).toMatchObject({ ok: false, reason: expect.stringMatching(/guardian council/) });
    claim("ws_a", undefined); // never checked
    expect(mayPause(t, watch("ws_a")).ok).toBe(false);
  });

  it("refuses a council-matching workspace that does not hold the official record", async () => {
    const { t, claim } = setup();
    claim("ws_a", true);
    claim("ws_b", true);
    await t.claimCanonical("testnet", "vault.testnet", "ws_a");
    expect(await t.claimCanonical("testnet", "vault.testnet", "ws_b")).toBe(false); // the first verified holder keeps it
    expect(mayPause(t, watch("ws_a")).ok).toBe(true);
    expect(mayPause(t, watch("ws_b"))).toMatchObject({ ok: false, reason: expect.stringMatching(/official record/) });
  });
});

describe("guardian council check", () => {
  const rpc = (reg: unknown, policies: Record<string, unknown> = {}) =>
    ({
      async view(contract: string, method: string) {
        if (method === "get_target") return { value: reg };
        if (method === "get_policy" && policies[contract]) return { value: policies[contract] };
        throw new Error("MethodNotFound");
      },
    }) as unknown as NearRpc;
  const dao = { roles: [{ name: "council", kind: { Group: ["alice.testnet"] }, permissions: ["*:*"] }, { name: "members", kind: { Group: ["mallory.testnet"] }, permissions: ["*:AddProposal"] }] };

  it("matches the council account itself", async () => {
    expect((await councilMatch(rpc({ council: "owner.testnet" }), "guardian.testnet", "vault.testnet", "owner.testnet")).matches).toBe(true);
    expect((await councilMatch(rpc({ council: "owner.testnet" }), "guardian.testnet", "vault.testnet", "other.testnet")).matches).toBe(false);
  });

  it("matches approvers of a DAO council, not ordinary DAO members", async () => {
    const r = rpc({ council: "dao.testnet" }, { "dao.testnet": dao });
    expect((await councilMatch(r, "guardian.testnet", "vault.testnet", "alice.testnet")).matches).toBe(true);
    expect((await councilMatch(r, "guardian.testnet", "vault.testnet", "mallory.testnet")).matches).toBe(false);
  });

  it("does not match when the contract is not registered or there is no guardian", async () => {
    expect((await councilMatch(rpc(null), "guardian.testnet", "vault.testnet", "owner.testnet")).matches).toBe(false);
    expect((await councilMatch(rpc({ council: "x" }), undefined, "vault.testnet", "x")).matches).toBe(false);
  });
});

describe("shared connection with Better Auth", () => {
  it("never starts a second transaction while another is open on the connection", async () => {
    const { openDb, tx, txWhenFree, TxBusyError } = await import("../../src/db/db.ts");
    const { Store } = await import("../../src/store/store.ts");
    const os = await import("node:os");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qorvex-tx-"));
    const db = openDb(path.join(dir, "q.db"));
    const store = new Store(dir, db);
    // Better Auth opens a transaction and awaits slow work (password hashing) inside it.
    db.exec("BEGIN");
    store.setWatcherProgress("sandbox", 7, "test"); // schedules a save
    expect(() => store.flush()).not.toThrow(); // waits instead of crashing
    expect(() => tx(db, () => 1)).toThrow(TxBusyError);
    const later = txWhenFree(db, () => "ran after");
    await new Promise((r) => setTimeout(r, 30));
    db.exec("COMMIT");
    expect(await later).toBe("ran after");
    await new Promise((r) => setTimeout(r, 60));
    expect((db.prepare("SELECT doc FROM store_docs WHERE kind = 'watcher'").get() as { doc: string }).doc).toContain('"lastBlock":7');
  });
});
