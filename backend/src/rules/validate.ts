/**
 * Rule validation.
 *
 * The AI drafts rules in exactly the JSON shape of the rule types in
 * @qorvex/shared (A4); `validateDraftShape` is the first gate every draft,
 * every hand-written rule and every edit passes through (A5).
 */
import type { Rule } from "@qorvex/shared";

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const METHOD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export function isAccountId(s: unknown): s is string {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && ACCOUNT_RE.test(s);
}

function checkViewRef(v: unknown, where: string, errors: string[]): void {
  if (!v || typeof v !== "object") {
    errors.push(`${where} must be an object`);
    return;
  }
  const r = v as Record<string, unknown>;
  if (typeof r.view !== "string" || !METHOD_RE.test(r.view)) errors.push(`${where}.view must be a method name`);
  if (r.contract !== undefined && !isAccountId(r.contract)) errors.push(`${where}.contract must be a NEAR account id`);
  if (r.args !== undefined && (typeof r.args !== "object" || r.args === null || Array.isArray(r.args)))
    errors.push(`${where}.args must be an object`);
  if (r.path !== undefined && (typeof r.path !== "string" || !/^[A-Za-z0-9_.]+$/.test(r.path)))
    errors.push(`${where}.path must be a dot path`);
  for (const k of Object.keys(r)) if (!["contract", "view", "args", "path"].includes(k)) errors.push(`${where}.${k} is not allowed`);
}

/** Validate the shape of a drafted rule. Returns a list of errors (empty = ok). */
export function validateDraftShape(x: unknown): string[] {
  const errors: string[] = [];
  if (!x || typeof x !== "object" || Array.isArray(x)) return ["rule must be an object"];
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) errors.push("id must match ^[a-z0-9][a-z0-9_.:-]{0,63}$");
  if (typeof r.explain !== "string" || r.explain.trim().length < 10 || r.explain.length > 300)
    errors.push("explain must be a plain-English sentence (10-300 chars)");
  if (r.type === "solvency") {
    if (typeof r.token !== "string" || r.token.length === 0 || r.token.length > 128) errors.push("token is required");
    checkViewRef(r.owed, "owed", errors);
    checkViewRef(r.held, "held", errors);
    for (const k of Object.keys(r)) if (!["id", "type", "token", "owed", "held", "explain"].includes(k)) errors.push(`field ${k} is not allowed`);
  } else if (r.type === "outflow_rate") {
    if (typeof r.max !== "string" || !/^\d+$/.test(r.max)) errors.push("max must be a decimal integer string (smallest units)");
    if (typeof r.window_sec !== "number" || !Number.isInteger(r.window_sec) || r.window_sec < 1 || r.window_sec > 30 * 86400)
      errors.push("window_sec must be an integer between 1 and 2592000");
    if (r.token !== "near" && !isAccountId(r.token)) errors.push('token must be a token contract id or "near"');
    for (const k of Object.keys(r)) if (!["id", "type", "token", "max", "window_sec", "explain"].includes(k)) errors.push(`field ${k} is not allowed`);
  } else if (r.type === "proposal_policy") {
    const allowed = ["id", "type", "explain", "max_transfer", "allowed_receivers", "allowed_call_contracts", "max_actions_per_call", "max_call_deposit_yocto", "alert_on_governance"];
    for (const k of Object.keys(r)) if (!allowed.includes(k)) errors.push(`field ${k} is not allowed`);
    if (r.max_transfer !== undefined) {
      if (!r.max_transfer || typeof r.max_transfer !== "object" || Array.isArray(r.max_transfer)) errors.push("max_transfer must be an object {token: amount}");
      else
        for (const [k, v] of Object.entries(r.max_transfer as Record<string, unknown>)) {
          if (k !== "near" && !isAccountId(k)) errors.push(`max_transfer key ${k} must be a token contract id or "near"`);
          if (typeof v !== "string" || !/^\d+$/.test(v)) errors.push(`max_transfer.${k} must be a decimal string`);
        }
    }
    for (const f of ["allowed_receivers", "allowed_call_contracts"]) {
      const v = r[f];
      if (v !== undefined && !(Array.isArray(v) && v.every(isAccountId))) errors.push(`${f} must be a list of account ids`);
    }
    if (r.max_actions_per_call !== undefined && !(Number.isInteger(r.max_actions_per_call) && (r.max_actions_per_call as number) >= 1))
      errors.push("max_actions_per_call must be an integer >= 1");
    if (r.max_call_deposit_yocto !== undefined && !(typeof r.max_call_deposit_yocto === "string" && /^\d+$/.test(r.max_call_deposit_yocto)))
      errors.push("max_call_deposit_yocto must be a decimal string");
    if (r.alert_on_governance !== undefined && typeof r.alert_on_governance !== "boolean") errors.push("alert_on_governance must be a boolean");
    if (!["max_transfer", "allowed_receivers", "allowed_call_contracts", "max_actions_per_call", "max_call_deposit_yocto", "alert_on_governance"].some((k) => r[k] !== undefined))
      errors.push("a proposal_policy needs at least one limit");
  } else {
    errors.push('type must be "solvency", "outflow_rate" or "proposal_policy"');
  }
  return errors;
}

/** Every account a rule reads from or watches, given the protected contract. */
export function accountsTouchedBy(rule: Rule, protectedContract: string): string[] {
  const s = new Set<string>([protectedContract]);
  if (rule.type === "solvency") {
    s.add(rule.owed.contract ?? protectedContract);
    s.add(rule.held.contract ?? protectedContract);
  } else if (rule.type === "outflow_rate" && rule.token !== "near") {
    s.add(rule.token);
  }
  return [...s];
}
