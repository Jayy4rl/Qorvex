/**
 * Proposal firewall policy evaluation. Pure and deterministic: the decision
 * to vote VoteReject is made here, never by the AI.
 *
 * Input is a Sputnik DAO v2 `ProposalOutput` as returned by `get_proposal` /
 * `get_proposals` (shape checked against sputnik-dao-contract v2.3.1, the
 * code mainnet sputnik-dao.near deploys today).
 */
import type { ProposalEvaluation, ProposalKind, ProposalPolicyRule } from "@qorvex/shared";

interface SputnikActionCall {
  method_name: string;
  args: string; // base64
  deposit: string;
  gas: string;
}

export interface SputnikProposal {
  id: number;
  proposer: string;
  description: string;
  kind: ProposalKind;
  status: string;
  vote_counts: Record<string, [string, string, string]>;
  votes: Record<string, "Approve" | "Reject" | "Remove">;
  submission_time: string;
}

const TOKEN_METHODS = new Set(["ft_transfer", "ft_transfer_call"]);
const GOVERNANCE_KINDS = new Set([
  "ChangeConfig",
  "ChangePolicy",
  "AddMemberToRole",
  "RemoveMemberFromRole",
  "UpgradeSelf",
  "UpgradeRemote",
  "SetStakingContract",
  "FactoryInfoUpdate",
  "ChangePolicyAddOrUpdateRole",
  "ChangePolicyRemoveRole",
  "ChangePolicyUpdateDefaultVotePolicy",
  "ChangePolicyUpdateParameters",
]);

export function kindLabel(kind: SputnikProposal["kind"]): string {
  return typeof kind === "string" ? kind : Object.keys(kind)[0] ?? "Unknown";
}

function decodeArgs(b64: string): any {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

const fmtYocto = (y: bigint) => {
  const s = y.toString().padStart(25, "0");
  return `${s.slice(0, -24).replace(/^0+(?=\d)/, "")}.${s.slice(-24, -19)} NEAR`;
};

/** Plain description of what a proposal does (deterministic, no AI). */
export function describeProposal(p: SputnikProposal): string {
  const label = kindLabel(p.kind);
  const k = typeof p.kind === "string" ? {} : p.kind[label];
  if (label === "Transfer") {
    const token = k.token_id === "" ? "NEAR" : k.token_id;
    return `Transfer ${k.amount} (${token === "NEAR" ? fmtYocto(BigInt(k.amount)) : `raw units of ${token}`}) to ${k.receiver_id}`;
  }
  if (label === "FunctionCall") {
    const counts = new Map<string, number>();
    let deposit = 0n;
    for (const a of k.actions as SputnikActionCall[]) {
      counts.set(a.method_name, (counts.get(a.method_name) ?? 0) + 1);
      deposit += BigInt(a.deposit);
    }
    const m = [...counts].map(([n, c]) => `${c}x ${n}`).join(", ");
    return `Call ${k.receiver_id}: ${m}; ${fmtYocto(deposit)} attached in total`;
  }
  return `${label} (governance)`;
}

/** Check one proposal against the policy. */
export function evaluateProposal(rule: ProposalPolicyRule, p: SputnikProposal, blockHeight: number): ProposalEvaluation {
  const label = kindLabel(p.kind);
  const k: any = typeof p.kind === "string" ? {} : p.kind[label];
  const v: string[] = [];
  const cap = (token: string) => rule.max_transfer?.[token];
  const recvOk = (r: string) => !rule.allowed_receivers || rule.allowed_receivers.includes(r);

  if (label === "Transfer") {
    const token = k.token_id === "" ? "near" : String(k.token_id);
    const c = cap(token);
    if (c !== undefined && BigInt(k.amount) > BigInt(c)) v.push(`transfer of ${k.amount} ${token} exceeds the per-proposal cap ${c}`);
    if (!recvOk(k.receiver_id)) v.push(`receiver ${k.receiver_id} is not on the allowed receivers list`);
  } else if (label === "FunctionCall") {
    const actions: SputnikActionCall[] = k.actions ?? [];
    if (rule.allowed_call_contracts && !rule.allowed_call_contracts.includes(k.receiver_id))
      v.push(`calls ${k.receiver_id}, which is not on the allowed contracts list`);
    if (rule.max_actions_per_call !== undefined && actions.length > rule.max_actions_per_call)
      v.push(`${actions.length} actions in one proposal (max ${rule.max_actions_per_call})`);
    const deposit = actions.reduce((a, x) => a + BigInt(x.deposit), 0n);
    if (rule.max_call_deposit_yocto !== undefined && deposit > BigInt(rule.max_call_deposit_yocto))
      v.push(`attaches ${fmtYocto(deposit)} in total (max ${fmtYocto(BigInt(rule.max_call_deposit_yocto))})`);
    // Token transfers made through a FunctionCall count against the same caps.
    let tokenTotal = 0n;
    const badReceivers = new Set<string>();
    for (const a of actions) {
      if (!TOKEN_METHODS.has(a.method_name)) continue;
      const args = decodeArgs(a.args);
      if (args?.amount && /^\d+$/.test(String(args.amount))) tokenTotal += BigInt(args.amount);
      if (args?.receiver_id && !recvOk(args.receiver_id)) badReceivers.add(args.receiver_id);
    }
    const c = cap(k.receiver_id);
    if (c !== undefined && tokenTotal > BigInt(c)) v.push(`moves ${tokenTotal} of ${k.receiver_id} through ${k.receiver_id}.ft_transfer, above the cap ${c}`);
    if (badReceivers.size) v.push(`token transfers to ${badReceivers.size} receiver(s) not on the allowed list (e.g. ${[...badReceivers][0]})`);
  }
  const governance = !!rule.alert_on_governance && GOVERNANCE_KINDS.has(label);
  return {
    ruleId: rule.id,
    type: "proposal",
    ok: v.length === 0 && !governance,
    governance,
    blockHeight,
    proposalId: p.id,
    proposer: p.proposer,
    kindLabel: label,
    summary: describeProposal(p),
    violations: governance && v.length === 0 ? [`governance change (${label}) — alert only`] : v,
    kind: p.kind,
    at: new Date().toISOString(),
  };
}

/** True when the firewall should vote VoteReject (governance-only flags never vote). */
export function shouldReject(rule: ProposalPolicyRule, ev: ProposalEvaluation): boolean {
  // The firewall role can only reject transfer/call proposals; governance flags are alerts.
  return rule.response === "reject" && !ev.ok && (ev.kindLabel === "Transfer" || ev.kindLabel === "FunctionCall");
}

/** The DAO role that gives Qorvex reject-only power (what the DAO votes to add). */
export function firewallRole(firewallAccount: string, name = "qorvex-firewall") {
  const vp = { weight_kind: "RoleWeight", quorum: "0", threshold: "1" };
  return {
    name,
    kind: { Group: [firewallAccount] },
    permissions: ["transfer:VoteReject", "call:VoteReject"],
    vote_policy: { transfer: vp, call: vp },
  };
}

/**
 * Check a DAO policy grants the firewall account reject-only power: it must be
 * in a role whose permissions are exactly VoteReject on transfer/call, with a
 * reject threshold of one vote, and in no role that can approve anything.
 */
export function verifyFirewallPolicy(policy: any, firewallAccount: string): { ok: boolean; problems: string[]; role?: string } {
  const problems: string[] = [];
  const roles: any[] = policy?.roles ?? [];
  const mine = roles.filter((r) => r.kind?.Group?.includes(firewallAccount) || r.kind === "Everyone" || r.kind?.Member);
  const firewall = mine.find((r) => r.kind?.Group?.includes(firewallAccount) && r.permissions?.some((x: string) => x.endsWith(":VoteReject")));
  if (!firewall) problems.push(`no role in the DAO policy gives ${firewallAccount} VoteReject`);
  for (const r of mine) {
    for (const perm of r.permissions ?? []) {
      const [, action] = perm.split(":");
      if (action === "VoteApprove" || action === "*") problems.push(`role ${r.name} lets ${r.kind === "Everyone" ? "everyone (including the firewall)" : firewallAccount} ${perm} — the firewall must not be able to approve`);
    }
  }
  if (firewall) {
    const extra = (firewall.permissions as string[]).filter((p) => !["transfer:VoteReject", "call:VoteReject"].includes(p));
    if (extra.length) problems.push(`firewall role ${firewall.name} has extra permissions: ${extra.join(", ")}`);
    const members = firewall.kind.Group.length;
    for (const label of ["transfer", "call"]) {
      const vp = firewall.vote_policy?.[label] ?? policy.default_vote_policy;
      const t = vp?.threshold;
      const weight = Array.isArray(t) ? Math.min(Math.floor((t[0] * members) / t[1]) + 1, members) : Math.min(Number(t), members);
      const need = Math.max(Number(vp?.quorum ?? 0), weight);
      if (need > 1) problems.push(`one firewall vote does not reach the ${label} reject threshold of role ${firewall.name} (needs ${need})`);
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], role: firewall?.name };
}
