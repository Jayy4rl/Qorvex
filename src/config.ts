/**
 * Runtime configuration. Everything secret comes from environment variables
 * (see .env.example); nothing secret is ever written to the repository.
 *
 * RPC endpoints are the public ones listed at
 * https://docs.near.org/api/rpc/providers (checked 2026-11-10).
 * Block stream endpoints are FastNEAR's NEAR Data API
 * (https://docs.fastnear.com/neardata).
 */
import path from "node:path";
import fs from "node:fs";

export type NetworkId = "mainnet" | "testnet" | "sandbox";

export interface NetworkPreset {
  id: NetworkId;
  /** Providers used for reads and for broadcasting pause transactions. */
  rpcUrls: string[];
  /** Archival endpoint for backtests (historical state). */
  archivalRpcUrl?: string;
  /** Block stream (NEAR Data API) base URL; absent for sandbox. */
  neardataUrl?: string;
  explorerTx?: (hash: string) => string;
}

export const NETWORKS: Record<Exclude<NetworkId, "sandbox">, NetworkPreset> = {
  mainnet: {
    id: "mainnet",
    rpcUrls: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.intea.rs"],
    archivalRpcUrl: "https://archival-rpc.mainnet.near.org",
    neardataUrl: "https://mainnet.neardata.xyz",
    explorerTx: (h) => `https://nearblocks.io/txns/${h}`,
  },
  testnet: {
    id: "testnet",
    rpcUrls: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs"],
    archivalRpcUrl: "https://archival-rpc.testnet.near.org",
    neardataUrl: "https://testnet.neardata.xyz",
    explorerTx: (h) => `https://testnet.nearblocks.io/txns/${h}`,
  },
};

/** Load KEY=VALUE lines from .env into process.env (without overriding). */
export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return v;
}

export interface AiConfig {
  baseUrl: string;
  apiKey?: string;
  /** "replay": committed fixtures only; "live": call the API; "record": call and save fixtures. */
  mode: "replay" | "live" | "record";
  draftModel: string;
  explainModel: string;
  /** Tried in order when the primary model is rate-limited or failing. */
  fallbackModels: string[];
  /** Qwen3 models reason before answering unless thinking is off (chat_template_kwargs.enable_thinking). */
  thinking: boolean;
  fixturesDir: string;
}

export function aiConfig(): AiConfig {
  const mode = (env("QORVEX_AI_MODE", "replay") as AiConfig["mode"]) ?? "replay";
  if (!["replay", "live", "record"].includes(mode)) throw new Error(`QORVEX_AI_MODE must be replay, live or record`);
  return {
    baseUrl: env("NEARAI_BASE_URL", "https://cloud-api.near.ai/v1")!,
    apiKey: env("NEARAI_API_KEY"),
    mode,
    // IDs checked against https://cloud-api.near.ai/v1/model/list on 2026-11-10; all open-weight and
    // served in TEEs ("verifiable": true). The PRD's examples (Qwen3.5-122B-A10B, Qwen3-30B-A3B-Instruct)
    // are not in the live catalog. qwen/qwen3.5-397b-a17b answered HTTP 429 (upstream rate limit) on every
    // try on 2026-11-10, so the newer Qwen3.8-27B (262k context) is the default and the 397B is a fallback.
    draftModel: env("QORVEX_DRAFT_MODEL", "Qwen/Qwen3.8-27B")!,
    explainModel: env("QORVEX_EXPLAIN_MODEL", "Qwen/Qwen3.6-35B-A3B-FP8")!,
    fallbackModels: (env("QORVEX_FALLBACK_MODELS", "qwen/qwen3.5-397b-a17b,z-ai/glm-5.3") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    thinking: env("QORVEX_AI_THINKING", "off") === "on",
    fixturesDir: path.resolve(env("QORVEX_AI_FIXTURES", "fixtures/ai")!),
  };
}

export function dataDir(): string {
  const d = path.resolve(env("QORVEX_DATA_DIR", "data")!);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
