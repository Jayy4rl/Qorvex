import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SolvencyEvaluation } from "@qorvex/shared";
import { Store } from "../../src/store/store.ts";
import { blockEventFromRpc } from "../../src/stream/rpc-follow.ts";
import { cachedTokenMeta, humanAmount } from "../../src/near/tokens.ts";
import { fromRepoRoot, REPO_ROOT } from "../../src/paths.ts";
import { loadDotEnv } from "../../src/config.ts";
import type { NearRpc } from "../../src/near/rpc.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qorvex-unit-"));

describe("store", () => {
  const ev = (id: string): SolvencyEvaluation => ({
    ruleId: "r",
    type: "solvency",
    ok: true,
    blockHeight: 1,
    owed: "1",
    held: "2",
    marginBps: 5000,
    at: "",
    reads: [{ id, label: "owed", contract: "c", view: "v", args: {}, value: "1", blockHeight: 1, raw: { provider: "p", request: {}, response: {}, curl: "" } }],
  });

  it("persists state and reads, and reloads them", () => {
    const dir = tmp();
    const s = new Store(dir);
    s.recordEvaluation("p", ev("read-1"));
    s.flush();
    const again = new Store(dir);
    expect(again.read("read-1")?.protocolId).toBe("p");
    expect(again.lastPassed("p", "r")?.blockHeight).toBe(1);
  });

  it("writes only changed rows, and keeps in-place edits made before a flush", () => {
    const dir = tmp();
    const s = new Store(dir);
    s.recordEvaluation("p", ev("read-1"));
    s.setWatcherProgress("sandbox", 5, "test");
    s.flush();
    const stamp = () => (s.db.prepare("SELECT updated_at FROM store_docs WHERE kind = 'evaluations'").get() as { updated_at: number }).updated_at;
    s.db.prepare("UPDATE store_docs SET updated_at = 0 WHERE kind = 'evaluations'").run();
    s.setWatcherProgress("sandbox", 6, "test");
    s.flush();
    expect(stamp()).toBe(0); // unchanged row not rewritten
    const p = { id: "prt_1", name: "x", network: "sandbox", contractId: "x.test", status: "connected", published: false, createdAt: "" } as const;
    s.upsertProtocol({ ...p });
    s.protocol("prt_1")!.published = true; // mutated in place, no put: still persisted by the next flush
    s.flush();
    const again = new Store(dir, s.db);
    expect(again.protocol("prt_1")?.published).toBe(true);
    expect(again.watcherProgress("sandbox")?.lastBlock).toBe(6);
    expect((s.db.prepare("SELECT count(*) AS n FROM store_reads").get() as { n: number }).n).toBe(1);
  });

  it("imports a legacy JSON store once", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ protocols: [{ id: "prt_old", name: "old", network: "sandbox", contractId: "o.test", status: "connected", published: true, createdAt: "" }], watcher: { sandbox: { lastBlock: 9, source: "x", at: "" } } }));
    fs.writeFileSync(path.join(dir, "reads.json"), JSON.stringify([{ ...ev("legacy-read").reads[0], protocolId: "prt_old", ruleId: "r" }]));
    const s = new Store(dir);
    expect(s.protocol("prt_old")?.name).toBe("old");
    expect(s.read("legacy-read")?.protocolId).toBe("prt_old");
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "state.json.imported"))).toBe(true);
    s.close();
    const again = new Store(dir);
    expect(again.watcherProgress("sandbox")?.lastBlock).toBe(9);
    expect(again.protocols()).toHaveLength(1);
  });

  it("deduplicates relayer decisions by id and caps the history", () => {
    const s = new Store(tmp());
    const d = (id: string) => ({ id, at: 1, beneficiary: "b", action: "a", cost: "0", allow: true, reason: "", basis: "budget" as const });
    s.addDecisions("r", [d("1"), d("2"), d("1")]);
    s.addDecisions("r", [d("2"), d("3")]);
    expect(s.decisions("r").map((x) => x.id)).toEqual(["1", "2", "3"]);
    s.addDecisions("r", Array.from({ length: 2_100 }, (_, i) => d(`x${i}`)));
    expect(s.decisions("r")).toHaveLength(2_000);
  });
});

describe("RPC block conversion", () => {
  const args = Buffer.from(JSON.stringify({ amount: "5" })).toString("base64");
  const rpc = {
    chunk: async (h: string) => ({
      receipts: [{ receipt_id: `R-${h}`, predecessor_id: "a.near", receiver_id: "b.near", receipt: { Action: { actions: [{ FunctionCall: { method_name: "ft_transfer", args, deposit: "1" } }] } } }],
      transactions: [{ hash: `T-${h}`, signer_id: "s.near", receiver_id: "b.near", actions: [{ Transfer: { deposit: "9" } }] }],
    }),
  } as unknown as NearRpc;
  const block = { header: { height: 7, hash: "H", timestamp: "2000000000" }, chunks: [{ chunk_hash: "c1", height_included: 7 }, { chunk_hash: "old", height_included: 6 }] };

  it("reads only the block's new chunks, with receipts and transactions", async () => {
    const b = await blockEventFromRpc(rpc, block, "test");
    expect(b).toMatchObject({ height: 7, hash: "H", timestampMs: 2000, source: "test" });
    expect(b.receipts.map((r) => r.receiptId)).toEqual(["R-c1", "tx:T-c1"]);
    expect(b.receipts[0].actions[0]).toMatchObject({ kind: "FunctionCall", method: "ft_transfer", args: { amount: "5" } });
    expect(b.receipts[1]).toMatchObject({ txHash: "T-c1", predecessor: "s.near", actions: [{ kind: "Transfer", deposit: "9" }] });
  });

  it("can leave transactions out", async () => {
    const b = await blockEventFromRpc(rpc, block, "test", { includeTransactions: false });
    expect(b.receipts.map((r) => r.receiptId)).toEqual(["R-c1"]);
  });
});

describe("tokens", () => {
  it("formats smallest units", () => {
    expect(humanAmount("500000000000", 6)).toBe("500,000");
    expect(humanAmount("1234567", 6)).toBe("1.234567");
    expect(humanAmount("1", 24)).toBe("0.000000");
  });

  it("reads ft_metadata once per provider set and token, also for concurrent callers", async () => {
    let calls = 0;
    const rpc = {
      urls: [`fake-${Math.random()}`],
      view: async () => {
        calls++;
        return { value: { symbol: "USDC", decimals: 6 } };
      },
    } as unknown as NearRpc;
    const [a, b] = await Promise.all([cachedTokenMeta(rpc, "usdc.near"), cachedTokenMeta(rpc, "usdc.near")]);
    await cachedTokenMeta(rpc, "usdc.near");
    expect(a).toEqual({ symbol: "USDC", decimals: 6 });
    expect(b).toEqual(a);
    expect(calls).toBe(1);
  });
});

describe("configuration paths", () => {
  it("resolves relative paths from the repository root, whatever the working directory", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "contracts", "Cargo.toml"))).toBe(true);
    expect(fromRepoRoot("data")).toBe(path.join(REPO_ROOT, "data"));
    expect(fromRepoRoot("/abs/dir")).toBe("/abs/dir");
  });

  it("loads .env values without overriding the environment, trimming whitespace and quotes", () => {
    const file = path.join(tmp(), ".env");
    fs.writeFileSync(file, ["# comment", "QX_TEST_A = spaced   ", 'QX_TEST_B="quoted"', "QX_TEST_C=from-file", "not a var"].join("\n"));
    process.env.QX_TEST_C = "from-env";
    loadDotEnv(file);
    expect(process.env.QX_TEST_A).toBe("spaced");
    expect(process.env.QX_TEST_B).toBe("quoted");
    expect(process.env.QX_TEST_C).toBe("from-env");
    delete process.env.QX_TEST_A;
    delete process.env.QX_TEST_B;
    delete process.env.QX_TEST_C;
  });
});
