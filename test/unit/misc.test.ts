import { describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { exportedFunctions } from "../../src/near/wasm.ts";
import { wasmPath } from "../../src/demo/deploy.ts";
import { blockFromNeardata } from "../../src/stream/neardata.ts";
import { WebhookChannel, breachMessage } from "../../src/alerts/alerts.ts";
import type { Breach } from "../../src/store/store.ts";

describe("wasm export parser", () => {
  it("lists the ledger's callable methods from the built wasm", () => {
    const names = exportedFunctions(fs.readFileSync(wasmPath("demo-ledger")));
    for (const m of ["ft_on_transfer", "withdraw", "pause", "unpause", "set_limits", "total_owed", "is_paused", "confirmed_deposits", "limits"]) expect(names).toContain(m);
  });
  it("lists the guardian's methods", () => {
    const names = exportedFunctions(fs.readFileSync(wasmPath("guardian")));
    for (const m of ["pause", "set_watchers", "pause_history", "register_target", "allow_repeat_pause"]) expect(names).toContain(m);
    expect(names).not.toContain("unpause");
  });
});

describe("neardata block parsing", () => {
  it("extracts receipts, actions, status and logs", () => {
    const args = Buffer.from(JSON.stringify({ receiver_id: "bob.near", amount: "5" })).toString("base64");
    const doc = {
      block: { header: { height: 10, hash: "H", timestamp_nanosec: "1700000000000000000" } },
      shards: [
        {
          receipt_execution_outcomes: [
            {
              tx_hash: "T",
              receipt: { receipt_id: "R", predecessor_id: "ledger.near", receiver_id: "usdc.near", receipt: { Action: { actions: [{ FunctionCall: { method_name: "ft_transfer", args, deposit: "1", gas: 1 } }] } } },
              execution_outcome: { outcome: { status: { SuccessValue: "" }, logs: ["EVENT_JSON:{}"] } },
            },
            {
              receipt: { receipt_id: "R2", predecessor_id: "a.near", receiver_id: "b.near", receipt: { Action: { actions: [{ Transfer: { deposit: "7" } }] } } },
              execution_outcome: { outcome: { status: { Failure: {} }, logs: [] } },
            },
          ],
        },
      ],
    };
    const b = blockFromNeardata(doc, 1, "test");
    expect(b.height).toBe(10);
    expect(b.timestampMs).toBe(1_700_000_000_000);
    expect(b.receipts[0]).toMatchObject({ receiptId: "R", txHash: "T", status: "success", actions: [{ kind: "FunctionCall", method: "ft_transfer", args: { amount: "5" } }] });
    expect(b.receipts[1]).toMatchObject({ status: "failure", actions: [{ kind: "Transfer", deposit: "7" }] });
  });
});

describe("alerts", () => {
  const breach = {
    id: "b",
    protocolId: "p",
    ruleId: "solvency-usdc",
    rule: { id: "solvency-usdc", type: "solvency", token: "usdc.near", explain: "USDC owed must never exceed USDC held" },
    detectedAtBlock: 101,
    triggerBlock: 100,
    triggerReceipts: [{ receiptId: "r", txHash: "TX1", predecessor: "a", receiver: "b" }],
    evaluation: { type: "solvency", owed: "2", held: "1" },
    evidenceHash: "e",
    detectedAt: "",
    response: "pause",
    pause: { status: "landed", pausedAtBlock: 103, blocksAfterBreach: 3, txHash: "PTX" },
    alerts: [],
  } as unknown as Breach;

  it("reports a contained incident", () => {
    const m = breachMessage(breach, "http://x/status/p");
    expect(m.subject).toMatch(/^CONTAINED/);
    expect(m.text).toContain("paused at block 103 (3 blocks later)");
    expect(m.text).toContain("TX1");
  });

  it("signs webhook bodies with HMAC-SHA256", async () => {
    let got: { sig?: string; body?: string } = {};
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      got = { sig: req.headers["x-qorvex-signature"] as string, body: raw };
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, r));
    await new WebhookChannel(`http://127.0.0.1:${(server.address() as any).port}`, "s3cret").send("subj", "text", { a: 1 });
    server.close();
    expect(got.sig).toBe(`sha256=${crypto.createHmac("sha256", "s3cret").update(got.body!).digest("hex")}`);
    expect(JSON.parse(got.body!).payload).toEqual({ a: 1 });
  });
});
