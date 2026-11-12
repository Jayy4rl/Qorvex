/**
 * Deterministic rule evaluation. No AI anywhere in this file: the decision to
 * pause is made only by this code (trust model, A6).
 */
import crypto from "node:crypto";
import type { Evaluation, OutflowEvaluation, OutflowRateRule, Read, SolvencyEvaluation, SolvencyRule, ViewRef } from "@qorvex/shared";
import type { BlockRef, NearRpc } from "../near/rpc.ts";
import type { BlockEvent, StreamReceipt } from "../stream/types.ts";

export function extractAmount(value: unknown, path?: string): bigint {
  let v: unknown = value;
  if (path) for (const p of path.split(".")) v = v == null ? undefined : (v as Record<string, unknown>)[p];
  if (v === null || v === undefined) throw new Error(`value${path ? ` at ${path}` : ""} is null`);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error(`value${path ? ` at ${path}` : ""} is not a non-negative integer: ${JSON.stringify(v).slice(0, 80)}`);
}

export async function readAmount(rpc: NearRpc, ref: ViewRef, defaultContract: string, at: BlockRef, label: string): Promise<Read> {
  const contract = ref.contract ?? defaultContract;
  const args = ref.args ?? {};
  const r = await rpc.view(contract, ref.view, args, at);
  const amount = extractAmount(r.value, ref.path);
  return {
    id: crypto.randomUUID(),
    label,
    contract,
    view: ref.view,
    args,
    value: amount.toString(),
    blockHeight: r.blockHeight,
    raw: r.raw,
  };
}

export function marginBps(owed: bigint, held: bigint): number | null {
  if (held === 0n) return owed === 0n ? null : -10_000;
  return Number(((held - owed) * 10_000n) / held);
}

/**
 * Evaluate a solvency rule. Both reads are pinned to the same block so the
 * comparison is consistent across shards.
 */
export async function evaluateSolvency(rpc: NearRpc, rule: SolvencyRule, protectedContract: string, at: BlockRef): Promise<SolvencyEvaluation> {
  let ref = at;
  if (!("blockId" in ref)) {
    // Pin "latest" to one concrete block so owed and held are read together.
    const b = await rpc.block(ref);
    ref = { blockId: b.header.height };
  }
  const [owed, held] = await Promise.all([
    readAmount(rpc, rule.owed, protectedContract, ref, "owed"),
    readAmount(rpc, rule.held, protectedContract, ref, "held"),
  ]);
  const o = BigInt(owed.value);
  const h = BigInt(held.value);
  return {
    ruleId: rule.id,
    type: "solvency",
    ok: o <= h,
    blockHeight: owed.blockHeight,
    owed: owed.value,
    held: held.value,
    marginBps: marginBps(o, h),
    reads: [owed, held],
    at: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ outflow rate

export interface Outflow {
  receiptId: string;
  txHash?: string;
  blockHeight: number;
  timestampMs: number;
  from: string;
  token: string;
  amount: bigint;
  to?: string;
}

/** Rolling-window outflow tracker for one rule. */
export class OutflowWindow {
  private events: Outflow[] = [];
  constructor(public readonly rule: OutflowRateRule) {}

  add(o: Outflow): void {
    if (this.events.some((e) => e.receiptId === o.receiptId)) return;
    this.events.push(o);
  }

  evaluate(nowMs: number, blockHeight: number): OutflowEvaluation {
    const from = nowMs - this.rule.window_sec * 1000;
    this.events = this.events.filter((e) => e.timestampMs >= from);
    const total = this.events.reduce((a, e) => a + e.amount, 0n);
    return {
      ruleId: this.rule.id,
      type: "outflow_rate",
      ok: total <= BigInt(this.rule.max),
      blockHeight,
      total: total.toString(),
      max: this.rule.max,
      windowSec: this.rule.window_sec,
      count: this.events.length,
      receipts: this.events.map((e) => e.receiptId),
      at: new Date().toISOString(),
    };
  }
}

/** Outflows of `token` sent by `contract` in this block's receipts (failed receipts excluded). */
export function outflowsFrom(contract: string, token: string, b: BlockEvent, receipts: StreamReceipt[]): Outflow[] {
  const out: Outflow[] = [];
  for (const r of receipts) {
    if (r.predecessor !== contract || r.status === "failure") continue;
    for (const a of r.actions) {
      if (token === "near" && a.kind === "Transfer" && a.deposit && a.deposit !== "0") {
        out.push({ receiptId: r.receiptId, txHash: r.txHash, blockHeight: b.height, timestampMs: b.timestampMs, from: contract, token, amount: BigInt(a.deposit), to: r.receiver });
      }
      if (token !== "near" && r.receiver === token && a.kind === "FunctionCall" && (a.method === "ft_transfer" || a.method === "ft_transfer_call")) {
        const args = a.args as { amount?: string; receiver_id?: string } | undefined;
        if (args?.amount && /^\d+$/.test(args.amount)) {
          out.push({ receiptId: r.receiptId, txHash: r.txHash, blockHeight: b.height, timestampMs: b.timestampMs, from: contract, token, amount: BigInt(args.amount), to: args.receiver_id });
        }
      }
    }
  }
  return out;
}

/** Stable hash of the evidence behind a breach, recorded on-chain by the guardian. */
export function evidenceHash(ev: Evaluation): string {
  const canon = (e: Evaluation) =>
    e.type === "solvency"
      ? { r: e.ruleId, b: e.blockHeight, owed: e.owed, held: e.held }
      : e.type === "outflow_rate"
        ? { r: e.ruleId, b: e.blockHeight, total: e.total, max: e.max, receipts: e.receipts }
        : { r: e.ruleId, b: e.blockHeight, proposal: e.proposalId, kind: e.kind, violations: e.violations };
  return crypto.createHash("sha256").update(JSON.stringify(canon(ev))).digest("hex");
}
