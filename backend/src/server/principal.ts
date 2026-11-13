/**
 * Who is calling, and in which workspace (change request §5, step 1-2 of the
 * authorisation middleware). Resolved once per request, before any handler.
 *
 *   1. `Authorization: Bearer qvx_...`   an organization-owned API key (Better Auth api-key plugin)
 *   2. `Authorization: Bearer <admin>`   the operator token, only when QORVEX_SINGLE_TENANT=true
 *   3. session cookie                     a signed-in user; workspace = `x-qorvex-workspace` header
 *                                         or the session's active organization
 */
import crypto from "node:crypto";
import type http from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import type { WorkspaceRole } from "@qorvex/shared";
import { API_KEY_SCOPES, can, type Action } from "../auth/access.ts";
import type { QorvexAuth } from "../auth/auth.ts";
import { DEFAULT_WORKSPACE, type Tenancy } from "../tenancy/tenancy.ts";

export type Principal =
  | { kind: "anonymous" }
  | { kind: "admin"; workspaceId: string; role: "owner" }
  | { kind: "session"; userId: string; name: string; email: string; workspaceId: string | null; role: WorkspaceRole | undefined }
  | { kind: "apiKey"; keyId: string; workspaceId: string; actions: Action[] };

export function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export interface PrincipalDeps {
  auth?: QorvexAuth;
  tenancy: Tenancy;
  singleTenant: boolean;
  adminToken: string;
}

export async function resolvePrincipal(d: PrincipalDeps, req: http.IncomingMessage, tokenOverride?: string): Promise<Principal> {
  const token = tokenOverride ?? bearer(req);
  if (token) {
    if (d.singleTenant && d.adminToken && safeEqual(token, d.adminToken)) return { kind: "admin", workspaceId: DEFAULT_WORKSPACE, role: "owner" };
    if (token.startsWith("qvx_") && d.auth) {
      const v = await d.auth.auth.api.verifyApiKey({ body: { key: token } }).catch(() => null);
      if (v?.valid && v.key) {
        const perms = (v.key.permissions ?? {}) as Record<string, string[]>;
        const actions = [...new Set(Object.keys(perms).flatMap((scope) => API_KEY_SCOPES[scope] ?? []))];
        return { kind: "apiKey", keyId: v.key.id, workspaceId: v.key.referenceId, actions };
      }
    }
    return { kind: "anonymous" };
  }
  if (!d.auth || !req.headers.cookie) return { kind: "anonymous" };
  const s = await d.auth.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
  if (!s) return { kind: "anonymous" };
  const asked = typeof req.headers["x-qorvex-workspace"] === "string" ? req.headers["x-qorvex-workspace"] : null;
  const ws = asked ?? (s.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
  const role = ws ? d.tenancy.roleOf(s.user.id, ws) : undefined;
  return { kind: "session", userId: s.user.id, name: s.user.name, email: s.user.email, workspaceId: role ? ws : null, role };
}

/** Matrix check (step 3). On-chain authority and step-up are separate, explicit guards. */
export function allowed(p: Principal, action: Action): boolean {
  switch (p.kind) {
    case "admin":
      return true;
    case "apiKey":
      return p.actions.includes(action);
    case "session":
      return !!p.workspaceId && action !== "demo.run" && can(p.role, action);
    default:
      return false;
  }
}

export function actorOf(p: Principal): { actor: string; method: string } {
  switch (p.kind) {
    case "admin":
      return { actor: "admin-token", method: "admin-token" };
    case "apiKey":
      return { actor: `api-key:${p.keyId}`, method: "api-key" };
    case "session":
      return { actor: `user:${p.userId}`, method: "session" };
    default:
      return { actor: "anonymous", method: "none" };
  }
}
