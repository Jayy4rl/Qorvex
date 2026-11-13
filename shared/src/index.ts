/**
 * The Qorvex domain model and HTTP API response shapes, shared by the backend
 * (which produces them) and the frontend (which renders them).
 *
 * Types only: nothing here exists at runtime. Amounts are decimal strings in
 * the token's smallest unit.
 */

export type NetworkId = "mainnet" | "testnet" | "sandbox";

// ------------------------------------------------------------------ rules

/** A read of one view method. `contract` defaults to the protected contract. */
export interface ViewRef {
  contract?: string;
  view: string;
  args?: Record<string, unknown>;
  /** Dot path into the JSON result, when the amount is nested (e.g. "total"). */
  path?: string;
}

/** "pause" applies to solvency/outflow rules; "reject" (vote to reject) to proposal_policy rules. */
export type RuleResponse = "alert" | "pause" | "reject";
export type RuleStatus = "draft" | "approved" | "rejected";

export interface RuleBase {
  id: string;
  /** Plain-English sentence shown to the operator and on the status page. */
  explain: string;
  response: RuleResponse;
  status: RuleStatus;
  /** Who produced the rule: the AI drafter (with model id) or a human. */
  origin: { kind: "ai"; model: string; draftId: string } | { kind: "human"; author: string };
  approvedBy?: string;
  approvedAt?: string;
}

/** owed <= held, per token (D2). */
export interface SolvencyRule extends RuleBase {
  type: "solvency";
  token: string;
  owed: ViewRef;
  held: ViewRef;
}

/**
 * Outflows of `token` from the protected contract must stay under `max`
 * (smallest units) per `window_sec` (D2). Counted from the receipt stream:
 * `ft_transfer`/`ft_transfer_call` sent by the contract to the token
 * contract, or native NEAR transfers when token is "near".
 */
export interface OutflowRateRule extends RuleBase {
  type: "outflow_rate";
  token: string;
  max: string;
  window_sec: number;
}

/** The limits of a treasury proposal policy (see ProposalPolicyRule). */
export interface ProposalPolicyLimits {
  /** Per-proposal cap by token contract id, or "near" (smallest units). Applies to Transfer
   *  proposals and to ft_transfer / ft_transfer_call actions inside FunctionCall proposals. */
  max_transfer?: Record<string, string>;
  /** If set, Transfer receivers (and ft_transfer receiver_id) must be in this list. */
  allowed_receivers?: string[];
  /** If set, FunctionCall proposals may only call these contracts. */
  allowed_call_contracts?: string[];
  /** Maximum actions in one FunctionCall proposal (the Trezu drain used 200). */
  max_actions_per_call?: number;
  /** Maximum NEAR attached across all actions of one FunctionCall proposal (yoctoNEAR). */
  max_call_deposit_yocto?: string;
  /** Alert (never vote) on governance changes: policy, roles, config, upgrades. */
  alert_on_governance?: boolean;
}

/**
 * Treasury proposal policy for a Sputnik DAO (D2 "treasury transfer policy").
 * Every new proposal is checked against it; with response "reject", Qorvex
 * votes VoteReject through a DAO role that has no other permission.
 */
export interface ProposalPolicyRule extends RuleBase, ProposalPolicyLimits {
  type: "proposal_policy";
}

export type Rule = SolvencyRule | OutflowRateRule | ProposalPolicyRule;
export type RuleType = Rule["type"];

/** The rule lifecycle fields, which a drafted rule does not have yet. */
export type RuleLifecycle = "status" | "origin" | "response" | "approvedBy" | "approvedAt";
/** Draft rule as the model (or an operator) writes it: no status/origin/response yet. */
export type DraftRule = Omit<SolvencyRule, RuleLifecycle> | Omit<OutflowRateRule, RuleLifecycle> | Omit<ProposalPolicyRule, RuleLifecycle>;
/** A proposal policy without lifecycle fields (used by relayers). */
export type ProposalPolicy = Omit<ProposalPolicyRule, RuleLifecycle>;

// ------------------------------------------------------------ evaluations

/** The exact RPC exchange behind a number, replayable with `curl` (S2). */
export interface RawRead {
  provider: string;
  request: unknown;
  response: unknown;
  /** Ready-to-paste command that reproduces the read. */
  curl: string;
}

export interface Read {
  id: string;
  label: string;
  contract: string;
  view: string;
  args: Record<string, unknown>;
  value: string;
  blockHeight: number;
  raw: RawRead;
}

export interface SolvencyEvaluation {
  ruleId: string;
  type: "solvency";
  ok: boolean;
  blockHeight: number;
  owed: string;
  held: string;
  /** (held - owed) / held, in basis points; negative when insolvent. */
  marginBps: number | null;
  reads: Read[];
  at: string;
}

export interface OutflowEvaluation {
  ruleId: string;
  type: "outflow_rate";
  ok: boolean;
  blockHeight: number;
  total: string;
  max: string;
  windowSec: number;
  count: number;
  receipts: string[];
  at: string;
}

/** A Sputnik DAO proposal kind: `{ "Transfer": {...} }`, `{ "FunctionCall": {...} }`, or a bare string. */
export type ProposalKind = Record<string, any> | string;

export interface ProposalEvaluation {
  ruleId: string;
  type: "proposal";
  ok: boolean;
  /** Governance change flagged for attention (alert only, never a vote). */
  governance: boolean;
  blockHeight: number;
  proposalId: number;
  proposer: string;
  kindLabel: string;
  summary: string;
  violations: string[];
  /** The proposal kind exactly as stored; act_proposal must be called with it. */
  kind: ProposalKind;
  at: string;
}

export type Evaluation = SolvencyEvaluation | OutflowEvaluation | ProposalEvaluation;

export interface BacktestResult {
  ruleId: string;
  network: NetworkId;
  fromBlock: number;
  toBlock: number;
  days: number;
  samples: number;
  fires: number;
  firedAt: number[];
  errors: number;
  minMarginBps: number | null;
  method: string;
  at: string;
}

// ------------------------------------------------- protocols and incidents

export interface Protocol {
  id: string;
  /** Owning workspace. Absent on records from before multi-tenancy: those belong to "default". */
  workspaceId?: string;
  name: string;
  network: NetworkId;
  contractId: string;
  /** Qorvex guardian contract that can pause this protocol. */
  guardianId?: string;
  /** "dao" for Sputnik DAOs (proposal firewall + council); "contract" otherwise. */
  kind?: "contract" | "dao";
  firewallVerified?: { at: string; ok: boolean; role?: string; problems: string[] };
  /** Read-only, unofficial page built from public data (e.g. mainnet Intents). */
  unofficial?: boolean;
  status: "connected" | "protected";
  published: boolean;
  source?: { kind: "nep330" | "upload"; link?: string; files: { path: string; bytes: number }[]; fetchedAt: string };
  guardianVerified?: { at: string; guardianSet: string | null; registered: boolean; council?: string };
  createdAt: string;
}

export type ActionStatus = "sending" | "landed" | "failed" | "skipped";

export interface Breach {
  id: string;
  protocolId: string;
  ruleId: string;
  rule: Rule;
  detectedAtBlock: number;
  /** Height of the block whose receipts triggered the evaluation. */
  triggerBlock: number;
  triggerReceipts: { receiptId: string; txHash?: string; predecessor: string; receiver: string; method?: string }[];
  evaluation: Evaluation;
  confirmation?: Evaluation;
  evidenceHash: string;
  detectedAt: string;
  response: RuleResponse;
  pause?: {
    status: ActionStatus;
    txHash?: string;
    provider?: string;
    /** Block in which the protected contract's pause() receipt executed. */
    pausedAtBlock?: number;
    blocksAfterBreach?: number;
    msAfterDetection?: number;
    error?: string;
    guardianRecordIndex?: number;
  };
  /** Proposal firewall: the VoteReject cast on a Sputnik DAO proposal. */
  vote?: {
    status: ActionStatus;
    txHash?: string;
    votedAtBlock?: number;
    blocksAfterProposal?: number;
    msAfterDetection?: number;
    proposalStatusAfter?: string;
    error?: string;
  };
  /** Measured latency of the detect-and-pause path (wall-clock ms and block heights). */
  timeline?: {
    triggerBlockTimestampMs: number;
    blockReceivedMs: number;
    detectedMs: number;
    confirmedMs?: number;
    broadcastMs?: number;
    landedMs?: number;
    txBlock?: number;
    guardianBlock?: number;
    pausedBlock?: number;
  };
  alerts: AlertResult[];
  explanation?: { model: string; text: string; at: string; source: "live" | "replay" };
}

export interface AlertResult {
  channel: string;
  ok: boolean;
  error?: string;
  at: string;
}

export interface DraftRun {
  id: string;
  protocolId: string;
  model: string;
  startedAt: string;
  finishedAt?: string;
  attempts: { n: number; responseText: string; chatId?: string; errors: string[] }[];
  accepted: string[];
  dropped: { rule: unknown; errors: string[] }[];
  attestation?: { model: string; nonce: string; signingAddress?: string; fetchedAt: string; report?: unknown; error?: string };
  source: "live" | "replay" | "record";
  error?: string;
}

// ---------------------------------------------------------------- relayers

export interface Budget {
  /** Account id or "*". */
  beneficiary: string;
  window_sec: number;
  max_cost_yocto?: string;
  max_count?: Record<string, number>;
  allowed_receivers?: string[];
}

export interface Decision {
  id: string;
  /** Unix ms. */
  at: number;
  beneficiary: string;
  action: string;
  cost: string;
  receiver?: string;
  allow: boolean;
  reason: string;
  /** "budget" when budgets decided; "fail-open"/"fail-closed" when none were available. */
  basis: "budget" | "no-budget" | "fail-open" | "fail-closed" | "proposal-policy";
  meta?: Record<string, unknown>;
}

export interface Relayer {
  id: string;
  /** Owning workspace. Absent on records from before multi-tenancy: those belong to "default". */
  workspaceId?: string;
  name: string;
  /** SHA-256 of the relayer's API token; the token itself is shown once. */
  tokenHash: string;
  budgets: Budget[];
  failMode: "closed" | "open";
  /** Proposal policy the relayer applies before sponsoring a DAO approval vote. */
  proposalPolicy?: ProposalPolicy;
  updatedAt: string;
}

/** A relayer as the API returns it: never with its token hash. */
export type RelayerView = Omit<Relayer, "tokenHash">;

// ---------------------------------------------------- on-chain view shapes

/** `guard_status` of a contract that embeds the qorvex-guard crate. */
export interface GuardStatus {
  owner: string;
  guardian: string | null;
  self_accounting: boolean;
  paused: { reason: string; by: string; block_height: number; timestamp_ns: number } | null;
  limits: { token_id: string; cap: string; window_sec: number; used_in_window: string; window_start_ns: number }[];
  tallies: { token_id: string; pending_in: string; confirmed_in: string; out: string; credited: string; backing: string }[];
}

/** One entry of the guardian's `pause_history`. */
export interface PauseRecord {
  index: number;
  target: string;
  rule_id: string;
  evidence_hash: string;
  watcher: string;
  block_height: string | number;
  timestamp_ns: string | number;
  status: string;
  council_override?: boolean;
  /** What was paused: "ALL" or a near-plugins feature key (guardian 1.1). */
  scope?: string;
}

export interface TokenMeta {
  symbol?: string;
  decimals?: number;
}

// ------------------------------------------------------------ API responses

/** GET /api/health */
export interface Health {
  ok: boolean;
  networks: NetworkId[];
  ai: { mode: "replay" | "record" | "live"; draftModel: string; explainModel: string; live: boolean };
  alerts: string[];
  demo: boolean;
}

export interface WatcherProgress {
  lastBlock: number;
  source: string;
  at: string;
}

/** GET /api/networks */
export interface NetworkInfo {
  id: NetworkId;
  rpcUrls: string[];
  stream: string;
  guardianId: string | null;
  watcherAccount: string | null;
  watcherKeyLoaded: boolean;
  firewallAccount: string | null;
  firewallDaos: string[];
  progress: WatcherProgress | null;
}

/** One rule in GET /api/protocols/:id, with its latest evaluation and backtest. */
export interface RuleEntry {
  rule: Rule;
  evaluation?: Evaluation;
  backtest?: BacktestResult;
  lastPassed?: { blockHeight: number; at: string };
  /** Proposal-policy limits in plain units (from each token's ft_metadata). */
  limits?: string;
}

/** GET /api/protocols/:id */
export interface ProtocolDetail {
  protocol: Protocol;
  rules: RuleEntry[];
  drafts: DraftRun[];
  breaches: Breach[];
}

/** A check's latest evaluation as the status view shows it (no `type`: branch on the check's `type`). */
export type StatusEvaluation =
  | (Omit<SolvencyEvaluation, "reads" | "ruleId" | "type"> & { reads: (Omit<Read, "raw" | "blockHeight"> & { provider: string })[] })
  | Omit<OutflowEvaluation, "ruleId" | "type" | "receipts">
  | Omit<ProposalEvaluation, "ruleId" | "type" | "governance" | "proposer" | "kindLabel" | "kind">;

export interface StatusCheck {
  id: string;
  type: RuleType;
  explain: string;
  response: RuleResponse;
  rule: Rule;
  evaluation: StatusEvaluation | null;
  lastPassed: { blockHeight: number; at: string } | null;
  backtest: BacktestResult | null;
}

export type StatusBreach = Pick<Breach, "id" | "ruleId" | "triggerBlock" | "detectedAt" | "evaluation" | "pause" | "vote" | "triggerReceipts" | "explanation" | "evidenceHash"> & { explain: string };

export interface StatusProposal {
  id: number;
  proposer: string;
  kind: string;
  summary: string;
  ok: boolean;
  violations: string[];
  at: string;
}

/** GET /api/status/:id (public) and GET /api/protocols/:id/status (operator). */
export interface StatusView {
  tokens: Record<string, TokenMeta>;
  guard: GuardStatus | null;
  protocol: {
    id: string;
    name: string;
    network: NetworkId;
    contractId: string;
    kind: "contract" | "dao";
    unofficial: boolean;
    guardianId: string | null;
    status: Protocol["status"];
    published: boolean;
  };
  paused: boolean | null;
  pausedRead?: RawRead;
  pauseHistory: PauseRecord[];
  checks: StatusCheck[];
  breaches: StatusBreach[];
  proposals: StatusProposal[];
  firewall: Protocol["firewallVerified"] | null;
  watcher: WatcherProgress | null;
  scope: string;
}

/** A server-sent event from GET /api/events. */
export interface LiveEvent {
  type: string;
  protocolId?: string;
  relayerId?: string;
  data?: any;
  /** True when the event concerns a published (public) protocol. */
  public?: boolean;
}

// ------------------------------------------------------- multi-tenancy (SaaS)

export type WorkspaceRole = "owner" | "admin" | "responder" | "viewer";

/** Protection ladder (change request §6.1). */
export type ProtectionLevel = 0 | 1 | 2 | 3;

export const PROTECTION_LEVELS: Record<ProtectionLevel, { name: string; can: string[]; cannot: string[] }> = {
  0: {
    name: "Watching",
    can: ["Check rules on every block that touches the contract", "Alert you (Telegram, webhook)", "Show an unofficial status page"],
    cannot: ["Pause anything", "Move or hold funds"],
  },
  1: {
    name: "Assisted pause",
    can: ["Everything in Watching", "Put a ready-to-sign pause transaction or DAO proposal in every alert"],
    cannot: ["Pause without your signature", "Move or hold funds"],
  },
  2: {
    name: "Automatic pause",
    can: ["Everything in Assisted pause", "Pause through the guardian within seconds of a confirmed breach, at most once an hour unless your council allows another"],
    cannot: ["Unpause (only you or your DAO can)", "Change limits", "Move or hold funds"],
  },
  3: {
    name: "In-contract guard",
    can: ["Everything in Automatic pause", "Block over-limit outflows and pause in the same transaction, even if Qorvex is down"],
    cannot: ["Unpause", "Change limits", "Move or hold funds"],
  },
};

/** Where a detection fact came from (change request §8). */
export type FactSource = "detected" | "suggested-by-ai" | "confirmed-by-you";

/** Result of the read-only probes run when a contract is added, nightly and on code changes (§6.2). */
export interface Detection {
  network: NetworkId;
  contractId: string;
  at: string;
  hasContract: boolean;
  codeHash: string | null;
  fullAccessKeys: number;
  /** What kind of contract the probes recognised. */
  kind: "qorvex-guard" | "near-plugins" | "sputnik-dao" | "fungible-token" | "unknown";
  plugins: { pausable: boolean; pausedFeatures: string[]; roles: string[]; superAdmins: string[]; pauseRole: string | null } | null;
  guard: { owner: string; guardian: string | null; selfAccounting: boolean } | null;
  /** Who controls the contract: owner view, near-plugins super-admin, or the DAO itself. */
  owner: { accountId: string; via: string; isDao: boolean; council: string[] } | null;
  /** The contract is itself a Sputnik DAO: its council. */
  dao: { council: string[]; roles: string[] } | null;
  token: { symbol: string; decimals: number } | null;
  /** Registered with this network's Qorvex guardian (guardian 1.1 get_target). */
  guardianRegistration: { adapter: string; council: string; scopes: string[] } | null;
  level: ProtectionLevel;
  recommended: { level: ProtectionLevel; path: "set-guardian" | "near-plugins-grant" | "dao-firewall" | "watch-only"; explain: string; signer: string | null; viaDao: boolean };
  /** Every probe and what it returned, for the "how do we know" panel. */
  probes: { name: string; ok: boolean; value?: unknown; source: FactSource }[];
}

export interface AuthorityClaim {
  id: string;
  workspaceId: string;
  network: NetworkId;
  contractId: string;
  method: "owner-account" | "near-plugins-admin" | "dao-council" | "contract-account" | "guardian-transaction" | "admin-token";
  evidence: {
    account: string;
    detail: string;
    /**
     * Whether `account` is the guardian's council for this contract (or sits on
     * the council of the DAO the guardian names). Only then may this workspace
     * trigger automatic pauses. Absent until checked.
     */
    council?: { council: string | null; matches: boolean; checkedAt: string };
  };
  status: "verified" | "lapsed" | "pending";
  verifiedAt: string | null;
}

/** A transaction for the user's wallet to sign (near-connect signAndSendTransactions). */
export interface WalletTx {
  receiverId: string;
  actions: { type: "FunctionCall"; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[];
  /** Plain-English line shown above the wallet prompt. */
  explain: string;
}

/** A ready-made rule the operator fills in with a few fields (friction item 3). */
export interface RuleTemplate {
  id: string;
  title: string;
  explain: string;
  /** Why this template is offered for this contract. */
  because: string;
  fields: { name: string; label: string; kind: "token" | "amount" | "seconds" | "account" | "method" | "bps"; default: string; help?: string }[];
}

export interface ContractCheck {
  detection: Detection;
  templates: RuleTemplate[];
  /** Workspaces never see each other: only whether the public page is claimed. */
  claimed: boolean;
  statusPageId: string | null;
}
