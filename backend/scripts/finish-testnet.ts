/**
 * Finish a minimal testnet deploy that stopped part-way (accounts and
 * contracts exist, keys in data/testnet/keys.json). Each step checks the
 * chain first and is skipped when already done.
 *
 *   npm run finish:testnet                    print what would be done (reads only)
 *   npm run finish:testnet -- --yes           do it
 *   npm run finish:testnet -- --yes --deposit also make Alice's starter deposit (tops her up 0.2 NEAR)
 *
 * Steps: a new pause-only key on the watcher (the old one's private key was
 * lost), removal of unusable pause keys, the owner authorising the guardian on
 * the ledger, and writing data/testnet/world.json plus data/testnet/railway.env
 * (the three QORVEX_TESTNET_* variables, mode 600; never printed).
 */
import fs from "node:fs";
import path from "node:path";
import { InMemoryKeyStore, Near, parseKey } from "near-kit";
import { NETWORKS, loadDotEnv, requireEnv } from "../src/config.ts";
import { authoriseGuardian, usdc, type DemoWorld } from "../src/demo/deploy.ts";
import { newKey } from "../src/near/accounts.ts";
import { NearRpc } from "../src/near/rpc.ts";
import { fromRepoRoot } from "../src/paths.ts";

loadDotEnv();
const yes = process.argv.includes("--yes");
const deposit = process.argv.includes("--deposit");
const root = requireEnv("TESTNET_ACCOUNT_ID");
const rpcUrl = process.env.QORVEX_TESTNET_RPC_URLS?.split(",")[0] ?? NETWORKS.testnet.rpcUrls[0];
const dir = fromRepoRoot("data/testnet");
const keysFile = path.join(dir, "keys.json");
const keys: Record<string, string> = JSON.parse(fs.readFileSync(keysFile, "utf8"));
const id = (n: string) => `${n}.${root}`;
const A = { guardian: id("guardian"), watcher: id("watcher"), owner: id("owner"), usdc: id("usdc"), ledger: id("ledger"), alice: id("alice"), mallory: id("mallory") };
for (const a of Object.values(A)) if (!keys[a]) throw new Error(`no key for ${a} in ${keysFile}`);

const rpc = new NearRpc([rpcUrl]);
const ks: Record<string, string> = { [root]: requireEnv("TESTNET_PRIVATE_KEY") };
for (const a of Object.values(A)) ks[a] = keys[a];
const near = new Near({ network: { rpcUrl, networkId: "testnet" }, keyStore: new InMemoryKeyStore(ks) });

const save = () => fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
const pauseLabel = `watcher-pause-key:${A.watcher}`;

// ---- read the current state
const guard = (await rpc.view<any>(A.ledger, "guard_status", {})).value;
const keyList = (await rpc.call("query", { request_type: "view_access_key_list", finality: "final", account_id: A.watcher })).result.keys as any[];
const pauseKeys = keyList.filter((k) => k.access_key.permission?.FunctionCall?.receiver_id === A.guardian);
const savedPause = keys[pauseLabel];
const savedPub = savedPause ? newKeyFrom(savedPause) : undefined;
const usablePause = savedPub && pauseKeys.some((k) => k.public_key === savedPub);
const orphans = pauseKeys.filter((k) => k.public_key !== savedPub);
const owed = (await rpc.view<string>(A.ledger, "total_owed", { token_id: A.usdc })).value;

const plan: string[] = [];
if (!usablePause) plan.push(`add a new pause-only key on ${A.watcher} (receiver ${A.guardian}, method pause, 0.2 NEAR fee allowance), saved to keys.json first`);
const cleanup = process.argv.includes("--cleanup");
if (orphans.length && cleanup) plan.push(`delete ${orphans.length} pause key(s) on ${A.watcher} whose private key is not saved`);
if (guard.guardian !== A.guardian) plan.push(`${A.owner} authorises the guardian on ${A.ledger} (set_guardian, 1 yoctoNEAR; the ledger registers itself, 0.01 NEAR storage from the ledger)`);
if (deposit && owed === "0") plan.push(`send 0.2 NEAR from ${root} to ${A.alice}, then Alice deposits 250,000 demo USDC into the ledger`);
plan.push("write data/testnet/world.json and data/testnet/railway.env (QORVEX_TESTNET_* variables, not printed)");
console.log(`Finish the testnet deploy under ${root}:\n${plan.map((p, i) => `  ${i + 1}. ${p}`).join("\n")}`);
if (!deposit && owed === "0") console.log("  (Alice's starter deposit is skipped; add --deposit for it. The ledger then holds zero until someone deposits.)");
if (!yes) {
  console.log("\nNothing sent. Re-run with --yes to do this.");
  process.exit(0);
}

// ---- do it
let pauseSecret = usablePause ? savedPause! : undefined;
if (!usablePause) {
  const k = newKey();
  keys[pauseLabel] = k.secretKey;
  save();
  await near.transaction(A.watcher).addKey(k.publicKey, { type: "functionCall", receiverId: A.guardian, methodNames: ["pause"], allowance: "0.2 NEAR" }).send({ waitUntil: "FINAL" });
  pauseSecret = k.secretKey;
  console.log("added the new pause-only key");
}
for (const o of cleanup ? orphans : []) {
  await near.transaction(A.watcher).deleteKey(A.watcher, o.public_key).send({ waitUntil: "FINAL" });
  console.log(`deleted unusable pause key ${o.public_key.slice(0, 20)}…`);
}
if (guard.guardian !== A.guardian) console.log(`guardian authorised: ${await authoriseGuardian(near, A.owner, A.ledger, A.guardian)}`);
if (deposit && owed === "0") {
  await near.transaction(root).transfer(A.alice, "0.2 NEAR").send({ waitUntil: "FINAL" });
  await near.call(A.usdc, "ft_transfer_call", { receiver_id: A.ledger, amount: usdc(250_000), msg: "" }, { signerId: A.alice, attachedDeposit: "1 yocto", gas: "100 Tgas", waitUntil: "FINAL" });
  console.log("Alice deposited 250,000 demo USDC");
}
const reg = (await rpc.view<any>(A.guardian, "get_target", { target: A.ledger })).value;
if (!reg) throw new Error("the guardian has no registration for the ledger");

const acc = (n: keyof typeof A) => ({ accountId: A[n], secretKey: keys[A[n]], publicKey: newKeyFrom(keys[A[n]]) });
const world = {
  networkId: "testnet",
  rpcUrl,
  root,
  accounts: { guardian: acc("guardian"), watcher: acc("watcher"), owner: acc("owner"), usdc: acc("usdc"), ledger: acc("ledger"), alice: acc("alice"), mallory: acc("mallory") },
  watcherPauseKey: { accountId: A.watcher, secretKey: pauseSecret!, publicKey: newKeyFrom(pauseSecret!), receiverId: A.guardian, methodNames: ["pause"] },
  trapAccount: id("trap"),
  createdAt: new Date().toISOString(),
} as unknown as DemoWorld;
fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(dir, "railway.env"), `QORVEX_TESTNET_GUARDIAN=${A.guardian}\nQORVEX_TESTNET_WATCHER_ACCOUNT=${A.watcher}\nQORVEX_TESTNET_WATCHER_KEY=${pauseSecret}\n`, { mode: 0o600 });
console.log(`\nDone. The guardian can pause ${A.ledger} (registered, council ${reg.council}).`);
console.log(`Railway variables written to ${path.join(dir, "railway.env")} (copy the three lines into Railway → Variables).`);

/** Public key of an "ed25519:<base58>" secret key. */
function newKeyFrom(secret: string): string {
  return parseKey(secret).publicKey.toString();
}
