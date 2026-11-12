/**
 * Signing helpers built on near-kit. Keys live only in memory or in the
 * git-ignored data directory, never in the repository.
 */
import { Near, generateKey } from "near-kit";

export interface KeyedAccount {
  accountId: string;
  secretKey: string;
  publicKey: string;
}

/** A key the Qorvex service signs with: a function-call key on one account (e.g. limited to `guardian.pause`). */
export interface FunctionCallKey {
  accountId: string;
  secretKey: string;
}

/** A near-kit client that signs as `key.accountId` with that one key. */
export function signerFor(rpcUrls: string[], networkId: string, key: FunctionCallKey): Near {
  return new Near({ network: { rpcUrl: rpcUrls[0], networkId }, privateKey: key.secretKey as `ed25519:${string}`, defaultSignerId: key.accountId });
}

export function newKey(): { secretKey: string; publicKey: string } {
  const k = generateKey();
  return { secretKey: k.secretKey, publicKey: k.publicKey.toString() };
}

/**
 * Create `accountId` (a sub-account of `parent`) with a fresh full-access
 * key, fund it, and optionally deploy + initialise a contract, in one
 * transaction signed by `parent`.
 */
export async function createAccount(
  near: Near,
  parent: string,
  accountId: string,
  opts: { balance: string; wasm?: Uint8Array; init?: { method: string; args: object } },
): Promise<KeyedAccount> {
  const key = newKey();
  let tx = near
    .transaction(parent)
    .createAccount(accountId)
    .transfer(accountId, opts.balance as `${number} NEAR`)
    .addKey(key.publicKey, { type: "fullAccess" });
  if (opts.wasm) tx = tx.deployContract(accountId, opts.wasm);
  if (opts.wasm && opts.init) tx = tx.functionCall(accountId, opts.init.method, opts.init.args, { gas: "100 Tgas" });
  await tx.send({ waitUntil: "FINAL" });
  return { accountId, ...key };
}
