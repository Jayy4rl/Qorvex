/**
 * Domain store on SQLite (see db/db.ts).
 *
 * The working set stays in memory, so the watcher's per-block reads are
 * synchronous and cheap, and callers may keep mutating the objects they got
 * from the store (as they did with the JSON-file store this replaces). A
 * debounced flush writes every entity whose JSON changed since it was last
 * written, in one transaction, so a crash never leaves a half-written state.
 *
 * Every row carries the owning workspace id (when the entity has one) so
 * queries outside this process (admin tools, exports) can scope by workspace.
 * A legacy `state.json` / `reads.json` in the store directory is imported once
 * and renamed to `*.imported`.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BacktestResult, Breach, Decision, DraftRun, Evaluation, ProposalEvaluation, Protocol, Read, Relayer, Rule, WatcherProgress } from "@qorvex/shared";
import { openDb, tx, type Db } from "../db/db.ts";

interface State {
  protocols: Protocol[];
  rules: Record<string, Rule[]>;
  drafts: DraftRun[];
  evaluations: Record<string, Evaluation>; // latest per protocolId/ruleId
  lastPassed: Record<string, { blockHeight: number; at: string }>;
  breaches: Breach[];
  backtests: Record<string, BacktestResult>;
  relayers: Relayer[];
  decisions: Record<string, Decision[]>;
  watcher: Record<string, WatcherProgress>;
  proposals: Record<string, ProposalEvaluation[]>;
}

const EMPTY: State = {
  protocols: [],
  rules: {},
  drafts: [],
  evaluations: {},
  lastPassed: {},
  breaches: [],
  backtests: {},
  relayers: [],
  decisions: {},
  watcher: {},
  proposals: {},
};

const MAX_READS = 20_000;
/** Recent evaluations kept per rule for the monitor charts (memory only, refilled as blocks arrive). */
const HISTORY_POINTS = 240;

/** One evaluation, compacted for charts. */
export interface HistoryPoint {
  blockHeight: number;
  at: string;
  ok: boolean;
  owed?: string;
  held?: string;
  marginBps?: number | null;
  total?: string;
  max?: string;
}
const MAX_DECISIONS = 2_000;

export type StoreEvent = { type: string; protocolId?: string; relayerId?: string; data?: unknown };

type StoredRead = Read & { protocolId: string; ruleId: string };
/** Collections stored one row per array item (keyed by `id`); the rest are records (one row per key). */
const ARRAY_KINDS = new Set<keyof State>(["protocols", "drafts", "breaches", "relayers"]);

export class Store {
  private state: State;
  private reads = new Map<string, StoredRead>();
  /** Reads added since the last flush (written as new rows). */
  private newReads: StoredRead[] = [];
  /** Last JSON written per row ("kind\0key"), to write only what changed. */
  private written = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(e: StoreEvent) => void>();
  private history = new Map<string, HistoryPoint[]>();
  public readonly db: Db;

  /**
   * @param dir store directory (holds `qorvex.db` unless `db` is given, and any legacy JSON files to import)
   * @param db  an open database to share (the service passes the one Better Auth also uses)
   */
  constructor(
    public readonly dir: string,
    db?: Db,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = db ?? openDb(path.join(dir, "qorvex.db"));
    this.state = structuredClone(EMPTY);
    this.load();
    this.importLegacy();
  }

  private load(): void {
    const rows = this.db.prepare("SELECT kind, key, doc FROM store_docs ORDER BY rowid").all() as { kind: keyof State; key: string; doc: string }[];
    for (const r of rows) {
      if (!(r.kind in EMPTY)) continue;
      const v = JSON.parse(r.doc);
      if (ARRAY_KINDS.has(r.kind)) (this.state[r.kind] as unknown[]).push(v);
      else (this.state[r.kind] as Record<string, unknown>)[r.key] = v;
      this.written.set(`${r.kind}\0${r.key}`, r.doc);
    }
    for (const r of this.db.prepare("SELECT doc FROM store_reads ORDER BY seq").all() as { doc: string }[]) {
      const x = JSON.parse(r.doc) as StoredRead;
      this.reads.set(x.id, x);
    }
  }

  /** One-time import of the JSON-file store this replaced. */
  private importLegacy(): void {
    const file = path.join(this.dir, "state.json");
    const readsFile = path.join(this.dir, "reads.json");
    if (fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<State>;
      for (const k of Object.keys(EMPTY) as (keyof State)[]) {
        if (old[k] === undefined) continue;
        if (ARRAY_KINDS.has(k)) {
          const have = new Set((this.state[k] as { id: string }[]).map((x) => x.id));
          for (const x of old[k] as { id: string }[]) if (!have.has(x.id)) (this.state[k] as unknown[]).push(x);
        } else {
          this.state[k] = { ...(old[k] as object), ...(this.state[k] as object) } as never;
        }
      }
    }
    if (fs.existsSync(readsFile)) {
      for (const r of JSON.parse(fs.readFileSync(readsFile, "utf8")) as StoredRead[]) {
        if (!this.reads.has(r.id)) {
          this.reads.set(r.id, r);
          this.newReads.push(r);
        }
      }
    }
    if (fs.existsSync(file) || fs.existsSync(readsFile)) {
      this.flush();
      for (const f of [file, readsFile]) if (fs.existsSync(f)) fs.renameSync(f, `${f}.imported`);
    }
  }

  on(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: StoreEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* listener errors never break the watcher */
      }
    }
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  /** Write every entity whose JSON changed since its last write, and new reads, in one transaction. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    const upsert = this.db.prepare(
      "INSERT INTO store_docs (kind, key, workspace_id, doc, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET workspace_id = excluded.workspace_id, doc = excluded.doc, updated_at = excluded.updated_at",
    );
    const del = this.db.prepare("DELETE FROM store_docs WHERE kind = ? AND key = ?");
    const seen = new Set<string>();
    tx(this.db, () => {
      for (const kind of Object.keys(EMPTY) as (keyof State)[]) {
        const entries: [string, unknown][] = ARRAY_KINDS.has(kind)
          ? (this.state[kind] as { id: string }[]).map((x) => [x.id, x])
          : Object.entries(this.state[kind] as Record<string, unknown>);
        for (const [key, v] of entries) {
          const id = `${kind}\0${key}`;
          seen.add(id);
          const doc = JSON.stringify(v, bigintReplacer);
          if (this.written.get(id) === doc) continue;
          const ws = v && typeof v === "object" && typeof (v as { workspaceId?: unknown }).workspaceId === "string" ? (v as { workspaceId: string }).workspaceId : null;
          upsert.run(kind, key, ws, doc, now);
          this.written.set(id, doc);
        }
      }
      for (const id of [...this.written.keys()]) {
        if (seen.has(id)) continue;
        const [kind, key] = id.split("\0");
        del.run(kind, key);
        this.written.delete(id);
      }
      if (this.newReads.length) {
        const ins = this.db.prepare("INSERT OR REPLACE INTO store_reads (id, protocol_id, doc) VALUES (?, ?, ?)");
        for (const r of this.newReads) if (this.reads.has(r.id)) ins.run(r.id, r.protocolId, JSON.stringify(r, bigintReplacer));
        this.newReads = [];
        // Keep the newest MAX_READS rows, matching the in-memory cap.
        this.db.prepare("DELETE FROM store_reads WHERE seq <= (SELECT seq FROM store_reads ORDER BY seq DESC LIMIT 1 OFFSET ?)").run(MAX_READS);
      }
    });
  }

  /** Flush and close the database (service shutdown). */
  close(): void {
    this.flush();
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ------------------------------------------------------------ protocols

  protocols(): Protocol[] {
    return this.state.protocols;
  }

  protocol(id: string): Protocol | undefined {
    return this.state.protocols.find((p) => p.id === id);
  }

  upsertProtocol(p: Protocol): Protocol {
    const i = this.state.protocols.findIndex((x) => x.id === p.id);
    if (i >= 0) this.state.protocols[i] = p;
    else this.state.protocols.push(p);
    this.save();
    this.emit({ type: "protocol", protocolId: p.id });
    return p;
  }

  // ---------------------------------------------------------------- rules

  rules(protocolId: string): Rule[] {
    return this.state.rules[protocolId] ?? [];
  }

  rule(protocolId: string, ruleId: string): Rule | undefined {
    return this.rules(protocolId).find((r) => r.id === ruleId);
  }

  putRule(protocolId: string, rule: Rule): void {
    const list = (this.state.rules[protocolId] ??= []);
    const i = list.findIndex((r) => r.id === rule.id);
    if (i >= 0) list[i] = rule;
    else list.push(rule);
    this.save();
    this.emit({ type: "rules", protocolId });
  }

  // ---------------------------------------------------------- evaluations

  recordEvaluation(protocolId: string, ev: Evaluation): void {
    const key = `${protocolId}/${ev.ruleId}`;
    this.state.evaluations[key] = ev;
    if (ev.type !== "proposal") {
      const h = this.history.get(key) ?? [];
      const last = h.at(-1);
      const point: HistoryPoint =
        ev.type === "solvency" ? { blockHeight: ev.blockHeight, at: ev.at, ok: ev.ok, owed: ev.owed, held: ev.held, marginBps: ev.marginBps } : { blockHeight: ev.blockHeight, at: ev.at, ok: ev.ok, total: ev.total, max: ev.max };
      if (last && last.blockHeight === point.blockHeight) h[h.length - 1] = point;
      else h.push(point);
      if (h.length > HISTORY_POINTS) h.splice(0, h.length - HISTORY_POINTS);
      this.history.set(key, h);
    }
    if (ev.ok) this.state.lastPassed[key] = { blockHeight: ev.blockHeight, at: ev.at };
    if (ev.type === "solvency") {
      for (const r of ev.reads) {
        const x = { ...r, protocolId, ruleId: ev.ruleId };
        this.reads.set(r.id, x);
        this.newReads.push(x);
      }
      if (this.reads.size > MAX_READS) {
        const drop = this.reads.size - MAX_READS;
        let i = 0;
        for (const k of this.reads.keys()) {
          if (i++ >= drop) break;
          this.reads.delete(k);
        }
      }
    }
    this.save();
    const detail =
      ev.type === "solvency"
        ? { owed: ev.owed, held: ev.held, marginBps: ev.marginBps }
        : ev.type === "outflow_rate"
          ? { total: ev.total, max: ev.max }
          : { proposalId: ev.proposalId, summary: ev.summary };
    this.emit({ type: "evaluation", protocolId, data: { ruleId: ev.ruleId, ruleType: ev.type, ok: ev.ok, blockHeight: ev.blockHeight, ...detail } });
  }

  /** Recent evaluations per rule of a protocol, oldest first. */
  evaluationHistory(protocolId: string): Record<string, HistoryPoint[]> {
    const out: Record<string, HistoryPoint[]> = {};
    for (const r of this.rules(protocolId)) out[r.id] = this.history.get(`${protocolId}/${r.id}`) ?? [];
    return out;
  }

  breach(id: string): Breach | undefined {
    return this.state.breaches.find((b) => b.id === id);
  }

  evaluation(protocolId: string, ruleId: string): Evaluation | undefined {
    return this.state.evaluations[`${protocolId}/${ruleId}`];
  }

  lastPassed(protocolId: string, ruleId: string): { blockHeight: number; at: string } | undefined {
    return this.state.lastPassed[`${protocolId}/${ruleId}`];
  }

  read(id: string) {
    return this.reads.get(id);
  }

  // ------------------------------------------------------------- breaches

  breaches(protocolId?: string): Breach[] {
    return protocolId ? this.state.breaches.filter((b) => b.protocolId === protocolId) : this.state.breaches;
  }

  putBreach(b: Breach): void {
    const i = this.state.breaches.findIndex((x) => x.id === b.id);
    if (i >= 0) this.state.breaches[i] = b;
    else this.state.breaches.push(b);
    this.save();
    this.emit({ type: "breach", protocolId: b.protocolId, data: { id: b.id } });
  }

  // --------------------------------------------------------------- drafts

  putDraft(d: DraftRun): void {
    const i = this.state.drafts.findIndex((x) => x.id === d.id);
    if (i >= 0) this.state.drafts[i] = d;
    else this.state.drafts.push(d);
    this.save();
    this.emit({ type: "draft", protocolId: d.protocolId });
  }

  drafts(protocolId: string): DraftRun[] {
    return this.state.drafts.filter((d) => d.protocolId === protocolId);
  }

  // ------------------------------------------------------------ backtests

  putBacktest(protocolId: string, b: BacktestResult): void {
    this.state.backtests[`${protocolId}/${b.ruleId}`] = b;
    this.save();
    this.emit({ type: "backtest", protocolId });
  }

  backtest(protocolId: string, ruleId: string): BacktestResult | undefined {
    return this.state.backtests[`${protocolId}/${ruleId}`];
  }

  // ------------------------------------------------------------- relayers

  relayers(): Relayer[] {
    return this.state.relayers;
  }

  relayer(id: string): Relayer | undefined {
    return this.state.relayers.find((r) => r.id === id);
  }

  putRelayer(r: Relayer): void {
    const i = this.state.relayers.findIndex((x) => x.id === r.id);
    if (i >= 0) this.state.relayers[i] = r;
    else this.state.relayers.push(r);
    this.save();
    this.emit({ type: "relayer", relayerId: r.id });
  }

  addDecisions(relayerId: string, ds: Decision[]): void {
    const list = (this.state.decisions[relayerId] ??= []);
    const seen = new Set(list.map((x) => x.id));
    for (const d of ds) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      list.push(d);
    }
    if (list.length > MAX_DECISIONS) list.splice(0, list.length - MAX_DECISIONS);
    this.save();
    this.emit({ type: "decisions", relayerId });
  }

  decisions(relayerId: string): Decision[] {
    return this.state.decisions[relayerId] ?? [];
  }

  // ------------------------------------------------------------- proposals

  recordProposal(protocolId: string, ev: ProposalEvaluation): void {
    const list = (this.state.proposals[protocolId] ??= []);
    const i = list.findIndex((x) => x.proposalId === ev.proposalId);
    if (i >= 0) list[i] = ev;
    else list.push(ev);
    if (list.length > 200) list.splice(0, list.length - 200);
    this.save();
    this.emit({ type: "proposal", protocolId, data: { proposalId: ev.proposalId, ok: ev.ok } });
  }

  proposals(protocolId: string): ProposalEvaluation[] {
    return this.state.proposals[protocolId] ?? [];
  }

  // -------------------------------------------------------------- watcher

  setWatcherProgress(network: string, lastBlock: number, source: string): void {
    this.state.watcher[network] = { lastBlock, source, at: new Date().toISOString() };
    this.save();
  }

  watcherProgress(network: string): WatcherProgress | undefined {
    return this.state.watcher[network];
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
