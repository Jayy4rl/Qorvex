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
import { NearRpc, sleep } from "../near/rpc.ts";
import { evaluateSolvency, OutflowWindow } from "../rules/evaluate.ts";
import type { OutflowRateRule, ProposalPolicyRule, Rule, SolvencyRule } from "../rules/types.ts";
import { evaluateProposal, type SputnikProposal } from "../firewall/policy.ts";
import type { BacktestResult } from "../store/store.ts";
import type { NetworkId } from "../config.ts";
import { outflowsFrom } from "../watcher/watcher.ts";
import { blockFromNeardata } from "../stream/neardata.ts";
import { parseActions, type BlockEvent } from "../stream/types.ts";

/** Wraps an RPC with an on-disk cache of view results by (contract, method, args, height). */
export class CachedArchive {
  private cache: Record<string, unknown>;
  constructor(
    public readonly rpc: NearRpc,
    private readonly file: string,
  ) {
    this.cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }
  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache));
  }
  /** An NearRpc-compatible object whose `view`/`block` hit the cache first. */
  asRpc(): NearRpc {
    const self = this;
    const proxy = Object.create(this.rpc) as NearRpc;
    proxy.view = async function (contract: string, method: string, args: unknown = {}, ref: any = { finality: "final" }) {
      if (!("blockId" in ref)) return self.rpc.view(contract, method, args, ref);
      const k = `${contract}|${method}|${JSON.stringify(args)}|${ref.blockId}`;
      if (k in self.cache) return self.cache[k] as any;
      const r = await self.rpc.view(contract, method, args, ref);
      self.cache[k] = r;
      self.save(); // persist every archival read: the public archival node is heavily rate-limited
      return r;
    } as NearRpc["view"];
    return proxy;
  }
}

export interface BacktestOptions {
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

export async function backtestSolvency(rule: SolvencyRule, protectedContract: string, o: BacktestOptions): Promise<BacktestResult> {
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

/** Fetch recent blocks as stream events (neardata where available, else RPC). */
export async function recentBlocks(o: { rpc: NearRpc; neardataUrl?: string; count: number }): Promise<BlockEvent[]> {
  const head = await o.rpc.block({ finality: "final" });
  const heights = Array.from({ length: o.count }, (_, i) => head.header.height - o.count + 1 + i).filter((h) => h > 0);
  const out: BlockEvent[] = [];
  const queue = [...heights];
  const worker = async () => {
    while (queue.length) {
      const h = queue.shift()!;
      try {
        if (o.neardataUrl) {
          const res = await fetch(`${o.neardataUrl}/v0/block/${h}`, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
          const t = await res.text();
          if (res.ok && t.trim() !== "null") out.push(blockFromNeardata(JSON.parse(t), Date.now(), "neardata"));
        } else {
          const b = await o.rpc.block({ blockId: h });
          const ev: BlockEvent = { height: h, hash: b.header.hash, timestampMs: Math.floor(Number(b.header.timestamp) / 1e6), receipts: [], source: "rpc", receivedAtMs: Date.now() };
          for (const c of b.chunks ?? []) {
            if (c.height_included !== h) continue;
            const ch = await o.rpc.chunk(c.chunk_hash).catch(() => null);
            for (const r of ch?.receipts ?? [])
              ev.receipts.push({ receiptId: r.receipt_id, predecessor: r.predecessor_id, receiver: r.receiver_id, actions: parseActions(r.receipt?.Action?.actions ?? []), status: "unknown", logs: [] });
          }
          out.push(ev);
        }
      } catch {
        /* skipped height */
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out.sort((a, b) => a.height - b.height);
}

export async function backtestOutflow(rule: OutflowRateRule, protectedContract: string, o: { network: NetworkId; rpc: NearRpc; neardataUrl?: string; blocks: number }): Promise<BacktestResult> {
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
export async function backtestProposals(rule: ProposalPolicyRule, dao: string, o: { network: NetworkId; rpc: NearRpc }): Promise<BacktestResult & { flagged: { id: number; summary: string; violations: string[] }[] }> {
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
