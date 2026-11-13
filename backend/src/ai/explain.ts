/**
 * Breach explanation (A7). Called only after the pause has landed (or for an
 * alert-only rule after the alert), never on the pause path.
 */
import type { Breach } from "@qorvex/shared";
import { FixtureMissingError, type NearAiClient } from "./client.ts";
import { humanAmount } from "../near/tokens.ts";

/** Token decimals and symbol, so the model gets amounts in plain units instead of guessing the scale. */
export interface TokenUnits {
  decimals: number;
  symbol?: string;
}

function explainMessages(b: Breach, contract?: string, units?: TokenUnits) {
  const plain = (raw: string) => (units ? `${humanAmount(raw, units.decimals)}${units.symbol ? ` ${units.symbol}` : ""}` : undefined);
  const ev = b.evaluation;
  const facts = {
    contract,
    rule: b.rule,
    evaluation:
      ev.type === "solvency"
        ? {
            owed: ev.owed,
            held: ev.held,
            block: ev.blockHeight,
            ...(units
              ? { owed_plain: plain(ev.owed), held_plain: plain(ev.held), shortfall_plain: BigInt(ev.owed) > BigInt(ev.held) ? plain((BigInt(ev.owed) - BigInt(ev.held)).toString()) : plain("0") }
              : {}),
          }
        : ev,
    confirmation: b.confirmation && b.confirmation.type === "solvency" ? { owed: b.confirmation.owed, held: b.confirmation.held, block: b.confirmation.blockHeight } : undefined,
    triggerBlock: b.triggerBlock,
    receipts_in_breaking_block: b.triggerReceipts,
    qorvex_action:
      b.pause?.status === "landed"
        ? `Qorvex paused the contract through the guardian at block ${b.pause.pausedAtBlock}.`
        : b.pause?.status === "skipped"
          ? `Qorvex did not send a pause: ${b.pause.error}.`
          : `Pause status: ${b.pause?.status ?? "none"} ${b.pause?.error ?? ""}`,
  };
  return [
    {
      role: "system" as const,
      content:
        "You explain security incidents on NEAR smart contracts to the protocol's on-call engineer. The contract is already paused (or the rule is alert-only); you do not decide anything. Plain text, at most 8 short lines: what broke, by how much (give the difference, using the *_plain amounts when present), which accounts and receipts/transactions to check first, and the most likely cause based only on the receipts listed (e.g. a deposit that was refunded but stayed credited shows as an ft_on_transfer/resolve followed by ft_resolve_transfer). Describe Qorvex's action exactly as given in qorvex_action. If the data does not show the cause, say so instead of guessing.",
    },
    { role: "user" as const, content: JSON.stringify(facts) },
  ];
}

/** Decode a Sputnik proposal for the model: base64 args become JSON. */
function decodedProposal(kind: unknown): unknown {
  if (!kind || typeof kind !== "object") return kind;
  const k = kind as Record<string, any>;
  if (!k.FunctionCall) return k;
  const actions = (k.FunctionCall.actions as any[]).map((a) => {
    let args: unknown = a.args;
    try {
      args = JSON.parse(Buffer.from(a.args, "base64").toString("utf8"));
    } catch {
      /* keep base64 */
    }
    return { ...a, args };
  });
  // Long batches (the Trezu drain had 200 actions) are summarised: first 5 + count.
  return { FunctionCall: { receiver_id: k.FunctionCall.receiver_id, action_count: actions.length, first_actions: actions.slice(0, 5) } };
}

function proposalExplainMessages(b: Breach) {
  if (b.evaluation.type !== "proposal") throw new Error("not a proposal evaluation");
  const ev = b.evaluation;
  const facts = {
    dao_policy_rule: b.rule,
    proposal: { id: ev.proposalId, proposer: ev.proposer, kind: ev.kindLabel, decoded: decodedProposal(ev.kind) },
    deterministic_summary: ev.summary,
    violations: ev.violations,
    qorvex_action:
      b.vote?.status === "landed"
        ? `Qorvex voted VoteReject; the proposal is now ${b.vote.proposalStatusAfter}.`
        : b.vote?.status === "skipped"
          ? "Qorvex did NOT vote: this is an alert only. The proposal is still open and can be approved by the council."
          : `Qorvex tried to vote but failed: ${b.vote?.error ?? "unknown"}. The proposal is still open.`,
  };
  return [
    {
      role: "system" as const,
      content:
        "You explain Sputnik DAO proposals to the DAO's council members, who otherwise see raw base64 function-call arguments. The Qorvex firewall has already acted (or only alerted); you do not decide anything. Plain text, at most 7 short lines: what the proposal would do if executed (decode the calls), who benefits, why it breaks the DAO's policy, and what the council should check. Describe Qorvex's action exactly as given in qorvex_action; never say a proposal was blocked or rejected unless qorvex_action says so. Do not speculate beyond the data.",
    },
    { role: "user" as const, content: JSON.stringify(facts) },
  ];
}

/**
 * A recorded explanation names the block heights and receipts of the run it
 * was recorded in. Replayed for another incident, those identifiers are
 * swapped for the current incident's: the recorded and current facts have the
 * same shape, so every leaf that differs (and every number inside a differing
 * string) gives an old -> new pair. The model's reasoning is unchanged.
 */
export function retargetExplanation(text: string, recordedFacts: unknown, currentFacts: unknown): string {
  const pairs = new Map<string, string>();
  const add = (a: unknown, b: unknown) => {
    const x = String(a);
    const y = String(b);
    if (x !== y && x.length >= 3) pairs.set(x, y);
  };
  const walk = (a: unknown, b: unknown) => {
    if (a === null || b === null || a === undefined || b === undefined) return;
    if (typeof a === "object" && typeof b === "object") {
      for (const k of Object.keys(a as object)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
      return;
    }
    if (typeof a === "string" && typeof b === "string" && a !== b) {
      const na = a.match(/\d+/g) ?? [];
      const nb = b.match(/\d+/g) ?? [];
      if (na.length && na.length === nb.length && a.replace(/\d+/g, "#") === b.replace(/\d+/g, "#")) na.forEach((n, i) => add(n, nb[i]));
      else add(a, b);
      return;
    }
    if ((typeof a === "number" || typeof a === "string") && (typeof b === "number" || typeof b === "string")) add(a, b);
  };
  walk(recordedFacts, currentFacts);
  if (!pairs.size) return text;
  // One pass over the text, longest identifiers first, so a replaced value is never replaced again.
  const keys = [...pairs.keys()].sort((p, q) => q.length - p.length);
  const re = new RegExp(keys.map((k) => (/^\d+$/.test(k) ? `(?<![\\d.,])${k}(?![\\d])` : k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("|"), "g");
  return text.replace(re, (m) => pairs.get(m) ?? m);
}

export async function explainBreach(ai: NearAiClient, b: Breach, contract?: string, units?: TokenUnits): Promise<Breach["explanation"] | undefined> {
  let request: { messages: ReturnType<typeof explainMessages>; replayKey: object; maxTokens: number };
  if (b.evaluation.type === "proposal") {
    if (b.vote?.status === "sending") return undefined;
    // Replay keys are hashed into fixture file names: keep their fields and order stable.
    request = { messages: proposalExplainMessages(b), replayKey: { job: "explain-proposal", ruleId: b.ruleId, proposalId: b.evaluation.proposalId, summary: b.evaluation.summary }, maxTokens: 500 };
  } else {
    if (b.response === "pause" && b.pause?.status !== "landed" && b.pause?.status !== "skipped") return undefined;
    // The contract is part of the key: two contracts with the same rule id get their own explanation.
    request = { messages: explainMessages(b, contract), replayKey: { job: "explain-breach", contract: contract ?? null, ruleId: b.ruleId, ruleType: b.rule.type }, maxTokens: 600 };
    request.messages = explainMessages(b, contract, units);
  }
  try {
    const r = await ai.chat(ai.cfg.explainModel, request.messages, request.replayKey, { maxTokens: request.maxTokens });
    if (r.source === "replay" && r.recordedRequest) {
      const recorded = (r.recordedRequest as { messages?: { content?: string }[] }).messages?.[1]?.content;
      if (recorded) {
        try {
          r.text = retargetExplanation(r.text, JSON.parse(recorded), JSON.parse(request.messages[1].content));
        } catch {
          /* recorded facts not comparable: keep the text */
        }
      }
    }
    return { model: r.model, text: r.text.trim(), at: new Date().toISOString(), source: r.source === "replay" ? "replay" : "live" };
  } catch (e) {
    if (e instanceof FixtureMissingError) return undefined; // replay mode without a recording: no explanation
    throw e;
  }
}
