/**
 * Operator session. The Qorvex backend has one operator credential, QORVEX_ADMIN_TOKEN
 * (printed by `npm start` / `npm run demo` when unset). There are no user accounts.
 * The token is kept for this browser tab only (sessionStorage).
 */
const KEY = "qorvex.operatorToken";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* storage unavailable: the session lasts for this page view only */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: "rejected" | "unreachable" | "invalid"; message: string };

/** The backend requires at least 16 characters (see backend/src/config.ts). */
export function validateTokenShape(token: string): string | null {
  const t = token.trim();
  if (!t) return "Enter the operator token.";
  if (/\s/.test(t)) return "The token cannot contain spaces.";
  if (t.length < 16) return "Operator tokens are at least 16 characters long.";
  return null;
}

/** Checks the token against an operator-only endpoint of this Qorvex server. */
export async function verifyToken(token: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  const shape = validateTokenShape(token);
  if (shape) return { ok: false, reason: "invalid", message: shape };
  let res: Response;
  try {
    res = await fetchImpl("/api/protocols", { headers: { authorization: `Bearer ${token.trim()}` } });
  } catch {
    return { ok: false, reason: "unreachable", message: "Could not reach the Qorvex server. Start it with `npm run demo` or `npm start`, then try again." };
  }
  await res.text().catch(() => undefined); // drain the body so the request completes cleanly
  if (res.status === 401) return { ok: false, reason: "rejected", message: "This server rejected the token. Use the operator token printed by the server at startup." };
  if (!res.ok) return { ok: false, reason: "unreachable", message: `The Qorvex server answered HTTP ${res.status}. Check that the backend is running on this origin.` };
  return { ok: true };
}
