/**
 * Multi-tenant records in SQLite: authority claims, the canonical public
 * record per (network, contract), the append-only audit log, NEAR-account
 * invitations and workspace membership lookups.
 */
import crypto from "node:crypto";
import type { AuthorityClaim, Detection, NetworkId, WorkspaceRole } from "@qorvex/shared";
import { txWhenFree, type Db } from "../db/db.ts";

/** Records created before multi-tenancy, and everything the single-tenant admin token touches. */
export const DEFAULT_WORKSPACE = "default";

export interface WorkspaceAlertRow {
  workspace_id: string;
  telegram_chat_id: string | null;
  /** The workspace's own bot; null uses the server's bot (TELEGRAM_BOT_TOKEN). */
  telegram_bot_token: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  updated_at: number;
  updated_by: string | null;
}

const id = (p: string) => `${p}_${crypto.randomBytes(8).toString("hex")}`;

export class Tenancy {
  constructor(public readonly db: Db) {}

  // ------------------------------------------------------------ members

  roleOf(userId: string, workspaceId: string): WorkspaceRole | undefined {
    const r = this.db.prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ?").get(userId, workspaceId) as { role: string } | undefined;
    return r?.role as WorkspaceRole | undefined;
  }

  workspacesOf(userId: string): { id: string; name: string; slug: string; role: WorkspaceRole }[] {
    return this.db
      .prepare("SELECT o.id AS id, o.name AS name, o.slug AS slug, m.role AS role FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = ? ORDER BY o.createdAt")
      .all(userId) as { id: string; name: string; slug: string; role: WorkspaceRole }[];
  }

  // ------------------------------------------------------------- alerts

  /** A workspace's own alert destinations, with the secrets (bot token, webhook secret) left in. */
  alertSettings(workspaceId: string): WorkspaceAlertRow | undefined {
    return this.db.prepare("SELECT * FROM workspace_alerts WHERE workspace_id = ?").get(workspaceId) as WorkspaceAlertRow | undefined;
  }

  putAlertSettings(workspaceId: string, v: Omit<WorkspaceAlertRow, "workspace_id" | "updated_at">): void {
    this.db
      .prepare(
        `INSERT INTO workspace_alerts (workspace_id, telegram_chat_id, telegram_bot_token, webhook_url, webhook_secret, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id, telegram_bot_token = excluded.telegram_bot_token,
           webhook_url = excluded.webhook_url, webhook_secret = excluded.webhook_secret, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(workspaceId, v.telegram_chat_id, v.telegram_bot_token, v.webhook_url, v.webhook_secret, Date.now(), v.updated_by);
  }

  // ------------------------------------------------------------- claims

  claim(workspaceId: string, network: NetworkId, contractId: string): AuthorityClaim | undefined {
    const r = this.db.prepare("SELECT * FROM authority_claims WHERE workspace_id = ? AND network = ? AND contract_id = ?").get(workspaceId, network, contractId) as any;
    return r ? rowToClaim(r) : undefined;
  }

  verifiedClaimFor(network: NetworkId, contractId: string): AuthorityClaim | undefined {
    const r = this.db.prepare("SELECT * FROM authority_claims WHERE network = ? AND contract_id = ? AND status = 'verified' ORDER BY verified_at DESC LIMIT 1").get(network, contractId) as any;
    return r ? rowToClaim(r) : undefined;
  }

  claims(workspaceId: string): AuthorityClaim[] {
    return (this.db.prepare("SELECT * FROM authority_claims WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as any[]).map(rowToClaim);
  }

  putClaim(c: Omit<AuthorityClaim, "id"> & { id?: string }): AuthorityClaim {
    const existing = this.claim(c.workspaceId, c.network, c.contractId);
    const claimId = existing?.id ?? c.id ?? id("clm");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO authority_claims (id, workspace_id, network, contract_id, method, evidence, status, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, network, contract_id) DO UPDATE SET method = excluded.method, evidence = excluded.evidence, status = excluded.status, verified_at = excluded.verified_at`,
      )
      .run(claimId, c.workspaceId, c.network, c.contractId, c.method, JSON.stringify(c.evidence), c.status, c.verifiedAt ? Date.parse(c.verifiedAt) : null, now);
    return this.claim(c.workspaceId, c.network, c.contractId)!;
  }

  // ---------------------------------------------------- canonical records

  canonical(network: NetworkId, contractId: string): { id: string; claimedBy: string | null; detection: Detection | null; detectedAt: number | null } | undefined {
    const r = this.db.prepare("SELECT * FROM canonical_contracts WHERE network = ? AND contract_id = ?").get(network, contractId) as any;
    return r ? { id: r.id, claimedBy: r.claimed_by_workspace, detection: r.detection ? JSON.parse(r.detection) : null, detectedAt: r.detected_at } : undefined;
  }

  putDetection(d: Detection): string {
    const existing = this.canonical(d.network, d.contractId);
    if (existing) {
      this.db.prepare("UPDATE canonical_contracts SET detection = ?, detected_at = ? WHERE id = ?").run(JSON.stringify(d), Date.now(), existing.id);
      return existing.id;
    }
    const cid = id("cc");
    this.db.prepare("INSERT INTO canonical_contracts (id, network, contract_id, detection, detected_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(cid, d.network, d.contractId, JSON.stringify(d), Date.now(), Date.now());
    return cid;
  }

  /** The canonical public record goes to the first workspace with verified authority; later ones keep their private watch. */
  claimCanonical(network: NetworkId, contractId: string, workspaceId: string): Promise<boolean> {
    return txWhenFree(this.db, () => {
      const c = this.canonical(network, contractId);
      if (!c) {
        this.db.prepare("INSERT INTO canonical_contracts (id, network, contract_id, claimed_by_workspace, created_at) VALUES (?, ?, ?, ?, ?)").run(id("cc"), network, contractId, workspaceId, Date.now());
        return true;
      }
      if (c.claimedBy && c.claimedBy !== workspaceId) {
        // Only if the current holder's claim lapsed may another verified workspace take it over.
        const holder = this.claim(c.claimedBy, network, contractId);
        if (holder?.status === "verified") return false;
      }
      this.db.prepare("UPDATE canonical_contracts SET claimed_by_workspace = ? WHERE id = ?").run(workspaceId, c.id);
      return true;
    });
  }

  // ----------------------------------------------------------- audit log

  audit(e: { workspaceId: string | null; actor: string; method: string; action: string; target?: string; detail?: unknown; signedMessage?: unknown }): void {
    this.db
      .prepare("INSERT INTO audit_log (at, workspace_id, actor, method, action, target, detail, signed_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), e.workspaceId, e.actor, e.method, e.action, e.target ?? null, e.detail === undefined ? null : JSON.stringify(e.detail), e.signedMessage === undefined ? null : JSON.stringify(e.signedMessage));
  }

  auditLog(workspaceId: string, limit = 200): unknown[] {
    return (this.db.prepare("SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY seq DESC LIMIT ?").all(workspaceId, limit) as any[]).map((r) => ({
      seq: r.seq,
      at: new Date(r.at).toISOString(),
      actor: r.actor,
      method: r.method,
      action: r.action,
      target: r.target,
      detail: r.detail ? JSON.parse(r.detail) : null,
      signedMessage: r.signed_message ? JSON.parse(r.signed_message) : null,
    }));
  }

  // ------------------------------------------------- NEAR-account invites

  inviteNear(workspaceId: string, accountKey: string, role: WorkspaceRole, invitedBy: string): string {
    const iid = id("inv");
    this.db.prepare("INSERT INTO near_invites (id, workspace_id, account_id, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(iid, workspaceId, accountKey, role, invitedBy, Date.now() + 48 * 3600_000);
    return iid;
  }

  /** Attach a user to every workspace that invited this NEAR account (matched on first sign-in). */
  acceptNearInvites(userId: string, accountKey: string): Promise<string[]> {
    return txWhenFree(this.db, () => {
      const rows = this.db.prepare("SELECT * FROM near_invites WHERE account_id = ? AND accepted_at IS NULL AND expires_at > ?").all(accountKey, Date.now()) as any[];
      const joined: string[] = [];
      for (const r of rows) {
        if (!this.roleOf(userId, r.workspace_id)) {
          this.db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)").run(id("mem"), r.workspace_id, userId, r.role, new Date().toISOString());
          joined.push(r.workspace_id);
        }
        this.db.prepare("UPDATE near_invites SET accepted_at = ? WHERE id = ?").run(Date.now(), r.id);
      }
      return joined;
    });
  }

  // --------------------------------------------------------- rate limits

  /** Fixed-window counter; true while under `max` requests per `windowMs`. */
  rateLimit(key: string, max: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    return txWhenFree(this.db, () => {
      const r = this.db.prepare("SELECT window_start, count FROM rate_limits WHERE key = ?").get(key) as { window_start: number; count: number } | undefined;
      if (!r || now - r.window_start >= windowMs) {
        this.db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 1").run(key, now);
        return true;
      }
      if (r.count >= max) return false;
      this.db.prepare("UPDATE rate_limits SET count = count + 1 WHERE key = ?").run(key);
      return true;
    });
  }
}

function rowToClaim(r: any): AuthorityClaim {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    network: r.network,
    contractId: r.contract_id,
    method: r.method,
    evidence: JSON.parse(r.evidence),
    status: r.status,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
  };
}
