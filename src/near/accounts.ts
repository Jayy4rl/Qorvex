/**
 * Signing helpers built on near-kit. Keys live only in memory or in the
 * git-ignored data directory, never in the repository.
 */
import { Near, InMemoryKeyStore, generateKey } from "near-kit";

export interface KeyedAccount {
  accountId: string;
  secretKey: string;
  publicKey: string;
}

export function nearFor(rpcUrl: string, networkId: string, keys: Record<string, string>): Near {
  return new Near({ network: { rpcUrl, networkId }, keyStore: new InMemoryKeyStore(keys) });
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
