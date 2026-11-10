/**
 * Small JSON-file store. One process owns the data directory; writes are
 * atomic (write to temp, rename). Good enough for a single watcher instance;
 * the README lists a real database as future work.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { NetworkId } from "../config.ts";
import type { ProposalPolicyRule, Rule, RuleResponse } from "../rules/types.ts";

export type ProposalPolicy = Omit<ProposalPolicyRule, "status" | "origin" | "response" | "approvedBy" | "approvedAt">;
import type { Evaluation, Read } from "../rules/evaluate.ts";
import type { ProposalEvaluation } from "../firewall/policy.ts";
import type { Budget, Decision } from "../relayer/budgets.ts";

export interface Protocol {
  id: string;
  name: string;
  network: NetworkId;
  contractId: string;
  /** Qorvex guardian contract that can pause this protocol. */
  guardianId?: string;
  /** "dao" for Sputnik DAOs (proposal firewall + council); "contract" otherwise. */
  kind?: "contract" | "dao";
  firewallVerified?: { at: string; ok: boolean; role?: string; problems: string[] };
  /** Read-only, unofficial page built from public data (e.g. mainnet Intents). */
  unofficial?: boolean;
  status: "connected" | "protected";
  published: boolean;
  source?: { kind: "nep330" | "upload"; link?: string; files: { path: string; bytes: number }[]; fetchedAt: string };
  guardianVerified?: { at: string; guardianSet: string | null; registered: boolean; council?: string };
  createdAt: string;
}

export interface Breach {
  id: string;
  protocolId: string;
  ruleId: string;
  rule: Rule;
  detectedAtBlock: number;
  /** Height of the block whose receipts triggered the evaluation. */
  triggerBlock: number;
  triggerReceipts: { receiptId: string; txHash?: string; predecessor: string; receiver: string; method?: string }[];
  evaluation: Evaluation;
  confirmation?: Evaluation;
  evidenceHash: string;
  detectedAt: string;
  response: RuleResponse;
  pause?: {
    status: "sending" | "landed" | "failed" | "skipped";
    txHash?: string;
    provider?: string;
    /** Block in which the protected contract's pause() receipt executed. */
    pausedAtBlock?: number;
    blocksAfterBreach?: number;
    msAfterDetection?: number;
    error?: string;
    guardianRecordIndex?: number;
  };
  /** Proposal firewall: the VoteReject cast on a Sputnik DAO proposal. */
  vote?: {
    status: "sending" | "landed" | "failed" | "skipped";
    txHash?: string;
    votedAtBlock?: number;
    blocksAfterProposal?: number;
    msAfterDetection?: number;
    proposalStatusAfter?: string;
    error?: string;
  };
  /** Measured latency of the detect-and-pause path (wall-clock ms and block heights). */
  timeline?: {
    triggerBlockTimestampMs: number;
    blockReceivedMs: number;
    detectedMs: number;
    confirmedMs?: number;
    broadcastMs?: number;
    landedMs?: number;
    txBlock?: number;
    guardianBlock?: number;
    pausedBlock?: number;
  };
  alerts: { channel: string; ok: boolean; error?: string; at: string }[];
  explanation?: { model: string; text: string; at: string; source: "live" | "replay" };
}

export interface DraftRun {
  id: string;
  protocolId: string;
  model: string;
  startedAt: string;
  finishedAt?: string;
  attempts: { n: number; responseText: string; chatId?: string; errors: string[] }[];
  accepted: string[];
  dropped: { rule: unknown; errors: string[] }[];
  attestation?: { model: string; nonce: string; signingAddress?: string; fetchedAt: string; report?: unknown; error?: string };
  source: "live" | "replay" | "record";
  error?: string;
}

export interface BacktestResult {
  ruleId: string;
  network: NetworkId;
  fromBlock: number;
  toBlock: number;
  days: number;
  samples: number;
  fires: number;
  firedAt: number[];
  errors: number;
  minMarginBps: number | null;
  method: string;
  at: string;
}

export interface Relayer {
  id: string;
  name: string;
  /** SHA-256 of the relayer's API token; the token itself is shown once. */
  tokenHash: string;
  budgets: Budget[];
  failMode: "closed" | "open";
  /** Proposal policy the relayer applies before sponsoring a DAO approval vote (proposal_policy rule fields). */
  proposalPolicy?: ProposalPolicy;
  updatedAt: string;
}

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
  watcher: Record<string, { lastBlock: number; source: string; at: string }>;
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
const MAX_DECISIONS = 2_000;

export type StoreEvent = { type: string; protocolId?: string; relayerId?: string; data?: unknown };

export class Store {
  private state: State;
  private reads = new Map<string, Read & { protocolId: string; ruleId: string }>();
  private file: string;
  private readsFile: string;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(e: StoreEvent) => void>();

  constructor(public readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.readsFile = path.join(dir, "reads.json");
    this.state = fs.existsSync(this.file) ? { ...EMPTY, ...JSON.parse(fs.readFileSync(this.file, "utf8")) } : structuredClone(EMPTY);
    if (fs.existsSync(this.readsFile)) {
      for (const r of JSON.parse(fs.readFileSync(this.readsFile, "utf8"))) this.reads.set(r.id, r);
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

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    writeAtomic(this.file, JSON.stringify(this.state, bigintReplacer, 1));
    writeAtomic(this.readsFile, JSON.stringify([...this.reads.values()], bigintReplacer));
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

  removeRule(protocolId: string, ruleId: string): void {
    this.state.rules[protocolId] = this.rules(protocolId).filter((r) => r.id !== ruleId);
    this.save();
    this.emit({ type: "rules", protocolId });
  }

  // ---------------------------------------------------------- evaluations

  recordEvaluation(protocolId: string, ev: Evaluation): void {
    const key = `${protocolId}/${ev.ruleId}`;
    this.state.evaluations[key] = ev;
    if (ev.ok) this.state.lastPassed[key] = { blockHeight: ev.blockHeight, at: ev.at };
    if (ev.type === "solvency") {
      for (const r of ev.reads) this.reads.set(r.id, { ...r, protocolId, ruleId: ev.ruleId });
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
    this.emit({ type: "evaluation", protocolId, data: { ruleId: ev.ruleId, ok: ev.ok, blockHeight: ev.blockHeight } });
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

  breach(id: string): Breach | undefined {
    return this.state.breaches.find((b) => b.id === id);
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
    for (const d of ds) if (!list.some((x) => x.id === d.id)) list.push(d);
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

  watcherProgress(network: string) {
    return this.state.watcher[network];
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}
