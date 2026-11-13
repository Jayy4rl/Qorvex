import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Breach, NetworkId, WalletTx } from "@qorvex/shared";
import { api, ApiError } from "../lib/api";
import { sendTransactions, WalletError } from "../lib/wallet";
import { useLiveEvents, useThrottled } from "../lib/live";
import { amount, explorerTx, pct, short } from "../lib/format";
import { TxList } from "./ContractPage";

interface IncidentView {
  breach: Breach;
  protocol: { id: string; name: string; network: NetworkId; contractId: string; published: boolean };
  paused: boolean | null;
  recovery: { txs: WalletTx[]; notes: string[] } | null;
  tokenMeta: { symbol?: string; decimals?: number } | null;
  statusUrl: string | null;
}

/**
 * One incident: what broke, the evidence (with the raw reads), how fast it was
 * contained, the AI explanation, and the recovery steps. Qorvex never
 * unpauses: recovery transactions are prepared here for the owner to sign.
 */
export default function IncidentPage() {
  const { id } = useParams();
  const [v, setV] = useState<IncidentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setV(await api<IncidentView>(`/api/breaches/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  const refresh = useThrottled(() => void load(), 2000);
  useLiveEvents((e) => {
    if (v && e.protocolId === v.protocol.id && e.type === "breach") refresh();
  }, !!v);

  if (error) return <p className="auth-error">{error}</p>;
  if (!v) return <p className="faint">Loading…</p>;
  const b = v.breach;
  const ev = b.evaluation as any;
  const meta = v.tokenMeta ?? undefined;
  const contained = b.pause?.status === "landed" || b.vote?.status === "landed";
  const t = b.timeline;
  const tl: [string, number | undefined, string?][] = t
    ? [
        ["Block produced", t.triggerBlockTimestampMs, `block ${b.triggerBlock.toLocaleString()}`],
        ["Block received by the watcher", t.blockReceivedMs],
        ["Rule failed", t.detectedMs],
        ["Confirmed by a direct read", t.confirmedMs],
        ["Pause transaction sent", t.broadcastMs, t.txBlock ? `in block ${t.txBlock.toLocaleString()}` : undefined],
        ["Contract paused", t.landedMs, t.pausedBlock ? `block ${t.pausedBlock.toLocaleString()} (guardian at ${t.guardianBlock?.toLocaleString() ?? "?"})` : undefined],
      ]
    : [];
  const t0 = t?.blockReceivedMs ?? 0;

  return (
    <div className="stack-lg">
      <div>
        <p className="faint small">
          <Link to={`/app/contracts/${v.protocol.id}?tab=incidents`}>{v.protocol.contractId}</Link> / incident
        </p>
        <h1 className="serif page-title">{b.rule.explain}</h1>
      </div>

      <div className={`banner banner-${contained ? "paused" : b.response === "alert" ? "breach" : "breach"}`}>
        <span className="banner-title">
          {b.pause?.status === "landed" && `Contained: paused at block ${b.pause.pausedAtBlock?.toLocaleString()}, ${b.pause.blocksAfterBreach} blocks after the breaking block`}
          {b.vote?.status === "landed" && `Contained: proposal voted down, ${b.vote.blocksAfterProposal} blocks after it was submitted`}
          {!contained && b.response === "alert" && "Alert only: this rule does not pause"}
          {!contained && b.response !== "alert" && `Not contained: ${b.pause?.error ?? b.vote?.error ?? b.pause?.status ?? b.vote?.status ?? "no action"}`}
        </span>
        <span className="small">
          Broke at block {b.triggerBlock.toLocaleString()} · {new Date(b.detectedAt).toLocaleString()} · contract is now {v.paused === null ? "in an unknown pause state" : v.paused ? "paused" : "running"}
        </span>
      </div>

      <div className="check-grid">
        <div className="card panel">
          <h2 className="h-small">Evidence</h2>
          {ev?.type === "solvency" && (
            <div className="figures">
              <div>
                <p className="mono small faint">Owed</p>
                <p className="figure mono">{amount(ev.owed, meta)}</p>
              </div>
              <div>
                <p className="mono small faint">Held</p>
                <p className="figure mono">{amount(ev.held, meta)}</p>
              </div>
              <div>
                <p className="mono small faint">Shortfall</p>
                <p className="figure mono bad">{BigInt(ev.owed) > BigInt(ev.held) ? amount((BigInt(ev.owed) - BigInt(ev.held)).toString(), meta) : "0"}</p>
              </div>
              <div>
                <p className="mono small faint">Margin</p>
                <p className="figure mono">{pct(ev.marginBps)}</p>
              </div>
            </div>
          )}
          {ev?.type === "outflow_rate" && (
            <p className="mono">
              {amount(ev.total, meta)} left in {ev.windowSec}s against a cap of {amount(ev.max, meta)} ({ev.count} transfers)
            </p>
          )}
          {ev?.type === "proposal" && (
            <>
              <p>
                Proposal #{ev.proposalId} by <span className="mono">{ev.proposer}</span>: {ev.summary}
              </p>
              <ul className="bad small">
                {ev.violations.map((x: string) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}
          <p className="faint small">{meta?.decimals === undefined ? "Amounts in the token's smallest units. " : ""}Evidence hash (also recorded by the guardian): <span className="mono">{short(b.evidenceHash, 16)}</span></p>
          {ev?.reads?.length > 0 && (
            <details>
              <summary className="small">The reads, reproducible with curl</summary>
              {ev.reads.map((r: any) => (
                <div key={r.id} className="evidence">
                  <p className="small mono">
                    {r.label}: {r.contract}.{r.view}({JSON.stringify(r.args)}) = {r.value} at block {r.blockHeight?.toLocaleString()}
                  </p>
                  {r.raw?.curl && <pre className="code-pre">{r.raw.curl}</pre>}
                </div>
              ))}
            </details>
          )}
          {b.confirmation && <p className="small ok">Confirmed by a second, direct read before acting (D3).</p>}
        </div>

        <div className="card panel">
          <h2 className="h-small">Timeline</h2>
          {tl.length ? (
            <ol className="timeline">
              {tl
                .filter(([, ms]) => ms)
                .map(([label, ms, extra]) => (
                  <li key={label}>
                    <span className="mono small">{ms! >= t0 ? `+${((ms! - t0) / 1000).toFixed(2)} s` : `${((ms! - t0) / 1000).toFixed(2)} s`}</span> {label}
                    {extra && <span className="faint small"> · {extra}</span>}
                  </li>
                ))}
            </ol>
          ) : (
            <p className="faint small">No timeline recorded.</p>
          )}
          {b.pause?.txHash && (
            <p className="small">
              Pause transaction: <TxLink network={v.protocol.network} hash={b.pause.txHash} /> {b.pause.provider && <span className="faint">via {b.pause.provider}</span>}
            </p>
          )}
          {b.vote?.txHash && (
            <p className="small">
              Reject vote: <TxLink network={v.protocol.network} hash={b.vote.txHash} />
            </p>
          )}
          {b.pause?.guardianRecordIndex !== undefined && <p className="small">Guardian record #{b.pause.guardianRecordIndex} in pause_history.</p>}
        </div>
      </div>

      {b.triggerReceipts.length > 0 && (
        <div className="card panel">
          <h2 className="h-small">Receipts that triggered the check</h2>
          <ul className="mono small">
            {b.triggerReceipts.map((r) => (
              <li key={r.receiptId}>
                {r.predecessor} → {r.receiver}
                {r.method ? `.${r.method}` : ""} {r.txHash && <TxLink network={v.protocol.network} hash={r.txHash} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card panel">
        <h2 className="h-small">What happened (AI explanation)</h2>
        {b.explanation ? (
          <>
            <p className="pre-wrap">{b.explanation.text}</p>
            <p className="faint small">
              Written by {b.explanation.model} after the {b.response === "pause" ? "pause landed" : "alert"} ({b.explanation.source === "replay" ? "recorded AI response" : "live"}). The AI never decides to pause.
            </p>
          </>
        ) : (
          <p className="faint small">No explanation yet (it is written only after the pause or vote lands).</p>
        )}
        {b.alerts.length > 0 && (
          <p className="small">
            Alerts:{" "}
            {b.alerts.map((a, i) => (
              <span key={i} className={`pill tiny ${a.ok ? "pill-lime" : "pill-bad"}`}>
                {a.channel} {a.ok ? "sent" : "failed"}
              </span>
            ))}
          </p>
        )}
      </div>

      <Recovery v={v} onDone={load} />
    </div>
  );
}

function TxLink({ network, hash }: { network: string; hash: string }) {
  const url = explorerTx(network, hash);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="mono">
      {short(hash, 12)}
    </a>
  ) : (
    <span className="mono">{short(hash, 12)}</span>
  );
}

function Recovery({ v, onDone }: { v: IncidentView; onDone: () => void }) {
  const [state, setState] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const r = v.recovery;
  const sign = async () => {
    if (!r || (v.protocol.network !== "mainnet" && v.protocol.network !== "testnet")) return;
    setErr(null);
    setState("Waiting for the wallet…");
    try {
      await sendTransactions(v.protocol.network, r.txs);
      setState("Sent.");
      onDone();
    } catch (e) {
      setState(null);
      setErr(e instanceof ApiError || e instanceof WalletError ? e.message : String(e));
    }
  };
  return (
    <div className="card panel">
      <h2 className="h-small">Recovery</h2>
      <p className="muted small">Qorvex cannot unpause. When the cause is fixed, the owner (or the DAO) signs these.</p>
      {!r ? (
        <p className="faint small">Could not read the contract to prepare recovery steps.</p>
      ) : (
        <>
          <ul className="small">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {r.txs.length > 0 && <TxList txs={r.txs} />}
          {r.txs.length > 0 && v.protocol.network !== "sandbox" && (
            <button className="btn btn-primary btn-sm" onClick={sign}>
              Sign in my wallet
            </button>
          )}
          {v.protocol.network === "sandbox" && <p className="faint small">Sandbox demo: use Simulations → “Recover and re-arm” to run these as the demo owner.</p>}
        </>
      )}
      {state && <p className="small">{state}</p>}
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}
