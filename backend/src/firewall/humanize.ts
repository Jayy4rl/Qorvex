/**
 * Human-readable form of a proposal policy's limits, using each token's
 * on-chain ft_metadata decimals. Shown next to the rule so a reviewer can see
 * units mistakes (e.g. a sentence that says "10,000 NEAR" for a 10 NEAR cap).
 */
import type { ProposalPolicyLimits } from "@qorvex/shared";
import type { NearRpc } from "../near/rpc.ts";
import { cachedTokenMeta, humanAmount } from "../near/tokens.ts";

export async function humanizePolicy(rpc: NearRpc, rule: ProposalPolicyLimits): Promise<string> {
  const parts: string[] = [];
  for (const [token, cap] of Object.entries(rule.max_transfer ?? {})) {
    if (token === "near") {
      parts.push(`at most ${humanAmount(cap, 24)} NEAR per transfer`);
      continue;
    }
    const m = await cachedTokenMeta(rpc, token);
    parts.push(m.decimals !== undefined ? `at most ${humanAmount(cap, m.decimals)} ${m.symbol ?? token} per proposal` : `at most ${cap} raw units of ${token} (no ft_metadata)`);
  }
  if (rule.allowed_call_contracts) parts.push(`calls only to ${rule.allowed_call_contracts.join(", ")}`);
  if (rule.allowed_receivers) parts.push(`payments only to ${rule.allowed_receivers.join(", ")}`);
  if (rule.max_actions_per_call !== undefined) parts.push(`at most ${rule.max_actions_per_call} actions per call proposal`);
  if (rule.max_call_deposit_yocto !== undefined) parts.push(`at most ${humanAmount(rule.max_call_deposit_yocto, 24)} NEAR attached per call proposal`);
  if (rule.alert_on_governance) parts.push("alert on governance changes");
  return parts.join("; ");
}
