/**
 * Minimal NEAR JSON-RPC client.
 *
 * Every view call returns the exact request body, the raw response and the
 * provider it came from, so the status page can show (and anyone can replay
 * with curl) the read behind every number (S2).
 *
 * nearcore does not support JSON-RPC batches (docs.near.org/api/rpc/providers),
 * so each request is a single POST.
 */

export type BlockRef = { blockId: number | string } | { finality: "optimistic" | "near-final" | "final" };

export interface RawRead {
  provider: string;
  request: unknown;
  response: unknown;
  /** Ready-to-paste command that reproduces the read. */
  curl: string;
}

export interface ViewResult<T = unknown> {
  value: T;
  blockHeight: number;
  blockHash: string;
  raw: RawRead;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly data?: unknown,
    public readonly kind?: string,
  ) {
    super(message);
  }
}

let idCounter = 0;

function blockParams(ref: BlockRef): Record<string, unknown> {
  return "blockId" in ref ? { block_id: ref.blockId } : { finality: ref.finality };
}

export function curlFor(url: string, body: unknown): string {
  return `curl -s -X POST ${url} -H 'Content-Type: application/json' -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
}

export interface RpcOptions {
  timeoutMs?: number;
  /** Retries per provider on 429/5xx/network errors (with backoff). */
  retries?: number;
  backoffMs?: number;
}

export class NearRpc {
  constructor(
    public readonly urls: string[],
    private readonly opts: RpcOptions = {},
  ) {
    if (urls.length === 0) throw new Error("NearRpc needs at least one URL");
  }

  /** Call one provider. Throws RpcError on transport or RPC errors. */
  async callAt(url: string, method: string, params: unknown): Promise<{ result: any; request: unknown; response: unknown }> {
    const request = { jsonrpc: "2.0", id: `q${++idCounter}`, method, params };
    const retries = this.opts.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new RpcError(`HTTP ${res.status}`, url, await res.text().catch(() => ""), "HTTP");
          await sleep((this.opts.backoffMs ?? 500) * 2 ** attempt);
          continue;
        }
        const response = (await res.json()) as any;
        if (response.error) {
          const cause = response.error.cause?.name ?? response.error.name;
          throw new RpcError(
            `${method}: ${response.error.message ?? "error"} ${cause ? `(${cause})` : ""} ${JSON.stringify(response.error.data ?? "")}`.trim(),
            url,
            response.error,
            cause,
          );
        }
        // Function-call errors come back inside result.error for `query`.
        if (response.result && typeof response.result === "object" && "error" in response.result && method === "query") {
          throw new RpcError(`${method}: ${response.result.error}`, url, response.result, "QUERY_ERROR");
        }
        return { result: response.result, request, response };
      } catch (e) {
        if (e instanceof RpcError && e.kind !== "HTTP") throw e;
        lastErr = e;
        if (attempt < retries) await sleep((this.opts.backoffMs ?? 500) * 2 ** attempt);
      }
    }
    throw lastErr instanceof RpcError ? lastErr : new RpcError(String((lastErr as Error)?.message ?? lastErr), url, undefined, "NETWORK");
  }

  /** Call providers in order until one answers (deterministic RPC errors are not retried elsewhere). */
  async call(method: string, params: unknown): Promise<{ result: any; request: unknown; response: unknown; provider: string }> {
    let lastErr: unknown;
    for (const url of this.urls) {
      try {
        const r = await this.callAt(url, method, params);
        return { ...r, provider: url };
      } catch (e) {
        lastErr = e;
        if (e instanceof RpcError && (e.kind === "QUERY_ERROR" || e.kind === "UNKNOWN_ACCOUNT" || e.kind === "INVALID_ACCOUNT")) throw e;
      }
    }
    throw lastErr;
  }

  /** View call returning parsed JSON plus the raw request/response. */
  async view<T = unknown>(contract: string, method: string, args: unknown = {}, ref: BlockRef = { finality: "final" }): Promise<ViewResult<T>> {
    const params = {
      request_type: "call_function",
      ...blockParams(ref),
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args ?? {})).toString("base64"),
    };
    const { result, request, response, provider } = await this.call("query", params);
    const text = Buffer.from(result.result as number[]).toString("utf8");
    let value: T;
    try {
      value = text.length ? JSON.parse(text) : (undefined as T);
    } catch {
      throw new RpcError(`${contract}.${method} returned non-JSON: ${text.slice(0, 120)}`, provider, text, "NON_JSON");
    }
    return {
      value,
      blockHeight: result.block_height,
      blockHash: result.block_hash,
      raw: { provider, request, response, curl: curlFor(provider, request) },
    };
  }

  /** View call returning the raw result bytes (e.g. the zstd ABI from `__contract_abi`). */
  async viewRaw(contract: string, method: string, args: unknown = {}, ref: BlockRef = { finality: "final" }): Promise<Uint8Array> {
    const { result } = await this.call("query", {
      request_type: "call_function",
      ...blockParams(ref),
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args ?? {})).toString("base64"),
    });
    return Uint8Array.from(result.result as number[]);
  }

  async block(ref: BlockRef): Promise<any> {
    return (await this.call("block", blockParams(ref))).result;
  }

  async chunk(chunkId: string): Promise<any> {
    return (await this.call("chunk", { chunk_id: chunkId })).result;
  }

  async viewAccount(accountId: string, ref: BlockRef = { finality: "final" }): Promise<any> {
    return (await this.call("query", { request_type: "view_account", ...blockParams(ref), account_id: accountId })).result;
  }

  async viewAccessKey(accountId: string, publicKey: string, ref: BlockRef = { finality: "final" }): Promise<{ result: any; raw: RawRead }> {
    const r = await this.call("query", { request_type: "view_access_key", ...blockParams(ref), account_id: accountId, public_key: publicKey });
    return { result: r.result, raw: { provider: r.provider, request: r.request, response: r.response, curl: curlFor(r.provider, r.request) } };
  }

  async viewCode(accountId: string): Promise<Uint8Array> {
    const r = await this.call("query", { request_type: "view_code", finality: "final", account_id: accountId });
    return Buffer.from(r.result.code_base64, "base64");
  }

  async txStatus(hash: string, senderId: string, waitUntil = "EXECUTED"): Promise<any> {
    return (await this.call("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: senderId, wait_until: waitUntil })).result;
  }

  /**
   * Broadcast one signed transaction to every provider at once and return as
   * soon as the first one accepts it. The same signed bytes have the same
   * hash everywhere, so duplicates are harmless.
   */
  async broadcastToAll(signedTxBase64: string, waitUntil = "INCLUDED"): Promise<{ provider: string; result: any; errors: string[] }> {
    const errors: string[] = [];
    return await new Promise((resolve, reject) => {
      let pending = this.urls.length;
      for (const url of this.urls) {
        this.callAt(url, "send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil })
          .then((r) => resolve({ provider: url, result: r.result, errors }))
          .catch((e) => {
            errors.push(`${url}: ${(e as Error).message}`);
            if (--pending === 0) reject(new Error(`all providers rejected the transaction: ${errors.join("; ")}`));
          });
      }
    });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
