import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { NetworkId, RawRead, StatusCheck, StatusView, TokenMeta } from "@qorvex/shared";
import { api } from "../lib/api";
import { useLiveEvents, useThrottled } from "../lib/live";
import { ago, amount, explorerTx, NEAR_META, pct, short } from "../lib/format";
import { useTitle } from "../lib/hooks";
import { Sparkline } from "../components/Sparkline";
import { errorText, pauseReason } from "../lib/errors";
import { browserView, redactText, redactUrl, STALE_EVALUATION_MS, STALE_WATCHER_MS, VERDICT_CLASS, VERDICT_HELP, VERDICT_LABEL, type BrowserRead, type Verdict } from "../lib/verify";
import "../styles/app.css";

type History = Record<string, { blockHeight: number; ok: boolean; marginBps?: number | null; total?: string; owed?: string }[]>;

/**
 * Public status page (PRD S1, S2). Answers "is this protocol still fully backed,
 * and what can stop it if not?" in a few lines, then keeps every read behind
 * it one click away so anyone can repeat it without trusting Qorvex.
 *
 * Rules for this page:
 * - Only a fresh on-chain read can make something "confirmed" or "failed".
 * - A read that could not be made is "unavailable", never "absent" or "detected".
 * - Settings an operator chose (a rule's response, a guardian id) are labelled as
 *   configuration, not as evidence that protection is active.
 * - Provider URLs are shown with credentials hidden; no server internals are shown.
 */
export default function StatusPage() {
  const { id } = useParams();
  const [v, setV] = useState<StatusView | null>(null);
  const [history, setHistory] = useState<History>({});
  const [registration, setRegistration] = useState<BrowserRead | null>(null);
  const [historyRead, setHistoryRead] = useState<BrowserRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  useTitle(v ? `${v.protocol.name} · Status` : "Status");

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api<StatusView>(`/api/status/${id}`), api<History>(`/api/status/${id}/history`).catch(() => ({}))]);
      setV(s);
      setHistory(h);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  const refresh = useThrottled(() => void load(), 2000);
  useLiveEvents((e) => {
    if (e.protocolId === id) refresh();
  });
  // Re-render every 20 s so "x ago" and staleness stay true while the page is open.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  // Independent check from the visitor's browser: is this contract registered with the guardian?
  const guardianId = v?.protocol.guardianId ?? null;
  const network = v?.protocol.network;
  const contractId = v?.protocol.contractId;
  useEffect(() => {
    if (!guardianId || !network || !contractId) return;
    let live = true;
    void browserView(network, guardianId, "get_target", { target: contractId }).then((r) => live && setRegistration(r));
    void browserView(network, guardianId, "pause_history", { target: contractId, limit: 100 }).then((r) => live && setHistoryRead(r));
    return () => {
      live = false;
    };
  }, [guardianId, network, contractId]);

  if (error && !v) return <p className="container page auth-error">{error}</p>;
  if (!v) return <p className="container page faint">Reading the chain…</p>;

  const tok = (t: string): TokenMeta | undefined => (t === "near" ? NEAR_META : v.tokens[t]);
  const checks = v.checks.map((c) => ({ c, ...checkVerdict(c) }));
  const failed = checks.filter((x) => x.verdict === "failed");
  const confirmed = checks.filter((x) => x.verdict === "confirmed");
  const pausedBlock = blockOf(v.pausedRead);
  const watcherAge = v.watcher ? Date.now() - Date.parse(v.watcher.at) : Infinity;
  const watcherStale = watcherAge > STALE_WATCHER_MS;

  // Headline: evidence only.
  let headline: { tone: "paused" | "breach" | "healthy" | "unknown"; title: string };
  if (v.paused === true) headline = { tone: "paused", title: "Paused: outflows are stopped" };
  else if (failed.length) headline = { tone: "breach", title: `Breach: ${failed.length} check${failed.length > 1 ? "s" : ""} failing` };
  else if (!checks.length) headline = { tone: "unknown", title: "No checks are published for this contract yet" };
  else if (confirmed.length === checks.length) headline = { tone: "healthy", title: `All ${checks.length} check${checks.length > 1 ? "s" : ""} passing` };
  else if (confirmed.length) headline = { tone: "unknown", title: `${confirmed.length} of ${checks.length} checks confirmed; the rest have no recent evidence` };
  else headline = { tone: "unknown", title: "No recent evidence: the checks have not been evaluated lately" };

  return (
    <section className="container page" aria-labelledby="status-title">
      <div className="row-between">
        <div>
          <p className="eyebrow">Public status</p>
          <h1 id="status-title" className="serif page-title">
            {v.protocol.name}
          </h1>
          <p className="mono faint small">
            {v.protocol.contractId} · {v.protocol.network}
          </p>
        </div>
        <span className={`pill ${v.protocol.unofficial ? "pill-warn" : "pill-outline-lime"}`}>{v.protocol.unofficial ? "Unofficial · built from public data" : "Published by the contract's operator"}</span>
      </div>

      <div className={`banner banner-${headline.tone}`} role="status" aria-live="polite">
        <span className="banner-title">{headline.title}</span>
        <span className="small">
          {v.watcher ? (
            <>
              Last block seen: {v.watcher.lastBlock.toLocaleString()} · {ago(v.watcher.at)}
              {watcherStale && <b className="warn-text"> · monitoring may be behind</b>}
            </>
          ) : (
            <b className="warn-text">Monitoring is not reporting</b>
          )}
        </span>
      </div>

      <div className="card panel">
        <h2 className="h-small">Security summary</h2>
        <ul className="summary">
          <SummaryRow
            label="Checks"
            verdict={!checks.length ? "absent" : failed.length ? "failed" : confirmed.length === checks.length ? "confirmed" : "unknown"}
            text={
              !checks.length
                ? "No checks are published."
                : `${checks.length} published · ${confirmed.length} confirmed${failed.length ? ` · ${failed.length} failing` : ""}${checks.length - confirmed.length - failed.length ? ` · ${checks.length - confirmed.length - failed.length} without recent evidence` : ""}.`
            }
          />
          <SummaryRow
            label="Pause state"
            verdict={v.paused === null ? "unavailable" : "confirmed"}
            text={v.paused === null ? "The contract's pause state could not be read (it may have no is_paused view)." : v.paused ? "The contract is paused." : "The contract is running (not paused)."}
            block={v.paused === null ? undefined : pausedBlock}
          />
          <AutoPauseRow v={v} registration={registration} />
          {v.protocol.kind !== "dao" && (
            <SummaryRow
              label="In-contract limits"
              verdict={v.guard ? "confirmed" : "unknown"}
              text={
                v.guard
                  ? `The contract embeds qorvex-guard: ${v.guard.limits.length} outflow limit${v.guard.limits.length === 1 ? "" : "s"}, self-accounting ${v.guard.self_accounting ? "on" : "off"}. These work even if Qorvex is down.`
                  : "The contract did not report in-contract limits. It may not embed them, or the read failed."
              }
            />
          )}
          {v.protocol.kind === "dao" && (
            <SummaryRow
              label="Proposal firewall"
              verdict={!v.firewall ? "unknown" : !v.firewall.ok ? "failed" : Date.now() - Date.parse(v.firewall.at) < 24 * 3600_000 ? "confirmed" : "unknown"}
              text={
                !v.firewall
                  ? "No firewall verification is on record."
                  : v.firewall.ok
                    ? `A reject-only role can vote down proposals that break the treasury policy. Last verified from the DAO's policy ${ago(v.firewall.at)}.`
                    : "The last verification of the DAO's policy found problems."
              }
            />
          )}
          <PauseHistoryRow v={v} read={historyRead} />
        </ul>
        <details className="legend">
          <summary className="small">What these labels mean</summary>
          <ul className="small">
            {(Object.keys(VERDICT_LABEL) as Verdict[]).map((k) => (
              <li key={k}>
                <VerdictPill verdict={k} /> {VERDICT_HELP[k]}.
              </li>
            ))}
          </ul>
        </details>
      </div>

      <div className="stack">
        <h2 className="h-small">Checks</h2>
        {checks.length === 0 && <p className="faint small">No checks are published.</p>}
        {checks.map(({ c, verdict, note }) => (
          <CheckCard key={c.id} c={c} verdict={verdict} note={note} tok={tok} history={history[c.id] ?? []} />
        ))}
      </div>

      {v.proposals.length > 0 && (
        <div className="card panel">
          <h2 className="h-small">Treasury proposals checked</h2>
          <ul className="rules">
            {v.proposals.slice(0, 5).map((p) => (
              <ProposalItem key={p.id} p={p} />
            ))}
          </ul>
          {v.proposals.length > 5 && (
            <details>
              <summary className="small">{v.proposals.length - 5} older proposals</summary>
              <ul className="rules">
                {v.proposals.slice(5).map((p) => (
                  <ProposalItem key={p.id} p={p} />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {v.breaches.length > 0 && (
        <div className="card panel">
          <h2 className="h-small">Incidents</h2>
          <ul className="rules">
            {v.breaches.map((b) => (
              <li key={b.id}>
                <p>
                  <b>{b.explain}</b> <span className="faint small">broke at block {b.triggerBlock.toLocaleString()} · {ago(b.detectedAt)}</span>
                </p>
                {b.pause?.status === "landed" && (
                  <p className="ok small">
                    Paused at block {b.pause.pausedAtBlock?.toLocaleString()}, {b.pause.blocksAfterBreach} blocks after the breaking block. {b.pause.txHash && <TxLink network={v.protocol.network} hash={b.pause.txHash} />}
                  </p>
                )}
                {b.vote?.status === "landed" && <p className="ok small">The proposal was voted down {b.vote.blocksAfterProposal} blocks after it was submitted.</p>}
                {b.pause && b.pause.status !== "landed" && <p className="small faint">Not paused: {pauseReason(b.pause.error, b.pause.status)}.</p>}
                {b.explanation && (
                  <details>
                    <summary className="small">AI-written explanation (context, not evidence)</summary>
                    <p className="muted small pre-wrap">{b.explanation.text}</p>
                    <p className="faint small">
                      Written by {b.explanation.model} after the {b.pause?.status === "landed" ? "pause landed" : "alert"}. The AI never decides whether to pause.
                    </p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="card panel evidence-all">
        <summary className="h-small">All evidence</summary>
        <p className="faint small">Every value above comes from these reads. Repeat any of them with the curl command; provider addresses are shown without credentials.</p>
        <EvidenceRead title="Pause state" read={v.pausedRead} what={`${v.protocol.contractId}.is_paused()`} unavailable="The is_paused read did not succeed, so no pause state is claimed." />
        {v.protocol.guardianId && <BrowserEvidence title="Guardian registration (read by your browser)" what={`${v.protocol.guardianId}.get_target({target: "${v.protocol.contractId}"})`} r={registration} />}
        {v.guard && (
          <div className="evidence">
            <p className="small">
              <b>In-contract limits</b> <span className="mono faint">{v.protocol.contractId}.guard_status()</span>
            </p>
            <ul className="mono small">
              <li>guardian: {v.guard.guardian ?? "none set"}</li>
              <li>self-accounting: {v.guard.self_accounting ? "on" : "off"}</li>
              {v.guard.paused && <li>paused: {v.guard.paused.reason}</li>}
              {v.guard.limits.map((l) => (
                <li key={l.token_id}>
                  limit {l.token_id}: {amount(l.used_in_window, tok(l.token_id))} used of {amount(l.cap, tok(l.token_id))} per {l.window_sec}s
                </li>
              ))}
              {v.guard.tallies.map((t) => (
                <li key={`t${t.token_id}`}>
                  tally {t.token_id}: credited {amount(t.credited, tok(t.token_id))} · backing {amount(t.backing, tok(t.token_id))}
                </li>
              ))}
            </ul>
          </div>
        )}
        {v.protocol.guardianId && (
          <div className="evidence">
            <p className="small">
              <b>On-chain pause history</b> <span className="mono faint">{v.protocol.guardianId}.pause_history({`{target: "${v.protocol.contractId}"}`})</span>
            </p>
            <p className="faint small">The guardian can only pause. It cannot unpause, change limits or move funds.</p>
            {v.pauseHistory.length === 0 ? (
              <p className="faint small">No pauses recorded.</p>
            ) : (
              <ul className="mono small">
                {v.pauseHistory.map((p) => (
                  <li key={p.index}>
                    #{p.index} block {Number(p.block_height).toLocaleString()} · rule {p.rule_id} · {p.status}
                    {p.scope ? ` · scope ${p.scope}` : ""} · evidence {short(p.evidence_hash, 12)}
                    {p.council_override ? " · council override" : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </details>

      <p className="faint small">{v.scope}</p>
      <p className="faint small">
        <Link to={`/c/${v.protocol.network}/${v.protocol.contractId}`}>How this contract can be protected</Link>
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ verdicts

/** A check's state from its latest evaluation and how recent it is. */
function checkVerdict(c: StatusCheck): { verdict: Verdict; note: string } {
  const ev = c.evaluation as any;
  if (!ev) return { verdict: "unknown", note: "Not evaluated yet." };
  const age = Date.now() - Date.parse(ev.at);
  const when = `block ${Number(ev.blockHeight).toLocaleString()} · ${ago(ev.at)}`;
  if (!ev.ok) return { verdict: "failed", note: `Failed at ${when}.` };
  if (c.type === "proposal_policy") return { verdict: "confirmed", note: `Latest proposal checked was within policy (${when}).` };
  if (age > STALE_EVALUATION_MS) return { verdict: "unknown", note: `Last passed at ${when}; no evaluation since. It is re-checked when the contract is used.` };
  return { verdict: "confirmed", note: `Passed at ${when}.` };
}

function VerdictPill({ verdict }: { verdict: Verdict }) {
  return <span className={`pill tiny ${VERDICT_CLASS[verdict]}`}>{VERDICT_LABEL[verdict]}</span>;
}

function SummaryRow({ label, verdict, text, block }: { label: string; verdict: Verdict; text: string; block?: number }) {
  return (
    <li className="summary-row">
      <span className="summary-label">{label}</span>
      <VerdictPill verdict={verdict} />
      <span className="small">
        {text}
        {block !== undefined && <span className="faint"> Read at block {block.toLocaleString()}.</span>}
      </span>
    </li>
  );
}

/**
 * Automatic pause needs three things: a guardian, at least one check set to
 * pause, and the contract registered with that guardian. Only the last is an
 * on-chain fact, and it is read here by the visitor's browser.
 */
function AutoPauseRow({ v, registration }: { v: StatusView; registration: BrowserRead | null }) {
  const pauseChecks = v.checks.filter((c) => c.response === "pause").length;
  if (v.protocol.kind === "dao") return null;
  if (!v.protocol.guardianId) return <SummaryRow label="Automatic pause" verdict="absent" text="No guardian is set for this contract: Qorvex can alert but cannot pause it." />;
  if (!pauseChecks) return <SummaryRow label="Automatic pause" verdict="absent" text="No published check is set to pause; checks only alert." />;
  if (!registration) return <SummaryRow label="Automatic pause" verdict="unknown" text="Checking the guardian registration from your browser…" />;
  if (!registration.ok) {
    if (registration.reason === "no-public-rpc") return <SummaryRow label="Automatic pause" verdict="unknown" text="This network has no public RPC your browser can use; the guardian registration was not checked here." />;
    return <SummaryRow label="Automatic pause" verdict="unavailable" text="Your browser could not read the guardian registration, so automatic pause is not claimed. Retry, or run the curl under All evidence." />;
  }
  const reg = registration.value as { adapter?: unknown; scopes?: string[] } | null;
  if (!reg) return <SummaryRow label="Automatic pause" verdict="absent" text={`${pauseChecks} check${pauseChecks > 1 ? "s are" : " is"} set to pause, but the contract is not registered with the guardian, so a pause cannot be forwarded.`} block={registration.blockHeight} />;
  const adapter = typeof reg.adapter === "string" ? reg.adapter : Object.keys((reg.adapter as object) ?? {})[0] ?? "QorvexGuard";
  return (
    <SummaryRow
      label="Automatic pause"
      verdict="confirmed"
      text={`Registered with the guardian (${adapter}, scope ${(reg.scopes ?? ["ALL"]).join(", ")}); ${pauseChecks} check${pauseChecks > 1 ? "s are" : " is"} set to pause. At most one automatic pause per hour unless the contract's council allows another.`}
      block={registration.blockHeight}
    />
  );
}

/**
 * Pauses recorded by the guardian. The server returns an empty list both when
 * there are none and when its read failed, so "none" is only stated when the
 * visitor's browser read the guardian itself.
 */
function PauseHistoryRow({ v, read }: { v: StatusView; read: BrowserRead | null }) {
  if (!v.protocol.guardianId) return <SummaryRow label="Recorded pauses" verdict="absent" text="No guardian is set for this contract, so no automatic pause can be recorded." />;
  const list = read?.ok && Array.isArray(read.value) ? (read.value as { block_height: string | number }[]) : v.pauseHistory;
  if (list.length) {
    return <SummaryRow label="Recorded pauses" verdict="confirmed" text={`${list.length} pause${list.length > 1 ? "s" : ""} recorded on-chain by the guardian; latest at block ${Number(list.at(-1)!.block_height).toLocaleString()}.`} block={read?.ok ? read.blockHeight : undefined} />;
  }
  if (read?.ok) return <SummaryRow label="Recorded pauses" verdict="confirmed" text="No pauses recorded on-chain." block={read.blockHeight} />;
  if (!read) return <SummaryRow label="Recorded pauses" verdict="unknown" text="Reading the guardian's pause history from your browser…" />;
  return <SummaryRow label="Recorded pauses" verdict={read.reason === "no-public-rpc" ? "unknown" : "unavailable"} text="None reported, but the guardian's history could not be read independently here, so this is not confirmed." />;
}

// -------------------------------------------------------------------- checks

function CheckCard({ c, verdict, note, tok, history }: { c: StatusCheck; verdict: Verdict; note: string; tok: (t: string) => TokenMeta | undefined; history: History[string] }) {
  const ev = c.evaluation as any;
  const token = c.rule.type === "proposal_policy" ? undefined : tok(c.rule.token);
  const setTo = c.response === "pause" ? "alert and pause" : c.response === "reject" ? "alert and vote to reject" : "alert only";
  return (
    <div className={`card panel check ${verdict === "failed" ? "check-bad" : ""}`}>
      <div className="row-between">
        <h3 className="h-small">{c.explain}</h3>
        <VerdictPill verdict={verdict} />
      </div>
      {c.type === "solvency" && ev && (
        <p className="mono check-line">
          owed {amount(ev.owed, token)} · held {amount(ev.held, token)} · margin {pct(ev.marginBps)}
        </p>
      )}
      {c.type === "outflow_rate" && ev && (
        <p className="mono check-line">
          {amount(ev.total, token)} left in the last {ev.windowSec}s · cap {amount(ev.max, token)}
        </p>
      )}
      {c.type === "proposal_policy" && ev && <p className="small check-line">Latest proposal #{ev.proposalId}: {ev.summary}</p>}
      <p className="faint small">
        {note} On breach: {setTo} (configured by the operator).
        {c.lastPassed && verdict !== "confirmed" ? ` Last passed at block ${c.lastPassed.blockHeight.toLocaleString()}.` : ""}
      </p>
      {(c.type === "solvency" || c.type === "outflow_rate") && history.length > 1 && (
        <Sparkline values={history.map((h) => (c.type === "solvency" ? (h.marginBps ?? 0) : Number(h.total ?? 0)))} fails={history.map((h) => !h.ok)} label={c.type === "solvency" ? "margin over recent evaluations" : "outflow over recent evaluations"} />
      )}
      <details>
        <summary className="small">Evidence</summary>
        {ev?.reads?.length ? (
          ev.reads.map((r: any) => <ReadEvidence key={r.id} r={r} token={token} />)
        ) : (
          <p className="faint small">{ev ? "This check is computed from the receipt stream; there is no single view call to repeat." : "No evaluation yet, so no reads."}</p>
        )}
        {c.backtest && (
          <p className="faint small">
            Before approval it was replayed on {c.backtest.samples} past points{c.backtest.days ? ` over ${c.backtest.days} days` : ""} and fired {c.backtest.fires} time{c.backtest.fires === 1 ? "" : "s"} ({redactText(c.backtest.method)}).
          </p>
        )}
        <p className="faint small">
          Rule <span className="mono">{c.id}</span> ({c.type})
        </p>
      </details>
    </div>
  );
}

function ProposalItem({ p }: { p: StatusView["proposals"][number] }) {
  return (
    <li>
      <span className={`pill tiny ${p.ok ? "pill-lime" : "pill-bad"}`}>{p.ok ? "within policy" : "breaks policy"}</span> #{p.id} · {p.kind} by <span className="mono">{p.proposer}</span> <span className="faint small">· {ago(p.at)}</span>
      <p className="muted small">{p.summary}</p>
      {p.violations.map((x) => (
        <p key={x} className="bad small">
          {x}
        </p>
      ))}
    </li>
  );
}

// ------------------------------------------------------------------ evidence

/** One read behind a number: what was called, the value, the block, and (on demand) the exact request/response. */
function ReadEvidence({ r, token }: { r: { id: string; label: string; contract: string; view: string; args: Record<string, unknown>; value: string; provider: string }; token?: TokenMeta }) {
  const [raw, setRaw] = useState<{ raw?: RawRead; blockHeight?: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setRaw(await api<{ raw: RawRead; blockHeight: number }>(`/api/reads/${r.id}`).catch((e: unknown) => ({ error: errorText(e) })));
    setBusy(false);
  };
  return (
    <div className="evidence">
      <p className="small">
        <b>{r.label}</b>: <span className="mono">{amount(r.value, token)}</span> from <span className="mono">{r.contract}.{r.view}({JSON.stringify(r.args)})</span>
        {raw?.blockHeight !== undefined && <span className="faint"> at block {raw.blockHeight.toLocaleString()}</span>}
      </p>
      <p className="faint small">Provider: {redactUrl(r.provider)}</p>
      {!raw && (
        <button className="text-link small" onClick={load} disabled={busy}>
          {busy ? "Loading…" : "Show the request and response"}
        </button>
      )}
      {raw?.error && <p className="auth-error small">{raw.error}</p>}
      {raw?.raw && <RawBlock raw={raw.raw} />}
    </div>
  );
}

/** The value a view call returned, decoded from the byte array in the RPC response. */
function decoded(response: unknown): string | null {
  const bytes = (response as { result?: { result?: unknown } } | undefined)?.result?.result;
  if (!Array.isArray(bytes)) return null;
  try {
    return new TextDecoder().decode(Uint8Array.from(bytes as number[]));
  } catch {
    return null;
  }
}

function RawBlock({ raw }: { raw: RawRead }) {
  const value = decoded(raw.response);
  return (
    <>
      {value !== null && (
        <p className="small">
          Returned: <span className="mono">{value.slice(0, 300)}</span>
        </p>
      )}
      <p className="mono small faint">Repeat it yourself:</p>
      <pre className="code-pre">{redactText(raw.curl)}</pre>
      <details>
        <summary className="small">Raw response</summary>
        <pre className="code-pre">{redactText(JSON.stringify(raw.response, null, 1)).slice(0, 4000)}</pre>
      </details>
    </>
  );
}

function EvidenceRead({ title, read, what, unavailable }: { title: string; read?: RawRead; what: string; unavailable: string }) {
  const block = blockOf(read);
  return (
    <div className="evidence">
      <p className="small">
        <b>{title}</b> <span className="mono faint">{what}</span>
        {block !== undefined && <span className="faint"> at block {block.toLocaleString()}</span>}
      </p>
      {read ? (
        <>
          <p className="faint small">Provider: {redactUrl(read.provider)}</p>
          <RawBlock raw={read} />
        </>
      ) : (
        <p className="faint small">{unavailable}</p>
      )}
    </div>
  );
}

function BrowserEvidence({ title, what, r }: { title: string; what: string; r: BrowserRead | null }) {
  return (
    <div className="evidence">
      <p className="small">
        <b>{title}</b> <span className="mono faint">{what}</span>
        {r?.ok && <span className="faint"> at block {r.blockHeight.toLocaleString()}</span>}
      </p>
      {!r && <p className="faint small">Reading…</p>}
      {r && !r.ok && r.reason === "no-public-rpc" && <p className="faint small">This network has no public RPC endpoint, so your browser cannot read it directly.</p>}
      {r && !r.ok && r.reason !== "no-public-rpc" && <p className="faint small">Your browser could not complete this read{r.reason === "unreachable" ? " (the RPC did not answer)" : " (the RPC returned an error)"}.</p>}
      {r?.ok && (
        <p className="small">
          Returned: <span className="mono">{r.value === null ? "null (not registered)" : JSON.stringify(r.value)}</span>
        </p>
      )}
      {r?.provider && <p className="faint small">Provider: {redactUrl(r.provider)} (called directly from your browser, not through Qorvex)</p>}
      {r?.curl && (
        <>
          <p className="mono small faint">Repeat it yourself:</p>
          <pre className="code-pre">{redactText(r.curl)}</pre>
        </>
      )}
      {r?.ok && (
        <details>
          <summary className="small">Raw response</summary>
          <pre className="code-pre">{JSON.stringify(r.response, null, 1).slice(0, 4000)}</pre>
        </details>
      )}
    </div>
  );
}

function TxLink({ network, hash }: { network: NetworkId; hash: string }) {
  const url = explorerTx(network, hash);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {short(hash, 10)}
    </a>
  ) : (
    <span className="mono">{short(hash, 10)}</span>
  );
}

/** Block height of a raw RPC read, when the response carries one. */
function blockOf(read?: RawRead): number | undefined {
  const h = (read?.response as { result?: { block_height?: unknown } } | undefined)?.result?.block_height;
  return typeof h === "number" ? h : undefined;
}
