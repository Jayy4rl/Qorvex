/**
 * Rule templates (friction item 3): ready-made rules picked from what the
 * detection probes found, so an operator can protect a contract without
 * uploading source or waiting for an AI draft. A filled template becomes an
 * ordinary draft rule and goes through the same validator and backtest as
 * every AI-drafted or hand-written rule before anyone can approve it.
 */
import type { Budget, Detection, DraftRule, RuleTemplate } from "@qorvex/shared";
import { isAccountId } from "./validate.ts";

const NEAR_DECIMALS = 24;

/** "1.5" with 6 decimals -> "1500000". Rejects anything that is not a plain non-negative decimal. */
export function toUnits(human: string, decimals: number): string {
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(human.trim().replace(/_/g, ""));
  if (!m) throw new Error(`"${human}" is not an amount`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}

export function templatesFor(d: Detection): RuleTemplate[] {
  const out: RuleTemplate[] = [];
  const tok = d.guard ? "" : "near";
  if (d.kind !== "sputnik-dao") {
    out.push({
      id: "outflow-cap",
      title: "Outflow cap",
      explain: "Alert (or pause) when more than an amount of one token leaves the contract within a time window.",
      because: "Every contract that holds funds can be drained; a cap on outflows bounds the damage of any bug.",
      fields: [
        { name: "token", label: "Token contract (or near)", kind: "token", default: tok || "near", help: "The NEP-141 contract id, or near for native NEAR." },
        { name: "amount", label: "Maximum per window", kind: "amount", default: "10000", help: "In whole tokens, e.g. 10000 or 2.5." },
        { name: "window", label: "Window (seconds)", kind: "seconds", default: "3600" },
      ],
    });
  }
  if (d.kind === "qorvex-guard" || d.kind === "near-plugins" || d.kind === "unknown" || d.kind === "fungible-token") {
    out.push({
      id: "ledger-solvency",
      title: "Solvency: owed never exceeds held",
      explain: "Compare what the contract owes users (one of its views) with the tokens it actually holds (the token's ft_balance_of). Fires on the first unbacked credit.",
      because: d.guard
        ? "The contract embeds qorvex-guard, which tracks what it credits users; the NEAR Intents ghost-balance bug broke exactly this invariant."
        : "Ledger-style contracts that credit users must stay fully backed; this catches ghost balances like the NEAR Intents incident.",
      fields: [
        { name: "token", label: "Token contract", kind: "token", default: "", help: "The NEP-141 token the contract holds for users." },
        { name: "owedView", label: "View returning the total owed", kind: "method", default: d.guard ? "guard_status" : "total_owed", help: "A view method of this contract that returns the amount owed to users." },
        { name: "owedPath", label: "Path inside the result (optional)", kind: "method", default: d.guard ? "tallies.0.credited" : "", help: "Dot path when the amount is nested, e.g. total or tallies.0.credited." },
        { name: "owedArgs", label: "Arguments of that view (optional JSON)", kind: "method", default: "", help: 'e.g. {"token_id": "{token}"}; {token} is replaced with the token contract.' },
      ],
    });
  }
  if (d.kind === "sputnik-dao") {
    out.push({
      id: "treasury-policy",
      title: "Treasury proposal policy",
      explain: "Check every new proposal: cap transfers, cap actions per call (the Trezu drain used 200), and alert on governance changes. With the firewall role, Qorvex votes to reject proposals that break it.",
      because: "This account is a Sputnik DAO.",
      fields: [
        { name: "maxNear", label: "Max NEAR per transfer proposal", kind: "amount", default: "100" },
        { name: "maxActions", label: "Max actions in one call proposal", kind: "amount", default: "10" },
      ],
    });
  }
  return out;
}

export interface TemplateContext {
  contractId: string;
  /** Token decimals (ft_metadata), or NEAR's 24 for "near". */
  decimalsOf: (token: string) => Promise<number>;
}

/** Fill a template. Throws with a plain message on bad input; the caller then runs validateDraft + backtest. */
export async function instantiate(templateId: string, values: Record<string, string>, c: TemplateContext): Promise<DraftRule> {
  const v = (k: string, fallback = "") => String(values[k] ?? fallback).trim();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  if (templateId === "outflow-cap") {
    const token = v("token", "near");
    if (token !== "near" && !isAccountId(token)) throw new Error("token must be a NEP-141 contract id or near");
    const decimals = token === "near" ? NEAR_DECIMALS : await c.decimalsOf(token);
    const window = Number(v("window", "3600"));
    if (!Number.isInteger(window) || window < 60 || window > 30 * 86400) throw new Error("window must be between 60 seconds and 30 days");
    const amount = v("amount");
    return {
      id: `outflow-${slug(token)}`,
      type: "outflow_rate",
      token,
      max: toUnits(amount, decimals),
      window_sec: window,
      explain: `At most ${amount} ${token === "near" ? "NEAR" : token} may leave ${c.contractId} per ${window >= 3600 && window % 3600 === 0 ? `${window / 3600} hour(s)` : `${window} seconds`}.`,
    };
  }
  if (templateId === "ledger-solvency") {
    const token = v("token");
    if (!isAccountId(token)) throw new Error("token must be the NEP-141 contract id the contract holds");
    const owedView = v("owedView", "total_owed");
    const owedPath = v("owedPath");
    let owedArgs: Record<string, unknown> | undefined;
    if (v("owedArgs")) {
      try {
        owedArgs = JSON.parse(v("owedArgs").replaceAll("{token}", token));
      } catch {
        throw new Error("view arguments must be a JSON object");
      }
      if (!owedArgs || typeof owedArgs !== "object" || Array.isArray(owedArgs)) throw new Error("view arguments must be a JSON object");
    }
    return {
      id: `solvency-${slug(token)}`,
      type: "solvency",
      token,
      owed: { view: owedView, ...(owedArgs ? { args: owedArgs } : {}), ...(owedPath ? { path: owedPath } : {}) },
      held: { contract: token, view: "ft_balance_of", args: { account_id: c.contractId } },
      explain: `${token} owed to users by ${c.contractId} must never exceed the ${token} it holds.`,
    };
  }
  if (templateId === "treasury-policy") {
    const maxActions = Number(v("maxActions", "10"));
    if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new Error("max actions must be between 1 and 100");
    return {
      id: "treasury-policy",
      type: "proposal_policy",
      max_transfer: { near: toUnits(v("maxNear", "100"), NEAR_DECIMALS) },
      max_actions_per_call: maxActions,
      alert_on_governance: true,
      explain: `Transfers above ${v("maxNear", "100")} NEAR and call proposals with more than ${maxActions} actions break the treasury policy; governance changes alert.`,
    };
  }
  throw new Error(`unknown template ${templateId}`);
}

/** Starting budgets for a new gas-sponsor relayer (the Trezu #1871 shape). */
export function relayerBudgetTemplate(o: { dailyNear?: string; storageDeposits?: number; receivers?: string[] } = {}): Budget[] {
  return [
    {
      beneficiary: "*",
      window_sec: 86_400,
      max_cost_yocto: toUnits(o.dailyNear ?? "1", NEAR_DECIMALS),
      max_count: { storage_deposit: o.storageDeposits ?? 10 },
      ...(o.receivers?.length ? { allowed_receivers: o.receivers } : {}),
    },
  ];
}
