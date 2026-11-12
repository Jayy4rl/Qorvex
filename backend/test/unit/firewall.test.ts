import { describe, expect, it } from "vitest";
import { evaluateProposal, shouldReject, verifyFirewallPolicy, firewallRole, type SputnikProposal } from "../../src/firewall/policy.ts";
import type { ProposalPolicyRule } from "@qorvex/shared";
import { validateDraftShape } from "../../src/rules/validate.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const rule = (extra: Partial<ProposalPolicyRule> = {}): ProposalPolicyRule => ({
  id: "treasury-policy",
  type: "proposal_policy",
  explain: "Treasury proposals must stay within the DAO's limits",
  response: "reject",
  status: "approved",
  origin: { kind: "human", author: "t" },
  max_transfer: { "usdc.near": "10000000000", near: "5000000000000000000000000" },
  allowed_call_contracts: ["usdc.near", "wrap.near"],
  max_actions_per_call: 20,
  max_call_deposit_yocto: "1000000000000000000000000",
  ...extra,
});
const prop = (id: number, kind: SputnikProposal["kind"]): SputnikProposal => ({ id, proposer: "p.near", description: "", kind, status: "InProgress", vote_counts: {}, votes: {}, submission_time: "0" });

// Shapes copied from rawwheat-audit1.sputnik-dao.near (the DAO used in Trezu issue #1871), read from mainnet.
const drain200 = prop(13, { FunctionCall: { receiver_id: "capture.rawwheat7006.near", actions: Array.from({ length: 200 }, (_, i) => ({ method_name: "ft_transfer", args: b64({ receiver_id: `r${i}.near`, amount: "1" }), deposit: "1", gas: "5000000000000" })) } });
const sweep = prop(29, { FunctionCall: { receiver_id: "capture.rawwheat7006.near", actions: [{ method_name: "storage_deposit", args: b64({ account_id: "rawwheat7006.near", registration_only: true }), deposit: "950000000000000000000000", gas: "30000000000000" }] } });

describe("proposal firewall policy", () => {
  it("flags the Trezu drain proposals (200 ft_transfers to the attacker's own token)", () => {
    const ev = evaluateProposal(rule(), drain200, 1);
    expect(ev.ok).toBe(false);
    expect(ev.violations.join()).toMatch(/not on the allowed contracts list/);
    expect(ev.violations.join()).toMatch(/200 actions in one proposal \(max 20\)/);
    expect(ev.summary).toBe("Call capture.rawwheat7006.near: 200x ft_transfer; 0.00000 NEAR attached in total");
    expect(shouldReject(rule(), ev)).toBe(true);
  });

  it("flags the treasury sweep into the attacker contract even with one action", () => {
    const ev = evaluateProposal(rule({ max_call_deposit_yocto: "100000000000000000000000" }), sweep, 1);
    expect(ev.violations.some((v) => v.includes("attaches 0.95000 NEAR"))).toBe(true);
  });

  it("caps Transfer proposals per token and NEAR, and checks receivers", () => {
    const big = prop(1, { Transfer: { token_id: "usdc.near", receiver_id: "x.near", amount: "20000000000", msg: null } });
    expect(evaluateProposal(rule(), big, 1).violations[0]).toMatch(/exceeds the per-proposal cap/);
    const small = prop(2, { Transfer: { token_id: "usdc.near", receiver_id: "x.near", amount: "1000000", msg: null } });
    expect(evaluateProposal(rule(), small, 1).ok).toBe(true);
    const near = prop(3, { Transfer: { token_id: "", receiver_id: "x.near", amount: "6000000000000000000000000", msg: null } });
    expect(evaluateProposal(rule(), near, 1).ok).toBe(false);
    const recv = evaluateProposal(rule({ allowed_receivers: ["payroll.near"] }), small, 1);
    expect(recv.violations[0]).toMatch(/not on the allowed receivers list/);
  });

  it("counts ft_transfer amounts made through a FunctionCall against the token cap", () => {
    const viaCall = prop(4, { FunctionCall: { receiver_id: "usdc.near", actions: [{ method_name: "ft_transfer", args: b64({ receiver_id: "x.near", amount: "60000000000" }), deposit: "1", gas: "1" }] } });
    expect(evaluateProposal(rule(), viaCall, 1).violations.join()).toMatch(/above the cap/);
  });

  it("alerts on governance changes but never votes on them", () => {
    const gov = prop(5, { ChangePolicyRemoveRole: { role: "qorvex-firewall" } });
    const ev = evaluateProposal(rule({ alert_on_governance: true }), gov, 1);
    expect(ev.ok).toBe(false);
    expect(ev.governance).toBe(true);
    expect(shouldReject(rule({ alert_on_governance: true }), ev)).toBe(false);
    expect(evaluateProposal(rule(), gov, 1).ok).toBe(true);
  });

  it("alert-only rules never vote", () => {
    const ev = evaluateProposal(rule({ response: "alert" }), drain200, 1);
    expect(shouldReject(rule({ response: "alert" }), ev)).toBe(false);
  });

  it("validates the rule shape", () => {
    const { status, origin, response, ...draft } = rule();
    void status; void origin; void response;
    expect(validateDraftShape(draft)).toEqual([]);
    expect(validateDraftShape({ id: "x", type: "proposal_policy", explain: "a policy with no limits" })).toContain("a proposal_policy needs at least one limit");
    expect(validateDraftShape({ ...draft, max_transfer: { "BAD ID": "1" } }).length).toBeGreaterThan(0);
  });
});

describe("verifying the DAO gave Qorvex reject-only power", () => {
  const base = { default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] }, roles: [{ name: "council", kind: { Group: ["a.near"] }, permissions: ["*:*"], vote_policy: {} }] };
  it("accepts the role Qorvex proposes", () => {
    expect(verifyFirewallPolicy({ ...base, roles: [...base.roles, firewallRole("fw.near")] }, "fw.near")).toMatchObject({ ok: true, role: "qorvex-firewall" });
  });
  it("rejects a setup where the firewall could approve", () => {
    const pol = { ...base, roles: [{ ...base.roles[0], kind: { Group: ["a.near", "fw.near"] } }, firewallRole("fw.near")] };
    expect(verifyFirewallPolicy(pol, "fw.near").problems.join()).toMatch(/must not be able to approve/);
  });
  it("rejects extra permissions and thresholds one vote cannot reach", () => {
    const r = firewallRole("fw.near");
    const pol = { ...base, roles: [...base.roles, { ...r, kind: { Group: ["fw.near", "b.near", "c.near"] }, permissions: [...r.permissions, "policy:VoteReject"], vote_policy: {} }] };
    const v = verifyFirewallPolicy(pol, "fw.near");
    expect(v.problems.join()).toMatch(/extra permissions/);
    expect(v.problems.join()).toMatch(/does not reach the transfer reject threshold/);
  });
  it("reports a missing role", () => {
    expect(verifyFirewallPolicy(base, "fw.near").ok).toBe(false);
  });
});
