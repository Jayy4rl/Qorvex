import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  PROTECTION_LEVELS,
  type AuthorityClaim,
  type Detection,
  type DraftRun,
  type Health,
  type ProtocolDetail,
  type RuleEntry,
  type RuleTemplate,
  type StatusView,
  type TokenMeta,
  type WalletTx,
} from "@qorvex/shared";
import { api } from "../lib/api";
import { sendTransactions, withStepUp } from "../lib/wallet";
import { useLiveEvents, useThrottled } from "../lib/live";
import { ago, amount, NEAR_META, pct } from "../lib/format";
import { Sparkline } from "../components/Sparkline";
import { LevelBadge } from "./Check";
import { errorText } from "../lib/errors";

interface DetectionView {
  detection: Detection;
  claim: AuthorityClaim | null;
  templates: RuleTemplate[];
}
type History = Record<string, { blockHeight: number; at: string; ok: boolean; owed?: string; held?: string; marginBps?: number | null; total?: string; max?: string }[]>;

const msg = (e: unknown) => errorText(e);
const TABS = ["setup", "rules", "monitor", "incidents", "proposals", "status"] as const;
type Tab = (typeof TABS)[number];

/**
 * One contract. Setup follows the onboarding order (change request §8);
 * Rules is where AI drafts, templates and hand-written rules are reviewed and
 * approved; Monitor shows every rule's live values; Incidents lists breaches.
 */
export default function ContractPage() {
  const { id } = useParams();
  const [search, setSearch] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(search.get("tab") ?? "") ? (search.get("tab") as Tab) : "setup";
  const [detail, setDetail] = useState<ProtocolDetail | null>(null);
  const [view, setView] = useState<DetectionView | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [tokens, setTokens] = useState<Record<string, TokenMeta>>({});
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      setDetail(await api<ProtocolDetail>(`/api/protocols/${id}`));
    } catch (e) {
      setError(msg(e));
    }
  }, [id]);
  const loadDetection = useCallback(async () => {
    try {
      setView(await api<DetectionView>(`/api/protocols/${id}/detection`));
    } catch (e) {
      setError(msg(e));
    }
  }, [id]);
  const loadAll = useCallback(async () => void (await Promise.all([loadDetail(), loadDetection()])), [loadDetail, loadDetection]);
  useEffect(() => {
    void loadAll();
    api<Health>("/api/health").then(setHealth).catch(() => {});
    api<StatusView>(`/api/protocols/${id}/status`).then((s) => setTokens(s.tokens)).catch(() => {});
  }, [loadAll, id]);
  const refresh = useThrottled(() => void loadDetail(), 3000);
  useLiveEvents((e) => {
    if (e.protocolId === id && e.type !== "evaluation") refresh();
  });

  if (error) return <p className="auth-error">{error}</p>;
  if (!detail || !view) return <p className="faint">Reading the chain…</p>;
  const p = detail.protocol;
  const d = view.detection;
  const isDao = p.kind === "dao" || d.kind === "sputnik-dao";
  const tabs = TABS.filter((t) => t !== "proposals" || isDao);
  const openBreaches = detail.breaches.length;

  return (
    <div className="stack-lg">
      <div className="row-between">
        <div>
          <p className="faint small">
            <Link to="/app/contracts">Contracts</Link> /
          </p>
          <h1 className="mono h-contract">{p.contractId}</h1>
          <p className="faint small mono">
            {p.network} · {d.kind} · {p.status === "protected" ? "guardian authorised" : "watching only"}
          </p>
        </div>
        <LevelBadge level={d.level} />
      </div>
      <nav className="tabs" aria-label="Contract sections">
        {tabs.map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} aria-current={tab === t ? "page" : undefined} onClick={() => setSearch({ tab: t })}>
            {t === "status" ? "Status page & authority" : t[0].toUpperCase() + t.slice(1)}
            {t === "rules" && detail.rules.length > 0 && <span className="count">{detail.rules.length}</span>}
            {t === "incidents" && openBreaches > 0 && <span className="count bad-bg">{openBreaches}</span>}
          </button>
        ))}
      </nav>
      {tab === "setup" && <Setup detail={detail} view={view} health={health} onChange={loadAll} goRules={() => setSearch({ tab: "rules" })} />}
      {tab === "rules" && <Rules detail={detail} templates={view.templates} health={health} tokens={tokens} onChange={loadDetail} />}
      {tab === "monitor" && <Monitor protocolId={p.id} detail={detail} />}
      {tab === "incidents" && <Incidents detail={detail} />}
      {tab === "proposals" && <Proposals protocolId={p.id} health={health} onChange={loadAll} />}
      {tab === "status" && <StatusAndAuthority detail={detail} view={view} onChange={loadAll} />}
    </div>
  );
}

// ------------------------------------------------------------------ setup

function Setup({ detail, view, health, onChange, goRules }: { detail: ProtocolDetail; view: DetectionView; health: Health | null; onChange: () => void; goRules: () => void }) {
  const d = view.detection;
  const p = detail.protocol;
  const verified = view.claim?.status === "verified";
  return (
    <div className="stack-lg">
      <ol className="steps">
        <Step n={1} done title="Detected" source="detected">
          {d.recommended.explain}
        </Step>
        <Step n={2} done={verified} title="Control verified" source={verified ? "confirmed-by-you" : undefined}>
          {view.claim ? (
            <>
              {view.claim.evidence.detail}. <span className={`pill tiny ${verified ? "pill-lime" : "pill-bad"}`}>{view.claim.status}</span>{" "}
              {view.claim.verifiedAt && <span className="faint small">checked {ago(view.claim.verifiedAt)}</span>}
            </>
          ) : (
            <>
              Not claimed by this workspace yet. <Link to={`/c/${p.network}/${p.contractId}`}>Claim it</Link> with the account that controls it.
            </>
          )}
        </Step>
        <Step n={3} done={d.level >= 2 || p.status === "protected"} title={`Authorise the guardian (level ${d.recommended.level})`}>
          <Authorise protocolId={p.id} network={p.network} canSign={verified} detection={d} sandboxDemo={!!health?.demo && p.network === "sandbox"} onDone={onChange} />
        </Step>
        <Step n={4} done={detail.rules.some((r) => r.rule.status === "approved")} title="Approve rules">
          {detail.rules.filter((r) => r.rule.status === "approved").length} approved, {detail.rules.filter((r) => r.rule.status === "draft").length} waiting for review.{" "}
          <button className="text-link" onClick={goRules}>
            Open Rules
          </button>
        </Step>
      </ol>
      <CanCannot level={d.level} />
    </div>
  );
}

function CanCannot({ level }: { level: 0 | 1 | 2 | 3 }) {
  return (
    <div className="card panel">
      <h2 className="h-small">
        At level {level}: {PROTECTION_LEVELS[level].name}
      </h2>
      <div className="cando">
        <div>
          <p className="mono small ok">Qorvex can</p>
          <ul>{PROTECTION_LEVELS[level].can.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
        <div>
          <p className="mono small bad">Qorvex cannot</p>
          <ul>{PROTECTION_LEVELS[level].cannot.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}

function Step({ n, done, title, source, children }: { n: number; done: boolean; title: string; source?: string; children: React.ReactNode }) {
  return (
    <li className={`card panel step ${done ? "done" : ""}`}>
      <div className="row-between">
        <h2 className="h-small">
          <span className="mono step-n">{done ? "✓" : n}</span> {title}
        </h2>
        {source && <span className="pill pill-outline-lime tiny">{source}</span>}
      </div>
      <div>{children}</div>
    </li>
  );
}

function Authorise({ protocolId, network, canSign, detection, sandboxDemo, onDone }: { protocolId: string; network: string; canSign: boolean; detection: Detection; sandboxDemo: boolean; onDone: () => void }) {
  const [txs, setTxs] = useState<WalletTx[] | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (detection.level >= 2) return <p className="muted">The guardian is registered ({detection.guardianRegistration?.adapter}, scopes {detection.guardianRegistration?.scopes.join(", ")}).</p>;
  if (detection.recommended.path === "watch-only" || detection.recommended.path === "dao-firewall")
    return <p className="muted">No automatic pause path for this contract: Qorvex watches and alerts.{detection.recommended.path === "dao-firewall" && " See the Proposals tab for the DAO firewall."}</p>;
  if (!canSign && !sandboxDemo) return <p className="muted">Verify control first.</p>;
  const verify = async () => {
    const r = await api<{ ok: boolean; level: number }>(`/api/protocols/${protocolId}/authorise/verify`, { body: {} });
    setState(r.ok ? `Confirmed on-chain: level ${r.level}.` : "The guardian registration is not on-chain yet.");
    if (r.ok) onDone();
  };
  const run = (fn: () => Promise<void>) => async () => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setState(null);
      setErr(msg(e));
    }
  };
  if (sandboxDemo)
    return (
      <div className="stack">
        <p className="muted small">Local sandbox: wallets cannot sign here, so the demo owner key signs the same transaction.</p>
        <div className="row">
          <button className="btn btn-primary" onClick={run(async () => (setState("Signing…"), await api(`/api/protocols/${protocolId}/guardian/sign-demo`, { body: {} }), await verify()))}>
            Sign with the sandbox owner key
          </button>
          <button className="btn btn-secondary" onClick={run(verify)}>
            Verify on-chain
          </button>
        </div>
        {state && <p className="small">{state}</p>}
        {err && <p className="auth-error">{err}</p>}
      </div>
    );
  return (
    <div className="stack">
      {!txs && (
        <button className="btn btn-primary" onClick={run(async () => setTxs((await api<{ transactions: WalletTx[] }>(`/api/protocols/${protocolId}/authorise`)).transactions))}>
          Show what I will sign
        </button>
      )}
      {txs && (
        <>
          <TxList txs={txs} />
          <div className="row">
            <button
              className="btn btn-primary"
              onClick={run(async () => {
                if (network !== "mainnet" && network !== "testnet") return;
                setState("Waiting for the wallet…");
                await sendTransactions(network, txs);
                setState(detection.recommended.viaDao ? "Proposals submitted. Once the council approves them, press Verify." : "Sent. Verifying on-chain…");
                if (!detection.recommended.viaDao) await verify();
              })}
            >
              Sign in my wallet{detection.recommended.signer ? ` as ${detection.recommended.viaDao ? "a council member" : detection.recommended.signer}` : ""}
            </button>
            <button className="btn btn-secondary" onClick={run(verify)}>
              Verify on-chain
            </button>
          </div>
        </>
      )}
      {state && <p className="small">{state}</p>}
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}

export function TxList({ txs }: { txs: WalletTx[] }) {
  return (
    <ol className="txs">
      {txs.map((t, i) => (
        <li key={i}>
          <p>{t.explain}</p>
          <code className="mono small">
            {t.receiverId}.{t.actions[0].params.methodName}({JSON.stringify(t.actions[0].params.args).slice(0, 200)}) · deposit {t.actions[0].params.deposit} yocto
          </code>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ rules

function Rules({ detail, templates, health, tokens, onChange }: { detail: ProtocolDetail; templates: RuleTemplate[]; health: Health | null; tokens: Record<string, TokenMeta>; onChange: () => void }) {
  const p = detail.protocol;
  const [err, setErr] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ draft: DraftRun; notes?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = (label: string, fn: () => Promise<void>) => async () => {
    setErr(null);
    setBusy(label);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(null);
    }
  };
  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = await Promise.all([...(e.target.files ?? [])].slice(0, 50).map(async (f) => ({ path: f.webkitRelativePath || f.name, content: await f.text() })));
    if (files.length) await run("upload", async () => void (await api(`/api/protocols/${p.id}/source`, { body: { files } })))();
  };
  const loadDemoSource = run("upload", async () => {
    const { files } = await api<{ files: { path: string; content: string }[] }>("/api/demo/action/demo-source", { body: {} });
    await api(`/api/protocols/${p.id}/source`, { body: { files } });
  });
  const draft = run("draft", async () => {
    const out = await api<{ draft: DraftRun; notes?: string }>(`/api/protocols/${p.id}/draft`, { body: {} });
    setLastRun(out);
  });
  const latestDraft = lastRun?.draft ?? detail.drafts.at(-1);
  const drafts = detail.rules.filter((r) => r.rule.status === "draft");
  const decided = detail.rules.filter((r) => r.rule.status !== "draft");

  return (
    <div className="stack-lg">
      <div className="card panel">
        <h2 className="h-small">Draft rules with AI</h2>
        <p className="muted small">
          An open-weight model on NEAR AI Cloud ({health?.ai.draftModel ?? "…"}, {health?.ai.mode === "replay" ? "recorded responses" : "live"}) reads the source, ABI, view methods, live state and recent transactions, and proposes rules. Every draft is checked against the chain and
          backtested before you see it; you approve each one. The AI never pauses anything.
        </p>
        <p className="small">
          Source:{" "}
          {p.source ? (
            p.source.kind === "nep330" ? (
              <>
                from NEP-330 metadata <span className="mono faint">{p.source.link}</span>
              </>
            ) : (
              <>{p.source.files.length} uploaded file(s), {p.source.files.map((f) => f.path).join(", ").slice(0, 160)}</>
            )
          ) : (
            <span className="faint">none yet (the contract publishes no NEP-330 source link): upload the Rust source</span>
          )}
        </p>
        <div className="row">
          <label className="btn btn-sm btn-secondary">
            Upload source files
            <input type="file" multiple accept=".rs,.toml,.ts,.json,.md" onChange={upload} hidden />
          </label>
          {health?.demo && p.network === "sandbox" && (
            <button className="btn btn-sm btn-secondary" onClick={loadDemoSource} disabled={!!busy}>
              Load demo source
            </button>
          )}
          <button className="btn btn-sm btn-primary" onClick={draft} disabled={!!busy}>
            {busy === "draft" ? "Drafting, checking and backtesting…" : "Draft rules with AI"}
          </button>
        </div>
        {latestDraft && <DraftSummary run={latestDraft} notes={lastRun?.notes} />}
      </div>

      {drafts.length > 0 && (
        <div className="stack">
          <h2 className="h-small">Waiting for your review ({drafts.length})</h2>
          {drafts.map((r) => (
            <RuleCard key={r.rule.id} entry={r} tokens={tokens} protocolId={p.id} network={p.network} onChange={onChange} />
          ))}
        </div>
      )}

      <div className="card panel">
        <h2 className="h-small">Start from a template</h2>
        <p className="faint small">No source needed. Every filled template is validated and backtested like an AI draft.</p>
        {templates.map((t) => (
          <Template key={t.id} t={t} protocolId={p.id} onDone={onChange} />
        ))}
        <HandRule protocolId={p.id} onDone={onChange} />
      </div>

      {decided.length > 0 && (
        <div className="stack">
          <h2 className="h-small">Approved and rejected</h2>
          {decided.map((r) => (
            <RuleCard key={r.rule.id} entry={r} tokens={tokens} protocolId={p.id} network={p.network} onChange={onChange} />
          ))}
        </div>
      )}
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}

function DraftSummary({ run, notes }: { run: DraftRun; notes?: string }) {
  return (
    <div className="draft-run">
      <p className="small">
        Last draft: <span className="mono">{run.model}</span> · {run.source === "replay" ? <span className="pill tiny pill-warn">Recorded AI response</span> : run.source} · {run.accepted.length} kept, {run.dropped.length} dropped · {run.attempts.length} attempt(s){" "}
        {run.attestation && !run.attestation.error && <span className="pill tiny pill-lime">drafted in an attested enclave</span>}
      </p>
      {notes && <p className="muted small">Model's notes: {notes}</p>}
      {run.error && <p className="auth-error small">The AI couldn't finish this draft. Try again, or start from a template below.</p>}
      {run.dropped.length > 0 && (
        <details>
          <summary className="small">Why drafts were dropped</summary>
          <ul className="small">
            {run.dropped.map((x, i) => (
              <li key={i}>
                <span className="mono">{(x.rule as { id?: string })?.id ?? "rule"}</span>: {x.errors.join("; ")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function liveLine(entry: RuleEntry, tokens?: Record<string, TokenMeta>): string | null {
  const ev = entry.evaluation as any;
  if (!ev) return null;
  const r = entry.rule;
  const meta = r.type !== "proposal_policy" ? (r.token === "near" ? NEAR_META : tokens?.[r.token]) : undefined;
  if (ev.type === "solvency") return `owed ${amount(ev.owed, meta)} · held ${amount(ev.held, meta)} · margin ${pct(ev.marginBps)} at block ${ev.blockHeight.toLocaleString()}`;
  if (ev.type === "outflow_rate") return `${amount(ev.total, meta)} out of ${amount(ev.max, meta)} allowed in the last ${ev.windowSec}s`;
  return null;
}

function RuleCard({ entry, tokens, protocolId, network, onChange }: { entry: RuleEntry; tokens: Record<string, TokenMeta>; protocolId: string; network: ProtocolDetail["protocol"]["network"]; onChange: () => void }) {
  const { rule, backtest } = entry;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const act = (fn: () => Promise<unknown>) => async () => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const approve = (response: "alert" | "pause" | "reject") => act(() => withStepUp(network, (headers) => api(`/api/protocols/${protocolId}/rules/${rule.id}/approve`, { body: { response }, headers })));
  const fired = backtest ? backtest.fires > 0 : true;
  const origin = rule.origin.kind === "ai" ? `AI draft (${rule.origin.model})` : `by ${rule.origin.author}`;
  return (
    <div className="card panel rule-card">
      <div className="row-between">
        <p className="tpl-title">{rule.explain}</p>
        <span className={`pill tiny ${rule.status === "approved" ? "pill-lime" : rule.status === "rejected" ? "pill-bad" : "pill-outline-lime"}`}>{rule.status === "approved" ? `approved · ${rule.response}` : rule.status}</span>
      </div>
      <p className="faint small">
        <span className="mono">{rule.id}</span> · {rule.type} · {origin}
        {rule.approvedBy ? ` · approved by ${rule.approvedBy}` : ""}
      </p>
      {liveLine(entry, tokens) && <p className="small mono">Live: {liveLine(entry, tokens)}</p>}
      {entry.limits && <p className="small">{entry.limits}</p>}
      <p className="small">
        {backtest ? (
          <>
            Backtest: fired <b className={backtest.fires ? "bad" : "ok"}>{backtest.fires}</b> times across {backtest.samples} samples ({backtest.days ? `${backtest.days} days, ` : ""}{backtest.method})
          </>
        ) : (
          <span className="faint">No backtest yet</span>
        )}{" "}
        <button className="text-link" onClick={act(() => api(`/api/protocols/${protocolId}/rules/${rule.id}/backtest`, { body: {} }))} disabled={busy}>
          {backtest ? "re-run" : "run backtest"}
        </button>
        {rule.type === "solvency" && (
          <>
            {" · "}
            <button className="text-link" onClick={act(() => api(`/api/protocols/${protocolId}/rules/${rule.id}/evaluate`, { body: {} }))} disabled={busy}>
              read live value
            </button>
          </>
        )}
        {" · "}
        <button className="text-link" onClick={() => setShowJson((s) => !s)}>
          {showJson ? "hide" : "show"} exact rule
        </button>
      </p>
      {showJson && <pre className="code-pre">{JSON.stringify(rule, null, 2)}</pre>}
      {rule.status === "draft" && (
        <div className="row">
          <button className="btn btn-sm btn-secondary" onClick={approve("alert")} disabled={busy || !backtest}>
            Approve: alert only
          </button>
          {rule.type === "proposal_policy" ? (
            <button className="btn btn-sm btn-primary" onClick={approve("reject")} disabled={busy || !backtest}>
              Approve: alert + vote to reject
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={approve("pause")} disabled={busy || fired} title={fired ? "Only rules with zero backtest fires can pause" : "Needs a wallet signature"}>
              Approve: alert + auto-pause
            </button>
          )}
          <button className="btn btn-sm btn-secondary" onClick={act(() => api(`/api/protocols/${protocolId}/rules/${rule.id}/reject`, { body: {} }))} disabled={busy}>
            Reject
          </button>
        </div>
      )}
      {rule.status === "draft" && fired && backtest && <p className="faint small">This rule fired in its backtest, so it can only be approved as alert-only (a false pause locks users out).</p>}
      {err && <p className="auth-error small">{err}</p>}
    </div>
  );
}

function Template({ t, protocolId, onDone }: { t: RuleTemplate; protocolId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(t.fields.map((f) => [f.name, f.default])));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fill = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/protocols/${protocolId}/templates/${t.id}`, { body: { values } });
      setOpen(false);
      onDone();
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tpl">
      <button className="text-link" onClick={() => setOpen((o) => !o)}>
        + {t.title}
      </button>
      {open && (
        <div className="stack tpl-form">
          <p className="muted small">{t.explain}</p>
          {t.fields.map((f) => (
            <label key={f.name} className="auth-label mono">
              {f.label}
              <input className="auth-input mono" value={values[f.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))} />
              {f.help && <span className="faint small">{f.help}</span>}
            </label>
          ))}
          <button className="btn btn-primary btn-sm" onClick={fill} disabled={busy}>
            {busy ? "Validating and backtesting…" : "Create draft rule"}
          </button>
          {err && <p className="auth-error small">{err}</p>}
        </div>
      )}
    </div>
  );
}

function HandRule({ protocolId, onDone }: { protocolId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('{\n  "id": "my-rule",\n  "type": "outflow_rate",\n  "token": "near",\n  "max": "10000000000000000000000000",\n  "window_sec": 3600,\n  "explain": "At most 10 NEAR may leave the contract per hour."\n}');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    let rule: unknown;
    try {
      rule = JSON.parse(text);
    } catch {
      return setErr("That isn't valid JSON. Check the brackets, quotes and commas.");
    }
    try {
      await api(`/api/protocols/${protocolId}/rules`, { body: { rule } });
      setOpen(false);
      onDone();
    } catch (e) {
      setErr(msg(e));
    }
  };
  return (
    <div className="tpl">
      <button className="text-link" onClick={() => setOpen((o) => !o)}>
        + Write a rule by hand (JSON)
      </button>
      {open && (
        <div className="stack tpl-form">
          <textarea className="auth-input mono code-area" rows={9} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <button className="btn btn-primary btn-sm" onClick={save}>
            Validate and backtest
          </button>
          {err && <p className="auth-error small">{err}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- monitor

function Monitor({ protocolId, detail }: { protocolId: string; detail: ProtocolDetail }) {
  const [history, setHistory] = useState<History>({});
  const [status, setStatus] = useState<StatusView | null>(null);
  const load = useCallback(async () => {
    const [h, s] = await Promise.all([api<History>(`/api/protocols/${protocolId}/history`), api<StatusView>(`/api/protocols/${protocolId}/status`)]);
    setHistory(h);
    setStatus(s);
  }, [protocolId]);
  useEffect(() => void load().catch(() => {}), [load]);
  const refresh = useThrottled(() => void load().catch(() => {}), 1500);
  useLiveEvents((e) => {
    if (e.protocolId === protocolId) refresh();
  });
  const active = detail.rules.filter((r) => r.rule.status === "approved" && r.rule.type !== "proposal_policy");
  const tok = (t: string) => (t === "near" ? NEAR_META : status?.tokens[t]);
  return (
    <div className="stack-lg">
      <div className={`banner banner-${status?.paused ? "paused" : active.some((r) => (status?.checks.find((c) => c.id === r.rule.id)?.evaluation?.ok ?? true) === false) ? "breach" : "healthy"}`}>
        <span className="banner-title">{status?.paused ? "Paused" : status?.paused === false ? "Running" : "Pause state unknown (no is_paused view)"}</span>
        <span className="small">{status?.watcher ? `Watcher at block ${status.watcher.lastBlock.toLocaleString()} · ${ago(status.watcher.at)}` : "Watcher not running on this network"}</span>
      </div>
      {active.length === 0 && <p className="muted">No approved rules yet: approve one in Rules to start monitoring.</p>}
      {active.map((r) => {
        const h = history[r.rule.id] ?? [];
        const c = status?.checks.find((x) => x.id === r.rule.id);
        const ev = c?.evaluation as any;
        const meta = r.rule.type !== "proposal_policy" ? tok(r.rule.token) : undefined;
        return (
          <div key={r.rule.id} className={`card panel ${ev && !ev.ok ? "check-bad" : ""}`}>
            <div className="row-between">
              <p className="tpl-title">{r.rule.explain}</p>
              <span className={`pill tiny ${!ev ? "pill-outline-lime" : ev.ok ? "pill-lime" : "pill-bad"}`}>{!ev ? "waiting for a block" : ev.ok ? "passing" : "failing"}</span>
            </div>
            {r.rule.type === "solvency" && (
              <div className="figures">
                <div>
                  <p className="mono small faint">Owed</p>
                  <p className="figure mono">{amount(ev?.owed, meta)}</p>
                </div>
                <div>
                  <p className="mono small faint">Held</p>
                  <p className="figure mono">{amount(ev?.held, meta)}</p>
                </div>
                <div>
                  <p className="mono small faint">Margin</p>
                  <p className="figure mono">{pct(ev?.marginBps)}</p>
                </div>
                <div>
                  <p className="mono small faint">Margin, last {h.length} blocks evaluated</p>
                  <Sparkline values={h.map((x) => x.marginBps ?? 0)} fails={h.map((x) => !x.ok)} label="margin history" />
                </div>
              </div>
            )}
            {r.rule.type === "outflow_rate" && (
              <div className="figures">
                <div>
                  <p className="mono small faint">Out this window</p>
                  <p className="figure mono">{amount(ev?.total, meta)}</p>
                </div>
                <div>
                  <p className="mono small faint">Cap</p>
                  <p className="figure mono">{amount(ev?.max ?? r.rule.max, meta)}</p>
                </div>
                <div>
                  <p className="mono small faint">Used</p>
                  <p className="figure mono">{ev ? `${Math.min(999, Math.round((Number(ev.total) / Math.max(1, Number(ev.max))) * 100))}%` : "—"}</p>
                </div>
                <div>
                  <p className="mono small faint">Outflow, last {h.length} evaluations</p>
                  <Sparkline values={h.map((x) => Number(x.total ?? 0))} fails={h.map((x) => !x.ok)} label="outflow history" />
                </div>
              </div>
            )}
            <p className="faint small">
              {ev ? `Last evaluated at block ${ev.blockHeight.toLocaleString()} (${ago(ev.at)})` : "Evaluated on the next block that touches the contract."}
              {c?.lastPassed ? ` · last passed at block ${c.lastPassed.blockHeight.toLocaleString()}` : ""} · on breach: {r.rule.response === "pause" ? "alert + pause" : r.rule.response}
            </p>
          </div>
        );
      })}
      {status?.guard && (
        <div className="card panel">
          <h2 className="h-small">In-contract guard</h2>
          <ul className="mono small">
            {status.guard.limits.map((l) => (
              <li key={l.token_id}>
                {l.token_id}: {amount(l.used_in_window, tok(l.token_id))} of {amount(l.cap, tok(l.token_id))} per {l.window_sec}s
              </li>
            ))}
            {status.guard.tallies.map((t) => (
              <li key={`t${t.token_id}`}>
                {t.token_id}: credited {amount(t.credited, tok(t.token_id))} · backing {amount(t.backing, tok(t.token_id))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- incidents

function Incidents({ detail }: { detail: ProtocolDetail }) {
  if (!detail.breaches.length) return <p className="muted">No incidents. When a rule breaks, the incident appears here with its evidence, timeline and recovery steps.</p>;
  return (
    <div className="card list">
      {detail.breaches.map((b) => (
        <Link key={b.id} to={`/app/incidents/${b.id}`} className="list-row incident-row">
          <span>
            <b>{b.rule.explain}</b>
            <br />
            <span className="faint small">
              block {b.triggerBlock.toLocaleString()} · {ago(b.detectedAt)}
            </span>
          </span>
          <span className="small">
            {b.pause?.status === "landed" ? `paused +${b.pause.blocksAfterBreach} blocks` : b.vote?.status === "landed" ? `rejected +${b.vote.blocksAfterProposal} blocks` : b.pause?.status ?? b.vote?.status ?? b.response}
          </span>
          <span className={`pill tiny ${b.pause?.status === "landed" || b.vote?.status === "landed" ? "pill-lime" : b.response === "alert" ? "pill-warn" : "pill-bad"}`}>{b.pause?.status === "landed" || b.vote?.status === "landed" ? "contained" : b.response === "alert" ? "alerted" : "action failed"}</span>
        </Link>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- proposals

function Proposals({ protocolId, health, onChange }: { protocolId: string; health: Health | null; onChange: () => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [fw, setFw] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    setList(await api<any[]>(`/api/protocols/${protocolId}/proposals`));
    setFw(await api(`/api/protocols/${protocolId}/firewall`).catch((e: unknown) => ({ error: errorText(e) })));
  }, [protocolId]);
  useEffect(() => void load().catch((e: unknown) => setErr(errorText(e))), [load]);
  const refresh = useThrottled(() => void load().catch(() => {}), 2000);
  useLiveEvents((e) => {
    if (e.protocolId === protocolId && e.type === "proposal") refresh();
  });
  const act = (fn: () => Promise<unknown>) => async () => {
    setErr(null);
    try {
      await fn();
      await load();
      onChange();
    } catch (e) {
      setErr(msg(e));
    }
  };
  return (
    <div className="stack-lg">
      <div className="card panel">
        <h2 className="h-small">Proposal firewall</h2>
        {fw?.error ? (
          <p className="faint small">{fw.error}</p>
        ) : fw ? (
          <>
            <p className="muted small">{fw.explains}</p>
            <p className="small">
              Firewall account <span className="mono">{fw.firewallAccount}</span> · reject key {fw.keyLoaded ? "loaded" : "not loaded"}
            </p>
            <div className="row">
              {fw.demoSigning && health?.demo && (
                <button className="btn btn-sm btn-primary" onClick={act(() => api(`/api/protocols/${protocolId}/firewall/sign-demo`, { body: {} }))}>
                  Propose and approve with the sandbox council
                </button>
              )}
              <button className="btn btn-sm btn-secondary" onClick={act(() => api(`/api/protocols/${protocolId}/firewall/verify`, { body: {} }))}>
                Read back and verify
              </button>
            </div>
          </>
        ) : (
          <p className="faint small">Loading…</p>
        )}
      </div>
      {list && list.length === 0 && <p className="muted">No proposals checked yet.</p>}
      {list && list.length > 0 && (
        <div className="card list">
          {list.map((x) => (
            <div key={x.proposalId} className="list-row">
              <span>
                #{x.proposalId} {x.kindLabel} by <span className="mono">{x.proposer}</span>
                <br />
                <span className="faint small">{x.summary}</span>
                {x.violations?.map((v: string) => (
                  <span key={v} className="bad small">
                    <br />
                    {v}
                  </span>
                ))}
              </span>
              <span className="faint small">{ago(x.at)}</span>
              <span className={`pill tiny ${x.ok ? "pill-lime" : "pill-bad"}`}>{x.ok ? "within policy" : "breaks policy"}</span>
            </div>
          ))}
        </div>
      )}
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}

/** Whether this workspace may trigger automatic pauses: its claim must come from the guardian's own council. */
function CouncilLine({ claim }: { claim: AuthorityClaim }) {
  const c = claim.evidence.council;
  if (claim.method === "admin-token") return <p className="small">Automatic pause: allowed (operator workspace).</p>;
  if (!c) return <p className="small">Automatic pause: not yet allowed. It is checked against the guardian's council once the guardian is authorised.</p>;
  if (c.matches) return <p className="small ok">Automatic pause: allowed. {claim.evidence.account} is the guardian's council{c.council && c.council !== claim.evidence.account ? ` (a member of ${c.council})` : ""}.</p>;
  return (
    <p className="small">
      Automatic pause: not allowed for this workspace.{" "}
      {c.council ? `The guardian's council for this contract is ${c.council}, and ${claim.evidence.account} is not it or one of its approvers.` : "The contract is not registered with the guardian yet."} Monitoring and alerts still work.
    </p>
  );
}

// ------------------------------------------------- status page & authority

function StatusAndAuthority({ detail, view, onChange }: { detail: ProtocolDetail; view: DetectionView; onChange: () => void }) {
  const p = detail.protocol;
  const d = view.detection;
  const [err, setErr] = useState<string | null>(null);
  const [guardian, setGuardian] = useState<any>(null);
  useEffect(() => void api(`/api/protocols/${p.id}/guardian`).then(setGuardian).catch(() => {}), [p.id]);
  const act = (fn: () => Promise<unknown>) => async () => {
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(msg(e));
    }
  };
  return (
    <div className="stack-lg">
      <div className="card panel">
        <h2 className="h-small">Public status page</h2>
        <p className="muted small">Depositors see each check, its live values and the raw RPC read behind every number. Publishing an official page needs verified control of the contract.</p>
        {p.published ? (
          <p>
            Published: <Link to={`/status/${p.id}`}>/status/{p.id}</Link>
          </p>
        ) : (
          <p className="faint small">Not published.</p>
        )}
        <div className="row">
          <button className="btn btn-sm btn-primary" onClick={act(() => api(`/api/protocols/${p.id}/publish`, { body: { published: !p.published } }))}>
            {p.published ? "Unpublish" : "Publish status page"}
          </button>
        </div>
      </div>
      <div className="card panel">
        <h2 className="h-small">Your authority over this contract</h2>
        {view.claim ? (
          <>
            <p>
              {view.claim.evidence.detail} <span className={`pill tiny ${view.claim.status === "verified" ? "pill-lime" : "pill-bad"}`}>{view.claim.status}</span>
            </p>
            <p className="faint small">Method: {view.claim.method} · last verified {ago(view.claim.verifiedAt ?? undefined)}. Re-checked from chain state on sensitive actions and every 6 hours.</p>
            <CouncilLine claim={view.claim} />
            <button className="btn btn-sm btn-secondary" onClick={act(() => api(`/api/claims/${view.claim!.id}/reverify`, { body: {} }))}>
              Re-verify now
            </button>
          </>
        ) : (
          <p className="faint small">
            Not claimed. <Link to={`/c/${p.network}/${p.contractId}`}>Claim it</Link>.
          </p>
        )}
      </div>
      <div className="card panel">
        <h2 className="h-small">What Qorvex holds</h2>
        <p className="small">
          Guardian <span className="mono">{guardian?.guardianId ?? "not configured"}</span>
          {d.guardianRegistration && (
            <>
              {" "}
              · registered with adapter <b>{d.guardianRegistration.adapter}</b>, council <span className="mono">{d.guardianRegistration.council}</span>, scopes {d.guardianRegistration.scopes.join(", ")}
            </>
          )}
        </p>
        <p className="small">
          Watcher key: a function-call key on <span className="mono">{guardian?.watcherAccount ?? "—"}</span> limited to <span className="mono">guardian.pause</span>, with no deposit. It cannot unpause, change limits or move funds.
        </p>
      </div>
      <CanCannot level={d.level} />
      {err && <p className="auth-error">{err}</p>}
    </div>
  );
}
