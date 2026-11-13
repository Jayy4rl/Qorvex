import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { StatusCheck, StatusView, TokenMeta } from "@qorvex/shared";
import { api } from "../lib/api";
import { useLiveEvents, useThrottled } from "../lib/live";
import { ago, amount, explorerTx, NEAR_META, pct, short } from "../lib/format";
import { useTitle } from "../lib/hooks";
import { Sparkline } from "../components/Sparkline";
import "../styles/app.css";

type History = Record<string, { blockHeight: number; ok: boolean; marginBps?: number | null; total?: string; owed?: string }[]>;

/**
 * Public status page (PRD S1, S2): is this protocol still fully backed? Every
 * number opens the exact RPC request and response behind it, with a curl to
 * reproduce it, so nobody has to trust Qorvex.
 */
export default function StatusPage() {
  const { id } = useParams();
  const [v, setV] = useState<StatusView | null>(null);
  const [history, setHistory] = useState<History>({});
  const [error, setError] = useState<string | null>(null);
  useTitle(v ? `${v.protocol.name} · Status` : "Status");

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api<StatusView>(`/api/status/${id}`), api<History>(`/api/status/${id}/history`).catch(() => ({}))]);
      setV(s);
      setHistory(h);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  const refresh = useThrottled(() => void load(), 2000);
  useLiveEvents((e) => {
    if (e.protocolId === id) refresh();
  });

  if (error && !v) return <p className="container page auth-error">{error}</p>;
  if (!v) return <p className="container page faint">Reading the chain…</p>;

  const failing = v.checks.filter((c) => c.evaluation && !c.evaluation.ok);
  const state = v.paused ? "paused" : failing.length ? "breach" : v.checks.length ? "healthy" : "unknown";
  const tok = (t: string): TokenMeta | undefined => (t === "near" ? NEAR_META : v.tokens[t]);

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
        <span className={`pill ${v.protocol.unofficial ? "pill-warn" : "pill-lime"}`}>{v.protocol.unofficial ? "Unofficial · built from public data" : "Official · verified by the protocol"}</span>
      </div>

      <div className={`banner banner-${state}`} role="status" aria-live="polite">
        <span className="banner-title">
          {state === "paused" && "Paused: outflows are stopped"}
          {state === "breach" && `Breach: ${failing.length} check${failing.length > 1 ? "s" : ""} failing`}
          {state === "healthy" && "All checks passing"}
          {state === "unknown" && "No checks published yet"}
        </span>
        <span className="small">
          {v.watcher ? `Watcher at block ${v.watcher.lastBlock.toLocaleString()} · ${ago(v.watcher.at)}` : "Watcher not running"}
          {v.paused === null && " · this contract has no is_paused view"}
        </span>
      </div>

      <div className="stack">
        {v.checks.map((c) => (
          <Check key={c.id} c={c} tok={tok} history={history[c.id] ?? []} />
        ))}
      </div>

      {v.guard && (
        <div className="card panel">
          <h2 className="h-small">In-contract guard (qorvex-guard)</h2>
          <p className="muted small">
            Self-accounting {v.guard.self_accounting ? "on" : "off"} · guardian {v.guard.guardian ?? "none"} · {v.guard.paused ? `paused: ${v.guard.paused.reason}` : "not paused"}
          </p>
          {v.guard.limits.length > 0 && (
            <ul className="mono small">
              {v.guard.limits.map((l) => (
                <li key={l.token_id}>
                  {l.token_id}: {amount(l.used_in_window, tok(l.token_id))} used of {amount(l.cap, tok(l.token_id))} per {l.window_sec}s
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {v.proposals.length > 0 && (
        <div className="card panel">
          <h2 className="h-small">Treasury proposals checked</h2>
          <ul className="rules">
            {v.proposals.map((p) => (
              <li key={p.id}>
                <span className={`pill tiny ${p.ok ? "pill-lime" : "pill-bad"}`}>{p.ok ? "within policy" : "breaks policy"}</span> #{p.id} · {p.kind} by <span className="mono">{p.proposer}</span>
                <p className="muted small">{p.summary}</p>
                {p.violations.map((x) => (
                  <p key={x} className="bad small">
                    {x}
                  </p>
                ))}
              </li>
            ))}
          </ul>
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
                    Paused at block {b.pause.pausedAtBlock?.toLocaleString()}, {b.pause.blocksAfterBreach} blocks after the breaking block.{" "}
                    {b.pause.txHash && <TxLink network={v.protocol.network} hash={b.pause.txHash} />}
                  </p>
                )}
                {b.pause && b.pause.status !== "landed" && <p className="small faint">Pause: {b.pause.status}{b.pause.error ? ` (${b.pause.error})` : ""}</p>}
                {b.explanation && <p className="muted small">AI explanation ({b.explanation.model}): {b.explanation.text}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {v.protocol.guardianId && (
        <div className="card panel">
          <h2 className="h-small">On-chain pause history</h2>
          <p className="faint small">
            Read from <code className="mono">{v.protocol.guardianId}.pause_history</code>. The guardian can only pause; it cannot unpause or move funds.
          </p>
          {v.pauseHistory.length === 0 ? (
            <p className="faint small">No pauses recorded.</p>
          ) : (
            <ul className="mono small">
              {v.pauseHistory.map((p) => (
                <li key={p.index}>
                  #{p.index} block {Number(p.block_height).toLocaleString()} · rule {p.rule_id} · {p.status} · evidence {short(p.evidence_hash, 12)}
                  {p.council_override ? " · council override" : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="faint small">{v.scope}</p>
      <p className="faint small">
        <Link to={`/c/${v.protocol.network}/${v.protocol.contractId}`}>How this contract is protected</Link>
      </p>
    </section>
  );
}

function TxLink({ network, hash }: { network: string; hash: string }) {
  const url = explorerTx(network, hash);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {short(hash, 10)}
    </a>
  ) : (
    <span className="mono">{short(hash, 10)}</span>
  );
}

function Check({ c, tok, history }: { c: StatusCheck; tok: (t: string) => TokenMeta | undefined; history: History[string] }) {
  const ev = c.evaluation as any;
  const token = c.rule.type === "proposal_policy" ? undefined : tok(c.rule.token);
  return (
    <div className={`card panel check ${ev && !ev.ok ? "check-bad" : ""}`}>
      <div className="row-between">
        <h2 className="h-small">{c.explain}</h2>
        <span className={`pill tiny ${!ev ? "pill-outline-lime" : ev.ok ? "pill-lime" : "pill-bad"}`}>{!ev ? "waiting" : ev.ok ? "passing" : "failing"}</span>
      </div>
      {c.type === "solvency" && ev && (
        <div className="figures">
          <Figure label="Owed to users" value={amount(ev.owed, token)} read={ev.reads?.find((r: any) => r.label === "owed")} />
          <Figure label="Held" value={amount(ev.held, token)} read={ev.reads?.find((r: any) => r.label === "held")} />
          <Figure label="Margin" value={pct(ev.marginBps)} />
          <div>
            <p className="mono small faint">Margin, last {history.length} evaluations</p>
            <Sparkline values={history.map((h) => h.marginBps ?? 0)} fails={history.map((h) => !h.ok)} label="margin over recent blocks" />
          </div>
        </div>
      )}
      {c.type === "outflow_rate" && ev && (
        <div className="figures">
          <Figure label={`Out in the last ${ev.windowSec}s`} value={amount(ev.total, token)} />
          <Figure label="Cap" value={amount(ev.max, token)} />
          <Figure label="Transfers" value={String(ev.count)} />
          <div>
            <p className="mono small faint">Outflow, last {history.length} evaluations</p>
            <Sparkline values={history.map((h) => Number(h.total ?? 0))} fails={history.map((h) => !h.ok)} label="outflow over recent blocks" />
          </div>
        </div>
      )}
      <p className="faint small">
        {ev ? `Checked at block ${ev.blockHeight.toLocaleString()}` : "Not evaluated yet"}
        {c.lastPassed ? ` · last passed at block ${c.lastPassed.blockHeight.toLocaleString()}` : ""}
        {c.backtest ? ` · backtest: fired ${c.backtest.fires} times across ${c.backtest.samples} samples${c.backtest.days ? ` (${c.backtest.days} days)` : ""}` : ""} · response: {c.response}
      </p>
    </div>
  );
}

/** A number with its evidence: click to see the RPC request/response and a curl that reproduces it. */
function Figure({ label, value, read }: { label: string; value: string; read?: { id: string; contract: string; view: string; args: Record<string, unknown>; provider: string } }) {
  const [raw, setRaw] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const toggle = async () => {
    setOpen((o) => !o);
    if (!raw && read) setRaw(await api(`/api/reads/${read.id}`).catch((e: Error) => ({ error: e.message })));
  };
  return (
    <div>
      <p className="mono small faint">{label}</p>
      {read ? (
        <button className="figure-btn mono" onClick={toggle} aria-expanded={open} title="Show the RPC read behind this number">
          {value}
        </button>
      ) : (
        <p className="figure mono">{value}</p>
      )}
      {open && read && (
        <div className="evidence">
          <p className="small">
            <span className="mono">
              {read.contract}.{read.view}({JSON.stringify(read.args)})
            </span>{" "}
            via {read.provider}
          </p>
          {!raw && <p className="faint small">Loading…</p>}
          {raw?.error && <p className="auth-error small">{raw.error}</p>}
          {raw?.raw && (
            <>
              <p className="mono small faint">Reproduce:</p>
              <pre className="code-pre">{raw.raw.curl}</pre>
              <details>
                <summary className="small">Raw response</summary>
                <pre className="code-pre">{JSON.stringify(raw.raw.response, null, 1).slice(0, 4000)}</pre>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}
