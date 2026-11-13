/**
 * Qorvex service entrypoint: HTTP API + console + status pages, and one
 * watcher per enabled network.
 *
 *   QORVEX_NETWORKS=mainnet,testnet npm start
 *
 * See .env.example for every setting.
 */
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type { NetworkId } from "@qorvex/shared";
import { aiConfig, dataDir, env, loadDotEnv, NETWORKS } from "../config.ts";
import { WEB_DIST_DIR } from "../paths.ts";
import { Store } from "../store/store.ts";
import { NearAiClient } from "../ai/client.ts";
import { explainBreach, type TokenUnits } from "../ai/explain.ts";
import { cachedTokenMeta } from "../near/tokens.ts";
import { Alerter, channelsFromEnv, type AlertChannel } from "../alerts/alerts.ts";
import { networkRuntime, type NetworkRuntime } from "./runtime.ts";
import { createServer, type ApiDeps } from "./api.ts";
import { openDb } from "../db/db.ts";
import { NearRpc } from "../near/rpc.ts";
import { createAuth, logEmailSender, type QorvexAuth } from "../auth/auth.ts";
import { Tenancy } from "../tenancy/tenancy.ts";
import { mayPause, reverifyAll, reverifyClaim, type ClaimDeps } from "../tenancy/claims.ts";

interface StartOptions {
  networks: NetworkId[];
  port: number;
  adminToken: string;
  publicUrl?: string;
  dataDir?: string;
  rpcOverrides?: Partial<Record<NetworkId, { rpcUrls: string[]; nearNetworkId?: string }>>;
  demo?: ApiDeps["demo"];
  extraAlertChannels?: AlertChannel[];
  startWatchers?: boolean;
  /** QORVEX_SINGLE_TENANT: the admin token acts as Owner of the "default" workspace. Default true. */
  singleTenant?: boolean;
  log?: (s: string) => void;
}

export interface Qorvex {
  store: Store;
  auth: QorvexAuth;
  tenancy: Tenancy;
  runtimes: Map<NetworkId, NetworkRuntime>;
  ai: NearAiClient;
  url: string;
  stop(): Promise<void>;
}

export async function startQorvex(o: StartOptions): Promise<Qorvex> {
  const log = o.log ?? ((s: string) => console.log(s));
  const dir = o.dataDir ?? dataDir();
  const db = openDb(path.join(dir, "qorvex.db"));
  const store = new Store(path.join(dir, "store"), db);
  const tenancy = new Tenancy(db);
  const ai = new NearAiClient(aiConfig());
  const alerter = new Alerter([...channelsFromEnv(), ...(o.extraAlertChannels ?? [])]);
  const publicUrl = o.publicUrl ?? `http://localhost:${o.port}`;
  const runtimes = new Map<NetworkId, NetworkRuntime>();
  for (const id of o.networks) {
    runtimes.set(id, networkRuntime(id, { store, alerter, dataDir: dir, publicUrl, explain: (b) => explainWithUnits(b), mayPause: (p) => mayPause(tenancy, p), log: (s) => log(`[${id}] ${s}`) }, o.rpcOverrides?.[id] ?? {}));
  }
  // Wallet sign-in needs mainnet/testnet RPC to check the signer's key even when this server
  // does not watch that network (e.g. the local sandbox demo).
  const signInRpcs = new Map<NetworkId, NearRpc>();
  /** Breach explanation with the contract and the token's units (plain amounts for the model). */
  async function explainWithUnits(b: Parameters<typeof explainBreach>[1]) {
    const p = store.protocol(b.protocolId);
    const token = b.rule.type === "proposal_policy" ? undefined : b.rule.token;
    const rt = p ? runtimes.get(p.network) : undefined;
    let units: TokenUnits | undefined;
    if (token === "near") units = { decimals: 24, symbol: "NEAR" };
    else if (token && rt) {
      const meta = await cachedTokenMeta(rt.rpc, token).catch(() => undefined);
      if (meta?.decimals !== undefined) units = { decimals: meta.decimals, symbol: meta.symbol };
    }
    return explainBreach(ai, b, p?.contractId, units);
  }
  const rpcFor = (n: NetworkId) => {
    const rt = runtimes.get(n)?.rpc;
    if (rt || n === "sandbox") return rt;
    if (!signInRpcs.has(n)) {
      const urls = env(`QORVEX_${n.toUpperCase()}_RPC_URLS`)?.split(",").map((s) => s.trim()).filter(Boolean) ?? NETWORKS[n].rpcUrls;
      signInRpcs.set(n, new NearRpc(urls, { retries: 2 }));
    }
    return signInRpcs.get(n);
  };
  const auth = createAuth({
    db,
    publicUrl,
    secret: env("QORVEX_AUTH_SECRET"),
    dataDir: dir,
    rpcFor,
    email: logEmailSender(log),
    log,
    extraOrigins: (env("QORVEX_TRUSTED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    onNearSignIn: async (userId, accountKey) => {
      const joined = await tenancy.acceptNearInvites(userId, accountKey);
      if (joined.length) log(`NEAR invite accepted: ${accountKey} joined ${joined.join(", ")}`);
    },
  });
  await auth.migrate();
  const claimDeps: ClaimDeps = {
    tenancy,
    rpcFor,
    guardianFor: (n) => runtimes.get(n)?.guardianId,
    onLapse: (c, why) => void alerter.send(`Authority lapsed: ${c.contractId}`, `${why}. Automatic pause is off for this workspace until authority is verified again; monitoring continues.`, { claimId: c.id }),
  };
  // Re-verify every claim from chain state every 6 hours (and lapse the ones that no longer hold).
  const claimTimer = setInterval(() => void reverifyAll(claimDeps).catch((e) => log(`claim re-verification failed: ${(e as Error).message}`)), 6 * 3600_000);
  claimTimer.unref();
  const server = createServer({
    store,
    networks: runtimes,
    ai,
    alerter,
    adminToken: o.adminToken,
    auth,
    tenancy,
    singleTenant: o.singleTenant ?? true,
    reverifyClaim: (ws, n, c) => reverifyClaim(claimDeps, ws, n, c),
    webDir: WEB_DIST_DIR,
    demo: o.demo,
    backtestDays: (n) => Number(env(`QORVEX_${n.toUpperCase()}_BACKTEST_DAYS`, n === "mainnet" ? "30" : n === "testnet" ? "7" : "1")),
    backtestSamples: (n) => Number(env(`QORVEX_${n.toUpperCase()}_BACKTEST_SAMPLES`, n === "mainnet" ? "30" : "24")),
    log,
  });
  await new Promise<void>((r) => server.listen(o.port, r));
  if (o.startWatchers !== false) {
    for (const rt of runtimes.values()) {
      rt.watcher.run().catch((e) => log(`[${rt.id}] watcher stopped: ${(e as Error).message}`));
    }
  }
  log(`Qorvex listening on port ${o.port}, all interfaces; public URL ${publicUrl} (networks: ${o.networks.join(", ")}; AI mode: ${ai.cfg.mode}; alerts: ${alerter.configured.join(", ") || "none configured"})`);
  if (process.env.RAILWAY_ENVIRONMENT && /localhost|127\.0\.0\.1/.test(publicUrl)) {
    log("WARNING: running on Railway without a public domain. Generate one (Settings → Networking) or set PUBLIC_URL: sign-in only works from the public URL.");
  }
  return {
    store,
    auth,
    tenancy,
    runtimes,
    ai,
    url: publicUrl,
    stop: async () => {
      clearInterval(claimTimer);
      for (const rt of runtimes.values()) rt.watcher.stop();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      store.close();
    },
  };
}

async function main() {
  loadDotEnv();
  const networks = env("QORVEX_NETWORKS", "mainnet")!.split(",").map((s) => s.trim()).filter(Boolean) as NetworkId[];
  const unknown = networks.filter((n) => n !== "sandbox" && !(n in NETWORKS));
  if (unknown.length) throw new Error(`QORVEX_NETWORKS: unknown network(s) ${unknown.join(", ")} (mainnet, testnet or sandbox)`);
  let adminToken = env("QORVEX_ADMIN_TOKEN");
  if (adminToken && adminToken.length < 16) throw new Error("QORVEX_ADMIN_TOKEN must be at least 16 characters (e.g. `openssl rand -hex 16`)");
  if (!adminToken) {
    adminToken = crypto.randomBytes(16).toString("hex");
    console.log(`QORVEX_ADMIN_TOKEN not set; generated one for this run: ${adminToken}`);
  }
  const port = Number(env("PORT", "8787"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a TCP port number");
  const singleTenant = env("QORVEX_SINGLE_TENANT", "true") !== "false";
  // On Railway the public domain is provided; it is also the NEP-413 recipient wallets sign for.
  const publicUrl = env("PUBLIC_URL") ?? (env("RAILWAY_PUBLIC_DOMAIN") ? `https://${env("RAILWAY_PUBLIC_DOMAIN")}` : undefined);
  const q = await startQorvex({ networks, port, adminToken, publicUrl, singleTenant });
  const shutdown = async () => {
    await q.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
