import { describe, expect, it } from "vitest";
import type { Rule } from "@qorvex/shared";
import { validateDraftShape, accountsTouchedBy } from "../../src/rules/validate.ts";
import { extractAmount, marginBps, OutflowWindow, evidenceHash, outflowsFrom } from "../../src/rules/evaluate.ts";
import type { BlockEvent } from "../../src/stream/types.ts";

const solvency = {
  id: "solvency-usdc",
  type: "solvency",
  token: "usdc.near",
  owed: { view: "mt_supply", args: { token_id: "nep141:usdc.near" } },
  held: { contract: "usdc.near", view: "ft_balance_of", args: { account_id: "ledger.near" } },
  explain: "USDC owed to users must never exceed USDC held",
};

describe("rule shape validation (the first gate for AI drafts)", () => {
  it("accepts the PRD example shape", () => {
    expect(validateDraftShape(solvency)).toEqual([]);
  });
  it("rejects unknown fields, bad ids and invented structure", () => {
    expect(validateDraftShape({ ...solvency, id: "Bad Id" })).toContain("id must match ^[a-z0-9][a-z0-9_.:-]{0,63}$");
    expect(validateDraftShape({ ...solvency, pause: true })).toContain("field pause is not allowed");
    expect(validateDraftShape({ ...solvency, owed: { view: "x; drop" } })).toContain("owed.view must be a method name");
    expect(validateDraftShape({ ...solvency, held: { contract: "NOT VALID", view: "ft_balance_of" } })).toContain("held.contract must be a NEAR account id");
    expect(validateDraftShape({ ...solvency, type: "magic" })).toContain('type must be "solvency", "outflow_rate" or "proposal_policy"');
    expect(validateDraftShape({ ...solvency, explain: "short" }).length).toBeGreaterThan(0);
  });
  it("validates outflow rules", () => {
    const r = { id: "out", type: "outflow_rate", token: "usdc.near", max: "1000", window_sec: 3600, explain: "No more than 1000 per hour may leave" };
    expect(validateDraftShape(r)).toEqual([]);
    expect(validateDraftShape({ ...r, max: 1000 })).toContain("max must be a decimal integer string (smallest units)");
    expect(validateDraftShape({ ...r, window_sec: 0 }).length).toBe(1);
  });
  it("lists the accounts a rule touches", () => {
    expect(accountsTouchedBy(solvency as unknown as Rule, "ledger.near").sort()).toEqual(["ledger.near", "usdc.near"]);
  });
});

describe("evaluation math", () => {
  it("extracts amounts from strings, numbers and nested paths", () => {
    expect(extractAmount("123")).toBe(123n);
    expect(extractAmount(5)).toBe(5n);
    expect(extractAmount({ total: "9" }, "total")).toBe(9n);
    expect(() => extractAmount("-1")).toThrow();
    expect(() => extractAmount(null)).toThrow();
    expect(() => extractAmount({ a: 1 }, "b")).toThrow();
  });
  it("computes the margin in basis points", () => {
    expect(marginBps(990n, 1000n)).toBe(100);
    expect(marginBps(1100n, 1000n)).toBe(-1000);
    expect(marginBps(0n, 0n)).toBeNull();
  });
  it("hashes evidence deterministically", () => {
    const ev = { ruleId: "r", type: "solvency" as const, ok: false, blockHeight: 5, owed: "2", held: "1", marginBps: -10000, reads: [], at: "x" };
    expect(evidenceHash(ev)).toBe(evidenceHash({ ...ev, at: "y" }));
    expect(evidenceHash(ev)).not.toBe(evidenceHash({ ...ev, held: "0" }));
  });
});

describe("outflow-rate window", () => {
  const rule = { id: "out", type: "outflow_rate" as const, token: "usdc.near", max: "100", window_sec: 60, explain: "x".repeat(12), response: "alert" as const, status: "approved" as const, origin: { kind: "human" as const, author: "t" } };
  const block = (height: number, ts: number, amount: string, from = "ledger.near"): BlockEvent => ({
    height,
    hash: `h${height}`,
    timestampMs: ts,
    source: "test",
    receivedAtMs: ts,
    receipts: [
      { receiptId: `r${height}`, predecessor: from, receiver: "usdc.near", status: "success", logs: [], actions: [{ kind: "FunctionCall", method: "ft_transfer", args: { receiver_id: "bob.near", amount } }] },
      { receiptId: `x${height}`, predecessor: from, receiver: "other.near", status: "success", logs: [], actions: [{ kind: "FunctionCall", method: "ft_transfer", args: { amount: "999" } }] },
    ],
  });
  it("sums ft_transfer outflows to the token contract only", () => {
    const b = block(1, 1000, "40");
    const o = outflowsFrom("ledger.near", "usdc.near", b, b.receipts);
    expect(o).toHaveLength(1);
    expect(o[0].amount).toBe(40n);
    expect(outflowsFrom("someone.near", "usdc.near", b, b.receipts)).toHaveLength(0);
  });
  it("fires above the cap and forgets old outflows", () => {
    const w = new OutflowWindow(rule);
    for (const [h, ts, a] of [[1, 0, "60"], [2, 10_000, "30"]] as const) {
      const b = block(h, ts, a);
      for (const o of outflowsFrom("ledger.near", "usdc.near", b, b.receipts)) w.add(o);
    }
    expect(w.evaluate(10_000, 2).ok).toBe(true);
    const b3 = block(3, 20_000, "20");
    for (const o of outflowsFrom("ledger.near", "usdc.near", b3, b3.receipts)) w.add(o);
    const ev = w.evaluate(20_000, 3);
    expect(ev.ok).toBe(false);
    expect(ev.total).toBe("110");
    // 61 s later the first outflow left the window
    expect(w.evaluate(61_000, 4).total).toBe("50");
  });
  it("ignores failed receipts", () => {
    const b = block(1, 0, "500");
    b.receipts[0].status = "failure";
    expect(outflowsFrom("ledger.near", "usdc.near", b, b.receipts)).toHaveLength(0);
  });
});
