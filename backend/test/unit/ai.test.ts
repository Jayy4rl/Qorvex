import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { NearAiClient, FixtureMissingError, parseJsonReply } from "../../src/ai/client.ts";
import { draftRules, validateDraft } from "../../src/ai/drafter.ts";
import { Store } from "../../src/store/store.ts";
import type { NearRpc } from "../../src/near/rpc.ts";
import type { DraftInputs } from "../../src/ai/inputs.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qorvex-test-"));
const cfg = (dir: string, mode: "replay" | "live" | "record", baseUrl = "http://127.0.0.1:9") => ({
  baseUrl,
  apiKey: mode === "replay" ? undefined : "k",
  mode,
  draftModel: "z-ai/glm-5.3",
  explainModel: "Qwen/Qwen3.6-35B-A3B-FP8",
  fallbackModels: [] as string[],
  thinking: false,
  fixturesDir: dir,
});

/** A fake RPC that answers the views the drafts reference. */
function fakeRpc(values: Record<string, unknown>): NearRpc {
  return {
    urls: ["fake"],
    view: async (contract: string, method: string, _args: unknown, ref: unknown) => {
      const k = `${contract}.${method}`;
      if (!(k in values)) throw new Error(`MethodNotFound ${k}`);
      return { value: values[k], blockHeight: (ref as any)?.blockId ?? 100, blockHash: "h", raw: { provider: "fake", request: {}, response: {}, curl: "" } };
    },
    block: async () => ({ header: { height: 100 } }),
  } as unknown as NearRpc;
}

const inputs: DraftInputs = {
  contractId: "ledger.test",
  network: "sandbox",
  codeHash: "abc",
  source: { kind: "upload", files: [{ path: "lib.rs", content: "fn x(){}" }] },
  abiAvailable: true,
  methods: [{ name: "total_owed", kind: "view", params: ["token_id"] }],
  stateReads: [],
  recentReceipts: [],
};

describe("NEAR AI client record/replay (A9)", () => {
  it("never invents an answer in replay mode", async () => {
    const c = new NearAiClient(cfg(tmp(), "replay"));
    await expect(c.chat("m", [{ role: "user", content: "x" }], { job: "t" })).rejects.toBeInstanceOf(FixtureMissingError);
  });

  it("records a live exchange and replays it without a key", async () => {
    const dir = tmp();
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      expect(body.temperature).toBe(0);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(req.headers.authorization).toBe("Bearer k");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", choices: [{ message: { content: '{"rules":[]}' } }] }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const rec = new NearAiClient(cfg(dir, "record", url));
    const r1 = await rec.chat("m", [{ role: "user", content: "x" }], { job: "t" }, { json: true });
    expect(r1.text).toBe('{"rules":[]}');
    server.close();
    const rep = new NearAiClient(cfg(dir, "replay"));
    const r2 = await rep.chat("m", [{ role: "user", content: "different prompt, same key" }], { job: "t" });
    expect(r2.source).toBe("replay");
    expect(r2.text).toBe('{"rules":[]}');
    expect(r2.chatId).toBe("chat-1");
  });

  it("retries a rate-limited model, then falls back to the next one and reports which answered", async () => {
    const seen: string[] = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      seen.push(body.model);
      if (body.model === "big") {
        res.writeHead(429);
        return res.end('{"message":"Rate limit exceeded by upstream provider"}');
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c2", choices: [{ message: { content: "fine" } }] }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const c = new NearAiClient({ ...cfg(tmp(), "live", `http://127.0.0.1:${(server.address() as any).port}`), fallbackModels: ["small"] });
    const r = await c.chat("big", [{ role: "user", content: "x" }], { job: "t" });
    server.close();
    expect(r.model).toBe("small");
    expect(seen.filter((m) => m === "big").length).toBe(3);
  }, 30_000);

  it("parses JSON replies with code fences", () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Here: {"a":2} done')).toEqual({ a: 2 });
  });
});

describe("drafting pipeline (A4, A5, A6)", () => {
  const rpc = fakeRpc({ "ledger.test.total_owed": "100", "usdc.test.ft_balance_of": "100" });
  const backtest = async (r: any) => ({ ruleId: r.id, network: "sandbox" as const, fromBlock: 1, toBlock: 2, days: 0, samples: 2, fires: 0, firedAt: [], errors: 0, minMarginBps: 0, method: "test", at: "" });
  const good = {
    id: "solvency-usdc",
    type: "solvency",
    token: "usdc.test",
    owed: { view: "total_owed", args: { token_id: "usdc.test" } },
    held: { contract: "usdc.test", view: "ft_balance_of", args: { account_id: "ledger.test" } },
    explain: "USDC owed must never exceed USDC held",
  };

  it("rejects a draft that references a made-up view method", async () => {
    const v = await validateDraft({ ...good, owed: { view: "mt_total_supply" } }, { rpc, contractId: "ledger.test", methods: new Set(["total_owed"]), backtest });
    expect(v.errors[0]).toMatch(/does not exist/);
  });

  it("sends failing drafts back to the model, then accepts the fix; nothing is approved automatically", async () => {
    const dir = tmp();
    const { sourceDigest } = await import("../../src/ai/inputs.ts");
    const fixture = (attempt: number, text: string) => {
      const c = new NearAiClient(cfg(dir, "replay"));
      const key = { model: "z-ai/glm-5.3", job: "draft-rules", contractId: "ledger.test", codeHash: "abc", source: sourceDigest(inputs.source.files), attempt };
      fs.writeFileSync(c.fixturePath(key), JSON.stringify({ text, replayKey: key, recordedAt: "t" }));
    };
    fixture(0, JSON.stringify({ rules: [{ ...good, owed: { view: "invented_view" } }], notes: "one token" }));
    fixture(1, JSON.stringify({ rules: [good] }));
    const store = new Store(tmp());
    const ai = new NearAiClient(cfg(dir, "replay"));
    const out = await draftRules(ai, store, "prt_1", inputs, { rpc, contractId: "ledger.test", methods: new Set(["total_owed"]), backtest });
    expect(out.run.attempts).toHaveLength(2);
    expect(out.run.attempts[0].errors.join()).toMatch(/invented_view/);
    expect(out.rules.map((r) => r.id)).toEqual(["solvency-usdc"]);
    expect(out.rules[0].status).toBe("draft");
    expect(out.rules[0].response).toBe("alert");
    expect(out.rules[0].origin).toMatchObject({ kind: "ai", model: "z-ai/glm-5.3" });
  });

  it("drops a draft that still fails after two retries", async () => {
    const dir = tmp();
    const { sourceDigest } = await import("../../src/ai/inputs.ts");
    const bad = JSON.stringify({ rules: [{ ...good, owed: { view: "nope" } }] });
    for (const attempt of [0, 1, 2]) {
      const c = new NearAiClient(cfg(dir, "replay"));
      const key = { model: "z-ai/glm-5.3", job: "draft-rules", contractId: "ledger.test", codeHash: "abc", source: sourceDigest(inputs.source.files), attempt };
      fs.writeFileSync(c.fixturePath(key), JSON.stringify({ text: bad, replayKey: key, recordedAt: "t" }));
    }
    const out = await draftRules(new NearAiClient(cfg(dir, "replay")), new Store(tmp()), "p", inputs, { rpc, contractId: "ledger.test", methods: new Set(["total_owed"]), backtest });
    expect(out.rules).toHaveLength(0);
    expect(out.run.attempts).toHaveLength(3);
    expect(out.run.dropped).toHaveLength(1);
  });
});

describe("replayed incident explanations", () => {
  it("swap the recorded run's block heights and receipts for the current incident's", async () => {
    const { retargetExplanation } = await import("../../src/ai/explain.ts");
    const recorded = { contract: "ledger.test.near", triggerBlock: 180, evaluation: { owed: "290000000000", held: "250000000000", block: 181 }, receipts_in_breaking_block: [{ receiptId: "GvMd5FePSCVudKZ6wP1CtfM67Ks5ba9uSEvFt9cJXWD", receiver: "usdc.test.near" }], qorvex_action: "Qorvex paused the contract through the guardian at block 184." };
    const current = { contract: "ledger.test.near", triggerBlock: 171, evaluation: { owed: "290000000000", held: "250000000000", block: 172 }, receipts_in_breaking_block: [{ receiptId: "8nA43z8Qx4Cke7S8dvvBXoEDSEBoh9xAqHpnJYAYKAuc", receiver: "usdc.test.near" }], qorvex_action: "Qorvex paused the contract through the guardian at block 176." };
    const text = "Solvency breach: USDC owed (290k) exceeds held (250k) by 40k USDC.\nCheck receipt GvMd5FePSCVudKZ6wP1CtfM67Ks5ba9uSEvFt9cJXWD in block 180.\nQorvex paused the contract through the guardian at block 184.";
    const out = retargetExplanation(text, recorded, current);
    expect(out).toContain("receipt 8nA43z8Qx4Cke7S8dvvBXoEDSEBoh9xAqHpnJYAYKAuc in block 171");
    expect(out).toContain("at block 176.");
    expect(out).toContain("owed (290k) exceeds held (250k) by 40k");
    expect(retargetExplanation(text, recorded, recorded)).toBe(text);
  });
});
