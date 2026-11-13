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


/**
 * Machine-readable error codes. The `error` text is written for API users and
 * logs; the web app shows its own plain-language sentence per code
 * (frontend/src/lib/errors.ts), so server wording never reaches end users raw.
 */
const CODES: [RegExp, string][] = [
  [/^network must be|network is required/, "INVALID_NETWORK"],
  [/must be a NEAR account id/, "INVALID_ACCOUNT"],
  [/needs verified on-chain authority/, "NEEDS_CLAIM"],
  [/^too many checks/, "RATE_LIMITED"],
  [/no published status page/, "STATUS_NOT_FOUND"],
  [/sign in with a user account|created by a signed-in user/, "USER_ACCOUNT_REQUIRED"],
  [/^name must be 2-60/, "WORKSPACE_NAME"],
  [/none of your NEAR accounts controls/, "NOT_CONTROLLER"],
  [/no guardian (is )?configured/, "NO_GUARDIAN"],
  [/failed validation|rule is invalid/, "RULE_INVALID"],
  [/^name and at least one scope/, "APIKEY_INVALID"],
  [/is not enabled on this server/, "NETWORK_UNAVAILABLE"],
  [/needs a fresh wallet signature/, "STEP_UP_REQUIRED"],
  [/^cannot read /, "CONTRACT_UNREADABLE"],
  [/has no contract deployed/, "NO_CONTRACT"],
  [/^files: \[/, "SOURCE_EMPTY"],
  [/no recorded NEAR AI response|fixture/i, "AI_NOT_RECORDED"],
  [/a rule with this id exists/, "RULE_EXISTS"],
  [/unofficial\) protocols can only/, "READONLY_PAGE"],
  [/can reject proposals|rules reject proposals/, "WRONG_RESPONSE"],
  [/run the backtest before approving/, "BACKTEST_REQUIRED"],
  [/fired \d+ times in its backtest/, "BACKTEST_FIRED"],
  [/only solvency rules have a live value/, "NO_LIVE_VALUE"],
  [/demo signing exists only|no demo world loaded/, "DEMO_ONLY"],
  [/proposal firewall is for Sputnik DAOs/, "NOT_A_DAO"],
  [/no firewall account configured/, "NO_FIREWALL"],
  [/another workspace holds the verified/, "CLAIMED_ELSEWHERE"],
  [/budgets|proposalPolicy/, "BUDGET_INVALID"],
  [/^cross-site request refused/, "CROSS_SITE"],
  [/choose or create a workspace/, "NO_WORKSPACE"],
  [/your role in this workspace cannot/, "ROLE_FORBIDDEN"],
  [/^sign in|^token rejected/, "SIGN_IN_REQUIRED"],
  [/sign-in is not configured/, "AUTH_UNAVAILABLE"],
  [/relayer token required/, "RELAYER_TOKEN"],
  [/live-event subscribers/, "BUSY"],
  [/body too large/, "TOO_LARGE"],
  [/invalid JSON body|must be a JSON object/, "BAD_REQUEST"],
];

export function errorCode(e: HttpError): string {
  const fromExtra = (e.extra as { code?: unknown } | undefined)?.code;
  if (typeof fromExtra === "string") return fromExtra;
  for (const [re, code] of CODES) if (re.test(e.message)) return code;
  if (e.status === 404) return "NOT_FOUND";
  if (e.status === 401) return "SIGN_IN_REQUIRED";
  if (e.status === 403) return "FORBIDDEN";
  if (e.status === 429) return "RATE_LIMITED";
  if (e.status >= 500) return "SERVER_ERROR";
  return "BAD_REQUEST";
}
