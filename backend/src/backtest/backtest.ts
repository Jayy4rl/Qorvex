/**
 * Backtests (A5, operator flow step 2).
 *
 * Solvency rules are re-evaluated on historical state at evenly spaced block
 * heights over the last N days, using an archival RPC (regular RPC nodes
 * garbage-collect state after ~2.5 epochs). Archival endpoints are heavily
 * rate-limited, so reads are cached on disk and retried with backoff.
 *
 * This is a sampled backtest: it proves the rule would not have fired at the
 * sampled heights, not at every block. The result records the method and the
 * number of samples so the UI never overstates it.
 *
 * Outflow-rate rules are backtested over the most recent blocks of the
 * stream (receipts are not available from archival state reads).
 */
import fs from "node:fs";
import path from "node:path";
import type { BacktestResult, NetworkId, OutflowRateRule, ProposalPolicyRule, Rule, SolvencyRule } from "@qorvex/shared";
import { sleep, type BlockRef, type NearRpc, type ViewResult } from "../near/rpc.ts";
import { evaluateSolvency, OutflowWindow, outflowsFrom } from "../rules/evaluate.ts";
import { evaluateProposal, type SputnikProposal } from "../firewall/policy.ts";
import { recentBlocks } from "../stream/recent.ts";

/**
 * Wraps an RPC with an on-disk cache of view results by (contract, method,
 * args, height). Archival reads are slow and rate-limited, so the cache is
 * persisted at most once a second while reads arrive (and on `save()`), which
 * lets an interrupted backtest resume where it stopped.
 */
export class CachedArchive {
  private cache: Record<string, ViewResult>;
  private saveTimer: NodeJS.Timeout | null = null;
  constructor(
    public readonly rpc: NearRpc,
    private readonly file: string,
  ) {
    this.cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }
  save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache));
  }
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), 1000);
    this.saveTimer.unref();
  }
  /** A NearRpc-compatible object whose `view` at a fixed height hits the cache first. */
  asRpc(): NearRpc {
    const proxy = Object.create(this.rpc) as NearRpc;
    proxy.view = (async (contract: string, method: string, args: unknown = {}, ref: BlockRef = { finality: "final" }) => {
      if (!("blockId" in ref)) return this.rpc.view(contract, method, args, ref);
      const k = `${contract}|${method}|${JSON.stringify(args)}|${ref.blockId}`;
      if (k in this.cache) return this.cache[k];
      const r = await this.rpc.view(contract, method, args, ref);
      this.cache[k] = r;
      this.saveSoon();
      return r;
    }) as NearRpc["view"];
    return proxy;
  }
}

interface BacktestOptions {
  network: NetworkId;
  /** Live RPC (for the head height) and archival RPC (for history). */
  rpc: NearRpc;
  archive: CachedArchive;
  days: number;
  samples: number;
  /** Block time estimate in seconds (mainnet ~0.6). Measured from chain if omitted. */
  secondsPerBlock?: number;
  /** Lowest height to sample (e.g. the contract's deployment block). */
  minHeight?: number;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

async function measureSecondsPerBlock(rpc: NearRpc): Promise<number> {
  const head = await rpc.block({ finality: "final" });
  const span = Math.min(10_000, head.header.height - 1);
  const old = await rpc.block({ blockId: head.header.height - span }).catch(() => null);
  if (!old) return 1;
  return (Number(head.header.timestamp) - Number(old.header.timestamp)) / 1e9 / span;
}

async function backtestSolvency(rule: SolvencyRule, protectedContract: string, o: BacktestOptions): Promise<BacktestResult> {
  const head = await o.rpc.block({ finality: "final" });
  const headHeight: number = head.header.height;
  const spb = o.secondsPerBlock ?? (await measureSecondsPerBlock(o.rpc));
  const span = Math.floor((o.days * 86400) / Math.max(spb, 0.1));
  const from = Math.max(o.minHeight ?? 1, headHeight - span);
  const n = Math.max(2, o.samples);
  // Samples are absolute multiples of a rounded step, so reruns and resumed runs
  // (after archival rate limiting) hit the same heights and therefore the cache.
  const rawStep = Math.max(1, Math.floor((headHeight - from) / (n - 1)));
  const unit = rawStep >= 10_000 ? 10_000 : rawStep >= 100 ? 100 : 1;
  const step = Math.max(unit, Math.round(rawStep / unit) * unit);
  const heights: number[] = [];
  for (let h = Math.ceil(from / step) * step; h <= headHeight; h += step) heights.push(h);
  if (heights.length < 2) heights.push(headHeight);
  const rpc = o.archive.asRpc();
  let fires = 0;
  let errors = 0;
  const firedAt: number[] = [];
  let minMargin: number | null = null;
  let done = 0;
  const conc = o.concurrency ?? 2;
  const queue = [...heights];
  const worker = async () => {
    while (queue.length) {
      const h = queue.shift()!;
      try {
        const ev = await evaluateSolvency(rpc, rule, protectedContract, { blockId: h });
        if (!ev.ok) {
          fires++;
          firedAt.push(h);
        }
        if (ev.marginBps !== null) minMargin = minMargin === null ? ev.marginBps : Math.min(minMargin, ev.marginBps);
      } catch (e) {
        // Blocks that were skipped, or heights before the contract existed, count as errors.
        errors++;
        if (/429|HTTP/.test(String((e as Error).message))) await sleep(2000);
      }
      done++;
      o.onProgress?.(done, heights.length);
      if (done % 10 === 0) o.archive.save();
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  o.archive.save();
  return {
    ruleId: rule.id,
    network: o.network,
    fromBlock: from,
    toBlock: headHeight,
    days: Math.round(((headHeight - from) * spb) / 864) / 100,
    samples: heights.length,
    fires,
    firedAt: firedAt.sort((a, b) => a - b),
    errors,
    minMarginBps: minMargin,
    method: `sampled ${heights.length} block heights evenly over ${o.days} days via archival RPC (${o.archive.rpc.urls[0]}), both reads pinned to each height`,
    at: new Date().toISOString(),
  };
}

async function backtestOutflow(rule: OutflowRateRule, protectedContract: string, o: { network: NetworkId; rpc: NearRpc; neardataUrl?: string; blocks: number }): Promise<BacktestResult> {
  const blocks = await recentBlocks({ rpc: o.rpc, neardataUrl: o.neardataUrl, count: o.blocks });
  const w = new OutflowWindow(rule);
  let fires = 0;
  const firedAt: number[] = [];
  for (const b of blocks) {
    for (const x of outflowsFrom(protectedContract, rule.token, b, b.receipts)) w.add(x);
    const ev = w.evaluate(b.timestampMs, b.height);
    if (!ev.ok) {
      fires++;
      firedAt.push(b.height);
    }
  }
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  return {
    ruleId: rule.id,
    network: o.network,
    fromBlock: first?.height ?? 0,
    toBlock: last?.height ?? 0,
    days: first && last ? Math.round((last.timestampMs - first.timestampMs) / 864e3) / 100 : 0,
    samples: blocks.length,
    fires,
    firedAt,
    errors: o.blocks - blocks.length,
    minMarginBps: null,
    method: `replayed receipts of the last ${blocks.length} blocks through the rolling window`,
    at: new Date().toISOString(),
  };
}

/**
 * Proposal policies are backtested against every proposal the DAO has ever
 * received (proposals stay in contract state, so no archival node is needed).
 * "fires" = proposals the policy would have flagged; their ids are in firedAt.
 */
async function backtestProposals(rule: ProposalPolicyRule, dao: string, o: { network: NetworkId; rpc: NearRpc }): Promise<BacktestResult & { flagged: { id: number; summary: string; violations: string[] }[] }> {
  const head = await o.rpc.block({ finality: "final" });
  const last = (await o.rpc.view<number>(dao, "get_last_proposal_id", {}, { blockId: head.header.height })).value;
  const flagged: { id: number; summary: string; violations: string[] }[] = [];
  let count = 0;
  for (let from = 0; from < last; from += 100) {
    const page = (await o.rpc.view<SputnikProposal[]>(dao, "get_proposals", { from_index: from, limit: 100 }, { blockId: head.header.height })).value;
    for (const prop of page) {
      count++;
      const ev = evaluateProposal(rule, prop, head.header.height);
      if (!ev.ok) flagged.push({ id: prop.id, summary: ev.summary, violations: ev.violations });
    }
  }
  return {
    ruleId: rule.id,
    network: o.network,
    fromBlock: head.header.height,
    toBlock: head.header.height,
    days: 0,
    samples: count,
    fires: flagged.length,
    firedAt: flagged.map((f) => f.id),
    errors: 0,
    minMarginBps: null,
    method: `evaluated all ${count} proposals ever submitted to ${dao} (read at block ${head.header.height}); fires = proposals the policy would have flagged`,
    at: new Date().toISOString(),
    flagged,
  };
}

export async function backtestRule(rule: Rule, protectedContract: string, o: BacktestOptions & { neardataUrl?: string; outflowBlocks?: number }): Promise<BacktestResult> {
  if (rule.type === "solvency") return backtestSolvency(rule, protectedContract, o);
  if (rule.type === "proposal_policy") return backtestProposals(rule, protectedContract, { network: o.network, rpc: o.rpc });
  return backtestOutflow(rule, protectedContract, { network: o.network, rpc: o.rpc, neardataUrl: o.neardataUrl, blocks: o.outflowBlocks ?? 300 });
}
