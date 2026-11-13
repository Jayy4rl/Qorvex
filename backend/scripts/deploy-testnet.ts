/**
 * Deploy the demo world to NEAR testnet under a funded account you control.
 *
 *   TESTNET_ACCOUNT_ID=you.testnet TESTNET_PRIVATE_KEY=ed25519:... npm run deploy:testnet          # prints the plan only
 *   TESTNET_ACCOUNT_ID=you.testnet TESTNET_PRIVATE_KEY=ed25519:... npm run deploy:testnet -- --yes  # signs and deploys (add --full for everything)
 *
 * Two profiles:
 *   default (minimal)  guardian, demo token, ledger, watcher, owner, alice, mallory:
 *                      what the ghost-balance replay needs. About 7.4 testnet NEAR.
 *   --full             also the treasury DAO, vault, firewall and the Trezu
 *                      sponsor-drain actors. About 25 testnet NEAR.
 *
 * Almost all of it is storage staking (~1 NEAR per 100 KB of contract code),
 * which is locked, not spent: deleting the accounts returns it. Gas for the
 * whole deploy is about 0.1 NEAR. The plan prints the exact total and the
 * script refuses to start when the root account cannot cover it, so it never
 * stops halfway for lack of funds. Get testnet NEAR from the faucet
 * (https://docs.near.org/getting-started/faucet).
 *
 * Keys of the created accounts are written to data/testnet/world.json
 * (git-ignored) AS EACH ACCOUNT IS CREATED, so a failure part-way through
 * never strands funds in accounts whose keys were lost. The env lines for the
 * Qorvex service (watcher function-call key only) are printed at the end.
 *
 * This script signs transactions. HACKATHON.md requires the human's explicit
 * confirmation before that, hence the --yes flag.
 */
import fs from "node:fs";
import path from "node:path";
import { InMemoryKeyStore, Near, parseKey } from "near-kit";
import { NETWORKS, loadDotEnv, requireEnv } from "../src/config.ts";
import { deployDemoWorld, authoriseGuardian, authoriseGuardianViaDao, MINIMAL_ACCOUNTS, type AccountName } from "../src/demo/deploy.ts";
import { NearRpc } from "../src/near/rpc.ts";
import { fromRepoRoot } from "../src/paths.ts";

loadDotEnv();
const root = requireEnv("TESTNET_ACCOUNT_ID");
const key = requireEnv("TESTNET_PRIVATE_KEY");
const rpcUrl = process.env.QORVEX_TESTNET_RPC_URLS?.split(",")[0] ?? NETWORKS.testnet.rpcUrls[0];

const full = process.argv.includes("--full");
/** Balances for the minimal profile (tighter: no DAO proposals, smaller key allowance). */
const MINIMAL_BALANCE: Partial<Record<AccountName, number>> = { guardian: 2.3, watcher: 0.25, owner: 0.3, usdc: 1.75, ledger: 2.25, alice: 0.1, mallory: 0.2 };

/** Every account the full demo world creates, with its testnet balance and what it is. */
const fullPlan: Record<AccountName, { balance: number; sub: string; what: string; parent?: AccountName }> = {
  guardian: { balance: 2.5, sub: "guardian", what: "guardian contract (210 KB wasm)" },
  watcher: { balance: 0.6, sub: "watcher", what: "holds the pause-only key (0.5 NEAR allowance)" },
  firewall: { balance: 0.6, sub: "firewall", what: "holds the reject-only DAO key (0.5 NEAR allowance)" },
  owner: { balance: 0.5, sub: "owner", what: "ledger owner, treasury council member" },
  treasury: { balance: 5.0, sub: "treasury", what: "Sputnik DAO v2.3.1 (444 KB), owns the vault" },
  malloryDao: { balance: 5.0, sub: "mallory-dao", what: "attacker's Sputnik DAO (Trezu #1871 replay)" },
  usdc: { balance: 1.9, sub: "usdc", what: "demo NEP-141 token (162 KB)" },
  ledger: { balance: 2.4, sub: "ledger", what: "demo ledger, self-accounting off (208 KB)" },
  vault: { balance: 2.4, sub: "vault", what: "demo ledger, self-accounting on (208 KB)" },
  alice: { balance: 0.2, sub: "alice", what: "honest depositor" },
  mallory: { balance: 2.4, sub: "mallory", what: "attacker; funds capture.mallory" },
  sponsor: { balance: 0.6, sub: "sponsor", what: "relayer sponsor (with check())" },
  sponsorOpen: { balance: 0.6, sub: "sponsor-open", what: "relayer sponsor (without check())" },
  capture: { balance: 1.9, sub: "capture.mallory", what: "attacker's token contract (162 KB)", parent: "mallory" },
};
const plan = full
  ? fullPlan
  : (Object.fromEntries(MINIMAL_ACCOUNTS.map((k) => [k, { ...fullPlan[k], balance: MINIMAL_BALANCE[k]! }])) as typeof fullPlan);
// Transaction fees: ~0.1 NEAR in practice, with a margin.
const GAS_RESERVE = full ? 0.5 : 0.2;

const fromRoot = Object.values(plan).filter((p) => !p.parent).reduce((s, p) => s + p.balance, 0);
const needed = Math.round((fromRoot + GAS_RESERVE) * 100) / 100;
const rpc = new NearRpc([rpcUrl]);
const acct = await rpc.viewAccount(root);
const have = Number(BigInt(acct.amount) / 10n ** 21n) / 1000;

console.log(`Plan: deploy the Qorvex demo world (${full ? "full" : "minimal; --full adds the DAO and Trezu demos"}) on testnet under ${root} via ${rpcUrl}`);
console.log(`\n  ${"account".padEnd(34)} ${"NEAR".padStart(5)}  purpose`);
for (const p of Object.values(plan)) {
  console.log(`  ${`${p.sub}.${root}`.padEnd(34)} ${p.balance.toFixed(1).padStart(5)}  ${p.what}${p.parent ? ` (paid by ${p.parent})` : ""}`);
}
console.log(`\n  needed on ${root}: ${needed} NEAR (${fromRoot.toFixed(1)} funding + ${GAS_RESERVE} gas reserve); balance: ${have} NEAR`);
console.log(full ? "  then: pause-only key on watcher, reject-only key on firewall, mint demo USDC, alice deposits," : "  then: pause-only key on watcher, mint demo USDC, alice deposits,");
console.log(full ? "        the owner authorises the guardian on the ledger, the treasury DAO votes to authorise it on the vault" : "        the owner authorises the guardian on the ledger");
console.log("  storage staking is locked, not spent: deleting the accounts returns it");
if (have < needed) {
  console.error(`\nNot enough NEAR: ${root} has ${have}, needs ${needed}. Top it up from the faucet and run again.`);
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  console.log("\nDry run. Re-run with --yes to sign and send these transactions.");
  process.exit(0);
}

const dir = fromRepoRoot("data/testnet");
fs.mkdirSync(dir, { recursive: true });
const keysFile = path.join(dir, "keys.json");
const created: Record<string, string> = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
const clash = Object.values(plan).map((p) => `${p.sub}.${root}`).filter((a) => created[a]);
if (clash.length) {
  console.error(`\n${keysFile} already holds keys for ${clash.join(", ")}: an earlier run created them. Use a fresh root account, or move that file away after recovering its funds.`);
  process.exit(1);
}

const ks = new InMemoryKeyStore({ [root]: key });
const near = new Near({ network: { rpcUrl, networkId: "testnet" }, keyStore: ks });
const balances = Object.fromEntries(Object.entries(plan).map(([k, p]) => [k, `${p.balance} NEAR`])) as Partial<Record<AccountName, string>>;
const world = await deployDemoWorld(
  near,
  async (a) => {
    created[a.accountId] = a.secretKey;
    fs.writeFileSync(keysFile, JSON.stringify(created, null, 2), { mode: 0o600 });
    await ks.add(a.accountId, parseKey(a.secretKey));
  },
  root,
  rpcUrl,
  "testnet",
  { balances, minimal: !full, log: console.log },
);
const A = world.accounts;
console.log(`authorising guardian on ${A.ledger.accountId} (owner signs): ${await authoriseGuardian(near, A.owner.accountId, A.ledger.accountId, A.guardian.accountId)}`);
if (full) {
  console.log(
    `authorising guardian on ${A.vault.accountId} (treasury DAO vote): ${await authoriseGuardianViaDao(near, A.treasury.accountId, A.owner.accountId, A.vault.accountId, A.guardian.accountId)}`,
  );
}
for (const t of full ? [A.ledger.accountId, A.vault.accountId] : [A.ledger.accountId]) {
  const reg = await near.view(A.guardian.accountId, "get_target", { target: t });
  if (!reg) throw new Error(`guardian has no registration for ${t}`);
}
fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world, null, 2), { mode: 0o600 });
console.log(`\nKeys written to ${path.join(dir, "world.json")} (git-ignored). Add to .env for the Qorvex service:\n`);
console.log(`QORVEX_TESTNET_GUARDIAN=${A.guardian.accountId}`);
console.log(`QORVEX_TESTNET_WATCHER_ACCOUNT=${world.watcherPauseKey.accountId}`);
console.log(`QORVEX_TESTNET_WATCHER_KEY=${world.watcherPauseKey.secretKey}`);
