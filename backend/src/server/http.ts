/** HTTP helpers shared by the API route modules. */
import type http from "node:http";
import { bigintReplacer } from "../store/store.ts";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: unknown,
  ) {
    super(message);
  }
}

export const MAX_BODY = 2_000_000;
/** Cap on concurrent server-sent-event subscribers (each holds a socket open). */
export const MAX_SSE_CLIENTS = 500;

export async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** Headers on every response: no MIME sniffing, no referrer leaks, no framing (clickjacking). */
export const SECURITY_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

export function send(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data, bigintReplacer));
}

/** A request body object (not an array or a primitive). */
export function obj(x: unknown, what: string): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new HttpError(400, `${what} must be a JSON object`);
  return x as Record<string, unknown>;
}

/** A finite number from the body, clamped to [min, max]; `fallback` when absent. */
export function num(x: unknown, what: string, fallback: number, min: number, max: number): number {
  if (x === undefined || x === null) return fallback;
  const n = Number(x);
  if (!Number.isFinite(n)) throw new HttpError(400, `${what} must be a number`);
  return Math.min(max, Math.max(min, n));
}

export const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : undefined);

