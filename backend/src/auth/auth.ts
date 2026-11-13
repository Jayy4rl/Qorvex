/**
 * Better Auth: sessions, email/password, workspaces (organization plugin with
 * the four Qorvex roles), organization-owned API keys and NEAR sign-in.
 *
 * Everything lives in the service's SQLite database (Better Auth's tables are
 * created by its own migrations on start). Mounted at /api/auth on the
 * plain node:http server.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { getMigrations } from "better-auth/db/migration";
import { apiKey } from "@better-auth/api-key";
import type { NetworkId } from "@qorvex/shared";
import type { Db } from "../db/db.ts";
import type { NearRpc } from "../near/rpc.ts";
import { ac, orgRoles } from "./access.ts";
import { nearAuth, type NearAuthOptions } from "./near-plugin.ts";

/** Outgoing mail. No provider is chosen yet: the default writes the message to the server log. */
export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

export function logEmailSender(log: (s: string) => void): EmailSender {
  return {
    async send(to, subject, text) {
      log(`[email not sent: no provider configured] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
    },
  };
}

export interface AuthConfig {
  db: Db;
  /** Public origin of the app, e.g. https://app.example.com or http://localhost:8787. */
  publicUrl: string;
  /** Persistent secret for signing cookies; generated into the data dir when absent. */
  secret?: string;
  dataDir: string;
  rpcFor: (network: NetworkId) => NearRpc | undefined;
  email: EmailSender;
  /** Other origins allowed to call the API with cookies (e.g. the Vite dev server). */
  extraOrigins?: string[];
  log?: (s: string) => void;
  onNearSignIn?: NearAuthOptions["onSignedIn"];
}

/** QORVEX_AUTH_SECRET, or a random one kept in <data>/auth-secret (mode 600) so sessions survive restarts. */
export function authSecret(dataDir: string, fromEnv?: string): string {
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error("QORVEX_AUTH_SECRET must be at least 32 characters (e.g. `openssl rand -hex 32`)");
    return fromEnv;
  }
  const f = path.join(dataDir, "auth-secret");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  const s = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

/**
 * Origins allowed to call the API with cookies. Besides the public origin and
 * QORVEX_TRUSTED_ORIGINS, a server on localhost also trusts its own
 * localhost/127.0.0.1 spellings and the Vite dev server (`npm run dev:web`,
 * :5173), which proxies the API: the browser labels those requests with the
 * dev server's origin.
 */
export function trustedOriginsFor(publicUrl: string, extra: string[] = []): string[] {
  const u = new URL(publicUrl);
  const out = new Set([u.origin, ...extra]);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
    for (const host of ["localhost", "127.0.0.1"]) {
      out.add(`${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`);
      out.add(`http://${host}:5173`);
    }
  }
  return [...out];
}

export function createAuth(c: AuthConfig) {
  const origin = new URL(c.publicUrl).origin;
  const recipient = new URL(c.publicUrl).host;
  const trusted = trustedOriginsFor(c.publicUrl, c.extraOrigins);
  const nearOptions: NearAuthOptions = { db: c.db, recipient, origin, trustedOrigins: trustedOriginsFor(c.publicUrl, c.extraOrigins), rpcFor: c.rpcFor, onSignedIn: c.onNearSignIn, log: c.log };
  const options = {
    appName: "Qorvex",
    baseURL: origin,
    basePath: "/api/auth",
    secret: authSecret(c.dataDir, c.secret),
    database: c.db,
    trustedOrigins: trusted,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        await c.email.send(user.email, "Reset your Qorvex password", `Open this link to set a new password (valid for one hour):\n${url}`);
      },
    },
    session: {
      // Absolute expiry of 7 days; the cookie is refreshed at most once per 12 hours of use.
      expiresIn: 7 * 24 * 3600,
      updateAge: 12 * 3600,
    },
    advanced: { useSecureCookies: origin.startsWith("https://") },
    plugins: [
      organization({
        ac,
        roles: orgRoles,
        creatorRole: "owner",
        invitationExpiresIn: 48 * 3600,
        sendInvitationEmail: async (data: { email: string; id: string; organization: { name: string }; inviter: { user: { name: string } } }) => {
          await c.email.send(data.email, `Join ${data.organization.name} on Qorvex`, `${data.inviter.user.name} invited you to the ${data.organization.name} workspace.\nAccept: ${origin}/accept-invite/${data.id}`);
        },
      }),
      apiKey({ references: "organization", defaultPrefix: "qvx_", enableMetadata: true, rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 } }),
      nearAuth(nearOptions),
    ],
  };
  const auth = betterAuth(options);
  return {
    auth,
    nearOptions,
    origin,
    trustedOrigins: trusted,
    recipient,
    /** Create or update Better Auth's tables. */
    migrate: async () => {
      const { runMigrations } = await getMigrations(options as never);
      await runMigrations();
    },
  };
}

export type QorvexAuth = ReturnType<typeof createAuth>;
