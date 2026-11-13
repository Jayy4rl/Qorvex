/**
 * Creates the testnet firewall account: the account Sputnik DAOs add to a reject-only role.
 *
 *   TESTNET_ACCOUNT_ID=you.testnet TESTNET_PRIVATE_KEY=ed25519:... npm run firewall:testnet          # prints the plan only
 *   TESTNET_ACCOUNT_ID=you.testnet TESTNET_PRIVATE_KEY=ed25519:... npm run firewall:testnet -- --yes  # signs and creates it
 *
 * The account holds only gas money. Its key is shared by every DAO that enables the firewall,
 * and what it can do to a DAO is set by that DAO's own policy: a role whose only permissions
 * are transfer:VoteReject and call:VoteReject. The key is saved to data/testnet/keys.json and
 * the two Railway variables to data/testnet/railway.env (both git-ignored); nothing is printed.
 */
import fs from "node:fs";
import path from "node:path";
import { InMemoryKeyStore, Near } from "near-kit";
import { NETWORKS, loadDotEnv, requireEnv } from "../src/config.ts";
import { createAccount } from "../src/near/accounts.ts";
import { NearRpc } from "../src/near/rpc.ts";
import { fromRepoRoot } from "../src/paths.ts";

loadDotEnv();
const root = requireEnv("TESTNET_ACCOUNT_ID");
const rootKey = requireEnv("TESTNET_PRIVATE_KEY");
const rpcUrl = process.env.QORVEX_TESTNET_RPC_URLS?.split(",")[0] ?? NETWORKS.testnet.rpcUrls[0];
const accountId = `firewall.${root}`;
const BALANCE = "0.3";

const rpc = new NearRpc([rpcUrl]);
const exists = await rpc.viewAccount(accountId).then(() => true).catch(() => false);
console.log(`Plan: create ${accountId} with ${BALANCE} NEAR from ${root} (one transaction, plus fees).`);
if (exists) {
  console.error(`${accountId} already exists. Nothing to do.`);
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  console.log("Dry run. Re-run with --yes to sign and send.");
  process.exit(0);
}

const near = new Near({ network: { rpcUrl, networkId: "testnet" }, keyStore: new InMemoryKeyStore({ [root]: rootKey }) });
const acct = await createAccount(near, root, accountId, { balance: `${BALANCE} NEAR` });

const dir = fromRepoRoot("data/testnet");
fs.mkdirSync(dir, { recursive: true });
const keysFile = path.join(dir, "keys.json");
const keys: Record<string, string> = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, "utf8")) : {};
keys[accountId] = acct.secretKey;
fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });

const envFile = path.join(dir, "railway.env");
const lines = (fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "").split("\n").filter((l) => l && !l.startsWith("QORVEX_TESTNET_FIREWALL_"));
lines.push(`QORVEX_TESTNET_FIREWALL_ACCOUNT=${accountId}`, `QORVEX_TESTNET_FIREWALL_KEY=${acct.secretKey}`);
fs.writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });

console.log(`Created ${accountId}. Its key is in ${keysFile}; add QORVEX_TESTNET_FIREWALL_ACCOUNT and QORVEX_TESTNET_FIREWALL_KEY from ${envFile} to Railway.`);
