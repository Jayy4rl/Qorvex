/**
 * API client. Signed-in users authenticate with Better Auth's httpOnly session
 * cookie (same origin); a self-hosted operator may instead use the
 * single-tenant admin token kept in sessionStorage.
 */
import { getToken } from "./session";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      credentials: "same-origin",
      headers: {
        ...(o.body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(o.headers ?? {}),
      },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
  } catch {
    throw new ApiError(0, "Could not reach the Qorvex server.");
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? json?.message ?? `HTTP ${res.status}`, json?.details ?? json);
  return json as T;
}

export interface Me {
  kind: "user" | "admin";
  singleTenant: boolean;
  user?: { id: string; name: string; email: string | null };
  nearAccounts: { network: string; accountId: string }[];
  workspaces: { id: string; name: string; slug: string; role: string }[];
  workspace: { id: string; name: string; role: string } | null;
  warnings?: string[];
}

/** The signed-in principal, or null when signed out. */
export async function me(): Promise<Me | null> {
  try {
    return await api<Me>("/api/me");
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
}
