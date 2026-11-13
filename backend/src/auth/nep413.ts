/**
 * NEP-413 verification for sign-in, account linking and step-up signatures.
 *
 * - The message, recipient and nonce come from the server's own nonce row,
 *   never from the client, so a signature made for another site (another
 *   recipient) or another action never verifies here.
 * - `callbackUrl` is part of the Borsh payload and some wallets sign without
 *   it (None and Some encode differently), so both encodings are tried.
 * - The key must be a FullAccess key of the account, read from the chain.
 *   An RPC failure is reported as `rpc-down` (fail closed, "retry"), never
 *   confused with a key that does not exist.
 */
import { verifyNep413Signature } from "near-kit";
import { RpcError, type NearRpc } from "../near/rpc.ts";

export interface SignedNep413 {
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface Nep413Expected {
  message: string;
  recipient: string;
  /** 32 bytes. */
  nonce: Uint8Array;
  callbackUrl?: string | null;
}

/** True when the signature verifies over the expected payload, with or without the callbackUrl. */
export async function verifyNep413(signed: SignedNep413, expected: Nep413Expected): Promise<boolean> {
  const base = { message: expected.message, recipient: expected.recipient, nonce: expected.nonce };
  const variants = expected.callbackUrl ? [{ ...base, callbackUrl: expected.callbackUrl }, base] : [base];
  for (const params of variants) {
    // The server issued and consumed the nonce itself, so near-kit's timestamp-nonce check is off.
    if (await verifyNep413Signature(signed, params, { nonceValidation: "none" })) return true;
  }
  return false;
}

export type KeyCheck = "full-access" | "function-call" | "missing" | "rpc-down";

/** Read the key from the chain: is it a FullAccess key of this account? */
export async function checkFullAccessKey(rpc: NearRpc, accountId: string, publicKey: string): Promise<KeyCheck> {
  try {
    const k = await rpc.viewAccessKey(accountId, publicKey, { finality: "final" });
    return k.result?.permission === "FullAccess" ? "full-access" : "function-call";
  } catch (e) {
    if (e instanceof RpcError) {
      // Deterministic "no such key / no such account" answers from the node.
      const text = `${e.kind ?? ""} ${e.message}`;
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist|QUERY_ERROR|INVALID_ACCOUNT/i.test(text) && e.kind !== "HTTP" && e.kind !== "NETWORK") return "missing";
    }
    return "rpc-down";
  }
}

export const KEY_CHECK_MESSAGE: Record<Exclude<KeyCheck, "full-access">, string> = {
  "function-call": "This key is a function-call key. NEAR sign-in needs a full-access key of the account. Use a wallet that holds one, or sign in with email.",
  missing: "This key is not (or no longer) on the account.",
  "rpc-down": "Could not reach the NEAR RPC to check the key. Nothing was signed in; please retry.",
};
