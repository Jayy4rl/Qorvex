/**
 * Budget engine for relayers and gas sponsors (P4). Pure and deterministic:
 * the same budgets and history always give the same decision.
 *
 * A budget applies to one beneficiary (e.g. a treasury / DAO account) or to
 * every beneficiary ("*"). Within a rolling window it caps:
 *  - total sponsored cost (yoctoNEAR),
 *  - the number of calls per action (e.g. storage_deposit),
 * and optionally restricts which contracts the sponsor may pay into
 * (the allowlist whose absence caused Trezu issue #1871).
 */

export interface Budget {
  beneficiary: string; // account id or "*"
  window_sec: number;
  max_cost_yocto?: string;
  max_count?: Record<string, number>;
  allowed_receivers?: string[];
}

export interface CheckRequest {
  beneficiary: string;
  action: string;
  /** Cost the sponsor pays, in yoctoNEAR (deposit + gas estimate). */
  cost: string | bigint;
  /** Contract the sponsored call goes to, if any. */
  receiver?: string;
  meta?: Record<string, unknown>;
}

export interface Decision {
  id: string;
  at: number; // ms
  beneficiary: string;
  action: string;
  cost: string;
  receiver?: string;
  allow: boolean;
  reason: string;
  /** "budget" when budgets decided; "fail-open"/"fail-closed" when none were available. */
  basis: "budget" | "no-budget" | "fail-open" | "fail-closed" | "proposal-policy";
  meta?: Record<string, unknown>;
}

const YOCTO_PER_NEAR = 10n ** 24n;

export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, 5).replace(/0+$/, "");
  return frac ? `${whole}.${frac} NEAR` : `${whole} NEAR`;
}

export function budgetsFor(budgets: Budget[], beneficiary: string): Budget[] {
  const exact = budgets.filter((b) => b.beneficiary === beneficiary);
  return exact.length ? exact : budgets.filter((b) => b.beneficiary === "*");
}

export function validateBudget(b: unknown): string[] {
  const e: string[] = [];
  if (!b || typeof b !== "object") return ["budget must be an object"];
  const x = b as Record<string, unknown>;
  if (typeof x.beneficiary !== "string" || x.beneficiary.length < 1) e.push("beneficiary required (account id or *)");
  if (typeof x.window_sec !== "number" || x.window_sec < 1) e.push("window_sec must be >= 1");
  if (x.max_cost_yocto !== undefined && !(typeof x.max_cost_yocto === "string" && /^\d+$/.test(x.max_cost_yocto)))
    e.push("max_cost_yocto must be a decimal string");
  if (x.max_count !== undefined) {
    if (typeof x.max_count !== "object" || x.max_count === null) e.push("max_count must be an object");
    else for (const [k, v] of Object.entries(x.max_count)) if (!Number.isInteger(v) || (v as number) < 0) e.push(`max_count.${k} must be an integer >= 0`);
  }
  if (x.allowed_receivers !== undefined && !(Array.isArray(x.allowed_receivers) && x.allowed_receivers.every((r) => typeof r === "string")))
    e.push("allowed_receivers must be a list of account ids");
  return e;
}

/**
 * Decide one request against budgets and the allowed history.
 * `history` must contain previous *allowed* decisions (denials do not spend).
 */
export function decide(budgets: Budget[], history: Decision[], req: CheckRequest, now: number, id: string): Decision {
  const cost = BigInt(req.cost);
  const base = { id, at: now, beneficiary: req.beneficiary, action: req.action, cost: cost.toString(), receiver: req.receiver, meta: req.meta };
  const applicable = budgetsFor(budgets, req.beneficiary);
  if (applicable.length === 0) {
    return { ...base, allow: false, reason: `no budget covers beneficiary ${req.beneficiary}`, basis: "no-budget" };
  }
  for (const b of applicable) {
    if (b.allowed_receivers && req.receiver && !b.allowed_receivers.includes(req.receiver)) {
      return { ...base, allow: false, reason: `receiver ${req.receiver} is not on the sponsor allowlist`, basis: "budget" };
    }
    const since = now - b.window_sec * 1000;
    const inWindow = history.filter((d) => d.allow && d.beneficiary === req.beneficiary && d.at >= since);
    if (b.max_cost_yocto !== undefined) {
      const spent = inWindow.reduce((a, d) => a + BigInt(d.cost), 0n);
      const cap = BigInt(b.max_cost_yocto);
      if (spent + cost > cap) {
        return {
          ...base,
          allow: false,
          reason: `spend cap: ${formatNear(spent)} spent + ${formatNear(cost)} > ${formatNear(cap)} per ${b.window_sec}s for ${req.beneficiary}`,
          basis: "budget",
        };
      }
    }
    const maxN = b.max_count?.[req.action];
    if (maxN !== undefined) {
      const n = inWindow.filter((d) => d.action === req.action).length;
      if (n + 1 > maxN) {
        return { ...base, allow: false, reason: `count cap: ${n} ${req.action} already sponsored for ${req.beneficiary} in ${b.window_sec}s (max ${maxN})`, basis: "budget" };
      }
    }
  }
  return { ...base, allow: true, reason: "within budget", basis: "budget" };
}
