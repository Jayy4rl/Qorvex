/**
 * One-command local demo (no API keys, no testnet funds):
 *
 *   npm run demo            # sandbox + deployed contracts + Qorvex console on :8787
 *   npm run demo -- --auto  # also runs the whole PRD demo script and prints a summary
 *   npm run demo -- --auto --exit   # same, then exits (used for CI / judges)
 *
 * Starts a local NEAR sandbox (nearcore, downloaded by near-kit), deploys the
 * guardian, token and two ledgers, starts Qorvex with a sandbox watcher that
 * holds only the watcher's pause-only key, and two mock sponsor relayers
 * (one with Qorvex check(), one without).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Sandbox } from "near-kit/sandbox";
import { InMemoryKeyStore, Near, parseKey } from "near-kit";
import { env, loadDotEnv } from "../src/config.ts";
import { fromRepoRoot } from "../src/paths.ts";
import { startQorvex } from "../src/server/main.ts";
import { deployDemoWorld, authoriseGuardian, authoriseGuardianViaDao, councilExecute, ghostDeposit, usdc, type DemoWorld } from "../src/demo/deploy.ts";
import { DemoActions, demoSourceFiles } from "../src/demo/actions.ts";
import { hashToken, newId } from "../src/store/store.ts";
import { QorvexRelayerGuard } from "../src/relayer/sdk.ts";
import { MockRelayer, trezuAttack } from "../src/demo/mock-relayer.ts";
import { formatNear } from "../src/relayer/budgets.ts";
import { NearRpc, sleep } from "../src/near/rpc.ts";

loadDotEnv();
const AUTO = process.argv.includes("--auto");
const EXIT = process.argv.includes("--exit");
const port = Number(env("PORT", "8787"));
const dir = fromRepoRoot(env("QORVEX_DEMO_DIR", "data/demo")!);
fs.rmSync(path.join(dir, "store"), { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const log = (s: string) => console.log(`[demo] ${s}`);
log("starting local NEAR sandbox (first run downloads the nearcore sandbox binary)...");
const sb = await Sandbox.start();
const ks = new InMemoryKeyStore({ [sb.rootAccount.id]: sb.rootAccount.secretKey });
const near = new Near({ network: { rpcUrl: sb.rpcUrl, networkId: sb.networkId }, keyStore: ks });
let stopping = false;
const cleanup = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  await qorvex?.stop().catch(() => {});
  await sb.stop().catch(() => {});
  process.exit(code);
};
process.on("SIGINT", () => void cleanup(0));
process.on("SIGTERM", () => void cleanup(0));

let qorvex: Awaited<ReturnType<typeof startQorvex>> | undefined;
try {
  const t0 = Date.now();
  const world: DemoWorld = await deployDemoWorld(near, (a) => ks.add(a.accountId, parseKey(a.secretKey)), sb.rootAccount.id, sb.rpcUrl, sb.networkId, { log });
  log(`demo world deployed in ${Math.round((Date.now() - t0) / 1000)} s`);
  // Keys of this throw-away sandbox go to the git-ignored data dir only.
  fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world, null, 2), { mode: 0o600 });
  const A = world.accounts;

  // The Qorvex service gets ONLY the watcher's function-call key.
  process.env.QORVEX_SANDBOX_GUARDIAN = A.guardian.accountId;
  process.env.QORVEX_SANDBOX_WATCHER_ACCOUNT = world.watcherPauseKey.accountId;
  process.env.QORVEX_SANDBOX_WATCHER_KEY = world.watcherPauseKey.secretKey;
  // ...and ONLY the firewall's function-call key (act_proposal on the treasury DAO).
  process.env.QORVEX_SANDBOX_FIREWALL_ACCOUNT = world.firewallKey.accountId;
  process.env.QORVEX_SANDBOX_FIREWALL_KEYS = JSON.stringify({ [A.treasury.accountId]: world.firewallKey.secretKey });

  const adminToken = env("QORVEX_ADMIN_TOKEN") ?? crypto.randomBytes(16).toString("hex");
  const relayerToken = `qrx_${crypto.randomBytes(24).toString("hex")}`;
  const relayerId = newId("rly");
  const treasury = `mallory-dao.${world.root}`;
  let guarded: MockRelayer | undefined;
  let open: MockRelayer | undefined;
  let actions: DemoActions | undefined;
  let tag = 0;

  qorvex = await startQorvex({
    networks: env("QORVEX_DEMO_MAINNET") === "1" ? ["sandbox", "mainnet"] : ["sandbox"],
    port,
    adminToken,
    dataDir: dir,
    rpcOverrides: { sandbox: { rpcUrls: [sb.rpcUrl], nearNetworkId: sb.networkId } },
    log: (s) => console.log(s),
    demo: {
      info: () => ({ root: world.root, accounts: Object.fromEntries(Object.entries(A).map(([k, v]) => [k, v.accountId])), trapAccount: world.trapAccount, relayerId, treasury }),
      // The vault is owned by the treasury DAO, so its guardian is authorised by a DAO vote.
      signSetGuardian: (p) =>
        p.contractId === A.vault.accountId
          ? authoriseGuardianViaDao(near, A.treasury.accountId, A.owner.accountId, p.contractId, A.guardian.accountId)
          : authoriseGuardian(near, A.owner.accountId, p.contractId, A.guardian.accountId),
      signFirewallRole: async (p, role) =>
        (await councilExecute(near, p.contractId, A.owner.accountId, "Add the Qorvex proposal firewall (reject-only role)", { ChangePolicyAddOrUpdateRole: { role } })).txHash,
      action: async (name, params) => {
        if (name === "propose") return actions!.propose(String(params.kind) as any);
        if (name === "council-approve") return actions!.councilApprove(Number(params.id));
        if (name === "dao-unpause") return actions!.daoUnpause(String(params.target ?? A.vault.accountId));
        if (name === "relay-vote") return actions!.relayVote(params.mode === "unguarded" ? "unguarded" : "guarded");
        const ledgers = [A.ledger.accountId, A.vault.accountId];
        const target = ledgers.includes(String(params.target)) ? String(params.target) : A.ledger.accountId;
        const amount = Math.max(1, Math.min(1_000_000, Number(params.amount ?? 1000)));
        if (name === "deposit") return actions!.deposit(target, amount);
        if (name === "withdraw") return actions!.withdraw(target, params.who === "mallory" ? "mallory" : "alice", amount);
        if (name === "ledger-state") return actions!.ledgerState(target);
        if (name === "rearm") return actions!.rearm(A.ledger.accountId);
        if (name === "demo-source") return actions!.demoSource();
        throw new Error(`unknown demo action ${name}`);
      },
      ghost: async (target, amount) => ((await ghostDeposit(near, world, target, amount)) as any).transaction.hash,
      trezu: async (mode, receivers) =>
        trezuAttack(mode === "guarded" ? guarded! : open!, { treasury, token: A.capture.accountId, receivers, tag: `${mode[0]}${++tag}` }),
    },
  });

  // Relayer registered in Qorvex with demo budgets (editable in the console).
  qorvex.store.putRelayer({
    id: relayerId,
    name: "Demo sponsor relayer (Trezu-style)",
    tokenHash: hashToken(relayerToken),
    failMode: "closed",
    updatedAt: new Date().toISOString(),
    budgets: [{ beneficiary: "*", window_sec: 3600, max_cost_yocto: "20000000000000000000000", max_count: { storage_deposit: 8 } }],
    // Applied before sponsoring any DAO approval vote, whoever controls the DAO (Trezu #1871).
    proposalPolicy: {
      id: "relayer-policy",
      type: "proposal_policy",
      explain: "Sponsored approvals only for calls to known tokens, at most 20 actions, at most 0.1 NEAR attached",
      allowed_call_contracts: [A.usdc.accountId],
      max_actions_per_call: 20,
      max_call_deposit_yocto: "100000000000000000000000",
    },
  });
  const sdk = new QorvexRelayerGuard({ relayerId, apiUrl: qorvex.url, apiToken: relayerToken, cacheTtlMs: 2000 });
  const sbRpc = new NearRpc([sb.rpcUrl]);
  guarded = new MockRelayer(near, sbRpc, A.sponsor.accountId, sdk);
  open = new MockRelayer(near, sbRpc, A.sponsorOpen.accountId);
  actions = new DemoActions(near, world, { guarded, open });

  console.log(`
==========================================================================
 Simulations:      ${qorvex.url}/simulations  (sandbox attack replays; sign in first)
 Qorvex console:   ${qorvex.url}/          (operator token: ${adminToken})
 Sandbox RPC:      ${sb.rpcUrl}
 Protected demo contracts: ${A.ledger.accountId} (watcher-protected), ${A.vault.accountId} (in-contract guard, owned by the DAO)
 Treasury DAO: ${A.treasury.accountId} (Sputnik v2.3.1)   Attacker DAO: ${A.malloryDao.accountId}
 Guardian: ${A.guardian.accountId}   Watcher: ${world.watcherPauseKey.accountId} (pause-only key)   Firewall: ${world.firewallKey.accountId} (reject-only key)
==========================================================================`);

  if (AUTO) {
    const summary = await runScript(qorvex.url, adminToken, world, near);
    console.log("\n" + summary);
    fs.writeFileSync(path.join(dir, "summary.txt"), summary);
  } else {
    log("open the console to walk through the flow, or rerun with --auto. Ctrl-C to stop.");
  }
  if (EXIT) await cleanup(0);
} catch (e) {
  console.error(e);
  await cleanup(1);
}

// ---------------------------------------------------------------------------

async function runScript(base: string, token: string, w: DemoWorld, near: Near): Promise<string> {
  const A = w.accounts;
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await r.json();
    if (!r.ok) throw Object.assign(new Error(`${method} ${p}: ${r.status} ${j.error}`), { status: r.status, body: j });
    return j;
  };
  const lines: string[] = [];
  const say = (s: string) => {
    lines.push(s);
    log(s);
  };

  const protect = async (contractId: string, name: string) => {
    const { protocol } = await api("POST", "/api/protocols", { network: "sandbox", contractId, name });
    await api("POST", `/api/protocols/${protocol.id}/source`, { files: demoSourceFiles() });
    const tStart = Date.now();
    try {
      const d = await api("POST", `/api/protocols/${protocol.id}/draft`);
      say(`${name}: AI drafted ${d.rules.length} rule(s) with ${d.draft.model} (${d.draft.source}): ${d.rules.join(", ")}`);
    } catch (e: any) {
      if (e.status !== 409) throw e;
      say(`${name}: no recorded NEAR AI response for this contract (QORVEX_AI_MODE=replay), so the demo adds the same rules by hand (origin: human). Set QORVEX_AI_MODE=record with NEARAI_API_KEY to draft them with Qwen on NEAR AI Cloud.`);
      await api("POST", `/api/protocols/${protocol.id}/rules`, {
        author: "demo script (AI fixture missing)",
        rule: {
          id: "solvency-usdc",
          type: "solvency",
          token: A.usdc.accountId,
          owed: { view: "total_owed", args: { token_id: A.usdc.accountId } },
          held: { contract: A.usdc.accountId, view: "ft_balance_of", args: { account_id: contractId } },
          explain: "USDC owed to depositors must never exceed the USDC the contract holds",
        },
      });
      await api("POST", `/api/protocols/${protocol.id}/rules`, {
        author: "demo script (AI fixture missing)",
        rule: { id: "outflow-usdc-1h", type: "outflow_rate", token: A.usdc.accountId, max: usdc(300_000), window_sec: 3600, explain: "No more than 300,000 USDC may leave the contract per hour" },
      });
    }
    const view = await api("GET", `/api/protocols/${protocol.id}`);
    for (const { rule, backtest } of view.rules) {
      if (rule.status !== "draft") continue;
      const response = rule.type === "solvency" && backtest?.fires === 0 ? "pause" : "alert";
      await api("POST", `/api/protocols/${protocol.id}/rules/${rule.id}/approve`, { response, approvedBy: "demo operator" });
      say(`${name}: approved ${rule.id} as ${response} (backtest: ${backtest?.fires ?? "?"} fires over ${backtest?.samples ?? "?"} samples)`);
    }
    await api("POST", `/api/protocols/${protocol.id}/guardian/sign-demo`);
    const v = await api("POST", `/api/protocols/${protocol.id}/guardian/verify`);
    say(`${name}: guardian verified=${v.ok} (contract guardian ${v.contractGuardian}, registered council ${v.registration?.council}, watcher key scope ok=${v.watcherKeyScopeOk})`);
    await api("POST", `/api/protocols/${protocol.id}/publish`);
    say(`${name}: connected -> protected in ${Math.round((Date.now() - tStart) / 1000)} s; status page ${base}/status/${protocol.id}`);
    return protocol.id as string;
  };

  const ledgerId = await protect(A.ledger.accountId, "Demo ledger");
  const vaultId = await protect(A.vault.accountId, "Demo vault (qorvex-guard)");
  await sleep(4000);

  // --- Replay 1: Intents ghost balance against the watcher-protected ledger
  say("Replay: NEAR Intents ghost-balance bug on the ledger (deposit with a failing notification)");
  const ghostTx = await api("POST", "/api/demo/ghost", { target: A.ledger.accountId, amount: 40_000 });
  say(`  ghost deposit tx ${ghostTx.txHash}`);
  const breach = await waitFor(async () => {
    const v = await api("GET", `/api/protocols/${ledgerId}`);
    return v.breaches.find((b: any) => b.pause && ["landed", "failed", "skipped"].includes(b.pause.status));
  }, 60_000);
  if (breach?.pause?.status === "landed") {
    say(`  watcher: breach at block ${breach.triggerBlock}, ledger paused at block ${breach.pause.pausedAtBlock} = ${breach.pause.blocksAfterBreach} blocks later, ${(breach.pause.msAfterDetection / 1000).toFixed(1)} s after detection (NEAR Intents: ~40 hours unnoticed)`);
    say(`  pause tx ${breach.pause.txHash} via guardian, evidence ${breach.evidenceHash.slice(0, 16)}...`);
    const t = breach.timeline;
    if (t) say(`  timeline: block ${breach.triggerBlock} produced -> received +${t.blockReceivedMs - t.triggerBlockTimestampMs} ms -> evaluated +${t.detectedMs - t.blockReceivedMs} ms -> confirmed+signed +${t.confirmedMs - t.detectedMs} ms -> broadcast; tx in block ${t.txBlock}, guardian receipt in ${t.guardianBlock}, target paused in ${t.pausedBlock}`);
  } else {
    say(`  pause did not land: ${JSON.stringify(breach?.pause)}`);
  }
  try {
    await near.call(A.ledger.accountId, "withdraw", { token_id: A.usdc.accountId, amount: usdc(40_000) }, { signerId: A.mallory.accountId, attachedDeposit: "1 yocto", gas: "100 Tgas" });
    say("  attacker withdraw: SUCCEEDED (not expected)");
  } catch (e) {
    say(`  attacker withdraw of the ghost balance: rejected (${String((e as Error).message).match(/qorvex-guard: [^)"]+/)?.[0] ?? "failed"})`);
  }

  // --- Replay 2: same bug against the contract with qorvex-guard self-accounting
  say("Replay: same bug against the vault (qorvex-guard self-accounting on)");
  const vTx: any = await ghostDeposit(near, w, A.vault.accountId, 40_000);
  const vs: any = (await near.view(A.vault.accountId, "guard_status", {})) as any;
  say(`  vault paused in the deposit transaction itself (${vTx.transaction.hash}): ${vs?.paused?.reason ?? "NOT PAUSED"}`);
  await sleep(3000);

  // --- Replay 3: Trezu sponsor drain
  say("Replay: Trezu sponsor drain (issue #1871): 100 sponsored storage_deposit calls into the attacker's token");
  const openRun = await api("POST", "/api/demo/trezu", { mode: "unguarded", receivers: 100 });
  say(`  without Qorvex: sponsored ${openRun.sponsored}, sponsor balance ${formatNear(BigInt(openRun.sponsorBalanceBefore))} -> ${formatNear(BigInt(openRun.sponsorBalanceAfter))}${openRun.failedTx.length ? ` (relayer failed: ${openRun.failedTx[0].slice(0, 80)})` : ""}`);
  const guardedRun = await api("POST", "/api/demo/trezu", { mode: "guarded", receivers: 100 });
  say(`  with Qorvex check(): sponsored ${guardedRun.sponsored}, refused ${guardedRun.refused}, sponsor balance ${formatNear(BigInt(guardedRun.sponsorBalanceBefore))} -> ${formatNear(BigInt(guardedRun.sponsorBalanceAfter))}`);
  say(`  first refusal: ${guardedRun.firstRefusal}`);

  // --- Proposal firewall on the treasury DAO (Sputnik v2.3.1, the exact mainnet code)
  say("Protect the treasury DAO with the proposal firewall");
  const { protocol: dao } = await api("POST", "/api/protocols", { network: "sandbox", contractId: A.treasury.accountId, name: "Team treasury (Sputnik DAO)" });
  say(`  connected ${A.treasury.accountId} as a ${dao.kind}`);
  let drafted = false;
  try {
    const d = await api("POST", `/api/protocols/${dao.id}/draft`);
    drafted = d.rules.length > 0;
    say(`  AI drafted ${d.rules.length} rule(s) with ${d.draft.model} (${d.draft.source}): ${d.rules.join(", ")}`);
  } catch (e: any) {
    if (e.status !== 409) throw e;
  }
  if (!drafted) {
    say("  no recorded NEAR AI response for this DAO (QORVEX_AI_MODE=replay): adding the treasury policy by hand (origin: human)");
    await api("POST", `/api/protocols/${dao.id}/rules`, {
      author: "demo script (AI fixture missing)",
      rule: {
        id: "treasury-policy",
        type: "proposal_policy",
        explain: "Treasury proposals: at most 25,000 USDC or 5 NEAR each, calls only to our own contracts, at most 20 actions",
        max_transfer: { [A.usdc.accountId]: usdc(25_000), near: "5000000000000000000000000" },
        allowed_call_contracts: [A.usdc.accountId, A.vault.accountId, A.guardian.accountId],
        max_actions_per_call: 20,
        max_call_deposit_yocto: "500000000000000000000000",
        alert_on_governance: true,
      },
    });
  }
  // Operator review (A6): the AI drafts, a human edits. If a drafted cap would let a 200,000 USDC
  // request through, the operator tightens it; the edit is re-validated and re-backtested.
  for (const { rule, limits } of (await api("GET", `/api/protocols/${dao.id}`)).rules) {
    if (rule.type !== "proposal_policy" || rule.status !== "draft") continue;
    say(`  drafted limits in plain units: ${limits}`);
    const cap = rule.max_transfer?.[A.usdc.accountId];
    if (cap === undefined || BigInt(cap) >= BigInt(usdc(200_000))) {
      const max_transfer = { ...(rule.max_transfer ?? {}), [A.usdc.accountId]: usdc(25_000) };
      await api("PATCH", `/api/protocols/${dao.id}/rules/${rule.id}`, { rule: { max_transfer, explain: "Treasury proposals: at most 25,000 USDC per proposal, calls only to our own contracts" } });
      say(`  operator review: tightened the USDC cap from ${cap ? Number(BigInt(cap) / 1_000_000n).toLocaleString("en-US") : "none"} to 25,000 USDC before approving`);
    }
  }
  const dv = await api("GET", `/api/protocols/${dao.id}`);
  for (const { rule, backtest } of dv.rules) {
    if (rule.status !== "draft") continue;
    const response = rule.type === "proposal_policy" ? "reject" : "alert";
    await api("POST", `/api/protocols/${dao.id}/rules/${rule.id}/approve`, { response, approvedBy: "demo operator" });
    say(`  approved ${rule.id} as ${response} (backtest over the DAO's ${backtest?.samples ?? 0} existing proposals: ${backtest?.fires ?? "?"} would have been flagged)`);
  }
  await api("POST", `/api/protocols/${dao.id}/firewall/sign-demo`);
  const fv = await api("POST", `/api/protocols/${dao.id}/firewall/verify`);
  say(`  firewall verified=${fv.ok}: role ${fv.role}, key ${JSON.stringify(fv.firewallKeyPermission?.FunctionCall?.method_names)} on ${fv.firewallKeyPermission?.FunctionCall?.receiver_id}${fv.problems.length ? `; problems: ${fv.problems.join("; ")}` : ""}`);
  await api("POST", `/api/protocols/${dao.id}/publish`);
  await sleep(2000);

  const firewallScene = async (label: string, kind: string) => {
    const pr = await api("POST", "/api/demo/action/propose", { kind });
    say(`${label}: ${pr.proposer} submits proposal #${pr.id}`);
    const b = await waitFor(async () => {
      const v = await api("GET", `/api/protocols/${dao.id}`);
      return v.breaches.find((x: any) => x.evaluation.proposalId === pr.id && x.vote && ["landed", "failed", "skipped"].includes(x.vote.status));
    }, 30_000);
    if (b?.vote?.status === "landed") say(`  Qorvex voted VoteReject ${b.vote.blocksAfterProposal} blocks after submission: "${b.evaluation.violations[0]}" -> proposal ${b.vote.proposalStatusAfter}`);
    else say(`  firewall result: ${JSON.stringify(b?.vote ?? "no decision")}`);
    const c = await api("POST", "/api/demo/action/council-approve", { id: pr.id });
    say(`  council then tries to approve: ${c.status ?? c.error}`);
  };
  await firewallScene("Insider transfer (requestor asks for 200,000 USDC)", "big-transfer");
  await firewallScene("Trezu #1871 shape inside a protected DAO (100 ft_transfers on the attacker's token)", "drain-call");
  const inv = await api("POST", "/api/demo/action/propose", { kind: "invoice" });
  await sleep(3000);
  const invVotes = (await api("GET", `/api/protocols/${dao.id}`)).breaches.filter((x: any) => x.evaluation.proposalId === inv.id).length;
  const invRes = await api("POST", "/api/demo/action/council-approve", { id: inv.id });
  say(`Legitimate invoice #${inv.id} (1,000 USDC to alice): firewall decisions ${invVotes}, council approves -> ${invRes.status}`);

  const un = await api("POST", "/api/demo/action/dao-unpause", { target: A.vault.accountId });
  say(`DAO council vote #${un.proposalId} unpauses the vault (owner = DAO, Qorvex cannot unpause): paused=${un.paused}. The guard re-trips on the next outflow until the books are fixed.`);

  say("Trezu #1871 at the relayer: the attacker owns their DAO, so no DAO-side firewall; the sponsor checks the proposal before relaying the approval");
  const rOpen = await api("POST", "/api/demo/action/relay-vote", { mode: "unguarded" });
  say(`  without Qorvex: relayed=${rOpen.relayed}, ${rOpen.registrations?.sponsored ?? 0} sponsored registrations, sponsor ${formatNear(BigInt(rOpen.sponsorBalanceBefore))} -> ${formatNear(BigInt(rOpen.sponsorBalanceAfter))}`);
  const rG = await api("POST", "/api/demo/action/relay-vote", { mode: "guarded" });
  say(`  with Qorvex checkProposal(): relayed=${rG.relayed}, refused: ${rG.refused}; sponsor ${formatNear(BigInt(rG.sponsorBalanceBefore))} -> ${formatNear(BigInt(rG.sponsorBalanceAfter))}`);

  // --- Trust model
  const hist: any = await near.view(A.guardian.accountId, "pause_history", { target: A.ledger.accountId });
  say(`Guardian on-chain pause history for ${A.ledger.accountId}: ${JSON.stringify(hist)}`);
  say(`Qorvex holds one key: function-call, receiver ${w.watcherPauseKey.receiverId}, methods ${JSON.stringify(w.watcherPauseKey.methodNames)}.`);
  return ["=== Qorvex demo summary ===", ...lines, `Console: ${base}/   Status pages: ${base}/status/${ledgerId}  ${base}/status/${vaultId}  ${base}/status/${dao.id}`].join("\n");
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return undefined;
}
