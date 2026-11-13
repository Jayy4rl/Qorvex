/**
 * Server-side relayer checks (friction item 4).
 *
 * The in-process SDK kept spend history per process, so two relayer
 * instances could each spend a full budget. Here every `check()` is decided
 * by the server in one SQLite transaction (BEGIN IMMEDIATE) against the
 * shared spend history, so concurrent instances queue and can never both
 * squeeze under a cap. The decision engine is the same pure `decide()`.
 */
import crypto from "node:crypto";
import type { Decision, ProposalPolicy, Relayer } from "@qorvex/shared";
import { txWhenFree, type Db } from "../db/db.ts";
import { decide, type CheckRequest } from "./budgets.ts";
import { evaluateProposal, type SputnikProposal } from "../firewall/policy.ts";

/** Longest budget window the validator allows (30 days); older spend rows are pruned. */
const MAX_WINDOW_MS = 30 * 86_400_000;

export function serverCheck(db: Db, relayer: Relayer, req: CheckRequest, now = Date.now()): Promise<Decision> {
  return txWhenFree(db, () => {
    const longest = Math.max(1, ...relayer.budgets.map((b) => b.window_sec)) * 1000;
    const rows = db
      .prepare("SELECT at, beneficiary, action, receiver, cost FROM relayer_spend WHERE relayer_id = ? AND beneficiary = ? AND at >= ?")
      .all(relayer.id, req.beneficiary, now - longest) as { at: number; beneficiary: string; action: string; receiver: string | null; cost: string }[];
    const history: Decision[] = rows.map((r, i) => ({ id: `h${i}`, at: r.at, beneficiary: r.beneficiary, action: r.action, receiver: r.receiver ?? undefined, cost: r.cost, allow: true, reason: "", basis: "budget" }));
    const d = decide(relayer.budgets, history, req, now, `dec_${crypto.randomBytes(6).toString("hex")}`);
    if (d.allow) {
      db.prepare("INSERT INTO relayer_spend (relayer_id, at, beneficiary, action, receiver, cost) VALUES (?, ?, ?, ?, ?, ?)").run(relayer.id, now, d.beneficiary, d.action, d.receiver ?? null, d.cost);
    }
    if (Math.random() < 0.01) db.prepare("DELETE FROM relayer_spend WHERE at < ?").run(now - MAX_WINDOW_MS);
    return d;
  });
}

export function serverCheckProposal(policy: ProposalPolicy | undefined, dao: string, proposal: SputnikProposal, now = Date.now()): Decision {
  const id = `dec_${crypto.randomBytes(6).toString("hex")}`;
  const base = { id, at: now, beneficiary: dao, action: "approve_proposal", cost: "0", meta: { proposalId: proposal.id } };
  if (!policy) return { ...base, allow: true, reason: "no proposal policy configured", basis: "proposal-policy" };
  const ev = evaluateProposal({ ...policy, status: "approved", response: "reject", origin: { kind: "human", author: "relayer" } }, proposal, 0);
  const receiver = typeof proposal.kind === "object" ? (Object.values(proposal.kind)[0] as { receiver_id?: string })?.receiver_id : undefined;
  return { ...base, receiver, allow: ev.violations.length === 0, reason: ev.violations.length ? `proposal #${proposal.id}: ${ev.violations.join("; ")}` : `proposal #${proposal.id} within policy`, basis: "proposal-policy" };
}
