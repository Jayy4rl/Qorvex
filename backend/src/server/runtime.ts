/**
 * Wires the per-network pieces together: RPC, block stream, watcher and the
 * pause executor holding that network's watcher function-call key.
 *
 * Per-network configuration (env, NET = SANDBOX | TESTNET | MAINNET):
 *   QORVEX_<NET>_RPC_URLS         comma-separated; defaults to the public list
 *   QORVEX_<NET>_GUARDIAN         guardian contract id
 *   QORVEX_<NET>_WATCHER_ACCOUNT  watcher account id
 *   QORVEX_<NET>_WATCHER_KEY      the watcher's function-call key (guardian.pause only)
 *   QORVEX_<NET>_FIREWALL_ACCOUNT the proposal-firewall account (a reject-only member of protected DAOs)
 *   QORVEX_<NET>_FIREWALL_KEYS    JSON {"<dao id>": "ed25519:..."}: one function-call key per DAO, act_proposal only
 *   QORVEX_<NET>_STREAM           neardata (default for testnet/mainnet) | rpc
 */
import path from "node:path";
import type { Breach, NetworkId, Protocol } from "@qorvex/shared";
import { env, NETWORKS } from "../config.ts";
import { NearRpc } from "../near/rpc.ts";
import { NeardataSource } from "../stream/neardata.ts";
import { RpcFollowSource } from "../stream/rpc-follow.ts";
import { PauseExecutor } from "../executor/pause.ts";
import { RejectExecutor } from "../firewall/executor.ts";
import { Watcher } from "../watcher/watcher.ts";
import type { Store } from "../store/store.ts";
import type { Alerter } from "../alerts/alerts.ts";
import { CachedArchive } from "../backtest/backtest.ts";

export interface NetworkRuntime {
  id: NetworkId;
  rpcUrls: string[];
  rpc: NearRpc;
  archive: CachedArchive;
  neardataUrl?: string;
  /** Human-readable description of the block source. */
  stream: string;
  /** Pause executors by guardian id (at most one: this network's guardian). */
  executors: Map<string, PauseExecutor>;
  /** Firewall reject-vote executors by DAO id. */
  rejecters: Map<string, RejectExecutor>;
  firewallAccount?: string;
  watcher: Watcher;
  watcherAccount?: string;
  /** Public key of the loaded watcher key, when one is loaded. */
  watcherPublicKey?: string;
  guardianId?: string;
}

interface RuntimeOptions {
  store: Store;
  alerter: Alerter;
  dataDir: string;
  explain?: (b: Breach) => Promise<Breach["explanation"] | undefined>;
  publicUrl: string;
  log?: (s: string) => void;
}

export function networkRuntime(id: NetworkId, o: RuntimeOptions, overrides: { rpcUrls?: string[]; nearNetworkId?: string } = {}): NetworkRuntime {
  const NET = id.toUpperCase();
  const preset = id === "sandbox" ? undefined : NETWORKS[id];
  const rpcUrls = overrides.rpcUrls ?? env(`QORVEX_${NET}_RPC_URLS`)?.split(",").map((s) => s.trim()).filter(Boolean) ?? preset?.rpcUrls;
  if (!rpcUrls?.length) throw new Error(`no RPC URLs for ${id}: set QORVEX_${NET}_RPC_URLS`);
  const rpc = new NearRpc(rpcUrls, { retries: 2 });
  const archivalUrl = env(`QORVEX_${NET}_ARCHIVAL_RPC`) ?? preset?.archivalRpcUrl ?? rpcUrls[0];
  const archive = new CachedArchive(new NearRpc([archivalUrl], { retries: 5, backoffMs: 2000, timeoutMs: 60_000 }), path.join(o.dataDir, "cache", `archive-${id}.json`));
  const nearNetworkId = overrides.nearNetworkId ?? (id === "sandbox" ? "localnet" : id);

  const executors = new Map<string, PauseExecutor>();
  const guardianId = env(`QORVEX_${NET}_GUARDIAN`);
  const watcherAccount = env(`QORVEX_${NET}_WATCHER_ACCOUNT`);
  const watcherKey = env(`QORVEX_${NET}_WATCHER_KEY`);
  let watcherPublicKey: string | undefined;
  if (guardianId && watcherAccount && watcherKey) {
    const ex = new PauseExecutor(rpcUrls, nearNetworkId, { accountId: watcherAccount, secretKey: watcherKey }, guardianId);
    executors.set(guardianId, ex);
    watcherPublicKey = ex.publicKey;
  }

  const rejecters = new Map<string, RejectExecutor>();
  const firewallAccount = env(`QORVEX_${NET}_FIREWALL_ACCOUNT`);
  const firewallKeys = env(`QORVEX_${NET}_FIREWALL_KEYS`);
  if (firewallAccount && firewallKeys) {
    let map: Record<string, string>;
    try {
      map = JSON.parse(firewallKeys);
    } catch {
      throw new Error(`QORVEX_${NET}_FIREWALL_KEYS must be JSON {"dao.near": "ed25519:..."}`);
    }
    for (const [dao, key] of Object.entries(map)) rejecters.set(dao, new RejectExecutor(rpcUrls, nearNetworkId, { accountId: firewallAccount, secretKey: key }, dao));
  }

  // QORVEX_<NET>_STREAM=rpc follows blocks + chunks over the RPC list instead of neardata.xyz.
  const useNeardata = !!preset?.neardataUrl && env(`QORVEX_${NET}_STREAM`, "neardata") !== "rpc";
  const stream = useNeardata ? `neardata (${preset!.neardataUrl})` : "rpc block + chunk following";
  const source = useNeardata && preset?.neardataUrl
    ? new NeardataSource(preset.neardataUrl, { optimistic: id !== "mainnet", concurrency: id === "mainnet" ? 4 : 2, apiKey: env("FASTNEAR_API_KEY"), log: o.log })
    : new RpcFollowSource(rpc, { pollMs: 150 });

  const watcher = new Watcher({
    store: o.store,
    network: id,
    rpc,
    source,
    executors,
    rejecters,
    alerter: o.alerter,
    explain: o.explain,
    statusUrl: (pid) => `${o.publicUrl}/status/${pid}`,
    // Read-only, unofficial pages for busy mainnet contracts are evaluated at most every 15 s
    // to stay within public RPC limits; protected contracts are evaluated every touching block.
    minEvalIntervalMs: (p: Protocol) => (p.unofficial ? 15_000 : 0),
    heartbeatBlocks: id === "mainnet" ? 100 : 30,
    heartbeatMs: id === "sandbox" ? 0 : 30_000,
    log: o.log,
  });
  return { id, rpcUrls, rpc, archive, neardataUrl: preset?.neardataUrl, stream, executors, rejecters, firewallAccount, watcher, watcherAccount, watcherPublicKey, guardianId };
}
