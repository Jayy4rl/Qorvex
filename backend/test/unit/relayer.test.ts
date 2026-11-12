import { describe, expect, it } from "vitest";
import http from "node:http";
import { decide, validateBudget, type Budget, type Decision } from "../../src/relayer/budgets.ts";
import { QorvexRelayerGuard } from "../../src/relayer/sdk.ts";

const COST = 2_250_000_000_000_000_000_000n; // 0.00225 NEAR
const budgets: Budget[] = [{ beneficiary: "*", window_sec: 3600, max_cost_yocto: "20000000000000000000000", max_count: { storage_deposit: 8 } }];

describe("budget engine (P4)", () => {
  it("allows within budget, then refuses with a reason (Trezu #1871 replay)", () => {
    const hist: Decision[] = [];
    const out: Decision[] = [];
    for (let i = 0; i < 12; i++) {
      const d = decide(budgets, hist, { beneficiary: "dao.near", action: "storage_deposit", cost: COST, receiver: "capture.near" }, 1000 + i, `d${i}`);
      if (d.allow) hist.push(d);
      out.push(d);
    }
    expect(out.filter((d) => d.allow)).toHaveLength(8);
    expect(out[8].reason).toMatch(/spend cap|count cap/);
  });
  it("tracks each beneficiary separately", () => {
    const hist: Decision[] = [];
    for (let i = 0; i < 8; i++) hist.push(decide(budgets, hist, { beneficiary: "a.near", action: "storage_deposit", cost: COST }, i, `a${i}`));
    expect(decide(budgets, hist, { beneficiary: "a.near", action: "storage_deposit", cost: COST }, 9, "a9").allow).toBe(false);
    expect(decide(budgets, hist, { beneficiary: "b.near", action: "storage_deposit", cost: COST }, 9, "b0").allow).toBe(true);
  });
  it("resets after the window", () => {
    const hist: Decision[] = [];
    for (let i = 0; i < 8; i++) hist.push(decide(budgets, hist, { beneficiary: "a.near", action: "storage_deposit", cost: COST }, i, `a${i}`));
    expect(decide(budgets, hist, { beneficiary: "a.near", action: "storage_deposit", cost: COST }, 3_600_001 + 8, "late").allow).toBe(true);
  });
  it("enforces the receiver allowlist", () => {
    const b: Budget[] = [{ beneficiary: "*", window_sec: 60, allowed_receivers: ["wrap.near"] }];
    expect(decide(b, [], { beneficiary: "x.near", action: "storage_deposit", cost: 1n, receiver: "capture.near" }, 0, "1").allow).toBe(false);
    expect(decide(b, [], { beneficiary: "x.near", action: "storage_deposit", cost: 1n, receiver: "wrap.near" }, 0, "2").allow).toBe(true);
  });
  it("denies when no budget covers the beneficiary", () => {
    const d = decide([{ beneficiary: "only.near", window_sec: 60 }], [], { beneficiary: "x.near", action: "a", cost: 1n }, 0, "1");
    expect(d.allow).toBe(false);
    expect(d.basis).toBe("no-budget");
  });
  it("validates budgets", () => {
    expect(validateBudget(budgets[0])).toEqual([]);
    expect(validateBudget({ beneficiary: "*", window_sec: 0 })).toContain("window_sec must be an integer between 1 and 2592000");
    expect(validateBudget({ beneficiary: "*", window_sec: 1, max_cost_yocto: 5 })).toContain("max_cost_yocto must be a decimal string");
  });
});

describe("relayer SDK (P4, P5)", () => {
  it("serialises concurrent checks so they cannot both squeeze under a cap", async () => {
    const g = new QorvexRelayerGuard({ relayerId: "r", budgets: [{ beneficiary: "*", window_sec: 60, max_count: { x: 3 } }] });
    const ds = await Promise.all(Array.from({ length: 10 }, () => g.check("dao.near", "x", 1n)));
    expect(ds.filter((d) => d.allow)).toHaveLength(3);
    await g.close();
  });

  it("fails closed or open when Qorvex is unreachable and nothing is cached", async () => {
    const closed = new QorvexRelayerGuard({ relayerId: "r", apiUrl: "http://127.0.0.1:9", failMode: "closed" });
    const c = await closed.check("dao.near", "x", 1n);
    expect(c.allow).toBe(false);
    expect(c.basis).toBe("fail-closed");
    await closed.close();
    const open = new QorvexRelayerGuard({ relayerId: "r", apiUrl: "http://127.0.0.1:9", failMode: "open" });
    expect((await open.check("dao.near", "x", 1n)).basis).toBe("fail-open");
    await open.close();
  });

  it("pulls budgets, keeps the cache through an outage, and ships every decision", async () => {
    let up = true;
    const received: Decision[] = [];
    const server = http.createServer(async (req, res) => {
      if (!up) return res.destroy();
      if (req.headers.authorization !== "Bearer tok") {
        res.writeHead(401);
        return res.end();
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ budgets: [{ beneficiary: "*", window_sec: 60, max_count: { x: 2 } }], failMode: "closed" }));
      }
      let raw = "";
      for await (const c of req) raw += c;
      received.push(...JSON.parse(raw).decisions);
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    let now = 0;
    const g = new QorvexRelayerGuard({ relayerId: "r1", apiUrl: `http://127.0.0.1:${port}`, apiToken: "tok", cacheTtlMs: 10, now: () => now, flushMs: 60_000 });
    expect((await g.check("dao.near", "x", 1n)).allow).toBe(true);
    up = false; // Qorvex goes down; cached budgets still apply
    now = 100;
    expect((await g.check("dao.near", "x", 1n)).allow).toBe(true);
    const third = await g.check("dao.near", "x", 1n);
    expect(third.allow).toBe(false);
    expect(third.basis).toBe("budget");
    up = true;
    await g.flush();
    expect(received.map((d) => d.allow)).toEqual([true, true, false]);
    await g.close();
    server.close();
  });
});
