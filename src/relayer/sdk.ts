/**
 * Qorvex relayer SDK (P4, P5).
 *
 *   const guard = new QorvexRelayerGuard({ relayerId, apiUrl, apiToken });
 *   const d = await guard.check(treasuryId, "storage_deposit", costYocto, { receiver: tokenId });
 *   if (!d.allow) refuse(d.reason); else signAndSend();
 *
 * - Budgets are edited in the Qorvex console and pulled by the SDK, cached
 *   locally (P5). If Qorvex is unreachable the last cached budgets keep
 *   working; with no budgets at all the SDK fails closed or open according to
 *   the operator's setting.
 * - Checks are serialised, so concurrent requests cannot both squeeze under
 *   a cap.
 * - Every decision is kept locally and shipped to the Qorvex API (P4).
 *
 * Spend history lives in this process. Run one SDK instance per relayer
 * process, or put the relayer behind one signer; see README limitations.
 */
import crypto from "node:crypto";
import { decide, type Budget, type Decision } from "./budgets.ts";
import { evaluateProposal, type SputnikProposal } from "../firewall/policy.ts";
import type { ProposalPolicy } from "../store/store.ts";

export interface RelayerGuardOptions {
  relayerId: string;
  /** Qorvex API base URL, e.g. http://localhost:8787. Omit to use local budgets only. */
  apiUrl?: string;
  apiToken?: string;
  /** Local budgets (used when no apiUrl, and as the initial cache). */
  budgets?: Budget[];
  /** Local proposal policy (pulled from Qorvex with the budgets when apiUrl is set). */
  proposalPolicy?: ProposalPolicy;
  failMode?: "closed" | "open";
  cacheTtlMs?: number;
  flushMs?: number;
  now?: () => number;
}

export class QorvexRelayerGuard {
  private budgets: Budget[] | null;
  private proposalPolicy: ProposalPolicy | undefined;
  private fetchedAt = 0;
  private failMode: "closed" | "open";
  private history: Decision[] = [];
  private outbox: Decision[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(private readonly o: RelayerGuardOptions) {
    this.budgets = o.budgets ?? null;
    this.proposalPolicy = o.proposalPolicy;
    this.failMode = o.failMode ?? "closed";
    this.now = o.now ?? Date.now;
    if (o.apiUrl) this.timer = setInterval(() => void this.flush(), o.flushMs ?? 1000);
  }

  /** Decide one sponsored action before signing it. */
  check(beneficiary: string, action: string, cost: bigint | string, extra: { receiver?: string; meta?: Record<string, unknown> } = {}): Promise<Decision> {
    const run = this.lock.then(() => this.checkNow(beneficiary, action, cost, extra));
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async checkNow(beneficiary: string, action: string, cost: bigint | string, extra: { receiver?: string; meta?: Record<string, unknown> }): Promise<Decision> {
    await this.refreshBudgets();
    const id = `dec_${crypto.randomBytes(6).toString("hex")}`;
    const now = this.now();
    let d: Decision;
    if (!this.budgets) {
      const allow = this.failMode === "open";
      d = {
        id,
        at: now,
        beneficiary,
        action,
        cost: BigInt(cost).toString(),
        receiver: extra.receiver,
        allow,
        reason: allow ? "Qorvex unreachable and no cached budgets: failing open" : "Qorvex unreachable and no cached budgets: failing closed",
        basis: allow ? "fail-open" : "fail-closed",
        meta: extra.meta,
      };
    } else {
      d = decide(this.budgets, this.history, { beneficiary, action, cost, receiver: extra.receiver, meta: extra.meta }, now, id);
    }
    if (d.allow) this.history.push(d);
    // keep only the last day of history
    const cutoff = now - 86_400_000;
    if (this.history.length > 5000 || (this.history[0] && this.history[0].at < cutoff)) this.history = this.history.filter((x) => x.at >= cutoff).slice(-5000);
    this.outbox.push(d);
    return d;
  }

  private async refreshBudgets(): Promise<void> {
    if (!this.o.apiUrl) return;
    if (this.budgets && this.now() - this.fetchedAt < (this.o.cacheTtlMs ?? 10_000)) return;
    try {
      const res = await fetch(`${this.o.apiUrl}/api/relayers/${encodeURIComponent(this.o.relayerId)}/budgets`, {
        headers: { authorization: `Bearer ${this.o.apiToken ?? ""}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { budgets: Budget[]; failMode: "closed" | "open"; proposalPolicy?: ProposalPolicy };
      this.budgets = body.budgets;
      this.proposalPolicy = body.proposalPolicy;
      this.failMode = body.failMode;
      this.fetchedAt = this.now();
    } catch {
      // keep the cached budgets (P5); failMode applies only when there are none
    }
  }

  /**
   * Before sponsoring an approval vote on a DAO proposal (e.g. a Trezu
   * treasury approval relayed as a meta-transaction), check the proposal
   * itself against the relayer's proposal policy. This protects the sponsor
   * even when the DAO is controlled by the attacker, as in Trezu issue #1871.
   */
  checkProposal(dao: string, proposal: SputnikProposal): Promise<Decision> {
    const run = this.lock.then(async () => {
      await this.refreshBudgets();
      const id = `dec_${crypto.randomBytes(6).toString("hex")}`;
      const base = { id, at: this.now(), beneficiary: dao, action: "approve_proposal", cost: "0", meta: { proposalId: proposal.id } };
      let d: Decision;
      if (!this.proposalPolicy) {
        const allow = this.budgets ? true : this.failMode === "open";
        d = { ...base, allow, reason: this.budgets ? "no proposal policy configured" : `Qorvex unreachable: failing ${this.failMode}`, basis: this.budgets ? "proposal-policy" : allow ? "fail-open" : "fail-closed" };
      } else {
        const ev = evaluateProposal({ ...this.proposalPolicy, status: "approved", response: "reject", origin: { kind: "human", author: "relayer" } }, proposal, 0);
        const receiver = typeof proposal.kind === "object" ? (Object.values(proposal.kind)[0] as any)?.receiver_id : undefined;
        d = { ...base, receiver, allow: ev.violations.length === 0, reason: ev.violations.length ? `proposal #${proposal.id}: ${ev.violations.join("; ")}` : `proposal #${proposal.id} within policy`, basis: "proposal-policy" };
      }
      this.outbox.push(d);
      return d;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Ship logged decisions to Qorvex. */
  async flush(): Promise<void> {
    if (!this.o.apiUrl || this.outbox.length === 0) return;
    const batch = this.outbox.splice(0, 500);
    try {
      const res = await fetch(`${this.o.apiUrl}/api/relayers/${encodeURIComponent(this.o.relayerId)}/decisions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiToken ?? ""}` },
        body: JSON.stringify({ decisions: batch }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      this.outbox.unshift(...batch);
    }
  }

  decisions(): Decision[] {
    return [...this.history];
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
