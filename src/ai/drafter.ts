/**
 * Rule drafting pipeline (A2 to A6):
 *
 *  1. collect inputs (source, ABI, methods, live reads, recent receipts);
 *  2. the drafting model returns rules as JSON, temperature 0;
 *  3. every draft is validated automatically: shape, referenced methods
 *     exist, every referenced view is called and must return an amount that
 *     parses, then the backtest runs. Failing drafts go back to the model
 *     with the errors, at most twice, then are dropped;
 *  4. survivors are stored with status "draft": nothing goes live until a
 *     human approves it (A6). The model can never approve, edit an active
 *     rule or trigger a pause.
 */
import type { NearRpc } from "../near/rpc.ts";
import { readAmount } from "../rules/evaluate.ts";
import { validateDraftShape, type DraftRule, type Rule } from "../rules/types.ts";
import { newId, type BacktestResult, type DraftRun, type Store } from "../store/store.ts";
import { FixtureMissingError, NearAiClient, parseJsonReply, type ChatMessage } from "./client.ts";
import { humanAmount, sourceDigest, type DraftInputs } from "./inputs.ts";
import { humanizePolicy } from "../firewall/humanize.ts";

export const MAX_RETRIES = 2;

export const RULE_FORMAT_DOC = `Qorvex rule format (JSON). Three rule types:

1. Solvency: what the contract owes users for a token must never exceed what it holds.
{"id":"solvency-usdc","type":"solvency","token":"<token contract id>",
 "owed":{"view":"<view method on the protected contract>","args":{...}},
 "held":{"contract":"<token contract id>","view":"ft_balance_of","args":{"account_id":"<protected contract id>"}},
 "explain":"USDC owed to users must never exceed USDC held"}
 - "owed"/"held" are view calls. "contract" defaults to the protected contract. Optional "path" (dot path) selects a nested field.
 - Both views must return a non-negative integer (JSON number or decimal string) in the token's smallest unit.

2. Outflow rate: tokens leaving the contract (ft_transfer / ft_transfer_call it sends to the token contract) must stay under a cap per window.
{"id":"outflow-usdc-1h","type":"outflow_rate","token":"<token contract id>","max":"<smallest units>","window_sec":3600,
 "explain":"No more than 100,000 USDC may leave the ledger per hour"}

3. Proposal policy (only for Sputnik DAO contracts: they expose add_proposal, act_proposal, get_policy, get_proposals):
{"id":"treasury-policy","type":"proposal_policy",
 "max_transfer":{"<token contract id or near>":"<smallest units per proposal>"},
 "allowed_call_contracts":["<contracts the DAO legitimately calls>"],
 "max_actions_per_call":20,
 "max_call_deposit_yocto":"<yoctoNEAR attached across one FunctionCall proposal>",
 "alert_on_governance":true,
 "explain":"Treasury proposals: at most 25,000 USDC each, calls only to known contracts"}
 - Every field except id/type/explain is optional, but include at least one limit.
 - Derive caps and allowed contracts from the DAO's balances, policy and past proposals in the live reads and receipts; set caps above normal past proposals.
 - For a DAO, draft only a proposal_policy (no solvency or outflow rules).

Rules:
- Reference ONLY view methods that appear in the method list you are given. Never invent method names.
- ids: lowercase, [a-z0-9_.:-], max 64 chars, unique.
- "explain": one plain-English sentence a depositor understands.
- Prefer one solvency rule per token the contract holds. Add an outflow_rate rule only if you can justify a cap from the observed state; set it well above normal activity.
- Reply with JSON only: {"rules":[...], "notes":"<one or two sentences on what you found: tokens, liability views, outflow methods>"}`;

export function buildDraftMessages(inputs: DraftInputs): ChatMessage[] {
  const methods = inputs.methods.map((m) => `${m.name}${m.params ? `(${m.params.join(", ")})` : ""} [${m.kind}]`).join("\n");
  const src = inputs.source.files.map((f) => `// FILE: ${f.path}\n${f.content}`).join("\n\n").slice(0, 110_000);
  const user = [
    `Protected contract: ${inputs.contractId} (network: ${inputs.network}, code hash ${inputs.codeHash})`,
    inputs.sourceMeta ? `NEP-330 source metadata: ${JSON.stringify(inputs.sourceMeta)}` : "No NEP-330 source metadata.",
    `ABI embedded: ${inputs.abiAvailable ? "yes" : "no"}`,
    `Methods:\n${methods}`,
    `Live state reads (latest block):\n${inputs.stateReads.map((r) => `${r.method}(${JSON.stringify(r.args)}) = ${JSON.stringify(r.value).slice(0, 500)}`).join("\n") || "(none)"}`,
    `Recent receipts touching the contract:\n${inputs.recentReceipts.map((r) => `#${r.height} ${r.predecessor} -> ${r.receiver}: ${r.methods.join(",")}`).join("\n") || "(none in the scanned window)"}`,
    inputs.dao
      ? `This is a Sputnik DAO treasury.\nNEAR balance: ${humanAmount(inputs.dao.nearBalanceYocto, 24)} NEAR = ${inputs.dao.nearBalanceYocto} yoctoNEAR (1 NEAR = 10^24 yoctoNEAR).\nTokens held:\n${inputs.dao.tokens.map((t) => `${t.contract}${t.symbol ? ` (${t.symbol}, ${t.decimals} decimals)` : ""}: ${t.human ?? "?"} = ${t.balance} smallest units`).join("\n") || "(none found)"}\nPast proposals:\n${inputs.dao.pastProposals.map((p) => `#${p.id} [${p.status}] ${p.summary}`).join("\n") || "(none)"}\nCap every token the treasury holds in max_transfer (smallest units). Set each cap to about 10% of the current balance, unless past proposals show larger legitimate payments. The "explain" sentence must state exactly the same amounts in human units (convert with the decimals above).`
      : "",
    src ? `Contract source:\n${src}` : "Contract source: not available.",
    "Draft the rules now.",
  ].join("\n\n");
  return [
    { role: "system", content: `You draft runtime safety rules for NEAR smart contracts. A human reviews every rule before it is used. Deterministic code, not you, evaluates the rules.\n\n${RULE_FORMAT_DOC}` },
    { role: "user", content: user },
  ];
}

export interface ValidationContext {
  rpc: NearRpc;
  contractId: string;
  methods: Set<string>;
  backtest: (rule: Rule) => Promise<BacktestResult>;
}

/** Validate one drafted rule. Returns errors (empty = valid) and its backtest. */
export async function validateDraft(draft: unknown, ctx: ValidationContext): Promise<{ errors: string[]; rule?: Rule; backtest?: BacktestResult; live?: string }> {
  const errors = validateDraftShape(draft);
  if (errors.length) return { errors };
  const d = draft as DraftRule;
  const rule: Rule = { ...(d as any), status: "draft", response: "alert", origin: { kind: "human", author: "validator" } };
  let live: string | undefined;
  if (rule.type === "solvency") {
    for (const [label, ref] of [["owed", rule.owed], ["held", rule.held]] as const) {
      const contract = ref.contract ?? ctx.contractId;
      if (contract === ctx.contractId && ctx.methods.size && !ctx.methods.has(ref.view)) {
        errors.push(`${label}.view "${ref.view}" does not exist on ${contract}`);
      }
    }
    if (errors.length) return { errors };
    try {
      const [o, h] = await Promise.all([
        readAmount(ctx.rpc, rule.owed, ctx.contractId, { finality: "final" }, "owed"),
        readAmount(ctx.rpc, rule.held, ctx.contractId, { finality: "final" }, "held"),
      ]);
      live = `owed ${o.value} · held ${h.value}`;
    } catch (e) {
      errors.push(`calling the referenced views failed: ${(e as Error).message.slice(0, 300)}`);
      return { errors };
    }
  }
  if (rule.type === "proposal_policy") live = await humanizePolicy(ctx.rpc, rule).catch(() => undefined);
  let backtest: BacktestResult | undefined;
  try {
    backtest = await ctx.backtest(rule);
  } catch (e) {
    errors.push(`backtest failed: ${(e as Error).message.slice(0, 200)}`);
  }
  return { errors, rule, backtest, live };
}

export interface DraftOutcome {
  run: DraftRun;
  rules: Rule[];
  backtests: BacktestResult[];
  notes?: string;
}

export async function draftRules(
  ai: NearAiClient,
  store: Store,
  protocolId: string,
  inputs: DraftInputs,
  ctx: ValidationContext,
  log: (s: string) => void = () => {},
): Promise<DraftOutcome> {
  const model = ai.cfg.draftModel;
  const run: DraftRun = { id: newId("drf"), protocolId, model, startedAt: new Date().toISOString(), attempts: [], accepted: [], dropped: [], source: ai.cfg.mode };
  store.putDraft(run);
  const messages = buildDraftMessages(inputs);
  const baseKey = { job: "draft-rules", contractId: inputs.contractId, codeHash: inputs.codeHash, source: sourceDigest(inputs.source.files) };
  const accepted: Rule[] = [];
  const backtests: BacktestResult[] = [];
  let notes: string | undefined;
  let pending: unknown[] | null = null;
  let lastChatId: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let text: string;
    try {
      const r = await ai.chat(model, messages, { ...baseKey, attempt }, { json: true });
      text = r.text;
      lastChatId = r.chatId ?? lastChatId;
      run.source = r.source;
      run.model = r.model;
    } catch (e) {
      run.error = (e as Error).message;
      run.finishedAt = new Date().toISOString();
      store.putDraft(run);
      if (e instanceof FixtureMissingError) throw e;
      throw e;
    }
    const errs: string[] = [];
    let drafts: unknown[] = [];
    try {
      const parsed = parseJsonReply(text) as { rules?: unknown[]; notes?: string };
      drafts = Array.isArray(parsed.rules) ? parsed.rules : [];
      notes = parsed.notes ?? notes;
      if (!drafts.length) errs.push('reply has no "rules" array');
    } catch (e) {
      errs.push(`reply is not valid JSON: ${(e as Error).message}`);
    }
    // On retries, only the previously failing rules were sent back.
    if (pending && drafts.length === 0) drafts = [];
    const failing: { rule: unknown; errors: string[] }[] = [];
    for (const d of drafts) {
      const id = (d as any)?.id;
      if (accepted.some((a) => a.id === id)) {
        failing.push({ rule: d, errors: [`duplicate id ${id}`] });
        continue;
      }
      const v = await validateDraft(d, ctx);
      if (v.errors.length === 0 && v.rule) {
        const rule: Rule = { ...v.rule, origin: { kind: "ai", model: run.model, draftId: run.id } };
        accepted.push(rule);
        if (v.backtest) backtests.push(v.backtest);
        log(`accepted ${rule.id} (${v.live ?? rule.type}; backtest fires=${v.backtest?.fires ?? "n/a"})`);
      } else {
        failing.push({ rule: d, errors: v.errors });
        log(`rejected draft ${id ?? "?"}: ${v.errors.join("; ")}`);
      }
    }
    run.attempts.push({ n: attempt, responseText: text, chatId: lastChatId, errors: [...errs, ...failing.flatMap((f) => f.errors.map((e) => `${(f.rule as any)?.id ?? "?"}: ${e}`))] });
    store.putDraft(run);
    if (failing.length === 0 && errs.length === 0) break;
    if (attempt === MAX_RETRIES) {
      run.dropped.push(...failing);
      break;
    }
    pending = failing.map((f) => f.rule);
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `These drafts failed automatic validation and were not shown to the operator:\n${JSON.stringify(failing, null, 1)}\n${errs.join("\n")}\nReturn corrected versions of ONLY these rules (or drop them) in the same JSON format. Use only methods from the list.`,
    });
  }

  run.accepted = accepted.map((r) => r.id);
  run.finishedAt = new Date().toISOString();
  if (ai.canCallLive) {
    const att = await ai.attestation(run.model, lastChatId);
    run.attestation = { model: run.model, nonce: att.nonce, signingAddress: att.signingAddress, fetchedAt: new Date().toISOString(), report: att.report, error: att.error };
  }
  store.putDraft(run);
  return { run, rules: accepted, backtests, notes };
}
