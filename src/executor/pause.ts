/**
 * Pause executor (D4). Signs `guardian.pause(target, rule_id, evidence_hash)`
 * with the watcher's function-call key (which can call nothing else) and
 * broadcasts the same signed bytes to every configured RPC provider at once.
 * It never waits on the AI.
 */
import { Near } from "near-kit";
import { NearRpc, sleep } from "../near/rpc.ts";

export interface PauseKey {
  accountId: string;
  secretKey: string;
}

export interface PauseResult {
  ok: boolean;
  txHash?: string;
  provider?: string;
  /** Block in which the target's `pause` receipt executed. */
  pausedAtBlock?: number;
  guardianRecordIndex?: number;
  /** Blocks where the transaction, the guardian's receipt and the target's pause executed. */
  txBlock?: number;
  guardianBlock?: number;
  broadcastAtMs?: number;
  broadcastErrors: string[];
  error?: string;
  sentAtMs: number;
  landedAtMs?: number;
}

export class PauseExecutor {
  private near: Near;
  private rpc: NearRpc;

  constructor(
    rpcUrls: string[],
    networkId: string,
    private readonly key: PauseKey,
    private readonly guardianId: string,
  ) {
    this.rpc = new NearRpc(rpcUrls, { retries: 1, timeoutMs: 20_000 });
    this.near = new Near({
      network: { rpcUrl: rpcUrls[0], networkId },
      privateKey: key.secretKey as `ed25519:${string}`,
      defaultSignerId: key.accountId,
    });
  }

  get watcherAccount(): string {
    return this.key.accountId;
  }

  get guardian(): string {
    return this.guardianId;
  }

  /**
   * Fetch and cache the access-key nonce now, so the first real pause does
   * not pay for that lookup. Signs a transaction that is never sent (NEAR
   * nonces only need to increase, gaps are fine).
   */
  async warm(): Promise<void> {
    try {
      await this.prepare(this.guardianId, "warmup", "0".repeat(64));
    } catch {
      /* best effort */
    }
  }

  /** Sign the pause transaction without sending it. */
  async prepare(target: string, ruleId: string, evidenceHash: string): Promise<{ hash: string; signedBase64: string; target: string }> {
    const tx = this.near
      .transaction(this.key.accountId)
      .functionCall(this.guardianId, "pause", { target, rule_id: ruleId.slice(0, 64), evidence_hash: evidenceHash }, { gas: "100 Tgas" });
    await tx.sign();
    return { hash: tx.getHash()!, signedBase64: Buffer.from(tx.serialize()).toString("base64"), target };
  }

  async pause(target: string, ruleId: string, evidenceHash: string): Promise<PauseResult> {
    const sentAtMs = Date.now();
    try {
      return await this.submit(await this.prepare(target, ruleId, evidenceHash), sentAtMs);
    } catch (e) {
      return { ok: false, broadcastErrors: [], sentAtMs, error: (e as Error).message };
    }
  }

  /** Broadcast a prepared pause to every provider at once and wait for the target's pause receipt. */
  async submit(prepared: { hash: string; signedBase64: string; target: string }, sentAtMs = Date.now()): Promise<PauseResult> {
    const target = prepared.target;
    const out: PauseResult = { ok: false, broadcastErrors: [], sentAtMs, txHash: prepared.hash };
    try {
      out.broadcastAtMs = Date.now();
      const sent = await this.rpc.broadcastToAll(prepared.signedBase64, "INCLUDED");
      out.provider = sent.provider;
      out.broadcastErrors = sent.errors;
      const final = await this.waitExecuted(prepared.hash);
      out.landedAtMs = Date.now();
      const receipts: any[] = final.receipts_outcome ?? [];
      const targetOutcome = receipts.find((r) => r.outcome.executor_id === target);
      const guardianOutcome = receipts.find((r) => r.outcome.executor_id === this.guardianId);
      const idxLog = guardianOutcome?.outcome.logs?.find((l: string) => l.includes("pause_requested"));
      if (idxLog) {
        try {
          out.guardianRecordIndex = JSON.parse(idxLog.slice("EVENT_JSON:".length)).data[0].index;
        } catch {
          /* ignore */
        }
      }
      const status = final.status ?? {};
      const targetFailed = targetOutcome && "Failure" in (targetOutcome.outcome.status ?? {});
      if ("Failure" in status || !targetOutcome || targetFailed) {
        out.error =
          "Failure" in status
            ? JSON.stringify(status.Failure).slice(0, 400)
            : targetFailed
              ? JSON.stringify(targetOutcome.outcome.status.Failure).slice(0, 400)
              : "target pause receipt not found";
        return out;
      }
      const heightOf = async (h?: string) => (h ? (await this.rpc.block({ blockId: h })).header.height : undefined);
      [out.pausedAtBlock, out.guardianBlock, out.txBlock] = await Promise.all([
        heightOf(targetOutcome.block_hash),
        heightOf(guardianOutcome?.block_hash),
        heightOf(final.transaction_outcome?.block_hash),
      ]);
      out.ok = true;
      return out;
    } catch (e) {
      out.error = (e as Error).message;
      return out;
    }
  }

  private async waitExecuted(hash: string): Promise<any> {
    let lastErr: unknown;
    for (let i = 0; i < 40; i++) {
      try {
        return await this.rpc.txStatus(hash, this.key.accountId, "EXECUTED");
      } catch (e) {
        lastErr = e;
        await sleep(300);
      }
    }
    throw lastErr;
  }
}
