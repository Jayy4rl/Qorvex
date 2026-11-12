/**
 * NEP-141 token metadata and amount formatting.
 */
import type { TokenMeta } from "@qorvex/shared";
import type { NearRpc } from "./rpc.ts";

/** Format smallest units with decimals, e.g. 500000000000 / 6 -> "500,000". */
export function humanAmount(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString("en-US");
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
}

/** Symbol and decimals from `ft_metadata`; empty when the contract is not a NEP-141 token. */
export async function tokenMeta(rpc: NearRpc, contract: string): Promise<TokenMeta> {
  try {
    const m = (await rpc.view<{ symbol?: unknown; decimals?: unknown }>(contract, "ft_metadata", {})).value;
    return { symbol: typeof m?.symbol === "string" ? m.symbol : undefined, decimals: typeof m?.decimals === "number" ? m.decimals : undefined };
  } catch {
    return {};
  }
}

// Token metadata practically never changes, so it is cached for the life of the process.
const metaCache = new Map<string, Promise<TokenMeta>>();

/** `tokenMeta`, cached per RPC provider set and token. Concurrent callers share one read. */
export function cachedTokenMeta(rpc: NearRpc, contract: string): Promise<TokenMeta> {
  const key = `${rpc.urls.join(",")}|${contract}`;
  let m = metaCache.get(key);
  if (!m) metaCache.set(key, (m = tokenMeta(rpc, contract)));
  return m;
}
