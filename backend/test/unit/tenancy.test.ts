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

  it("refuses a workspace without a verified claim, or with a lapsed one", () => {
    const { t, claim } = setup();
    expect(mayPause(t, watch("ws_a")).ok).toBe(false);
    claim("ws_a", true, "lapsed");
    t.claimCanonical("testnet", "vault.testnet", "ws_a");
    expect(mayPause(t, watch("ws_a"))).toMatchObject({ ok: false, reason: expect.stringMatching(/lapsed/) });
  });

  it("refuses a verified claim whose account is not the guardian council", () => {
    const { t, claim } = setup();
    claim("ws_a", false);
    t.claimCanonical("testnet", "vault.testnet", "ws_a");
    expect(mayPause(t, watch("ws_a"))).toMatchObject({ ok: false, reason: expect.stringMatching(/guardian council/) });
    claim("ws_a", undefined); // never checked
    expect(mayPause(t, watch("ws_a")).ok).toBe(false);
  });

  it("refuses a council-matching workspace that does not hold the official record", () => {
    const { t, claim } = setup();
    claim("ws_a", true);
    claim("ws_b", true);
    t.claimCanonical("testnet", "vault.testnet", "ws_a");
    expect(t.claimCanonical("testnet", "vault.testnet", "ws_b")).toBe(false); // the first verified holder keeps it
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
