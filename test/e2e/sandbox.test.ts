/**
 * End-to-end on a local NEAR sandbox: real contracts, real transactions,
 * the real Qorvex server and watcher. Takes ~2-3 minutes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Sandbox } from "near-kit/sandbox";
import { InMemoryKeyStore, Near, parseKey } from "near-kit";
import { deployDemoWorld, authoriseGuardian, councilExecute, daoPropose, daoVote, ghostDeposit, usdc, type DemoWorld } from "../../src/demo/deploy.ts";
import { startQorvex, type Qorvex } from "../../src/server/main.ts";
import { NearRpc, sleep } from "../../src/near/rpc.ts";
import { hashToken } from "../../src/store/store.ts";
import { QorvexRelayerGuard } from "../../src/relayer/sdk.ts";
import { MockRelayer, trezuAttack } from "../../mock-relayer/relayer.ts";
import { DemoActions, drainCallKind } from "../../src/demo/actions.ts";
import { oneYoctoCall } from "../../src/demo/deploy.ts";

let sb: Sandbox;
let near: Near;
let rpc: NearRpc;
let w: DemoWorld;
let q: Qorvex;
let fc: Near; // holds only the watcher's pause-only function-call key
const ADMIN = crypto.randomBytes(8).toString("hex");
const A = () => w.accounts;

async function api(method: string, p: string, body?: unknown, token = ADMIN) {
  const r = await fetch(`${q.url}${p}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json()) as any };
}

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as Error).message);
  }
  throw new Error("expected the call to fail");
}

beforeAll(async () => {
  sb = await Sandbox.start();
  const ks = new InMemoryKeyStore({ [sb.rootAccount.id]: sb.rootAccount.secretKey });
  near = new Near({ network: { rpcUrl: sb.rpcUrl, networkId: sb.networkId }, keyStore: ks });
  rpc = new NearRpc([sb.rpcUrl]);
  w = await deployDemoWorld(near, (a) => ks.add(a.accountId, parseKey(a.secretKey)), sb.rootAccount.id, sb.rpcUrl, sb.networkId);
  fc = new Near({ network: { rpcUrl: sb.rpcUrl, networkId: sb.networkId }, privateKey: w.watcherPauseKey.secretKey as any, defaultSignerId: w.watcherPauseKey.accountId });
  process.env.QORVEX_SANDBOX_GUARDIAN = A().guardian.accountId;
  process.env.QORVEX_SANDBOX_WATCHER_ACCOUNT = w.watcherPauseKey.accountId;
  process.env.QORVEX_SANDBOX_WATCHER_KEY = w.watcherPauseKey.secretKey;
  process.env.QORVEX_SANDBOX_FIREWALL_ACCOUNT = w.firewallKey.accountId;
  process.env.QORVEX_SANDBOX_FIREWALL_KEYS = JSON.stringify({ [A().treasury.accountId]: w.firewallKey.secretKey });
  process.env.QORVEX_AI_MODE = "replay";
  const port = 18_000 + Math.floor(Math.random() * 2000);
  q = await startQorvex({
    networks: ["sandbox"],
    port,
    adminToken: ADMIN,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "qorvex-e2e-")),
    rpcOverrides: { sandbox: { rpcUrls: [sb.rpcUrl], nearNetworkId: sb.networkId } },
    log: () => {},
    demo: {
      info: () => ({}),
      signSetGuardian: (p) => authoriseGuardian(near, A().owner.accountId, p.contractId, A().guardian.accountId),
      ghost: async () => "",
      trezu: async () => ({}),
      signFirewallRole: async (p, role) => (await councilExecute(near, p.contractId, A().owner.accountId, "add firewall", { ChangePolicyAddOrUpdateRole: { role } })).txHash,
      action: async () => ({}),
    },
  });
}, 300_000);

afterAll(async () => {
  await q?.stop();
  await sb?.stop();
});

describe("trust model: the watcher key can only ask the guardian to pause", () => {
  it("cannot change the watcher list or unpause anything", async () => {
    expect(await rejects(fc.call(A().guardian.accountId, "set_watchers", { add: [A().mallory.accountId], remove: [] }, { attachedDeposit: "1 yocto", gas: "30 Tgas" }))).toBeTruthy();
    expect(await rejects(fc.call(A().ledger.accountId, "unpause", {}, { gas: "30 Tgas" }))).toBeTruthy();
    expect(await rejects(fc.call(A().guardian.accountId, "register_target", { council: A().mallory.accountId }, { gas: "30 Tgas" }))).toBeTruthy();
  });

  it("only approved watchers can call guardian.pause, and the ledger accepts pause only from the guardian", async () => {
    const m1 = await rejects(near.call(A().guardian.accountId, "pause", { target: A().ledger.accountId, rule_id: "x", evidence_hash: "y" }, { signerId: A().mallory.accountId, gas: "80 Tgas" }));
    expect(m1).toMatch(/not an approved watcher/);
    const m2 = await rejects(near.call(A().ledger.accountId, "pause", {}, { signerId: A().mallory.accountId, gas: "30 Tgas" }));
    expect(m2).toMatch(/only the guardian can pause/);
  });
});

describe("in-contract outflow caps (P1, P2)", () => {
  it("rejects withdrawals above the per-window cap; only the owner (1 yocto) can set caps", async () => {
    const L = A().ledger.accountId;
    expect(await rejects(near.call(L, "set_limits", { token_id: A().usdc.accountId, cap: usdc(1000), window_sec: 3600 }, { signerId: A().alice.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas" }))).toMatch(/only the owner/);
    await near.call(L, "set_limits", { token_id: A().usdc.accountId, cap: usdc(1000), window_sec: 3600 }, { signerId: A().owner.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas" });
    await near.call(L, "withdraw", { token_id: A().usdc.accountId, amount: usdc(600) }, { signerId: A().alice.accountId, attachedDeposit: "1 yocto", gas: "100 Tgas", waitUntil: "FINAL" });
    const err = await rejects(near.call(L, "withdraw", { token_id: A().usdc.accountId, amount: usdc(500) }, { signerId: A().alice.accountId, attachedDeposit: "1 yocto", gas: "100 Tgas" }));
    expect(err).toMatch(/outflow cap exceeded/);
    const limits = (await rpc.view<any[]>(L, "limits", {})).value;
    expect(limits[0].used_in_window).toBe(usdc(600));
    await near.call(L, "set_limits", { token_id: A().usdc.accountId, cap: null }, { signerId: A().owner.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas" });
  });
});

describe("operator flow and the watcher (D1-D6, G1-G3, S1-S2)", () => {
  let ledgerPid: string;

  it("refuses operator calls without the token", async () => {
    expect((await api("GET", "/api/protocols", undefined, "wrong")).status).toBe(401);
  });

  it("connects, validates + backtests a rule, approves it with auto-pause, verifies the guardian, publishes", async () => {
    const c = await api("POST", "/api/protocols", { network: "sandbox", contractId: A().ledger.accountId, name: "Ledger" });
    expect(c.status).toBe(201);
    ledgerPid = c.body.protocol.id;
    const bad = await api("POST", `/api/protocols/${ledgerPid}/rules`, {
      rule: { id: "bad", type: "solvency", token: "usdc", owed: { view: "invented_view" }, held: { contract: A().usdc.accountId, view: "ft_balance_of", args: { account_id: A().ledger.accountId } }, explain: "owed must never exceed held" },
    });
    expect(bad.status).toBe(400);
    const r = await api("POST", `/api/protocols/${ledgerPid}/rules`, {
      author: "e2e",
      rule: {
        id: "solvency-usdc",
        type: "solvency",
        token: A().usdc.accountId,
        owed: { view: "total_owed", args: { token_id: A().usdc.accountId } },
        held: { contract: A().usdc.accountId, view: "ft_balance_of", args: { account_id: A().ledger.accountId } },
        explain: "USDC owed to depositors must never exceed the USDC the contract holds",
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.backtest.fires).toBe(0);
    expect(r.body.backtest.samples).toBeGreaterThan(1);
    const ap = await api("POST", `/api/protocols/${ledgerPid}/rules/solvency-usdc/approve`, { response: "pause" });
    expect(ap.body.rule.status).toBe("approved");
    const sign = await api("POST", `/api/protocols/${ledgerPid}/guardian/sign-demo`);
    expect(sign.status).toBe(200);
    const v = await api("POST", `/api/protocols/${ledgerPid}/guardian/verify`);
    expect(v.body.ok).toBe(true);
    expect(v.body.watcherKeyScopeOk).toBe(true);
    expect(v.body.registration.council).toBe(A().owner.accountId);
    await api("POST", `/api/protocols/${ledgerPid}/publish`);
    // public status page answers without a token
    const s = await fetch(`${q.url}/api/status/${ledgerPid}`);
    expect(s.status).toBe(200);
  });

  it("evaluates the rule from the block stream and every value links to a reproducible raw read", async () => {
    let ev: any;
    for (let i = 0; i < 60 && !ev; i++) {
      const s: any = await (await fetch(`${q.url}/api/status/${ledgerPid}`)).json();
      ev = s.checks[0]?.evaluation;
      if (!ev) await sleep(500);
    }
    expect(ev.ok).toBe(true);
    const read: any = await (await fetch(`${q.url}/api/reads/${ev.reads[0].id}`)).json();
    // Replay the exact request against the node: same block, same bytes.
    const again: any = await (await fetch(sb.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(read.raw.request) })).json();
    expect(again.result.result).toEqual(read.raw.response.result.result);
    expect(read.raw.curl).toContain(JSON.stringify(read.raw.request).slice(0, 40));
  });

  it("detects the ghost-balance bug, pauses through the guardian within a few blocks, and blocks the attacker", async () => {
    const tx: any = await ghostDeposit(near, w, A().ledger.accountId, 40_000);
    expect(tx.transaction.hash).toBeTruthy();
    let breach: any;
    for (let i = 0; i < 120 && !(breach?.pause?.status === "landed" || breach?.pause?.status === "failed"); i++) {
      breach = (await api("GET", `/api/protocols/${ledgerPid}`)).body.breaches[0];
      await sleep(500);
    }
    expect(breach.pause.status).toBe("landed");
    expect(breach.evaluation.owed).toBe(usdc(249_400 + 40_000));
    expect(BigInt(breach.evaluation.owed)).toBeGreaterThan(BigInt(breach.evaluation.held));
    // Measured breach-to-pause distance; the PRD target is 3 blocks (see README for the measured breakdown).
    expect(breach.pause.blocksAfterBreach).toBeGreaterThanOrEqual(3);
    expect(breach.pause.blocksAfterBreach).toBeLessThanOrEqual(6);
    expect((await rpc.view<boolean>(A().ledger.accountId, "is_paused", {})).value).toBe(true);
    // The guardian's callback marks the record "Paused" one block after the target paused; wait for finality.
    let hist: any[] = [];
    for (let i = 0; i < 20; i++) {
      hist = (await rpc.view<any[]>(A().guardian.accountId, "pause_history", { target: A().ledger.accountId })).value;
      if (hist.at(-1)?.status === "Paused") break;
      await sleep(500);
    }
    expect(hist.at(-1)).toMatchObject({ rule_id: "solvency-usdc", evidence_hash: breach.evidenceHash, watcher: w.watcherPauseKey.accountId, status: "Paused" });
    const err = await rejects(near.call(A().ledger.accountId, "withdraw", { token_id: A().usdc.accountId, amount: usdc(40_000) }, { signerId: A().mallory.accountId, attachedDeposit: "1 yocto", gas: "100 Tgas" }));
    expect(err).toMatch(/contract is paused/);
  });

  it("guardian allows one automatic pause per target per hour unless the council allows another (G4)", async () => {
    // owner unpauses (1 yocto), then a second pause inside the hour is refused...
    await near.call(A().ledger.accountId, "unpause", {}, { signerId: A().owner.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas" });
    const msg = await rejects(fc.call(A().guardian.accountId, "pause", { target: A().ledger.accountId, rule_id: "again", evidence_hash: "ab" }, { gas: "100 Tgas" }));
    expect(msg).toBeTruthy();
    // ...until the council allows it.
    await near.call(A().guardian.accountId, "allow_repeat_pause", { target: A().ledger.accountId }, { signerId: A().owner.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas" });
    await fc.call(A().guardian.accountId, "pause", { target: A().ledger.accountId, rule_id: "again", evidence_hash: "ab" }, { gas: "100 Tgas", waitUntil: "FINAL" });
    expect((await rpc.view<boolean>(A().ledger.accountId, "is_paused", {})).value).toBe(true);
    const hist = (await rpc.view<any[]>(A().guardian.accountId, "pause_history", { target: A().ledger.accountId })).value;
    expect(hist.at(-1).council_override).toBe(true);
  });
});

describe("self-accounting check (P3)", () => {
  it("pauses the guarded vault inside the ghost-deposit transaction itself", async () => {
    const tx: any = await ghostDeposit(near, w, A().vault.accountId, 40_000);
    const status = (await rpc.view<any>(A().vault.accountId, "guard_status", {})).value;
    expect(status.paused.by).toBe(A().vault.accountId);
    expect(status.paused.reason).toMatch(/self-accounting/);
    // The pause happened in one of this transaction's receipts.
    const blocks = await Promise.all(
      tx.receipts_outcome.map(async (r: any) => (await rpc.block({ blockId: r.block_hash })).header.height),
    );
    expect(blocks).toContain(status.paused.block_height);
    const err = await rejects(near.call(A().vault.accountId, "withdraw", { token_id: A().usdc.accountId, amount: usdc(1) }, { signerId: A().alice.accountId, attachedDeposit: "1 yocto", gas: "100 Tgas" }));
    expect(err).toMatch(/contract is paused/);
  });
});

describe("relayer SDK against the Trezu drain (P4)", () => {
  it("refuses sponsored storage_deposits over budget and logs every decision", async () => {
    const token = `qrx_${crypto.randomBytes(12).toString("hex")}`;
    q.store.putRelayer({ id: "rly_e2e", name: "e2e", tokenHash: hashToken(token), failMode: "closed", updatedAt: "", budgets: [{ beneficiary: "*", window_sec: 3600, max_count: { storage_deposit: 5 } }] });
    const sdk = new QorvexRelayerGuard({ relayerId: "rly_e2e", apiUrl: q.url, apiToken: token });
    const relayer = new MockRelayer(near, rpc, A().sponsor.accountId, sdk);
    const out = await trezuAttack(relayer, { treasury: "evil-dao.near", token: A().capture.accountId, receivers: 20, perProposal: 10, tag: "e" });
    expect(out.sponsored).toBe(5);
    expect(out.refused).toBe(15);
    expect(out.firstRefusal).toMatch(/count cap/);
    await sdk.close();
    const logged = (await api("GET", "/api/relayers/rly_e2e/admin")).body.decisions;
    expect(logged).toHaveLength(20);
    // a wrong relayer token cannot read budgets
    expect((await fetch(`${q.url}/api/relayers/rly_e2e/budgets`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});

describe("proposal firewall on a Sputnik DAO (exact mainnet code v2.3.1)", () => {
  let daoPid: string;
  const T = () => A().treasury.accountId;
  let fwNear: Near;

  it("connects the DAO, approves a reject policy, and verifies the reject-only role after the DAO votes it in", async () => {
    fwNear = new Near({ network: { rpcUrl: sb.rpcUrl, networkId: sb.networkId }, privateKey: w.firewallKey.secretKey as any, defaultSignerId: w.firewallKey.accountId });
    const c = await api("POST", "/api/protocols", { network: "sandbox", contractId: T(), name: "Treasury" });
    expect(c.body.protocol.kind).toBe("dao");
    daoPid = c.body.protocol.id;
    const r = await api("POST", `/api/protocols/${daoPid}/rules`, {
      rule: {
        id: "treasury-policy",
        type: "proposal_policy",
        explain: "At most 25,000 USDC per proposal, calls only to our contracts",
        max_transfer: { [A().usdc.accountId]: usdc(25_000) },
        allowed_call_contracts: [A().usdc.accountId, A().vault.accountId],
        max_actions_per_call: 20,
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.backtest.method).toMatch(/evaluated all/);
    expect((await api("POST", `/api/protocols/${daoPid}/rules/treasury-policy/approve`, { response: "pause" })).status).toBe(400);
    expect((await api("POST", `/api/protocols/${daoPid}/rules/treasury-policy/approve`, { response: "reject" })).status).toBe(200);
    const before = await api("POST", `/api/protocols/${daoPid}/firewall/verify`);
    expect(before.body.ok).toBe(false);
    await api("POST", `/api/protocols/${daoPid}/firewall/sign-demo`);
    const v = await api("POST", `/api/protocols/${daoPid}/firewall/verify`);
    expect(v.body.problems).toEqual([]);
    expect(v.body.ok).toBe(true);
    expect(v.body.firewallKeyScopeOk).toBe(true);
  });

  it("rejects an over-cap transfer proposal within a few blocks; the council can no longer approve it", async () => {
    const id = await daoPropose(near, T(), A().mallory.accountId, "pay me", { Transfer: { token_id: A().usdc.accountId, receiver_id: A().mallory.accountId, amount: usdc(200_000), msg: null } });
    let b: any;
    for (let i = 0; i < 60 && !(b?.vote && b.vote.status !== "sending"); i++) {
      b = (await api("GET", `/api/protocols/${daoPid}`)).body.breaches.find((x: any) => x.evaluation.proposalId === id);
      if (!(b?.vote && b.vote.status !== "sending")) await sleep(500);
    }
    expect(b.vote.status).toBe("landed");
    expect(b.vote.proposalStatusAfter).toBe("Rejected");
    expect(b.vote.blocksAfterProposal).toBeLessThanOrEqual(5);
    expect(await rejects(daoVote(near, T(), A().owner.accountId, id, "VoteApprove"))).toMatch(/ERR_PROPOSAL_NOT_READY_FOR_VOTE/);
  });

  it("rejects the Trezu #1871 shape (100 ft_transfers on an unknown token) and leaves a normal proposal alone", async () => {
    const bad = await daoPropose(near, T(), A().mallory.accountId, "bulk", drainCallKind(A().capture.accountId, 100, "e2e"));
    const good = await daoPropose(near, T(), A().alice.accountId, "invoice", { Transfer: { token_id: A().usdc.accountId, receiver_id: A().alice.accountId, amount: usdc(1_000), msg: null } });
    let st = "";
    for (let i = 0; i < 60 && st !== "Rejected"; i++) {
      st = ((await near.view(T(), "get_proposal", { id: bad })) as any).status;
      if (st !== "Rejected") await sleep(500);
    }
    expect(st).toBe("Rejected");
    await sleep(2000);
    expect(((await near.view(T(), "get_proposal", { id: good })) as any).status).toBe("InProgress");
    await daoVote(near, T(), A().owner.accountId, good, "VoteApprove");
    expect(((await near.view(T(), "get_proposal", { id: good })) as any).status).toBe("Approved");
  });

  it("the firewall key cannot approve, even a proposal it likes", async () => {
    const id = await daoPropose(near, T(), A().alice.accountId, "small", { Transfer: { token_id: A().usdc.accountId, receiver_id: A().alice.accountId, amount: usdc(10), msg: null } });
    const p: any = await near.view(T(), "get_proposal", { id });
    expect(await rejects(fwNear.call(T(), "act_proposal", { id, action: "VoteApprove", proposal: p.kind }, { gas: "150 Tgas" }))).toBeTruthy();
  });

  it("the DAO is the council: only a DAO vote unpauses the DAO-owned vault", async () => {
    await ghostDeposit(near, w, A().vault.accountId, 1_000);
    expect((await rpc.view<boolean>(A().vault.accountId, "is_paused", {})).value).toBe(true);
    expect(await rejects(near.call(A().vault.accountId, "unpause", {}, { signerId: A().owner.accountId, attachedDeposit: "1 yocto", gas: "30 Tgas" }))).toMatch(/only the owner/);
    await councilExecute(near, T(), A().owner.accountId, "unpause vault", oneYoctoCall(A().vault.accountId, "unpause", {}));
    expect((await rpc.view<boolean>(A().vault.accountId, "is_paused", {})).value).toBe(false);
  });

  it("relayer checkProposal refuses to sponsor approval of a drain proposal on an attacker-owned DAO", async () => {
    const policy = { id: "relayer-policy", type: "proposal_policy" as const, explain: "known tokens only", allowed_call_contracts: [A().usdc.accountId], max_actions_per_call: 20 };
    const sdk = new QorvexRelayerGuard({ relayerId: "local", budgets: [{ beneficiary: "*", window_sec: 3600, max_count: { storage_deposit: 100 } }], proposalPolicy: policy });
    const guarded = new MockRelayer(near, rpc, A().sponsor.accountId, sdk);
    const open = new MockRelayer(near, rpc, A().sponsorOpen.accountId);
    const actions = new DemoActions(near, w, { guarded, open });
    const g = await actions.relayVote("guarded");
    expect(g.relayed).toBe(false);
    expect(g.refused).toMatch(/not on the allowed contracts list/);
    expect(g.sponsorBalanceAfter).toBe(g.sponsorBalanceBefore);
    const o = await actions.relayVote("unguarded");
    expect(o.relayed).toBe(true);
    expect(BigInt(o.sponsorBalanceAfter)).toBeLessThan(BigInt(o.sponsorBalanceBefore));
    expect(((await near.view(A().malloryDao.accountId, "get_proposal", { id: o.proposal })) as any).votes[A().mallory.accountId]).toBe("Approve");
  }, 120_000);
});
