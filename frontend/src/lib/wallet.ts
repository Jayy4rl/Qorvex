/**
 * NEAR wallets through NEAR Connect (@hot-labs/near-connect), loaded on
 * demand so public pages do not pay for it.
 *
 * - signInWithWallet: NEP-413 sign-in against /api/auth/near/{nonce,verify}.
 * - stepUpHeader: a fresh signature bound to one action (x-qorvex-step-up).
 * - sendTransactions: the authorisation transactions the server builds.
 *
 * The message, recipient and nonce always come from the server; the browser
 * only asks the wallet to sign them.
 */
import type { NetworkId, WalletTx } from "@qorvex/shared";
import { api, ApiError } from "./api";

export type WalletNetwork = "mainnet" | "testnet";

type Connector = import("@hot-labs/near-connect").NearConnector;
const connectors = new Map<WalletNetwork, Promise<Connector>>();

function connector(network: WalletNetwork): Promise<Connector> {
  let c = connectors.get(network);
  if (!c) {
    c = import("@hot-labs/near-connect").then(({ NearConnector }) => new NearConnector({ network, features: { signMessage: true } }));
    connectors.set(network, c);
  }
  return c;
}

export class WalletError extends Error {}

async function wallet(network: WalletNetwork) {
  const c = await connector(network);
  try {
    return (await c.getConnectedWallet()).wallet;
  } catch {
    return await c.connect();
  }
}

interface NonceResponse {
  nonce: string;
  message: string;
  recipient: string;
  callbackUrl: string | null;
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function signNonce(network: WalletNetwork, n: NonceResponse, signerId?: string) {
  const w = await wallet(network);
  if (!w.manifest.features.signMessage) throw new WalletError(`${w.manifest.name} cannot sign messages. Choose another wallet, or sign in with email.`);
  try {
    return await w.signMessage({ message: n.message, recipient: n.recipient, nonce: fromB64(n.nonce), network, ...(signerId ? { signerId } : {}) });
  } catch (e) {
    const why = String((e as Error)?.message ?? "");
    console.error("[qorvex] wallet signMessage failed:", e);
    throw new WalletError(/reject|cancel|denied|closed|abort/i.test(why) || !why ? "You cancelled the request in your wallet." : "Your wallet couldn't sign this request. Try again, or choose another wallet.");
  }
}

/** Sign in (or link another account when `link` is true). */
export async function signInWithWallet(network: WalletNetwork, link = false): Promise<{ accountId: string; newUser?: boolean }> {
  const n = await api<NonceResponse>("/api/auth/near/nonce", { body: { network, purpose: link ? "link" : "sign-in" } });
  const s = await signNonce(network, n);
  const out = await api(link ? "/api/auth/near/link" : "/api/auth/near/verify", { body: { nonce: n.nonce, accountId: s.accountId, publicKey: s.publicKey, signature: s.signature } });
  return { accountId: s.accountId, newUser: out?.newUser };
}

/** A step-up proof for one action, ready for the x-qorvex-step-up header. */
export async function stepUpHeader(network: NetworkId, action: string, target: string, params: unknown, signerId?: string): Promise<Record<string, string>> {
  if (network === "sandbox") throw new WalletError("Wallets can't sign for the local demo network. Sign in with the operator token to use it.");
  const n = await api<NonceResponse>("/api/auth/near/nonce", { body: { network, purpose: "step-up", action, target, params } });
  const s = await signNonce(network, n, signerId);
  const proof = { nonce: n.nonce, accountId: s.accountId, publicKey: s.publicKey, signature: s.signature };
  return { "x-qorvex-step-up": btoa(JSON.stringify(proof)) };
}

/**
 * Call an API route; when it answers 428 (needs a fresh signature), ask the
 * wallet for one and retry once.
 */
export async function withStepUp<T>(network: NetworkId, call: (headers: Record<string, string>) => Promise<T>, signerId?: string): Promise<T> {
  try {
    return await call({});
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 428) throw e;
    const s = e.details?.stepUp;
    return call(await stepUpHeader(network, s.action, s.target, s.params, signerId));
  }
}

/** Ask the wallet to sign and send the server-built transactions, in order. */
export async function sendTransactions(network: WalletNetwork, txs: WalletTx[]): Promise<string[]> {
  const w = await wallet(network);
  let outcomes: unknown[];
  try {
    outcomes = await w.signAndSendTransactions({ network, transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions })) });
  } catch (e) {
    const why = String((e as Error)?.message ?? "");
    console.error("[qorvex] wallet signAndSendTransactions failed:", e);
    throw new WalletError(/reject|cancel|denied|closed|abort/i.test(why) || !why ? "You cancelled the transaction in your wallet. Nothing was sent." : "The transaction didn't go through. Check your wallet's balance and try again.");
  }
  return outcomes.map((o: any) => o?.transaction?.hash ?? o?.transaction_outcome?.id ?? "");
}

export async function disconnectWallets(): Promise<void> {
  for (const c of connectors.values()) await (await c).disconnect().catch(() => {});
}
