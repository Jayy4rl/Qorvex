/**
 * The watcher (D1 to D6).
 *
 * For every block from the stream it finds the receipts that touch a
 * protected contract (or an account its rules read from) and evaluates the
 * affected rules at that block. A failing solvency rule is confirmed with one
 * direct RPC read at the latest block (D3) and fired immediately: pause
 * through the guardian (D4), then alert as contained (D5), then breach log
 * (D6). The AI explanation is requested only after the pause has landed (A7).
 *
 * Evaluations run off the stream's critical path: a rule that is still being
 * evaluated is marked dirty and re-evaluated at the newest block afterwards,
 * so a slow RPC never stalls block ingestion.
 */
import type { NearRpc } from "../near/rpc.ts";
import type { BlockEvent, BlockSource, StreamReceipt } from "../stream/types.ts";
import { evaluateSolvency, evidenceHash, OutflowWindow, type Evaluation, type Outflow } from "../rules/evaluate.ts";
import { accountsTouchedBy, type OutflowRateRule, type Rule } from "../rules/types.ts";
import { newId, type Breach, type Protocol, type Store } from "../store/store.ts";
import type { PauseExecutor } from "../executor/pause.ts";
import { Alerter, breachMessage } from "../alerts/alerts.ts";
import type { RejectExecutor } from "../firewall/executor.ts";
import { evaluateProposal, shouldReject, type SputnikProposal } from "../firewall/policy.ts";
import type { ProposalPolicyRule } from "../rules/types.ts";

export interface WatcherDeps {
  store: Store;
  network: string;
  rpc: NearRpc;
  source: BlockSource;
  /** Pause executors by guardian contract id. */
  executors: Map<string, PauseExecutor>;
  /** Firewall reject-vote executors by DAO account id. */
  rejecters?: Map<string, RejectExecutor>;
  alerter: Alerter;
  explain?: (b: Breach) => Promise<Breach["explanation"] | undefined>;
  statusUrl?: (protocolId: string) => string;
  /** Re-evaluate every solvency rule at least this often (blocks), touched or not. */
  heartbeatBlocks?: number;
  /** Also evaluate every solvency rule on a wall-clock timer (ms; 0 = off), so pages stay fresh if the stream stalls. */
  heartbeatMs?: number;
  /** Minimum ms between evaluations of the same rule (protects public RPCs for busy read-only targets). */
  minEvalIntervalMs?: (p: Protocol) => number;
  log?: (s: string) => void;
}

interface RuleState {
  inflight: boolean;
  dirty?: { height: number; receipts: StreamReceipt[] };
  lastEvalMs: number;
  /** Open breach id: no re-fire until the rule passes again. */
  openBreach?: string;
}

export class Watcher {
  private states = new Map<string, RuleState>();
  private windows = new Map<string, OutflowWindow>();
  private blocksSeen = 0;
  private log: (s: string) => void;
  lastBlock?: BlockEvent;
  private blockTimes = new Map<number, { ts: number; recv: number }>();

  constructor(private readonly d: WatcherDeps) {
    this.log = d.log ?? ((s) => console.log(`[watcher:${d.network}] ${s}`));
  }

  private protocols(): Protocol[] {
    return this.d.store.protocols().filter((p) => p.network === this.d.network);
  }

  private activeRules(p: Protocol): Rule[] {
    return this.d.store.rules(p.id).filter((r) => r.status === "approved");
  }

  async run(fromHeight?: number): Promise<void> {
    this.log(`streaming from ${this.d.source.name}`);
    await Promise.all([...this.d.executors.values()].map((e) => e.warm()));
    if (this.d.heartbeatMs) {
      this.timer = setInterval(() => this.heartbeat(), this.d.heartbeatMs);
      this.heartbeat();
    }
    await this.d.source.run((b) => this.onBlock(b), fromHeight);
  }

  stop(): void {
    this.d.source.stop();
    if (this.timer) clearInterval(this.timer);
  }

  private timer: NodeJS.Timeout | null = null;

  /** Evaluate every active solvency rule at the latest block. */
  private heartbeat(): void {
    for (const p of this.protocols())
      for (const rule of this.activeRules(p))
        if (rule.type === "solvency") {
          const s = this.state(this.key(p, rule));
          if (s.inflight) continue;
          void this.evaluateLatest(p, rule);
        } else if (rule.type === "proposal_policy") {
          void this.scanProposals(p, rule, this.lastBlock?.height ?? 0, []);
        }
  }

  private async evaluateLatest(p: Protocol, rule: Rule): Promise<void> {
    if (rule.type !== "solvency") return;
    try {
      const b = await this.d.rpc.block({ finality: "final" });
      this.d.store.setWatcherProgress(this.d.network, Math.max(b.header.height, this.lastBlock?.height ?? 0), this.lastBlock?.source ?? "heartbeat");
      await this.evaluate(p, rule, b.header.height, []);
    } catch (e) {
      this.log(`heartbeat evaluation of ${rule.id} failed: ${(e as Error).message}`);
    }
  }

  /** Process one block. Public so tests can feed blocks directly. */
  async onBlock(b: BlockEvent): Promise<void> {
    this.lastBlock = b;
    this.blocksSeen++;
    this.blockTimes.set(b.height, { ts: b.timestampMs, recv: b.receivedAtMs });
    if (this.blockTimes.size > 500) this.blockTimes.delete(this.blockTimes.keys().next().value!);
    if (this.blocksSeen % 20 === 0) this.d.store.setWatcherProgress(this.d.network, b.height, b.source);
    const heartbeat = this.blocksSeen % (this.d.heartbeatBlocks ?? 30) === 0;

    for (const p of this.protocols()) {
      for (const rule of this.activeRules(p)) {
        const accounts = new Set(accountsTouchedBy(rule, p.contractId));
        const touching = b.receipts.filter((r) => accounts.has(r.receiver) || accounts.has(r.predecessor));
        if (rule.type === "outflow_rate") {
          this.trackOutflows(p, rule, b, touching);
          if (touching.length) this.evaluateOutflow(p, rule, b, touching);
          continue;
        }
        if (rule.type === "proposal_policy") {
          // A new proposal is an add_proposal receipt on the DAO (direct or via a relayed meta-transaction).
          const adds = touching.filter((r) => r.receiver === p.contractId && r.actions.some((a) => a.method === "add_proposal"));
          if (adds.length || heartbeat) void this.scanProposals(p, rule, b.height, adds);
          continue;
        }
        if (touching.length === 0 && !heartbeat) continue;
        this.schedule(p, rule, b.height, touching);
      }
    }
  }

  private key(p: Protocol, r: Rule) {
    return `${p.id}/${r.id}`;
  }

  private state(k: string): RuleState {
    let s = this.states.get(k);
    if (!s) this.states.set(k, (s = { inflight: false, lastEvalMs: 0 }));
    return s;
  }

  private schedule(p: Protocol, rule: Rule, height: number, receipts: StreamReceipt[]): void {
    const s = this.state(this.key(p, rule));
    const minGap = this.d.minEvalIntervalMs?.(p) ?? 0;
    if (s.inflight || Date.now() - s.lastEvalMs < minGap) {
      s.dirty = { height, receipts: [...(s.dirty?.receipts ?? []), ...receipts].slice(-50) };
      if (!s.inflight) setTimeout(() => this.drain(p, rule), minGap);
      return;
    }
    void this.evaluate(p, rule, height, receipts);
  }

  private drain(p: Protocol, rule: Rule): void {
    const s = this.state(this.key(p, rule));
    if (s.inflight || !s.dirty) return;
    const d = s.dirty;
    s.dirty = undefined;
    void this.evaluate(p, rule, d.height, d.receipts);
  }

  private async evaluate(p: Protocol, rule: Rule, height: number, receipts: StreamReceipt[]): Promise<void> {
    if (rule.type !== "solvency") return;
    const s = this.state(this.key(p, rule));
    s.inflight = true;
    s.lastEvalMs = Date.now();
    try {
      let ev: Evaluation;
      try {
        ev = await evaluateSolvency(this.d.rpc, rule, p.contractId, { blockId: height });
      } catch (e) {
        // The RPC may not serve this height yet (or has garbage-collected it): read latest instead.
        if (!/UNKNOWN_BLOCK|GARBAGE_COLLECTED|not found|DB Not Found/i.test(String((e as Error).message))) throw e;
        ev = await evaluateSolvency(this.d.rpc, rule, p.contractId, { finality: "optimistic" });
      }
      this.d.store.recordEvaluation(p.id, ev);
      if (ev.ok) {
        if (s.openBreach) this.log(`${rule.id} healthy again at block ${ev.blockHeight}`);
        s.openBreach = undefined;
      } else if (!s.openBreach) {
        await this.fire(p, rule, ev, height, receipts);
      }
    } catch (e) {
      this.log(`evaluation of ${rule.id} failed: ${(e as Error).message}`);
    } finally {
      s.inflight = false;
      if (s.dirty) this.drain(p, rule);
    }
  }

  // ------------------------------------------------------ proposal firewall

  private proposalScans = new Map<string, ProposalScanState>();

  /** Read new proposals on a protected DAO and check each against the policy. */
  scanProposals(p: Protocol, rule: ProposalPolicyRule, height: number, receipts: StreamReceipt[]): Promise<void> {
    return scanProposalsImpl(this, this.proposalScans, this.d, this.log, p, rule, height, receipts);
  }

  // --------------------------------------------------------- outflow rate

  private trackOutflows(p: Protocol, rule: OutflowRateRule, b: BlockEvent, receipts: StreamReceipt[]): void {
    const k = this.key(p, rule);
    let w = this.windows.get(k);
    if (!w || w.rule !== rule) {
      w = new OutflowWindow(rule);
      this.windows.set(k, w);
    }
    for (const o of outflowsFrom(p.contractId, rule.token, b, receipts)) w.add(o);
  }

  private evaluateOutflow(p: Protocol, rule: OutflowRateRule, b: BlockEvent, receipts: StreamReceipt[]): void {
    const k = this.key(p, rule);
    const w = this.windows.get(k);
    if (!w) return;
    const ev = w.evaluate(b.timestampMs, b.height);
    this.d.store.recordEvaluation(p.id, ev);
    const s = this.state(k);
    if (ev.ok) s.openBreach = undefined;
    else if (!s.openBreach) void this.fire(p, rule, ev, b.height, receipts);
  }

  // ----------------------------------------------------------------- fire

  private async fire(p: Protocol, rule: Rule, ev: Evaluation, triggerBlock: number, receipts: StreamReceipt[]): Promise<void> {
    const s = this.state(this.key(p, rule));
    s.openBreach = "pending";
    const detectedMs = Date.now();
    const wantsPause = rule.response === "pause";
    const executor = wantsPause && p.guardianId ? this.d.executors.get(p.guardianId) : undefined;
    // The evidence hash covers the breaching evaluation; the confirmation is logged alongside it.
    const hash = evidenceHash(ev);
    // D3 confirmation read, the "already paused?" check and signing the pause run in parallel.
    // The pause is only broadcast if the confirmation read fails too.
    const [confirmation, alreadyPaused, prepared] = await Promise.all([
      rule.type === "solvency" ? evaluateSolvency(this.d.rpc, rule, p.contractId, { finality: "optimistic" }).catch(() => undefined) : Promise.resolve(undefined),
      wantsPause
        ? this.d.rpc
            .view<boolean>(p.contractId, "is_paused", {}, { finality: "optimistic" })
            .then((r) => r.value === true)
            .catch(() => false)
        : Promise.resolve(false),
      executor ? executor.prepare(p.contractId, rule.id, hash).catch(() => undefined) : Promise.resolve(undefined),
    ]);
    const confirmedMs = Date.now();
    if (rule.type === "solvency") {
      if (!confirmation) {
        s.openBreach = undefined;
        this.log(`${rule.id}: confirmation read failed; will re-evaluate on the next block`);
        return;
      }
      this.d.store.recordEvaluation(p.id, confirmation);
      if (confirmation.ok) {
        s.openBreach = undefined;
        this.log(`${rule.id} failed at ${ev.blockHeight} but passed the confirmation read at ${confirmation.blockHeight}; not firing`);
        return;
      }
    }
    const breach: Breach = {
      id: newId("brc"),
      protocolId: p.id,
      ruleId: rule.id,
      rule,
      detectedAtBlock: (confirmation ?? ev).blockHeight,
      triggerBlock,
      triggerReceipts: receipts.slice(0, 20).map((r) => ({
        receiptId: r.receiptId,
        txHash: r.txHash,
        predecessor: r.predecessor,
        receiver: r.receiver,
        method: r.actions.find((a) => a.method)?.method,
      })),
      evaluation: ev,
      confirmation,
      evidenceHash: hash,
      detectedAt: new Date(detectedMs).toISOString(),
      response: rule.response,
      alerts: [],
      timeline: {
        triggerBlockTimestampMs: this.blockTimes.get(triggerBlock)?.ts ?? 0,
        blockReceivedMs: this.blockTimes.get(triggerBlock)?.recv ?? detectedMs,
        detectedMs,
        confirmedMs,
      },
    };
    s.openBreach = breach.id;
    this.log(`BREACH ${rule.id} on ${p.contractId} at block ${triggerBlock} (confirmed at ${breach.detectedAtBlock})`);

    if (wantsPause) {
      if (alreadyPaused) {
        breach.pause = { status: "skipped", error: "contract had already paused itself (in-contract guard)" };
      } else if (!executor || !prepared) {
        breach.pause = {
          status: "failed",
          error: !p.guardianId ? "protocol has no guardian authorised" : !executor ? `no pause key loaded for guardian ${p.guardianId}` : "could not sign the pause transaction",
        };
      } else {
        breach.pause = { status: "sending", txHash: prepared.hash };
        this.d.store.putBreach(breach);
        const r = await executor.submit(prepared, detectedMs);
        breach.pause = {
          status: r.ok ? "landed" : "failed",
          txHash: r.txHash,
          provider: r.provider,
          pausedAtBlock: r.pausedAtBlock,
          blocksAfterBreach: r.pausedAtBlock !== undefined ? r.pausedAtBlock - triggerBlock : undefined,
          msAfterDetection: r.landedAtMs ? r.landedAtMs - detectedMs : undefined,
          error: r.error,
          guardianRecordIndex: r.guardianRecordIndex,
        };
        Object.assign(breach.timeline!, { broadcastMs: r.broadcastAtMs, landedMs: r.landedAtMs, txBlock: r.txBlock, guardianBlock: r.guardianBlock, pausedBlock: r.pausedAtBlock });
        this.log(r.ok ? `PAUSED ${p.contractId} at block ${r.pausedAtBlock} (${breach.pause.blocksAfterBreach} blocks after the breaking block)` : `pause FAILED: ${r.error}`);
      }
    } else {
      breach.pause = { status: "skipped", error: "alert-only rule" };
    }
    this.d.store.putBreach(breach);

    const msg = breachMessage(breach, this.d.statusUrl?.(p.id));
    breach.alerts = await this.d.alerter.send(msg.subject, msg.text, breach);
    this.d.store.putBreach(breach);

    // A7: explanation only after the pause has landed (or for alert-only rules), never before.
    if (this.d.explain) {
      this.d
        .explain(breach)
        .then((x) => {
          if (!x) return;
          breach.explanation = x;
          this.d.store.putBreach(breach);
          return this.d.alerter.send(`Explanation: ${rule.id}`, `AI explanation (${x.model}) for ${rule.id}:\n${x.text}`, { breachId: breach.id });
        })
        .catch((e) => this.log(`explanation failed: ${(e as Error).message}`));
    }
  }
}


// ------------------------------------------------------------------------
// Proposal firewall (Sputnik DAO)
// ------------------------------------------------------------------------

interface ProposalScanState {
  lastSeen?: number;
  seen: Set<number>;
  inflight: boolean;
  again?: { height: number; receipts: StreamReceipt[] };
}

async function scanProposalsImpl(
  w: Watcher,
  map: Map<string, ProposalScanState>,
  d: WatcherDeps,
  log: (s: string) => void,
  p: Protocol,
  rule: ProposalPolicyRule,
  height: number,
  receipts: StreamReceipt[],
): Promise<void> {
  const key = `${p.id}/${rule.id}`;
  let st = map.get(key);
  if (!st) map.set(key, (st = { seen: new Set(), inflight: false }));
  if (st.inflight) {
    st.again = { height, receipts: [...(st.again?.receipts ?? []), ...receipts] };
    return;
  }
  st.inflight = true;
  try {
    const last = (await d.rpc.view<number>(p.contractId, "get_last_proposal_id", {}, { finality: "optimistic" })).value;
    // On first sight, look back over recent proposals still open for votes.
    const from = st.lastSeen !== undefined ? st.lastSeen : Math.max(0, last - 25);
    if (last > from) {
      const proposals = (await d.rpc.view<SputnikProposal[]>(p.contractId, "get_proposals", { from_index: from, limit: Math.min(100, last - from) }, { finality: "optimistic" })).value;
      for (const prop of proposals) {
        if (st.seen.has(prop.id)) continue;
        st.seen.add(prop.id);
        if (prop.status !== "InProgress") continue;
        const ev = evaluateProposal(rule, prop, height);
        d.store.recordProposal(p.id, ev);
        d.store.recordEvaluation(p.id, ev);
        if (!ev.ok) await fireFirewall(d, log, p, rule, prop, ev, height, receipts);
      }
    }
    st.lastSeen = last;
  } catch (e) {
    log(`proposal scan of ${p.contractId} failed: ${(e as Error).message}`);
  } finally {
    st.inflight = false;
    if (st.again) {
      const a = st.again;
      st.again = undefined;
      void w.scanProposals(p, rule, a.height, a.receipts);
    }
  }
}

async function fireFirewall(d: WatcherDeps, log: (s: string) => void, p: Protocol, rule: ProposalPolicyRule, prop: SputnikProposal, ev: ReturnType<typeof evaluateProposal>, height: number, receipts: StreamReceipt[]) {
  const detectedMs = Date.now();
  const breach: Breach = {
    id: newId("fwl"),
    protocolId: p.id,
    ruleId: rule.id,
    rule,
    detectedAtBlock: height,
    triggerBlock: height,
    triggerReceipts: receipts.slice(0, 10).map((r) => ({ receiptId: r.receiptId, txHash: r.txHash, predecessor: r.predecessor, receiver: r.receiver, method: r.actions.find((a) => a.method)?.method })),
    evaluation: ev,
    evidenceHash: evidenceHash(ev),
    detectedAt: new Date(detectedMs).toISOString(),
    response: rule.response,
    alerts: [],
  };
  log(`FIREWALL proposal #${prop.id} on ${p.contractId}: ${ev.violations.join("; ")}`);
  if (shouldReject(rule, ev)) {
    const ex = d.rejecters?.get(p.contractId);
    if (!ex) {
      breach.vote = { status: "failed", error: `no firewall key loaded for ${p.contractId}` };
    } else {
      breach.vote = { status: "sending" };
      d.store.putBreach(breach);
      const r = await ex.reject(prop.id, prop.kind, `qorvex firewall (${rule.id}): ${ev.violations[0]}`);
      breach.vote = {
        status: r.ok ? "landed" : "failed",
        txHash: r.txHash,
        votedAtBlock: r.votedAtBlock,
        blocksAfterProposal: r.votedAtBlock !== undefined ? r.votedAtBlock - height : undefined,
        msAfterDetection: r.landedAtMs ? r.landedAtMs - detectedMs : undefined,
        proposalStatusAfter: r.statusAfter,
        error: r.error,
      };
      log(r.ok ? `REJECTED proposal #${prop.id} on ${p.contractId} at block ${r.votedAtBlock} (status now ${r.statusAfter})` : `firewall vote FAILED: ${r.error}`);
    }
  } else {
    breach.vote = { status: "skipped", error: rule.response === "reject" ? "governance change: alert only" : "alert-only rule" };
  }
  d.store.putBreach(breach);
  const msg = breachMessage(breach, d.statusUrl?.(p.id));
  breach.alerts = await d.alerter.send(msg.subject, msg.text, breach);
  d.store.putBreach(breach);
  if (d.explain) {
    d.explain(breach)
      .then((x) => {
        if (!x) return;
        breach.explanation = x;
        d.store.putBreach(breach);
      })
      .catch((e) => log(`proposal explanation failed: ${(e as Error).message}`));
  }
}

/** Outflows of `token` sent by `contract` in this block's receipts. */
export function outflowsFrom(contract: string, token: string, b: BlockEvent, receipts: StreamReceipt[]): Outflow[] {
  const out: Outflow[] = [];
  for (const r of receipts) {
    if (r.predecessor !== contract || r.status === "failure") continue;
    for (const a of r.actions) {
      if (token === "near" && a.kind === "Transfer" && a.deposit && a.deposit !== "0") {
        out.push({ receiptId: r.receiptId, txHash: r.txHash, blockHeight: b.height, timestampMs: b.timestampMs, from: contract, token, amount: BigInt(a.deposit), to: r.receiver });
      }
      if (token !== "near" && r.receiver === token && a.kind === "FunctionCall" && (a.method === "ft_transfer" || a.method === "ft_transfer_call")) {
        const args = a.args as { amount?: string; receiver_id?: string } | undefined;
        if (args?.amount && /^\d+$/.test(args.amount)) {
          out.push({ receiptId: r.receiptId, txHash: r.txHash, blockHeight: b.height, timestampMs: b.timestampMs, from: contract, token, amount: BigInt(args.amount), to: args.receiver_id });
        }
      }
    }
  }
  return out;
}
