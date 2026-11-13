/**
 * Evidence helpers for the public status page.
 *
 * - `Verdict`: the five states a check can be in. Only "confirmed" and
 *   "failed" rest on a fresh on-chain read; nothing else is ever shown as if
 *   it were detected.
 * - `redactUrl` / `redactText`: provider URLs are shown so anyone can repeat a
 *   read, but credentials (user info, query strings, long key-like path
 *   segments) are never displayed.
 * - `browserView`: a read-only view call made by the visitor's browser
 *   straight to a public NEAR RPC, independent of the Qorvex server.
 */
import type { NetworkId } from "@qorvex/shared";

export type Verdict = "confirmed" | "failed" | "absent" | "unavailable" | "unknown";

export const VERDICT_LABEL: Record<Verdict, string> = {
  confirmed: "Confirmed",
  failed: "Failed",
  absent: "Absent",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

export const VERDICT_HELP: Record<Verdict, string> = {
  confirmed: "a recent on-chain read shows it holds",
  failed: "a recent on-chain read shows it is broken",
  absent: "a read shows it is not set up",
  unavailable: "the read could not be made, so nothing is claimed",
  unknown: "no recent evidence either way",
};

export const VERDICT_CLASS: Record<Verdict, string> = {
  confirmed: "pill-lime",
  failed: "pill-bad",
  absent: "",
  unavailable: "pill-warn",
  unknown: "pill-dashed",
};

/** Evaluations older than this no longer count as current evidence. */
export const STALE_EVALUATION_MS = 15 * 60_000;
/** A watcher that has not reported a block for this long may be behind. */
export const STALE_WATCHER_MS = 5 * 60_000;

/** A URL safe to display: no user info, no query string, key-like path segments hidden. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .split("/")
      .map((seg) => (seg.length >= 20 && /[a-z]/i.test(seg) && /\d/.test(seg) ? "[hidden]" : seg))
      .join("/");
    return `${u.protocol}//${u.host}${path === "/" ? "" : path}${u.search ? "?[hidden]" : ""}`;
  } catch {
    return "[hidden]";
  }
}

/** Replace every URL inside a text (e.g. a curl command) with its redacted form. */
export function redactText(text: string): string {
  return text.replace(/https?:\/\/[^\s'"]+/g, (m) => redactUrl(m));
}

const PUBLIC_RPC: Partial<Record<NetworkId, string>> = {
  mainnet: "https://free.rpc.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
};

export type BrowserRead =
  | { ok: true; value: unknown; blockHeight: number; provider: string; curl: string; response: unknown }
  | { ok: false; reason: "no-public-rpc" | "unreachable" | "error"; provider?: string; curl?: string; detail?: string };

/** A view call from the visitor's browser to a public RPC (no Qorvex server involved). */
export async function browserView(network: NetworkId, contract: string, method: string, args: Record<string, unknown>): Promise<BrowserRead> {
  const provider = PUBLIC_RPC[network];
  if (!provider) return { ok: false, reason: "no-public-rpc" };
  const body = {
    jsonrpc: "2.0",
    id: "status-page",
    method: "query",
    params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  };
  const curl = `curl -s -X POST ${provider} -H 'Content-Type: application/json' -d '${JSON.stringify(body)}'`;
  let json: any;
  try {
    const res = await fetch(provider, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    json = await res.json();
  } catch (e) {
    return { ok: false, reason: "unreachable", provider, curl, detail: String((e as Error)?.message ?? e) };
  }
  const r = json?.result;
  if (!r || r.error || !Array.isArray(r.result)) return { ok: false, reason: "error", provider, curl, detail: JSON.stringify(json?.error ?? r?.error ?? json).slice(0, 300) };
  const text = new TextDecoder().decode(Uint8Array.from(r.result as number[]));
  let value: unknown = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = text;
  }
  return { ok: true, value, blockHeight: r.block_height, provider, curl, response: json };
}
