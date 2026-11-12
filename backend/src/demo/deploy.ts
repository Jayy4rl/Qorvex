/**
 * Deploys the complete demo world under one root account (the sandbox root
 * `test.near`, or a funded testnet account):
 *
 *   guardian.<root>     Qorvex guardian contract (owner: <root>, i.e. Qorvex ops)
 *   watcher.<root>      watcher account; the Qorvex service gets ONLY a function-call key limited to guardian.pause
 *   firewall.<root>     proposal-firewall account; the service gets ONLY a function-call key limited to treasury.act_proposal
 *   owner.<root>        the protocol team's member account (council member of the treasury DAO, owner of the ledger)
 *   treasury.<root>     Sputnik DAO v2.3.1 (exact mainnet code): the team's treasury, the vault's owner and the guardian council
 *   usdc.<root>         demo NEP-141 token (6 decimals)
 *   ledger.<root>       demo ledger, self-accounting OFF (watcher catches the bug), owned by owner.<root>
 *   vault.<root>        demo ledger, self-accounting ON (pauses itself), owned by the treasury DAO
 *   alice.<root>        honest depositor, DAO requestor
 *   mallory.<root>      attacker, DAO requestor
 *   mallory-dao.<root>  attacker's own Sputnik DAO (Trezu issue #1871 shape)
 *   sponsor.<root>      gas-sponsor account of the relayer that uses Qorvex check() (Trezu replay)
 *   sponsor-open.<root> same, for the relayer without Qorvex (to show the drain)
 *   capture.mallory.<root>  attacker's own token contract (Trezu replay)
 */
import fs from "node:fs";
import path from "node:path";
import type { Near } from "near-kit";
import { createAccount, newKey, type KeyedAccount } from "../near/accounts.ts";
import { CONTRACTS_DIR } from "../paths.ts";

const USDC_DECIMALS = 6;
export const usdc = (n: number | bigint) => (BigInt(n) * 10n ** BigInt(USDC_DECIMALS)).toString();

type AccountName =
  | "guardian"
  | "watcher"
  | "firewall"
  | "owner"
  | "treasury"
  | "usdc"
  | "ledger"
  | "vault"
  | "alice"
  | "mallory"
  | "malloryDao"
  | "sponsor"
  | "sponsorOpen"
  | "capture";

export interface DemoWorld {
  networkId: string;
  rpcUrl: string;
  root: string;
  accounts: Record<AccountName, KeyedAccount>;
  /** The only key the Qorvex service holds for pausing: function-call, guardian.pause only. */
  watcherPauseKey: { accountId: string; secretKey: string; publicKey: string; receiverId: string; methodNames: string[] };
  /** The only key the Qorvex service holds for the treasury firewall: function-call, act_proposal on the DAO only. */
  firewallKey: { accountId: string; secretKey: string; publicKey: string; receiverId: string; methodNames: string[] };
  /** Account named in the malicious deposit message; it has no contract, so the notification fails. */
  trapAccount: string;
  createdAt: string;
}

type WasmName = "demo-ledger" | "demo-token" | "guardian" | "sputnikdao2";

export function wasmPath(name: WasmName): string {
  const base = CONTRACTS_DIR;
  // Sputnik DAO v2.3.1: the exact code mainnet sputnik-dao.near deploys (global contract
  // DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF), fetched from chain and hash-checked.
  return name === "sputnikdao2" ? path.join(base, "vendor", "sputnikdao2-v2.3.1.wasm") : path.join(base, "wasm", `${name}.wasm`);
}

function readWasm(name: WasmName): Uint8Array {
  const p = wasmPath(name);
  if (!fs.existsSync(p)) throw new Error(`${p} is missing: run \`npm run build:contracts\``);
  return fs.readFileSync(p);
}

/** A Sputnik DAO policy: one council role, one requestor role (can only add transfer/call proposals). */
export function daoPolicy(council: string[], requestors: string[]) {
  return {
    roles: [
      { name: "council", kind: { Group: council }, permissions: ["*:*"], vote_policy: {} },
      ...(requestors.length ? [{ name: "requestor", kind: { Group: requestors }, permissions: ["transfer:AddProposal", "call:AddProposal"], vote_policy: {} }] : []),
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
    proposal_bond: "0",
    proposal_period: "604800000000000",
    bounty_bond: "0",
    bounty_forgiveness_period: "86400000000000",
  };
}

interface DeployOptions {
  /** NEAR amounts; defaults suit the sandbox. Testnet uses smaller values. */
  balances?: Partial<Record<AccountName, string>>;
  log?: (s: string) => void;
}

export async function deployDemoWorld(near: Near, keyStoreAdd: (a: KeyedAccount) => Promise<void>, root: string, rpcUrl: string, networkId: string, opts: DeployOptions = {}): Promise<DemoWorld> {
  const log = opts.log ?? (() => {});
  const bal: Record<AccountName, string> = {
    guardian: "3 NEAR",
    watcher: "1 NEAR",
    firewall: "1 NEAR",
    owner: "5 NEAR",
    treasury: "8 NEAR",
    usdc: "3 NEAR",
    ledger: "4 NEAR",
    vault: "4 NEAR",
    alice: "2 NEAR",
    mallory: "6 NEAR",
    malloryDao: "6 NEAR",
    sponsor: "0.6 NEAR",
    sponsorOpen: "0.6 NEAR",
    capture: "3 NEAR",
    ...opts.balances,
  };
  const id = (n: string) => `${n}.${root}`;
  const ledgerWasm = readWasm("demo-ledger");
  const tokenWasm = readWasm("demo-token");
  const guardianWasm = readWasm("guardian");
  const daoWasm = readWasm("sputnikdao2");

  const acc = {} as DemoWorld["accounts"];
  const make = async (name: AccountName, accountId: string, parent: string, wasm?: Uint8Array, init?: { method: string; args: object }) => {
    log(`creating ${accountId}${wasm ? " (+contract)" : ""}`);
    acc[name] = await createAccount(near, parent, accountId, { balance: bal[name], wasm, init });
    await keyStoreAdd(acc[name]);
  };

  await make("owner", id("owner"), root);
  await make("watcher", id("watcher"), root);
  await make("firewall", id("firewall"), root);
  await make("alice", id("alice"), root);
  await make("mallory", id("mallory"), root);
  await make("guardian", id("guardian"), root, guardianWasm, { method: "new", args: { owner_id: root, watchers: [id("watcher")] } });
  await make("treasury", id("treasury"), root, daoWasm, {
    method: "new",
    args: { config: { name: "treasury", purpose: "Demo team treasury", metadata: "" }, policy: daoPolicy([id("owner")], [id("alice"), id("mallory")]) },
  });
  await make("malloryDao", id("mallory-dao"), root, daoWasm, {
    method: "new",
    args: { config: { name: "mallory-dao", purpose: "Attacker-controlled treasury", metadata: "" }, policy: daoPolicy([id("mallory")], []) },
  });
  await make("usdc", id("usdc"), root, tokenWasm, { method: "new", args: { owner_id: id("owner"), symbol: "USDC", decimals: USDC_DECIMALS } });
  await make("ledger", id("ledger"), root, ledgerWasm, { method: "new", args: { owner_id: id("owner"), tokens: [id("usdc")], self_accounting: false } });
  // The vault is owned by the treasury DAO: only a DAO vote can unpause it or change its limits.
  await make("vault", id("vault"), root, ledgerWasm, { method: "new", args: { owner_id: id("treasury"), tokens: [id("usdc")], self_accounting: true } });
  await make("sponsor", id("sponsor"), root);
  await make("sponsorOpen", id("sponsor-open"), root);
  await make("capture", `capture.${id("mallory")}`, id("mallory"), tokenWasm, {
    method: "new",
    args: { owner_id: id("mallory"), symbol: "CAPTURE", decimals: 6 },
  });

  // Qorvex ops keep the full-access keys; the service gets only these function-call keys.
  const pauseKey = newKey();
  const firewallKey = newKey();
  log("adding the pause-only and reject-only function-call keys");
  await near
    .transaction(id("watcher"))
    .addKey(pauseKey.publicKey, { type: "functionCall", receiverId: id("guardian"), methodNames: ["pause"], allowance: "0.5 NEAR" })
    .send({ waitUntil: "FINAL" });
  await near
    .transaction(id("firewall"))
    .addKey(firewallKey.publicKey, { type: "functionCall", receiverId: id("treasury"), methodNames: ["act_proposal"], allowance: "0.5 NEAR" })
    .send({ waitUntil: "FINAL" });

  const owner = id("owner");
  log("registering ledger, vault and treasury with the token, minting demo USDC");
  for (const a of [id("ledger"), id("vault"), id("treasury"), id("mallory-dao")]) {
    await near.call(id("usdc"), "storage_deposit", { account_id: a }, { signerId: owner, attachedDeposit: "0.00125 NEAR", gas: "30 Tgas" });
  }
  await near.call(id("usdc"), "mint", { account_id: id("alice"), amount: usdc(1_000_000) }, { signerId: owner, gas: "30 Tgas" });
  await near.call(id("usdc"), "mint", { account_id: id("mallory"), amount: usdc(50_000) }, { signerId: owner, gas: "30 Tgas" });
  await near.call(id("usdc"), "mint", { account_id: id("treasury"), amount: usdc(500_000) }, { signerId: owner, gas: "30 Tgas" });

  log("alice deposits 250,000 USDC into ledger and vault");
  for (const target of [id("ledger"), id("vault")]) {
    await near.call(
      id("usdc"),
      "ft_transfer_call",
      { receiver_id: target, amount: usdc(250_000), msg: "" },
      { signerId: id("alice"), attachedDeposit: "1 yocto", gas: "100 Tgas", waitUntil: "FINAL" },
    );
  }

  return {
    networkId,
    rpcUrl,
    root,
    accounts: acc,
    watcherPauseKey: { accountId: id("watcher"), ...pauseKey, receiverId: id("guardian"), methodNames: ["pause"] },
    firewallKey: { accountId: id("firewall"), ...firewallKey, receiverId: id("treasury"), methodNames: ["act_proposal"] },
    trapAccount: id("trap"),
    createdAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------- DAO helpers

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

/** Add a proposal to a Sputnik DAO; returns its id. */
export async function daoPropose(near: Near, dao: string, signer: string, description: string, kind: unknown): Promise<number> {
  const r: any = await near.call(dao, "add_proposal", { proposal: { description, kind } }, { signerId: signer, gas: "100 Tgas", waitUntil: "FINAL" });
  const v = r.status?.SuccessValue;
  if (v === undefined) throw new Error(`add_proposal failed: ${JSON.stringify(r.status).slice(0, 300)}`);
  return Number(JSON.parse(Buffer.from(v, "base64").toString("utf8")));
}

/** Vote on a proposal (fetches the proposal kind, which act_proposal must echo). */
export async function daoVote(near: Near, dao: string, signer: string, id: number, action: "VoteApprove" | "VoteReject" | "VoteRemove") {
  const p: any = await near.view(dao, "get_proposal", { id });
  return near.call(dao, "act_proposal", { id, action, proposal: p.kind }, { signerId: signer, gas: "300 Tgas", waitUntil: "FINAL" });
}

/** Council member proposes and approves in one go (council threshold is one member here). */
export async function councilExecute(near: Near, dao: string, member: string, description: string, kind: unknown): Promise<{ id: number; txHash: string }> {
  const id = await daoPropose(near, dao, member, description, kind);
  const r: any = await daoVote(near, dao, member, id, "VoteApprove");
  return { id, txHash: r.transaction?.hash };
}

/** A FunctionCall proposal kind calling one method with 1 yoctoNEAR (what owner-only methods require). */
export function oneYoctoCall(receiver: string, method: string, args: object, gas = "100000000000000") {
  return { FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: b64(args), deposit: "1", gas }] } };
}

/** Owner authorises the guardian on a protected contract: one transaction (operator step 4). */
export async function authoriseGuardian(near: Near, owner: string, target: string, guardian: string): Promise<string> {
  const r = await near.call(target, "set_guardian", { guardian_id: guardian }, { signerId: owner, attachedDeposit: "1 yocto", gas: "60 Tgas", waitUntil: "FINAL" });
  return (r as any).transaction?.hash ?? (r as any).transaction_outcome?.id;
}

/** Same, when the protected contract is owned by a DAO: the DAO votes the set_guardian call. */
export async function authoriseGuardianViaDao(near: Near, dao: string, member: string, target: string, guardian: string): Promise<string> {
  const r = await councilExecute(near, dao, member, `Let the Qorvex guardian ${guardian} pause ${target}`, oneYoctoCall(target, "set_guardian", { guardian_id: guardian }));
  return r.txHash;
}

/** The ghost-balance attack: deposit with a notification that fails. */
export async function ghostDeposit(near: Near, w: DemoWorld, target: string, amountUsdc: number) {
  return near.call(
    w.accounts.usdc.accountId,
    "ft_transfer_call",
    { receiver_id: target, amount: usdc(amountUsdc), msg: JSON.stringify({ notify: w.trapAccount }) },
    { signerId: w.accounts.mallory.accountId, attachedDeposit: "1 yocto", gas: "150 Tgas", waitUntil: "FINAL" },
  );
}
