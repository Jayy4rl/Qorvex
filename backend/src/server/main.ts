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
import { explainBreach } from "../ai/explain.ts";
import { Alerter, channelsFromEnv, type AlertChannel } from "../alerts/alerts.ts";
import { networkRuntime, type NetworkRuntime } from "./runtime.ts";
import { createServer, type ApiDeps } from "./api.ts";

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
  log?: (s: string) => void;
}

export interface Qorvex {
  store: Store;
  runtimes: Map<NetworkId, NetworkRuntime>;
  ai: NearAiClient;
  url: string;
  stop(): Promise<void>;
}

export async function startQorvex(o: StartOptions): Promise<Qorvex> {
  const log = o.log ?? ((s: string) => console.log(s));
  const dir = o.dataDir ?? dataDir();
  const store = new Store(path.join(dir, "store"));
  const ai = new NearAiClient(aiConfig());
  const alerter = new Alerter([...channelsFromEnv(), ...(o.extraAlertChannels ?? [])]);
  const publicUrl = o.publicUrl ?? `http://localhost:${o.port}`;
  const runtimes = new Map<NetworkId, NetworkRuntime>();
  for (const id of o.networks) {
    runtimes.set(id, networkRuntime(id, { store, alerter, dataDir: dir, publicUrl, explain: (b) => explainBreach(ai, b), log: (s) => log(`[${id}] ${s}`) }, o.rpcOverrides?.[id] ?? {}));
  }
  const server = createServer({
    store,
    networks: runtimes,
    ai,
    alerter,
    adminToken: o.adminToken,
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
  log(`Qorvex listening on ${publicUrl} (networks: ${o.networks.join(", ")}; AI mode: ${ai.cfg.mode}; alerts: ${alerter.configured.join(", ") || "none configured"})`);
  return {
    store,
    runtimes,
    ai,
    url: publicUrl,
    stop: async () => {
      for (const rt of runtimes.values()) rt.watcher.stop();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      store.flush();
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
  const q = await startQorvex({ networks, port, adminToken, publicUrl: env("PUBLIC_URL") });
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
