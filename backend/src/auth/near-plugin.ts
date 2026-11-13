/**
 * NEAR wallet sign-in for Better Auth (NEP-413), written in this repository
 * instead of better-near-auth 1.10.2, which does not compare the signed
 * `recipient` with its configuration and never reads back its issued nonce
 * (see the multi-tenant change-request review of 2026-11-12).
 *
 * Endpoints (under /api/auth):
 *   POST /near/nonce   {network, purpose: "sign-in"|"link"|"step-up", callbackUrl?, action?, target?, params?}
 *                      -> {nonce (base64, 32 bytes), message, recipient, callbackUrl}
 *   POST /near/verify  {nonce, accountId, publicKey, signature}   sign in (creates the user on first use)
 *   POST /near/link    {nonce, accountId, publicKey, signature}   link another NEAR account to the signed-in user
 *
 * Step-up signatures (a fresh signature for one action) are verified by
 * `consumeStepUp`, called from the Qorvex API routes that need one.
 *
 * Every nonce is single-use, expires after 5 minutes and is consumed with one
 * `DELETE ... RETURNING` statement, so two concurrent requests can never both
 * use it. The message and recipient the signature must cover come from the
 * nonce row, never from the client.
 */
import crypto from "node:crypto";
import * as z from "zod";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import type { NetworkId } from "@qorvex/shared";
import type { Db } from "../db/db.ts";
import type { NearRpc } from "../near/rpc.ts";
import { checkFullAccessKey, KEY_CHECK_MESSAGE, verifyNep413Report, type SignedNep413 } from "./nep413.ts";

export const NONCE_TTL_MS = 5 * 60_000;
export const NEAR_PROVIDER = "near";

export interface NearAuthOptions {
  db: Db;
  /** The exact host users sign for (NEP-413 `recipient`), e.g. "app.example.com" or "localhost:8787". */
  recipient: string;
  /** Origin that callbackUrls must start with. */
  origin: string;
  /** RPC for a network, or undefined when that network is not enabled. */
  rpcFor: (network: NetworkId) => NearRpc | undefined;
  /** All origins of this app (a wallet may sign the page address as callbackUrl). */
  trustedOrigins?: string[];
  /** Server log, for signature failures. */
  log?: (s: string) => void;
  /** Called after a NEAR sign-in, to attach pending NEAR-account invitations. */
  onSignedIn?: (userId: string, nearAccount: string) => Promise<void>;
}

type Purpose = "sign-in" | "link" | "step-up";
interface NonceRow {
  nonce: string;
  purpose: Purpose;
  message: string;
  state: string | null;
  user_id: string | null;
  expires_at: number;
}
interface NonceState {
  network: NetworkId;
  callbackUrl?: string;
  action?: string;
  target?: string;
  paramsHash?: string;
}

const NETWORKS = ["mainnet", "testnet", "sandbox"] as const;
const signedBody = z.object({
  nonce: z.string().min(40).max(64),
  accountId: z.string().min(2).max(64),
  publicKey: z.string().min(10).max(128),
  signature: z.string().min(10).max(256),
  /** The page the wallet was opened from; some wallets sign it as callbackUrl. */
  pageUrl: z.string().max(500).optional(),
});

/** Page addresses a wallet may have signed as callbackUrl: only addresses of this app, with and without query/hash. */
function pageCallbacks(o: NearAuthOptions, pageUrl?: string): string[] {
  const origins = new Set([o.origin, ...(o.trustedOrigins ?? [])]);
  const out: string[] = [];
  if (pageUrl) {
    try {
      const u = new URL(pageUrl);
      if (origins.has(u.origin)) out.push(pageUrl, `${u.origin}${u.pathname}`, `${u.origin}${u.pathname}${u.search}`);
    } catch {
      /* ignore an unparseable page address */
    }
  }
  for (const origin of origins) out.push(origin, `${origin}/`);
  return [...new Set(out)];
}

/** Stable hash of the parameters an action is bound to (key order does not matter). */
export function paramsHash(params: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return crypto.createHash("sha256").update(JSON.stringify(canon(params ?? {}))).digest("hex").slice(0, 32);
}

export function nearAccountKey(network: NetworkId, accountId: string): string {
  return `${network}:${accountId}`;
}

function issueNonce(db: Db, purpose: Purpose, message: string, state: NonceState, userId: string | null): string {
  const nonce = crypto.randomBytes(32).toString("base64");
  db.prepare("DELETE FROM near_nonces WHERE expires_at < ?").run(Date.now());
  db.prepare("INSERT INTO near_nonces (nonce, purpose, message, state, user_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(nonce, purpose, message, JSON.stringify(state), userId, Date.now() + NONCE_TTL_MS);
  return nonce;
}

/** Atomically take a nonce: it is gone after this, whether or not the signature verifies. */
function takeNonce(db: Db, nonce: string, purpose: Purpose): (NonceRow & { st: NonceState }) | undefined {
  const row = db.prepare("DELETE FROM near_nonces WHERE nonce = ? AND purpose = ? AND expires_at > ? RETURNING *").get(nonce, purpose, Date.now()) as NonceRow | undefined;
  return row ? { ...row, st: JSON.parse(row.state ?? "{}") as NonceState } : undefined;
}

export class NearAuthError extends Error {
  constructor(
    public readonly code: "NONCE" | "SIGNATURE" | "KEY" | "RPC" | "ACCOUNT" | "BINDING",
    message: string,
  ) {
    super(message);
  }
}

/** Verify a signature against a taken nonce row: signature, then the key on chain. */
async function verifyAgainst(o: NearAuthOptions, row: NonceRow & { st: NonceState }, s: SignedNep413 & { pageUrl?: string }): Promise<void> {
  const report = await verifyNep413Report(s, {
    message: row.message,
    recipient: o.recipient,
    nonce: Buffer.from(row.nonce, "base64"),
    callbackUrl: row.st.callbackUrl ?? null,
    extraCallbackUrls: pageCallbacks(o, s.pageUrl),
  });
  if (!report.ok) {
    const detail = `account=${s.accountId} key=${s.publicKey} signature=${s.signature.slice(0, 12)}…(${s.signature.length} chars) purpose=${row.purpose} recipient=${o.recipient} tried=${JSON.stringify(report.tried)}`;
    o.log?.(`NEP-413 signature did not verify: ${detail}`);
    throw new NearAuthError("SIGNATURE", `The signature does not match this request (message, recipient, nonce or callbackUrl). ${detail}`);
  }
  const rpc = o.rpcFor(row.st.network);
  if (!rpc) throw new NearAuthError("RPC", `Network ${row.st.network} is not enabled on this server.`);
  const k = await checkFullAccessKey(rpc, s.accountId, s.publicKey);
  if (k === "rpc-down") throw new NearAuthError("RPC", KEY_CHECK_MESSAGE["rpc-down"]);
  if (k !== "full-access") throw new NearAuthError("KEY", KEY_CHECK_MESSAGE[k]);
}

function toApiError(e: unknown): never {
  if (e instanceof NearAuthError) {
    const status = e.code === "RPC" ? "SERVICE_UNAVAILABLE" : "UNAUTHORIZED";
    throw APIError.fromStatus(status, { message: e.message, code: `NEAR_${e.code}` });
  }
  throw e;
}

/** Linked NEAR accounts of a user, as "network:account" keys. */
export function linkedNearAccounts(db: Db, userId: string): { network: NetworkId; accountId: string }[] {
  const rows = db.prepare(`SELECT accountId FROM account WHERE userId = ? AND providerId = ?`).all(userId, NEAR_PROVIDER) as { accountId: string }[];
  return rows.map((r) => {
    const i = r.accountId.indexOf(":");
    return { network: r.accountId.slice(0, i) as NetworkId, accountId: r.accountId.slice(i + 1) };
  });
}

export interface StepUpProof extends SignedNep413 {
  nonce: string;
  pageUrl?: string;
}

/**
 * Verify a step-up signature for one action: the nonce was issued to this
 * user for exactly this action, target and parameters; the signer is one of
 * the user's linked NEAR accounts (or `allowAccount`); and its key is still a
 * full-access key on chain. Returns what the audit log stores.
 */
export async function consumeStepUp(
  o: NearAuthOptions,
  userId: string,
  binding: { action: string; target: string; params: unknown },
  proof: StepUpProof,
  allowAccount?: (network: NetworkId, accountId: string) => boolean,
): Promise<{ network: NetworkId; accountId: string; message: string; signature: string; publicKey: string }> {
  const row = takeNonce(o.db, proof.nonce, "step-up");
  if (!row) throw new NearAuthError("NONCE", "The step-up request expired or was already used. Sign again.");
  if (row.user_id !== userId) throw new NearAuthError("BINDING", "This step-up signature was requested by another user.");
  if (row.st.action !== binding.action || row.st.target !== binding.target || row.st.paramsHash !== paramsHash(binding.params)) {
    throw new NearAuthError("BINDING", "This signature approves a different action, contract or parameters.");
  }
  const linked = linkedNearAccounts(o.db, userId).some((a) => a.network === row.st.network && a.accountId === proof.accountId);
  if (!linked && !allowAccount?.(row.st.network, proof.accountId)) throw new NearAuthError("ACCOUNT", `${proof.accountId} is not linked to your user. Link it first.`);
  await verifyAgainst(o, row, proof);
  return { network: row.st.network, accountId: proof.accountId, message: row.message, signature: proof.signature, publicKey: proof.publicKey };
}

export const nearAuth = (o: NearAuthOptions) => {
  const issued = () => new Date().toISOString();
  return {
    id: "near-nep413",
    endpoints: {
      nearNonce: createAuthEndpoint(
        "/near/nonce",
        {
          method: "POST",
          body: z.object({
            network: z.enum(NETWORKS),
            purpose: z.enum(["sign-in", "link", "step-up"]),
            callbackUrl: z.string().max(500).optional(),
            action: z.string().max(64).optional(),
            target: z.string().max(128).optional(),
            params: z.unknown().optional(),
          }),
        },
        async (ctx) => {
          const b = ctx.body;
          if (!o.rpcFor(b.network)) throw APIError.fromStatus("BAD_REQUEST", { message: `Network ${b.network} is not enabled on this server.` });
          if (b.callbackUrl && !b.callbackUrl.startsWith(`${o.origin}/`)) throw APIError.fromStatus("BAD_REQUEST", { message: "callbackUrl must be on this site." });
          let userId: string | null = null;
          if (b.purpose !== "sign-in") {
            const session = await getSessionFromCtx(ctx);
            if (!session) throw APIError.fromStatus("UNAUTHORIZED", { message: "Sign in first." });
            userId = session.user.id;
          }
          let message: string;
          const state: NonceState = { network: b.network, callbackUrl: b.callbackUrl };
          if (b.purpose === "sign-in") message = `Sign in to Qorvex\nhost: ${o.recipient}\nissued: ${issued()}`;
          else if (b.purpose === "link") message = `Link this NEAR account to your Qorvex user\nhost: ${o.recipient}\nissued: ${issued()}`;
          else {
            if (!b.action || !b.target) throw APIError.fromStatus("BAD_REQUEST", { message: "A step-up signature needs an action and a target." });
            state.action = b.action;
            state.target = b.target;
            state.paramsHash = paramsHash(b.params);
            message = `Qorvex action: ${b.action} · contract: ${b.target} · params: ${state.paramsHash}\nhost: ${o.recipient}\nissued: ${issued()}`;
          }
          const nonce = issueNonce(o.db, b.purpose, message, state, userId);
          return ctx.json({ nonce, message, recipient: o.recipient, callbackUrl: b.callbackUrl ?? null, expiresInMs: NONCE_TTL_MS });
        },
      ),
      nearVerify: createAuthEndpoint("/near/verify", { method: "POST", body: signedBody, requireRequest: true }, async (ctx) => {
        const s = ctx.body;
        const row = takeNonce(o.db, s.nonce, "sign-in");
        if (!row) throw APIError.fromStatus("UNAUTHORIZED", { message: "This sign-in request expired or was already used. Start again.", code: "NEAR_NONCE" });
        try {
          await verifyAgainst(o, row, s);
        } catch (e) {
          toApiError(e);
        }
        const key = nearAccountKey(row.st.network, s.accountId);
        const adapter = ctx.context.adapter;
        const existing = (await adapter.findOne({ model: "account", where: [{ field: "providerId", value: NEAR_PROVIDER }, { field: "accountId", value: key }] })) as { userId: string } | null;
        let user = existing ? await ctx.context.internalAdapter.findUserById(existing.userId) : null;
        let newUser = false;
        if (!user) {
          const local = s.accountId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
          user = await ctx.context.internalAdapter.createUser({ name: s.accountId, email: `${local}.${row.st.network}@near.placeholder.invalid`, emailVerified: false, image: "" }, { method: "near-nep413" });
          await ctx.context.internalAdapter.createAccount({ userId: user.id, providerId: NEAR_PROVIDER, accountId: key, createdAt: new Date(), updatedAt: new Date() });
          newUser = true;
        }
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw APIError.fromStatus("INTERNAL_SERVER_ERROR", { message: "Could not create a session." });
        await setSessionCookie(ctx, { session, user });
        await o.onSignedIn?.(user.id, key).catch(() => {});
        // The session token stays in the httpOnly cookie; it is not returned in the body.
        return ctx.json({ ok: true, newUser, user: { id: user.id, name: user.name }, nearAccount: { network: row.st.network, accountId: s.accountId } });
      }),
      nearLink: createAuthEndpoint("/near/link", { method: "POST", body: signedBody, requireRequest: true }, async (ctx) => {
        const session = await getSessionFromCtx(ctx);
        if (!session) throw APIError.fromStatus("UNAUTHORIZED", { message: "Sign in first." });
        const s = ctx.body;
        const row = takeNonce(o.db, s.nonce, "link");
        if (!row || row.user_id !== session.user.id) throw APIError.fromStatus("UNAUTHORIZED", { message: "This link request expired or was already used. Start again.", code: "NEAR_NONCE" });
        try {
          await verifyAgainst(o, row, s);
        } catch (e) {
          toApiError(e);
        }
        const key = nearAccountKey(row.st.network, s.accountId);
        const existing = (await ctx.context.adapter.findOne({ model: "account", where: [{ field: "providerId", value: NEAR_PROVIDER }, { field: "accountId", value: key }] })) as { userId: string } | null;
        if (existing && existing.userId !== session.user.id) throw APIError.fromStatus("CONFLICT", { message: `${s.accountId} is already linked to another Qorvex user.` });
        if (!existing) await ctx.context.internalAdapter.createAccount({ userId: session.user.id, providerId: NEAR_PROVIDER, accountId: key, createdAt: new Date(), updatedAt: new Date() });
        await o.onSignedIn?.(session.user.id, key).catch(() => {});
        return ctx.json({ ok: true, linked: { network: row.st.network, accountId: s.accountId } });
      }),
    },
  } satisfies BetterAuthPlugin;
};
