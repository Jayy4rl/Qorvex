/**
 * Scripted actors for the local demo (sandbox only): attacker and member
 * proposals on the treasury DAO, council votes, DAO-voted unpause, and the
 * Trezu-style relayed approval on the attacker's own DAO.
 */
import fs from "node:fs";
import type { Near } from "near-kit";
import { fromRepoRoot } from "../paths.ts";
import { daoPropose, daoVote, councilExecute, oneYoctoCall, usdc, type DemoWorld } from "./deploy.ts";
import type { MockRelayer, RelayVoteResult } from "./mock-relayer.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/**
 * The demo contracts' source, as uploaded for AI drafting. The paths are part of
 * the source digest in the AI fixture keys: keep them repository-relative and unchanged.
 */
export const DEMO_SOURCE_PATHS = ["contracts/demo-ledger/src/lib.rs", "contracts/qorvex-guard/src/lib.rs"];
export function demoSourceFiles(): { path: string; content: string }[] {
  return DEMO_SOURCE_PATHS.map((p) => ({ path: p, content: fs.readFileSync(fromRepoRoot(p), "utf8") }));
}

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

  // ------------------------------------------------- Watcher Lab (ledger)

  private short(e: unknown): string {
    const m = String((e as Error).message ?? e);
    return (m.match(/qorvex-guard: [^)"\\]+|ledger: [^)"\\]+|ERR_[A-Z_]+/)?.[0] ?? m).replace(/\s+/g, " ").slice(0, 200);
  }

  /** Honest user: Alice deposits USDC into a ledger (ft_transfer_call). */
  async deposit(target: string, amountUsdc: number): Promise<{ ok: boolean; txHash?: string; error?: string }> {
    const A = this.w.accounts;
    try {
      const r: any = await this.near.call(A.usdc.accountId, "ft_transfer_call", { receiver_id: target, amount: usdc(amountUsdc), msg: "" }, { signerId: A.alice.accountId, attachedDeposit: "1 yocto", gas: "100 Tgas", waitUntil: "FINAL" });
      return { ok: true, txHash: r.transaction?.hash };
    } catch (e) {
      return { ok: false, error: this.short(e) };
    }
  }

  /** Withdraw from a ledger as Alice (honest) or Mallory (cashing out a ghost balance). */
  async withdraw(target: string, who: "alice" | "mallory", amountUsdc: number): Promise<{ ok: boolean; txHash?: string; error?: string; returned?: unknown }> {
    const A = this.w.accounts;
    const signer = who === "mallory" ? A.mallory.accountId : A.alice.accountId;
    try {
      const r: any = await this.near.call(target, "withdraw", { token_id: A.usdc.accountId, amount: usdc(amountUsdc) }, { signerId: signer, attachedDeposit: "1 yocto", gas: "100 Tgas", waitUntil: "FINAL" });
      const v = r.status?.SuccessValue;
      const returned = v ? JSON.parse(Buffer.from(v, "base64").toString("utf8")) : undefined;
      return { ok: returned !== false, txHash: r.transaction?.hash, returned, error: returned === false ? "the guard tripped: the contract paused itself and sent nothing" : undefined };
    } catch (e) {
      return { ok: false, error: this.short(e) };
    }
  }

  /** Live numbers for the lab: owed, held, paused, and the two users' internal balances. */
  async ledgerState(target: string) {
    const A = this.w.accounts;
    const [owed, held, paused, alice, mallory, target_] = await Promise.all([
      this.near.view(target, "total_owed", { token_id: A.usdc.accountId }),
      this.near.view(A.usdc.accountId, "ft_balance_of", { account_id: target }),
      this.near.view(target, "is_paused", {}),
      this.near.view(target, "balance_of", { account_id: A.alice.accountId, token_id: A.usdc.accountId }),
      this.near.view(target, "balance_of", { account_id: A.mallory.accountId, token_id: A.usdc.accountId }),
      this.near.view(A.guardian.accountId, "get_target", { target }),
    ]);
    return { target, owed, held, paused, balances: { alice, mallory }, guardianRegistration: target_ ?? null };
  }

  /**
   * Owner recovery for the watcher-protected ledger, so the attack can be replayed:
   * 1. top up the missing USDC (the "fix the books" step; held >= owed again),
   * 2. as the guardian council, allow one more automatic pause inside the 1-hour cooldown,
   * 3. unpause (owner, 1 yoctoNEAR).
   */
  async rearm(target: string): Promise<{ steps: string[] }> {
    const A = this.w.accounts;
    const steps: string[] = [];
    const owed = BigInt((await this.near.view(target, "total_owed", { token_id: A.usdc.accountId })) as string);
    const held = BigInt((await this.near.view(A.usdc.accountId, "ft_balance_of", { account_id: target })) as string);
    if (owed > held) {
      await this.near.call(A.usdc.accountId, "mint", { account_id: target, amount: (owed - held).toString() }, { signerId: A.owner.accountId, gas: "30 Tgas", waitUntil: "FINAL" });
      steps.push(`topped up ${Number((owed - held) / 1_000_000n).toLocaleString("en-US")} USDC so held = owed`);
    } else steps.push("books already balance (held >= owed)");
    const reg: any = await this.near.view(A.guardian.accountId, "get_target", { target });
    if (reg && reg.last_pause_ns !== "0" && !reg.repeat_allowed && reg.council === A.owner.accountId) {
      await this.near.call(A.guardian.accountId, "allow_repeat_pause", { target }, { signerId: A.owner.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas", waitUntil: "FINAL" });
      steps.push("council allowed one more automatic pause within the hour (guardian G4)");
    }
    if ((await this.near.view(target, "is_paused", {})) === true) {
      await this.near.call(target, "unpause", {}, { signerId: A.owner.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas", waitUntil: "FINAL" });
      steps.push("owner unpaused the contract (1 yoctoNEAR; Qorvex's key cannot do this)");
    }
    return { steps };
  }

  /** The same source files the recorded Qwen drafts were made from (so replay mode hits the fixtures). */
  demoSource(): { files: { path: string; content: string }[] } {
    return { files: demoSourceFiles() };
  }

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
