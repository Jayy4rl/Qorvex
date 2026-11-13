/**
 * Workspace roles and the permission matrix (change request §3), in one place.
 *
 * The same table drives Better Auth's organization roles (so its built-in
 * member, invitation and API-key endpoints apply our matrix) and the
 * `can()` check every Qorvex route runs before its handler.
 */
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

export type Role = "owner" | "admin" | "responder" | "viewer";
export const ROLES: Role[] = ["owner", "admin", "responder", "viewer"];

/**
 * Every action a route can require. `onchain` actions also need verified
 * on-chain authority over the contract at the time of the action; `stepUp`
 * actions also need a fresh NEP-413 signature bound to the action.
 */
export const ACTIONS = {
  "dashboard.read": { roles: ["owner", "admin", "responder", "viewer"] },
  "contract.watch": { roles: ["owner", "admin"] },
  "rule.draft": { roles: ["owner", "admin"] },
  "rule.approve": { roles: ["owner", "admin"] },
  "contract.scopes": { roles: ["owner", "admin"], stepUp: true },
  "guardian.authorise": { roles: ["owner", "admin"], onchain: true },
  "pause.manual": { roles: ["owner", "admin", "responder"] },
  "alert.ack": { roles: ["owner", "admin", "responder"] },
  "status.publish": { roles: ["owner", "admin"], onchain: true },
  "contract.claim": { roles: ["owner", "admin"], stepUp: true },
  "relayer.manage": { roles: ["owner", "admin"] },
  "alerts.manage": { roles: ["owner", "admin"] },
  "apikey.create": { roles: ["owner", "admin"], stepUp: true },
  "member.invite": { roles: ["owner", "admin"] },
  "workspace.delete": { roles: ["owner"] },
  "workspace.transfer": { roles: ["owner"], stepUp: true },
  /** Sandbox demo actors: only the single-tenant admin token. */
  "demo.run": { roles: [] },
} as const satisfies Record<string, { roles: readonly Role[]; onchain?: boolean; stepUp?: boolean }>;

export type Action = keyof typeof ACTIONS;

export function can(role: Role | undefined, action: Action): boolean {
  return !!role && (ACTIONS[action].roles as readonly Role[]).includes(role);
}

export function needsStepUp(action: Action): boolean {
  return "stepUp" in ACTIONS[action] && !!(ACTIONS[action] as { stepUp?: boolean }).stepUp;
}

export function needsOnchain(action: Action): boolean {
  return "onchain" in ACTIONS[action] && !!(ACTIONS[action] as { onchain?: boolean }).onchain;
}

// ------------------------------------------- Better Auth organization roles

const statements = {
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
} as const;

export const ac = createAccessControl(statements);

/** Better Auth roles mirroring the matrix: members/invites for owner+admin, API keys for owner+admin. */
export const orgRoles = {
  owner: ac.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
    apiKey: ["create", "read", "update", "delete"],
  }),
  admin: ac.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    apiKey: ["create", "read", "update", "delete"],
  }),
  responder: ac.newRole({ apiKey: ["read"] }),
  viewer: ac.newRole({}),
};

/** What an API key may do, by its `permissions` record ({ scope: [actions] }). */
export const API_KEY_SCOPES: Record<string, Action[]> = {
  "contracts:read": ["dashboard.read"],
  "rules:read": ["dashboard.read"],
  "alerts:ack": ["alert.ack", "dashboard.read"],
};
