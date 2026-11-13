/** Display helpers: token amounts in plain units, block-relative times, short hashes. */
import type { TokenMeta } from "@qorvex/shared";

/** "250000000000" with 6 decimals -> "250,000". Falls back to the raw integer when decimals are unknown. */
export function amount(raw: string | undefined | null, meta?: Pick<TokenMeta, "decimals" | "symbol"> | { decimals?: number; symbol?: string }): string {
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return String(raw ?? "—");
  const dec = meta?.decimals;
  if (dec === undefined) return BigInt(raw).toLocaleString("en-US");
  const v = BigInt(raw);
  const base = 10n ** BigInt(dec);
  const whole = (v / base).toLocaleString("en-US");
  const frac = (v % base).toString().padStart(dec, "0").slice(0, 2).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}${meta?.symbol ? ` ${meta.symbol}` : ""}`;
}

export const NEAR_META = { decimals: 24, symbol: "NEAR" };

export function pct(bps: number | null | undefined): string {
  return bps === null || bps === undefined ? "—" : `${(bps / 100).toFixed(2)}%`;
}

export function ago(iso: string | number | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - (typeof iso === "number" ? iso : Date.parse(iso));
  if (ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export const short = (s: string | undefined, n = 10) => (!s ? "—" : s.length > n + 3 ? `${s.slice(0, n)}…` : s);

export function explorerTx(network: string, hash: string): string | null {
  if (network === "mainnet") return `https://nearblocks.io/txns/${hash}`;
  if (network === "testnet") return `https://testnet.nearblocks.io/txns/${hash}`;
  return null;
}

const YOCTO = 10n ** 24n;

/** "1.5" NEAR -> yoctoNEAR string. Throws on anything that is not a plain non-negative amount. */
export function nearToYocto(near: string): string {
  const m = /^(\d{1,12})(?:\.(\d{1,24}))?$/.exec(near.trim());
  if (!m) throw new Error(`"${near}" is not a NEAR amount`);
  return (BigInt(m[1]) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0") || "0")).toString();
}

/** yoctoNEAR string -> "1.5" (up to 5 decimals). */
export function yoctoToNear(yocto: string | undefined): string {
  if (!yocto || !/^\d+$/.test(yocto)) return "";
  const v = BigInt(yocto);
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 5).replace(/0+$/, "");
  return `${v / YOCTO}${frac ? `.${frac}` : ""}`;
}
