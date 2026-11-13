/**
 * Replay the NEAR Intents ghost-balance bug on the testnet demo world that
 * `npm run deploy:testnet` created (keys in data/testnet/world.json).
 *
 *   npm run replay:testnet -- state                 read owed / held / paused (no signing)
 *   npm run replay:testnet -- deposit --yes         Alice deposits 1,000 demo USDC (honest traffic)
 *   npm run replay:testnet -- ghost --yes           Mallory's ghost deposit of 40,000 (the exploit)
 *   npm run replay:testnet -- cash-out --yes        Mallory tries to withdraw the ghost balance
 *   npm run replay:testnet -- rearm --yes           owner tops up the books, allows another pause, unpauses
 *
 * Run the Qorvex server with the QORVEX_TESTNET_* lines the deploy printed
 * (QORVEX_NETWORKS=testnet npm start) and an approved solvency rule on the
 * ledger, then run `ghost`: the watcher should pause the ledger through the
 * guardian a few blocks later, and `cash-out` should be rejected.
 *
 * Every command except `state` signs testnet transactions, hence --yes.
 */
import fs from "node:fs";
import { InMemoryKeyStore, Near } from "near-kit";
import { NETWORKS, loadDotEnv } from "../src/config.ts";
import { ghostDeposit, type DemoWorld } from "../src/demo/deploy.ts";
import { DemoActions } from "../src/demo/actions.ts";
import { fromRepoRoot } from "../src/paths.ts";

loadDotEnv();
const cmd = process.argv[2];
const file = fromRepoRoot("data/testnet/world.json");
if (!fs.existsSync(file)) {
  console.error(`${file} not found: run \`npm run deploy:testnet -- --yes\` first.`);
  process.exit(1);
}
const world = JSON.parse(fs.readFileSync(file, "utf8")) as DemoWorld;
const rpcUrl = process.env.QORVEX_TESTNET_RPC_URLS?.split(",")[0] ?? NETWORKS.testnet.rpcUrls[0];
const keys: Record<string, string> = {};
for (const a of Object.values(world.accounts)) if (a?.accountId && a.secretKey) keys[a.accountId] = a.secretKey;
const near = new Near({ network: { rpcUrl, networkId: "testnet" }, keyStore: new InMemoryKeyStore(keys) });
const actions = new DemoActions(near, world, {} as never);
const ledger = world.accounts.ledger.accountId;

const signs = cmd !== "state";
if (signs && !process.argv.includes("--yes")) {
  console.error(`\`${cmd ?? ""}\` signs testnet transactions. Re-run with --yes.`);
  process.exit(1);
}
const show = async () => {
  const s: any = await actions.ledgerState(ledger);
  console.log(`${ledger}: owed ${s.owed} · held ${s.held} · paused ${s.paused} · mallory ${s.balances.mallory} · guardian registration ${s.guardianRegistration ? "yes" : "no"}`);
};

if (cmd === "state") await show();
else if (cmd === "deposit") console.log(await actions.deposit(ledger, 1000));
else if (cmd === "ghost") console.log(`ghost deposit tx ${((await ghostDeposit(near, world, ledger, 40_000)) as any).transaction?.hash}`);
else if (cmd === "cash-out") console.log(await actions.withdraw(ledger, "mallory", 40_000));
else if (cmd === "rearm") console.log((await actions.rearm(ledger)).steps.join("\n"));
else {
  console.error("usage: npm run replay:testnet -- state | deposit | ghost | cash-out | rearm  (all but state need --yes)");
  process.exit(1);
}
if (signs) await show();
