/**
 * The service database: one SQLite file (Node's built-in `node:sqlite`, no
 * native dependency) shared by the domain store, Better Auth's tables and the
 * multi-tenant tables (claims, audit log, NEAR sign-in nonces, relayer
 * decisions).
 *
 * WAL mode lets the HTTP handlers read while the watcher writes. Schema
 * changes are numbered migrations recorded in `qorvex_migrations`; Better Auth
 * runs its own migrations on the same file (see auth/auth.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: "domain store",
    sql: `
      -- Domain records (protocols, rules, breaches, ...), one row per entity, JSON body.
      -- kind = the store collection, key = the entity id (or record key).
      CREATE TABLE store_docs (
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        workspace_id TEXT,
        doc TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      );
      CREATE INDEX store_docs_workspace ON store_docs (kind, workspace_id);
      -- Raw RPC exchanges behind every published number (S2), capped by the store.
      CREATE TABLE store_reads (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        protocol_id TEXT NOT NULL,
        doc TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: "multi-tenant",
    sql: `
      -- One public record per (network, contract): the status page and guardian registration.
      CREATE TABLE canonical_contracts (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        claimed_by_workspace TEXT,
        detection TEXT,
        detected_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (network, contract_id)
      );
      -- What a workspace may do to a contract, derived from chain state and re-checked.
      CREATE TABLE authority_claims (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        network TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        method TEXT NOT NULL,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL,
        verified_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (workspace_id, network, contract_id)
      );
      -- Append-only: no UPDATE or DELETE is ever issued against it.
      CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        workspace_id TEXT,
        actor TEXT NOT NULL,
        method TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        signed_message TEXT
      );
      CREATE INDEX audit_log_workspace ON audit_log (workspace_id, seq);
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      -- NEP-413 nonces: single use, consumed atomically (DELETE ... RETURNING).
      CREATE TABLE near_nonces (
        nonce TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        message TEXT NOT NULL,
        state TEXT,
        user_id TEXT,
        expires_at INTEGER NOT NULL
      );
      -- Invitations by NEAR account id, matched when that account first signs in.
      CREATE TABLE near_invites (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER
      );
      CREATE INDEX near_invites_account ON near_invites (account_id);
      -- Relayer check() decisions made on the server, so every relayer instance shares one spend history.
      CREATE TABLE relayer_spend (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        relayer_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        beneficiary TEXT NOT NULL,
        action TEXT NOT NULL,
        receiver TEXT,
        cost TEXT NOT NULL
      );
      CREATE INDEX relayer_spend_lookup ON relayer_spend (relayer_id, at);
      -- Per-IP rate limiting for public endpoints (contract checks).
      CREATE TABLE rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
    `,
  },
];

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS qorvex_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT id FROM qorvex_migrations").all() as { id: number }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO qorvex_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(m.id, m.name, Date.now());
    });
  }
}

/**
 * Better Auth shares this connection and keeps its transactions open across
 * async work (e.g. password hashing during sign-up). A second BEGIN on the
 * same connection would fail, so callers must not start one while
 * `db.isTransaction` is true: `tx` refuses, `txWhenFree` waits.
 */
export class TxBusyError extends Error {
  constructor() {
    super("another transaction is open on this database connection");
  }
}

/** Run `fn` in one transaction (BEGIN IMMEDIATE, so concurrent writers queue instead of failing). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) throw new TxBusyError();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** `tx`, after waiting (without blocking the event loop) for any open transaction on the connection to finish. */
export async function txWhenFree<T>(db: Db, fn: () => T, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  while (db.isTransaction) {
    if (Date.now() - start > timeoutMs) throw new TxBusyError();
    await new Promise((r) => setTimeout(r, 5));
  }
  return tx(db, fn);
}
