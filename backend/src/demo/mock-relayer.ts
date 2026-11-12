/**
 * Mock gas-sponsor relayer modelled on the Trezu relay of issue #1871
 * (github.com/NEAR-DevHub/trezu/issues/1871): when a treasury proposal is
 * approved, the relayer registers every receiver on the token contract named
 * in the proposal by sending `storage_deposit` calls that the sponsor account
 * signs and pays for (0.00125 NEAR each, plus gas).
 *
 * With a QorvexRelayerGuard attached, `check()` runs before each sponsored
 * action and only allowed actions are signed. Without one, it reproduces the
 * drain. Transactions are real (sandbox or testnet).
 */
import http from "node:http";
import { decodeSignedDelegateAction, type Near } from "near-kit";
import type { SputnikProposal } from "../firewall/policy.ts";
import type { QorvexRelayerGuard } from "../relayer/sdk.ts";
import type { NearRpc } from "../near/rpc.ts";

export const STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR
const GAS_PER_ACTION = "10 Tgas";
/** Upper bound of the gas the sponsor burns per action at 0.1 Ggas price: 10 Tgas * 1e8 yocto. */
export const GAS_COST_ESTIMATE_YOCTO = 1_000_000_000_000_000_000_000n;
const ACTIONS_PER_TX = 10;

export interface ApproveRequest {
  treasury: string;
  proposalId: string;
  token: string;
  receivers: string[];
}

export interface ApproveResult {
  proposalId: string;
  sponsored: number;
  refused: { receiver: string; reason: string }[];
  txHashes: string[];
  failedTx: string[];
  sponsorBalanceBefore: string;
  sponsorBalanceAfter: string;
}

export interface RelayVoteResult {
  dao: string;
  proposalId: number;
  action: string;
  relayed: boolean;
  refused?: string;
  txHash?: string;
  registrations: ApproveResult | null;
  sponsorBalanceBefore: string;
  sponsorBalanceAfter: string;
}

export class MockRelayer {
  constructor(
    private readonly near: Near,
    private readonly rpc: NearRpc,
    public readonly sponsorId: string,
    private readonly guard?: QorvexRelayerGuard,
  ) {}

  /** Sponsor balance in yoctoNEAR (raw `amount` from view_account). */
  async balance(): Promise<bigint> {
    const a = await this.rpc.viewAccount(this.sponsorId, { finality: "optimistic" });
    return BigInt(a.amount);
  }

  async approve(req: ApproveRequest): Promise<ApproveResult> {
    const before = await this.balance();
    const allowed: string[] = [];
    const refused: ApproveResult["refused"] = [];
    for (const receiver of req.receivers.slice(0, 200)) {
      if (this.guard) {
        const d = await this.guard.check(req.treasury, "storage_deposit", STORAGE_DEPOSIT_YOCTO + GAS_COST_ESTIMATE_YOCTO, {
          receiver: req.token,
          meta: { proposalId: req.proposalId, account: receiver },
        });
        if (!d.allow) {
          refused.push({ receiver, reason: d.reason });
          continue;
        }
      }
      allowed.push(receiver);
    }
    const txHashes: string[] = [];
    const failedTx: string[] = [];
    let sponsored = 0;
    for (let i = 0; i < allowed.length; i += ACTIONS_PER_TX) {
      const batch = allowed.slice(i, i + ACTIONS_PER_TX);
      let tx = this.near.transaction(this.sponsorId);
      for (const r of batch) {
        tx = tx.functionCall(req.token, "storage_deposit", { account_id: r, registration_only: true }, { gas: GAS_PER_ACTION, attachedDeposit: STORAGE_DEPOSIT_YOCTO });
      }
      try {
        const out: any = await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" });
        txHashes.push(out.transaction.hash);
        sponsored += batch.length;
      } catch (e) {
        failedTx.push((e as Error).message.slice(0, 200));
        break; // sponsor drained or call failed
      }
    }
    await this.guard?.flush();
    const after = await this.balance();
    return { proposalId: req.proposalId, sponsored, refused, txHashes, failedTx, sponsorBalanceBefore: before.toString(), sponsorBalanceAfter: after.toString() };
  }

  /**
   * Relay a DAO member's approval vote, signed as a NEP-366 meta-transaction
   * (the Trezu flow). Like Trezu's backend, approving a proposal also makes
   * the sponsor register every ft_transfer receiver on the token contract the
   * proposal names. With Qorvex, the proposal is checked first and the whole
   * relay is refused if it breaks the relayer's proposal policy.
   */
  async relayVote(req: { dao: string; signedDelegate: string }): Promise<RelayVoteResult> {
    const before = await this.balance();
    const sd: any = decodeSignedDelegateAction(req.signedDelegate);
    const da = sd.signedDelegate?.delegateAction ?? sd.delegateAction;
    if (!da || da.receiverId !== req.dao) throw new Error("delegate action must target the DAO");
    const call = (da.actions as any[]).map((a) => a.functionCall).find((f) => f?.methodName === "act_proposal");
    if (!call) throw new Error("only act_proposal votes are relayed");
    const args = JSON.parse(Buffer.from(call.args).toString("utf8"));
    const proposal = (await this.rpc.view<SputnikProposal>(req.dao, "get_proposal", { id: args.id }, { finality: "optimistic" })).value;
    const out: RelayVoteResult = { dao: req.dao, proposalId: args.id, action: args.action, relayed: false, registrations: null, sponsorBalanceBefore: before.toString(), sponsorBalanceAfter: before.toString() };
    if (args.action === "VoteApprove" && this.guard) {
      const d = await this.guard.checkProposal(req.dao, proposal);
      if (!d.allow) {
        out.refused = d.reason;
        await this.guard.flush();
        return out;
      }
    }
    // Trezu-style side effect: register the proposal's ft_transfer receivers, sponsor-paid.
    const k: any = typeof proposal.kind === "object" ? proposal.kind.FunctionCall : undefined;
    if (args.action === "VoteApprove" && k) {
      const receivers = (k.actions as any[])
        .filter((a) => a.method_name === "ft_transfer")
        .map((a) => {
          try {
            return JSON.parse(Buffer.from(a.args, "base64").toString("utf8")).receiver_id as string;
          } catch {
            return undefined;
          }
        })
        .filter((x): x is string => !!x);
      if (receivers.length) out.registrations = await this.approve({ treasury: req.dao, proposalId: String(args.id), token: k.receiver_id, receivers });
    }
    const sent: any = await this.near.transaction(this.sponsorId).signedDelegateAction(sd).send({ waitUntil: "EXECUTED_OPTIMISTIC" });
    out.relayed = true;
    out.txHash = sent.transaction?.hash;
    out.sponsorBalanceAfter = (await this.balance()).toString();
    return out;
  }

  /** Minimal HTTP surface: POST /relay/approve with an ApproveRequest. */
  listen(port: number): http.Server {
    const s = http.createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/relay/balance") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ sponsor: this.sponsorId, balance: (await this.balance()).toString(), guarded: !!this.guard }));
        }
        if (req.method !== "POST" || req.url !== "/relay/approve") {
          res.writeHead(404);
          return res.end();
        }
        let raw = "";
        for await (const c of req) raw += c;
        const b = JSON.parse(raw) as ApproveRequest;
        if (!b.treasury || !b.token || !Array.isArray(b.receivers)) throw new Error("treasury, token and receivers are required");
        const out = await this.approve(b);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
    return s.listen(port);
  }
}

/** The attack from issue #1871: proposals full of receivers on the attacker's own token. */
export async function trezuAttack(relayer: MockRelayer, o: { treasury: string; token: string; receivers: number; perProposal?: number; tag: string }) {
  const per = o.perProposal ?? 25;
  const results: ApproveResult[] = [];
  for (let i = 0; i < o.receivers; i += per) {
    const receivers = Array.from({ length: Math.min(per, o.receivers - i) }, (_, k) => `r${o.tag}${i + k}.victim.near`);
    results.push(await relayer.approve({ treasury: o.treasury, proposalId: `${o.tag}-${i / per}`, token: o.token, receivers }));
  }
  const first = results[0];
  const last = results[results.length - 1];
  return {
    proposals: results.length,
    sponsored: results.reduce((a, r) => a + r.sponsored, 0),
    refused: results.reduce((a, r) => a + r.refused.length, 0),
    firstRefusal: results.flatMap((r) => r.refused)[0]?.reason ?? null,
    txs: results.flatMap((r) => r.txHashes).length,
    failedTx: results.flatMap((r) => r.failedTx),
    sponsorBalanceBefore: first?.sponsorBalanceBefore,
    sponsorBalanceAfter: last?.sponsorBalanceAfter,
  };
}
