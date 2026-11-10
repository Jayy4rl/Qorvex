/**
 * Drafting inputs (A3): contract source (NEP-330 link or upload), embedded
 * ABI if published, the list of methods, a few live state reads and recent
 * receipts touching the contract.
 */
import crypto from "node:crypto";
import zlib from "node:zlib";
import type { NearRpc } from "../near/rpc.ts";
import { exportedFunctions } from "../near/wasm.ts";
import { recentBlocks } from "../backtest/backtest.ts";
import { describeProposal, type SputnikProposal } from "../firewall/policy.ts";

export interface SourceFile {
  path: string;
  content: string;
}

export interface MethodInfo {
  name: string;
  kind: "view" | "call" | "unknown";
  params?: string[];
}

export interface DraftInputs {
  contractId: string;
  network: string;
  codeHash: string;
  sourceMeta?: unknown;
  source: { kind: "nep330" | "upload" | "none"; link?: string; files: SourceFile[] };
  abiAvailable: boolean;
  methods: MethodInfo[];
  stateReads: { method: string; args: unknown; value: unknown }[];
  recentReceipts: { height: number; predecessor: string; receiver: string; methods: string[] }[];
  /** Present for Sputnik DAOs: what the treasury holds and what it has been asked to do. */
  dao?: DaoContext;
}

export interface DaoContext {
  nearBalanceYocto: string;
  tokens: { contract: string; symbol?: string; decimals?: number; balance: string; human?: string }[];
  pastProposals: { id: number; status: string; summary: string }[];
}

/** Format smallest units with decimals, e.g. 500000000000 / 6 -> "500,000". */
export function humanAmount(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toLocaleString("en-US");
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
}

const FASTNEAR_API: Record<string, string> = { mainnet: "https://api.fastnear.com", testnet: "https://test.api.fastnear.com" };

export async function tokenMeta(rpc: NearRpc, contract: string): Promise<{ symbol?: string; decimals?: number }> {
  try {
    const m = (await rpc.view<any>(contract, "ft_metadata", {})).value;
    return { symbol: m?.symbol, decimals: typeof m?.decimals === "number" ? m.decimals : undefined };
  } catch {
    return {};
  }
}

async function collectDaoContext(rpc: NearRpc, network: string, dao: string, candidates: Set<string>): Promise<DaoContext> {
  const acct = await rpc.viewAccount(dao);
  // Token holdings: FastNEAR's account-assets API (testnet/mainnet), plus tokens seen in receipts and past proposals.
  const api = FASTNEAR_API[network];
  if (api) {
    try {
      const r = (await (await fetch(`${api}/v1/account/${dao}/ft`, { signal: AbortSignal.timeout(10_000) })).json()) as any;
      for (const t of r.tokens ?? []) candidates.add(t.contract_id);
    } catch {
      /* optional */
    }
  }
  let pastProposals: DaoContext["pastProposals"] = [];
  try {
    const last = (await rpc.view<number>(dao, "get_last_proposal_id", {})).value;
    const from = Math.max(0, last - 30);
    const props = (await rpc.view<SputnikProposal[]>(dao, "get_proposals", { from_index: from, limit: 30 })).value;
    pastProposals = props.map((p) => ({ id: p.id, status: p.status, summary: describeProposal(p) }));
    for (const p of props) {
      const k: any = typeof p.kind === "object" ? p.kind : {};
      if (k.Transfer?.token_id) candidates.add(k.Transfer.token_id);
      if (k.FunctionCall?.receiver_id) candidates.add(k.FunctionCall.receiver_id);
    }
  } catch {
    /* optional */
  }
  const tokens: DaoContext["tokens"] = [];
  for (const c of [...candidates].slice(0, 15)) {
    try {
      const bal = (await rpc.view<string>(c, "ft_balance_of", { account_id: dao })).value;
      const meta = await tokenMeta(rpc, c);
      tokens.push({ contract: c, ...meta, balance: String(bal), human: meta.decimals !== undefined ? humanAmount(String(bal), meta.decimals) : undefined });
    } catch {
      /* not a NEP-141 token */
    }
  }
  return { nearBalanceYocto: acct.amount, tokens, pastProposals };
}

const MAX_SOURCE_BYTES = 120_000;

/** Fetch Rust sources from a NEP-330 GitHub link (tree URL + optional contract_path). */
export async function fetchGithubSource(link: string, contractPath?: string): Promise<SourceFile[]> {
  const m = link.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?(?:[/?#]|$)/);
  if (!m) throw new Error(`unsupported source link ${link} (only GitHub is supported; upload the source instead)`);
  const [, owner, repo, rev = "HEAD"] = m;
  const tree = (await (await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${rev}?recursive=1`, { headers: { "user-agent": "qorvex" } })).json()) as any;
  if (!tree.tree) throw new Error(`GitHub tree fetch failed: ${tree.message ?? "unknown"}`);
  const prefix = contractPath ? `${contractPath.replace(/\/$/, "")}/` : "";
  const files = (tree.tree as any[])
    .filter((t) => t.type === "blob" && t.path.endsWith(".rs") && t.path.startsWith(prefix) && !/\/tests?\//.test(t.path))
    .sort((a, b) => (a.path.includes("lib.rs") ? -1 : 0) - (b.path.includes("lib.rs") ? -1 : 0) || a.size - b.size);
  const out: SourceFile[] = [];
  let total = 0;
  for (const f of files) {
    if (total + f.size > MAX_SOURCE_BYTES) continue;
    const raw = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${rev}/${f.path}`);
    if (!raw.ok) continue;
    const content = await raw.text();
    out.push({ path: f.path, content });
    total += content.length;
  }
  return out;
}

export async function readAbi(rpc: NearRpc, contractId: string): Promise<any | null> {
  try {
    const bytes = await rpc.viewRaw(contractId, "__contract_abi", {});
    return JSON.parse(zlib.zstdDecompressSync(Buffer.from(bytes)).toString("utf8"));
  } catch {
    return null;
  }
}

export function methodsFromAbi(abi: any): MethodInfo[] {
  return (abi?.body?.functions ?? []).map((f: any) => ({
    name: f.name,
    kind: f.kind === "view" ? "view" : "call",
    params: (f.params?.args ?? []).map((a: any) => a.name),
  }));
}

export async function collectInputs(
  rpc: NearRpc,
  network: string,
  contractId: string,
  opts: { upload?: SourceFile[]; neardataUrl?: string; recentBlockCount?: number } = {},
): Promise<DraftInputs> {
  const account = await rpc.viewAccount(contractId);
  const codeHash: string = account.code_hash;
  let sourceMeta: any;
  try {
    sourceMeta = (await rpc.view(contractId, "contract_source_metadata", {})).value;
  } catch {
    sourceMeta = undefined;
  }
  let source: DraftInputs["source"] = { kind: "none", files: [] };
  if (opts.upload?.length) {
    source = { kind: "upload", files: opts.upload };
  } else if (sourceMeta?.link) {
    try {
      source = { kind: "nep330", link: sourceMeta.link, files: await fetchGithubSource(sourceMeta.link, sourceMeta.build_info?.contract_path) };
    } catch {
      source = { kind: "nep330", link: sourceMeta.link, files: [] };
    }
  }

  const abi = await readAbi(rpc, contractId);
  let methods: MethodInfo[] = abi ? methodsFromAbi(abi) : [];
  if (!methods.length) {
    const code = await rpc.viewCode(contractId);
    methods = exportedFunctions(code).map((name) => ({ name, kind: "unknown" as const }));
  }

  // A few live reads: views (or unknown methods) that take no arguments.
  const stateReads: DraftInputs["stateReads"] = [];
  const candidates = methods.filter((m) => m.kind !== "call" && (m.params?.length ?? 0) === 0 && !m.name.startsWith("__") && m.name !== "contract_source_metadata");
  for (const m of candidates.slice(0, 10)) {
    try {
      const r = await rpc.view(contractId, m.name, {});
      stateReads.push({ method: m.name, args: {}, value: r.value });
    } catch {
      /* not a view or needs arguments */
    }
  }

  let recentReceipts: DraftInputs["recentReceipts"] = [];
  // Contracts whose calls name this account (e.g. ft_transfer/storage_deposit/mint to it): likely tokens it holds.
  const tokenCandidates = new Set<string>();
  try {
    const blocks = await recentBlocks({ rpc, neardataUrl: opts.neardataUrl, count: opts.recentBlockCount ?? 120 });
    for (const b of blocks)
      for (const r of b.receipts) {
        if (r.receiver === contractId || r.predecessor === contractId)
          recentReceipts.push({ height: b.height, predecessor: r.predecessor, receiver: r.receiver, methods: r.actions.map((a) => a.method ?? a.kind) });
        for (const a of r.actions) {
          const args = a.args as any;
          if (args && (args.account_id === contractId || args.receiver_id === contractId) && r.receiver !== contractId) tokenCandidates.add(r.receiver);
        }
      }
    recentReceipts = recentReceipts.slice(-40);
  } catch {
    /* recent activity is optional context */
  }

  const isDao = methods.some((m) => m.name === "add_proposal") && methods.some((m) => m.name === "get_policy");
  const dao = isDao ? await collectDaoContext(rpc, network, contractId, tokenCandidates).catch(() => undefined) : undefined;
  return { contractId, network, codeHash, sourceMeta, source, abiAvailable: !!abi, methods, stateReads, recentReceipts, dao };
}

export function sourceDigest(files: SourceFile[]): string {
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(f.path).update("\0").update(f.content).update("\0");
  return h.digest("hex");
}
