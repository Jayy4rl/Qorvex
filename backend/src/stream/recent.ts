/**
 * The most recent blocks as stream events, fetched in one go (not streamed):
 * context for AI rule drafting and the data for outflow-rate backtests.
 */
import type { NearRpc } from "../near/rpc.ts";
import { blockFromNeardata } from "./neardata.ts";
import { blockEventFromRpc } from "./rpc-follow.ts";
import type { BlockEvent } from "./types.ts";

/** Fetch the last `count` final blocks (neardata where available, else RPC block + chunk reads). Skipped heights are omitted. */
export async function recentBlocks(o: { rpc: NearRpc; neardataUrl?: string; count: number; concurrency?: number }): Promise<BlockEvent[]> {
  const head = await o.rpc.block({ finality: "final" });
  const heights = Array.from({ length: o.count }, (_, i) => head.header.height - o.count + 1 + i).filter((h) => h > 0);
  const out: BlockEvent[] = [];
  const fetchOne = async (h: number): Promise<BlockEvent | null> => {
    if (o.neardataUrl) {
      const res = await fetch(`${o.neardataUrl}/v0/block/${h}`, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
      const t = await res.text();
      return res.ok && t.trim() !== "null" ? blockFromNeardata(JSON.parse(t), Date.now(), "neardata") : null;
    }
    return blockEventFromRpc(o.rpc, await o.rpc.block({ blockId: h }), "rpc", { includeTransactions: false });
  };
  const queue = [...heights];
  const worker = async () => {
    for (let h = queue.shift(); h !== undefined; h = queue.shift()) {
      const b = await fetchOne(h).catch(() => null); // skipped or unavailable height
      if (b) out.push(b);
    }
  };
  await Promise.all(Array.from({ length: o.concurrency ?? 6 }, worker));
  return out.sort((a, b) => a.height - b.height);
}
