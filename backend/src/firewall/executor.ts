/**
 * Casts the firewall's VoteReject on a Sputnik DAO proposal.
 *
 * The key is a function-call key on the firewall account limited to
 * `act_proposal` on one DAO (act_proposal takes no deposit). What the vote can
 * do is limited by the DAO's own policy: the firewall role holds only
 * `transfer:VoteReject` and `call:VoteReject`, so even this key's owner cannot
 * approve anything.
 */
import { parseKey, type Near } from "near-kit";
import { NearRpc } from "../near/rpc.ts";
import { signerFor, type FunctionCallKey } from "../near/accounts.ts";
import type { SputnikProposal } from "./policy.ts";

interface VoteResult {
  ok: boolean;
  txHash?: string;
  provider?: string;
  votedAtBlock?: number;
  /** Proposal status read back after the vote (e.g. "Rejected"). */
  statusAfter?: string;
  error?: string;
  sentAtMs: number;
  landedAtMs?: number;
}

export class RejectExecutor {
  private near: Near;
  private rpc: NearRpc;
  /** Public half of the firewall key for this DAO (checked against the chain by the firewall verification). */
  readonly publicKey: string;

  constructor(
    rpcUrls: string[],
    networkId: string,
    private readonly key: FunctionCallKey,
    public readonly daoId: string,
  ) {
    this.rpc = new NearRpc(rpcUrls, { retries: 1, timeoutMs: 20_000 });
    this.near = signerFor(rpcUrls, networkId, key);
    this.publicKey = parseKey(key.secretKey).publicKey.toString();
  }

  async reject(proposalId: number, kind: SputnikProposal["kind"], memo: string): Promise<VoteResult> {
    const out: VoteResult = { ok: false, sentAtMs: Date.now() };
    try {
      const tx = this.near
        .transaction(this.key.accountId)
        .functionCall(this.daoId, "act_proposal", { id: proposalId, action: "VoteReject", proposal: kind, memo: memo.slice(0, 200) }, { gas: "150 Tgas" });
      await tx.sign();
      out.txHash = tx.getHash()!;
      const sent = await this.rpc.broadcastToAll(Buffer.from(tx.serialize()).toString("base64"), "INCLUDED");
      out.provider = sent.provider;
      const final = await this.rpc.waitForExecution(out.txHash, this.key.accountId);
      out.landedAtMs = Date.now();
      const daoOutcome = (final.receipts_outcome ?? []).find((r: any) => r.outcome.executor_id === this.daoId);
      if (!daoOutcome || "Failure" in (daoOutcome.outcome.status ?? {}) || "Failure" in (final.status ?? {})) {
        out.error = JSON.stringify(daoOutcome?.outcome.status?.Failure ?? final.status?.Failure ?? "DAO receipt not found").slice(0, 400);
        return out;
      }
      out.votedAtBlock = (await this.rpc.block({ blockId: daoOutcome.block_hash })).header.height;
      const p = await this.rpc.view<SputnikProposal>(this.daoId, "get_proposal", { id: proposalId }, { finality: "optimistic" });
      out.statusAfter = p.value.status;
      out.ok = true;
      return out;
    } catch (e) {
      out.error = (e as Error).message;
      return out;
    }
  }
}
