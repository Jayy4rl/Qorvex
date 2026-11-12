/**
 * Block stream that follows the chain head over plain JSON-RPC (`block` and
 * `chunk`). Used for the local sandbox, which has no NEAR Data API. Every
 * height is processed in order; receipts and transactions of every chunk are
 * reported (execution status is not known from a chunk view, so it is
 * "unknown"; the watcher's rules re-read state over RPC anyway).
 */
import { sleep, type NearRpc } from "../near/rpc.ts";
import { parseActions, type BlockEvent, type BlockSource, type StreamReceipt } from "./types.ts";

/**
 * Turn an RPC `block` result into a stream event by reading its new chunks.
 * Chunk receipts are always included; with `includeTransactions`, each
 * transaction in the chunk is reported too, as a pseudo-receipt `tx:<hash>`
 * from its signer (so a watcher sees a call in the block it was submitted).
 */
export async function blockEventFromRpc(rpc: NearRpc, block: any, source: string, { includeTransactions = true } = {}): Promise<BlockEvent> {
  const height: number = block.header.height;
  const chunks = await Promise.all(
    (block.chunks ?? []).filter((c: any) => c.height_included === height).map((c: any) => rpc.chunk(c.chunk_hash).catch(() => null)),
  );
  const receipts: StreamReceipt[] = [];
  for (const ch of chunks) {
    if (!ch) continue;
    for (const r of ch.receipts ?? []) {
      receipts.push({ receiptId: r.receipt_id, predecessor: r.predecessor_id, receiver: r.receiver_id, actions: parseActions(r.receipt?.Action?.actions ?? []), status: "unknown", logs: [] });
    }
    if (!includeTransactions) continue;
    for (const t of ch.transactions ?? []) {
      receipts.push({ receiptId: `tx:${t.hash}`, predecessor: t.signer_id, receiver: t.receiver_id, txHash: t.hash, actions: parseActions(t.actions ?? []), status: "unknown", logs: [] });
    }
  }
  return {
    height,
    hash: block.header.hash,
    timestampMs: Math.floor(Number(block.header.timestamp_nanosec ?? block.header.timestamp) / 1e6),
    receipts,
    source,
    receivedAtMs: Date.now(),
  };
}

export class RpcFollowSource implements BlockSource {
  readonly name: string;
  private stopped = false;

  constructor(
    private readonly rpc: NearRpc,
    private readonly opts: { pollMs?: number; finality?: "optimistic" | "final" } = {},
  ) {
    this.name = `rpc-follow:${rpc.urls[0]}`;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(onBlock: (b: BlockEvent) => Promise<void>, fromHeight?: number): Promise<void> {
    const finality = this.opts.finality ?? "optimistic";
    let next = fromHeight;
    while (!this.stopped) {
      let head: any;
      try {
        head = await this.rpc.block({ finality });
      } catch {
        await sleep(300);
        continue;
      }
      const headHeight: number = head.header.height;
      if (next === undefined) next = headHeight;
      while (next <= headHeight && !this.stopped) {
        let b: any;
        try {
          b = next === headHeight ? head : await this.rpc.block({ blockId: next });
        } catch (e) {
          // Height skipped (no block produced) or not available: move on.
          if (/UNKNOWN_BLOCK|DB Not Found|not found/i.test(String((e as Error).message))) {
            next++;
            continue;
          }
          await sleep(200);
          continue;
        }
        await onBlock(await blockEventFromRpc(this.rpc, b, this.name));
        next++;
      }
      await sleep(this.opts.pollMs ?? 150);
    }
  }
}
