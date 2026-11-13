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
  /**
   * Other callbackUrls a wallet may have put into the signed payload on its own
   * (some sign the page address even when none was requested). Only addresses
   * of this app are passed here; they do not change what the signature proves.
   */
  extraCallbackUrls?: string[];
}

/**
 * Signature encodings wallets return: base64 (NEP-413), "ed25519:<base58>", or
 * bare base58. near-kit reads bare base58 as base64, so it is also tried prefixed.
 */
function signatureVariants(sig: string): string[] {
  const out = [sig];
  if (!sig.includes(":") && /^[1-9A-HJ-NP-Za-km-z]+$/.test(sig)) out.push(`ed25519:${sig}`);
  return out;
}

export interface VerifyReport {
  ok: boolean;
  /** For logs and developer details only (never secret: signatures and public keys are public). */
  tried: { callbackUrl: string | null; signatureFormat: string }[];
}

/** True when the signature verifies over the expected payload, with or without the callbackUrl. */
export async function verifyNep413(signed: SignedNep413, expected: Nep413Expected): Promise<boolean> {
  return (await verifyNep413Report(signed, expected)).ok;
}

export async function verifyNep413Report(signed: SignedNep413, expected: Nep413Expected): Promise<VerifyReport> {
  const base = { message: expected.message, recipient: expected.recipient, nonce: expected.nonce };
  const callbacks = [...new Set([expected.callbackUrl ?? null, null, ...(expected.extraCallbackUrls ?? [])])];
  const tried: VerifyReport["tried"] = [];
  for (const sig of signatureVariants(signed.signature)) {
    const format = sig.startsWith("ed25519:") ? (signed.signature.startsWith("ed25519:") ? "prefixed base58" : "bare base58") : "base64";
    for (const cb of callbacks) {
      tried.push({ callbackUrl: cb, signatureFormat: format });
      const params = cb ? { ...base, callbackUrl: cb } : base;
      // The server issued and consumed the nonce itself, so near-kit's timestamp-nonce check is off.
      if (await verifyNep413Signature({ ...signed, signature: sig }, params, { nonceValidation: "none" })) return { ok: true, tried };
    }
  }
  return { ok: false, tried };
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
