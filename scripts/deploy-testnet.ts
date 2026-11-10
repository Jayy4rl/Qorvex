/**
 * Deploy the demo world to NEAR testnet under a funded account you control.
 *
 *   TESTNET_ACCOUNT_ID=you.testnet TESTNET_PRIVATE_KEY=ed25519:... npm run deploy:testnet          # prints the plan only
 *   TESTNET_ACCOUNT_ID=you.testnet TESTNET_PRIVATE_KEY=ed25519:... npm run deploy:testnet -- --yes  # signs and deploys
 *
 * Needs about 18 testnet NEAR on the root account (contract storage staking
 * is ~1 NEAR per 100 KB of wasm). Get testnet NEAR from the faucet
 * (https://docs.near.org/getting-started/faucet). Keys of the created
 * accounts are written to data/testnet/world.json (git-ignored); the env
 * lines for the Qorvex service (watcher function-call key only) are printed.
 *
 * This script signs transactions. HACKATHON.md requires the human's explicit
 * confirmation before that, hence the --yes flag.
 */
import fs from "node:fs";
import path from "node:path";
import { InMemoryKeyStore, Near, parseKey } from "near-kit";
import { NETWORKS, loadDotEnv, requireEnv } from "../src/config.ts";
import { deployDemoWorld, authoriseGuardian } from "../src/demo/deploy.ts";
import { NearRpc } from "../src/near/rpc.ts";

loadDotEnv();
const root = requireEnv("TESTNET_ACCOUNT_ID");
const key = requireEnv("TESTNET_PRIVATE_KEY");
const rpcUrl = process.env.QORVEX_TESTNET_RPC_URLS?.split(",")[0] ?? NETWORKS.testnet.rpcUrls[0];
const balances = {
  guardian: "2.2 NEAR",
  watcher: "0.6 NEAR",
  owner: "0.5 NEAR",
  usdc: "2.1 NEAR",
  ledger: "2.7 NEAR",
  vault: "2.7 NEAR",
  alice: "0.2 NEAR",
  mallory: "2.5 NEAR",
  sponsor: "0.6 NEAR",
  sponsorOpen: "0.6 NEAR",
  capture: "2.0 NEAR",
};

const rpc = new NearRpc([rpcUrl]);
const acct = await rpc.viewAccount(root);
const have = Number(BigInt(acct.amount) / 10n ** 21n) / 1000;
console.log(`Plan: deploy the Qorvex demo world on testnet under ${root} (balance ${have} NEAR) via ${rpcUrl}`);
console.log(`  accounts: ${Object.keys(balances).map((k) => (k === "capture" ? `capture.mallory.${root}` : `${k === "sponsorOpen" ? "sponsor-open" : k}.${root}`)).join(", ")}`);
console.log(`  funding: ${Object.entries(balances).map(([k, v]) => `${k} ${v}`).join(", ")} (capture is funded by mallory)`);
console.log("  then: pause-only function-call key on watcher, mint demo USDC, alice deposits, ledger+vault authorise the guardian");
if (!process.argv.includes("--yes")) {
  console.log("\nDry run. Re-run with --yes to sign and send these transactions.");
  process.exit(0);
}

const ks = new InMemoryKeyStore({ [root]: key });
const near = new Near({ network: { rpcUrl, networkId: "testnet" }, keyStore: ks });
const world = await deployDemoWorld(near, (a) => ks.add(a.accountId, parseKey(a.secretKey)), root, rpcUrl, "testnet", { balances, log: console.log });
for (const t of [world.accounts.ledger.accountId, world.accounts.vault.accountId]) {
  console.log(`authorising guardian on ${t}: ${await authoriseGuardian(near, world.accounts.owner.accountId, t, world.accounts.guardian.accountId)}`);
}
const dir = path.resolve("data/testnet");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world, null, 2), { mode: 0o600 });
console.log(`\nKeys written to ${path.join(dir, "world.json")} (git-ignored). Add to .env for the Qorvex service:\n`);
console.log(`QORVEX_TESTNET_GUARDIAN=${world.accounts.guardian.accountId}`);
console.log(`QORVEX_TESTNET_WATCHER_ACCOUNT=${world.watcherPauseKey.accountId}`);
console.log(`QORVEX_TESTNET_WATCHER_KEY=${world.watcherPauseKey.secretKey}`);
