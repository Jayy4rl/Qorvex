/**
 * @qorvex/relayer-sdk: ask Qorvex before a relayer or payout service signs.
 *
 *   import { Qorvex } from "@qorvex/relayer-sdk";
 *   const qorvex = new Qorvex({ url: process.env.QORVEX_URL!, relayerId: "rly_...", token: process.env.QORVEX_RELAYER_TOKEN! });
 *
 *   const d = await qorvex.check({ beneficiary: daoId, action: "storage_deposit", cost: "1250000000000000000000", receiver: tokenId });
 *   if (!d.allow) return refuse(d.reason);
 *   await signAndSend();
 *
 * Decisions are made on the Qorvex server against one shared spend history,
 * so any number of relayer instances share one budget. When Qorvex cannot be
 * reached, `whenUnreachable` decides per call: fail closed (the default), or
 * fail open for small amounts under a local cap that resets every window.
 */

export interface CheckInput {
  /** Who benefits (e.g. the DAO or user whose action is sponsored). */
  beneficiary: string;
  /** What is sponsored, e.g. "storage_deposit", "add_proposal", "payout". */
  action: string;
  /** What the sponsor pays, in yoctoNEAR (deposit + gas estimate). */
  cost: string | bigint;
  /** Contract the sponsored call goes to. */
  receiver?: string;
  meta?: Record<string, unknown>;
}

export interface Decision {
  id: string;
  /** Unix ms. */
  at: number;
  beneficiary: string;
  action: string;
  cost: string;
  receiver?: string;
  allow: boolean;
  reason: string;
  basis: "budget" | "no-budget" | "fail-open" | "fail-closed" | "proposal-policy";
  meta?: Record<string, unknown>;
}

export interface UnreachablePolicy {
  /** Allow calls costing at most this many yoctoNEAR while Qorvex is unreachable. Default "0": fail closed. */
  failOpenBelow?: string | bigint;
  /** Total yoctoNEAR this process may allow while unreachable, per window. Default: 10 x failOpenBelow. */
  localCap?: string | bigint;
  /** Window of the local cap, ms. Default 1 hour. */
  windowMs?: number;
}

export interface QorvexOptions {
  relayerId: string;
  /** The relayer token shown once when the relayer was created in Qorvex (qrx_...). */
  token: string;
  /** The Qorvex server, e.g. http://localhost:8787 when self-hosting. */
  url: string;
  /** Per request, ms. Default 2000. */
  timeoutMs?: number;
  whenUnreachable?: UnreachablePolicy;
  fetch?: typeof fetch;
}

export class Qorvex {
  private readonly url: string;
  private readonly f: typeof fetch;
  private offlineSpent = 0n;
  private offlineWindowStart = 0;

  constructor(private readonly o: QorvexOptions) {
    if (!o.url || !o.relayerId || !o.token) throw new Error("Qorvex: url, relayerId and token are required");
    this.url = o.url.replace(/\/+$/, "");
    this.f = o.fetch ?? fetch;
  }

  /** Decide one sponsored action before signing it. Never throws for network errors. */
  async check(input: CheckInput): Promise<Decision> {
    const body = { ...input, cost: BigInt(input.cost).toString() };
    try {
      return await this.post<Decision>("check", body);
    } catch (e) {
      if (e instanceof QorvexRequestError && e.status < 500 && e.status !== 429) throw e; // bad token or input: a bug, not an outage
      return this.offline(body, e as Error);
    }
  }

  /**
   * Before sponsoring an approval vote on a DAO proposal, check the proposal
   * against the relayer's proposal policy (Trezu issue #1871). Fails closed
   * when Qorvex is unreachable.
   */
  async checkProposal(dao: string, proposal: { id: number; kind: unknown; [k: string]: unknown }): Promise<Decision> {
    try {
      return await this.post<Decision>("check-proposal", { dao, proposal });
    } catch (e) {
      if (e instanceof QorvexRequestError && e.status < 500 && e.status !== 429) throw e;
      return { id: `local_${Date.now()}`, at: Date.now(), beneficiary: dao, action: "approve_proposal", cost: "0", allow: false, reason: `Qorvex unreachable (${(e as Error).message}): failing closed`, basis: "fail-closed" };
    }
  }

  private offline(body: { beneficiary: string; action: string; cost: string; receiver?: string; meta?: Record<string, unknown> }, err: Error): Decision {
    const p = this.o.whenUnreachable ?? {};
    const below = BigInt(p.failOpenBelow ?? 0);
    const cap = BigInt(p.localCap ?? below * 10n);
    const now = Date.now();
    if (now - this.offlineWindowStart > (p.windowMs ?? 3_600_000)) {
      this.offlineWindowStart = now;
      this.offlineSpent = 0n;
    }
    const cost = BigInt(body.cost);
    const allow = below > 0n && cost <= below && this.offlineSpent + cost <= cap;
    if (allow) this.offlineSpent += cost;
    return {
      id: `local_${now}_${Math.random().toString(36).slice(2, 8)}`,
      at: now,
      ...body,
      allow,
      reason: allow ? `Qorvex unreachable (${err.message}): allowed under the local fail-open cap` : `Qorvex unreachable (${err.message}): failing closed`,
      basis: allow ? "fail-open" : "fail-closed",
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.f(`${this.url}/api/relayers/${encodeURIComponent(this.o.relayerId)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 2000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new QorvexRequestError(res.status, json.error ?? `HTTP ${res.status}`);
    return json as T;
  }
}

export class QorvexRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Qorvex ${status}: ${message}`);
  }
}
