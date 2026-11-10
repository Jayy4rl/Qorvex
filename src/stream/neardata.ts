/**
 * Block stream from FastNEAR's NEAR Data API (https://docs.fastnear.com/neardata),
 * an equivalent of NEAR Lake served over HTTP without AWS credentials.
 *
 * Each block document contains every shard's `receipt_execution_outcomes`,
 * i.e. the receipts executed in that block with their status and logs, which
 * is exactly what the watcher needs to evaluate "every receipt that touches a
 * protected contract in the block it lands in" (D1).
 *
 * Several heights are fetched concurrently so the stream keeps up with
 * mainnet (~0.6 s blocks) even when one block document takes ~2 s to fetch.
 */
import { sleep } from "../near/rpc.ts";
import { parseActions, type BlockEvent, type BlockSource, type StreamReceipt } from "./types.ts";

export function blockFromNeardata(doc: any, receivedAtMs: number, source: string): BlockEvent {
  const header = doc.block.header;
  const receipts: StreamReceipt[] = [];
  for (const shard of doc.shards ?? []) {
    for (const reo of shard.receipt_execution_outcomes ?? []) {
      const r = reo.receipt;
      const outcome = reo.execution_outcome?.outcome ?? {};
      const st = outcome.status ?? {};
      receipts.push({
        receiptId: r.receipt_id,
        predecessor: r.predecessor_id,
        receiver: r.receiver_id,
        txHash: reo.tx_hash ?? undefined,
        actions: parseActions(r.receipt?.Action?.actions ?? []),
        status: "Failure" in st ? "failure" : "SuccessValue" in st || "SuccessReceiptId" in st ? "success" : "unknown",
        logs: outcome.logs ?? [],
      });
    }
  }
  return {
    height: header.height,
    hash: header.hash,
    timestampMs: Math.floor(Number(header.timestamp_nanosec ?? header.timestamp) / 1e6),
    receipts,
    source,
    receivedAtMs,
  };
}

export class NeardataSource implements BlockSource {
  readonly name: string;
  private stopped = false;
  private headers: Record<string, string>;

  constructor(
    private readonly baseUrl: string,
    private readonly opts: { optimistic?: boolean; concurrency?: number; apiKey?: string; log?: (s: string) => void } = {},
  ) {
    this.name = `neardata:${new URL(baseUrl).host}${opts.optimistic ? ":optimistic" : ":final"}`;
    // Optional FastNEAR API key (higher limits): https://docs.fastnear.com/neardata
    this.headers = opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {};
  }

  stop(): void {
    this.stopped = true;
  }

  /** GET with backoff on 429/5xx (honours Retry-After). Returns null on 404 (height not produced yet / too far ahead). */
  private async get(path: string): Promise<string | null> {
    let delay = 500;
    while (!this.stopped) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, { redirect: "follow", headers: this.headers, signal: AbortSignal.timeout(30_000) });
      } catch {
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
        continue;
      }
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay;
        if (res.status === 429) this.opts.log?.(`neardata rate-limited; backing off ${Math.round(wait / 1000)} s (set FASTNEAR_API_KEY for higher limits)`);
        await sleep(wait);
        delay = Math.min(delay * 2, 30_000);
        continue;
      }
      if (!res.ok) throw new Error(`neardata ${path}: HTTP ${res.status}`);
      return await res.text();
    }
    return null;
  }

  private async head(): Promise<number> {
    const t = await this.get(`/v0/last_block/${this.opts.optimistic ? "optimistic" : "final"}`);
    if (!t) throw new Error("neardata: no head");
    return JSON.parse(t).block.header.height;
  }

  /** One height: the block document, null if the height was skipped, "ahead" if not produced yet. */
  private async fetchHeight(h: number): Promise<any | null | "ahead"> {
    const t = await this.get(`/v0/${this.opts.optimistic ? "block_opt" : "block"}/${h}`);
    if (t === null) return "ahead";
    if (t.trim() === "null") return null;
    return JSON.parse(t);
  }

  async run(onBlock: (b: BlockEvent) => Promise<void>, fromHeight?: number): Promise<void> {
    let next = fromHeight ?? (await this.head());
    let knownHead = next;
    const conc = this.opts.concurrency ?? 3;
    const inflight = new Map<number, Promise<any | null | "ahead">>();
    while (!this.stopped) {
      // Pipeline up to `conc` heights that are known to exist, plus the next one (long-polled).
      for (let h = next; h < next + conc && h <= knownHead + 1; h++) if (!inflight.has(h)) inflight.set(h, this.fetchHeight(h));
      const doc = await inflight.get(next)!;
      inflight.delete(next);
      if (doc === "ahead") {
        knownHead = await this.head().catch(() => knownHead);
        if (next > knownHead) await sleep(300);
        continue;
      }
      if (doc !== null) await onBlock(blockFromNeardata(doc, Date.now(), this.name));
      knownHead = Math.max(knownHead, next);
      next++;
    }
  }
}
