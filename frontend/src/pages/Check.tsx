import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { PROTECTION_LEVELS, type ContractCheck, type NetworkId } from "@qorvex/shared";
import { api, me } from "../lib/api";
import { withStepUp } from "../lib/wallet";
import { useTitle } from "../lib/hooks";
import "../styles/app.css";
import { errorText } from "../lib/errors";

/**
 * Start with only a contract id (friction item 2): no account needed to see
 * what Qorvex would watch, how it could pause, and which rules fit. Claiming
 * (and everything after) needs a sign-in and a signature from the account
 * that controls the contract.
 */
export default function Check() {
  const params = useParams();
  const navigate = useNavigate();
  const [network, setNetwork] = useState<NetworkId>((params.network as NetworkId) ?? "testnet");
  const [contractId, setContractId] = useState(params.contractId ?? "");
  const [result, setResult] = useState<ContractCheck | null>(null);
  const [networks, setNetworks] = useState<string[]>(["testnet", "mainnet"]);
  useEffect(() => void api<{ networks: string[] }>("/api/health").then((h) => h.networks.includes("sandbox") && setNetworks(["testnet", "mainnet", "sandbox"])).catch(() => {}), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useTitle(params.contractId ? `${params.contractId} · Check` : "Check a contract");

  const load = async (n: NetworkId, c: string, fresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setResult(fresh ? await api<ContractCheck>("/api/public/check", { body: { network: n, contractId: c } }) : await api<ContractCheck>(`/api/public/contracts/${n}/${c}`));
    } catch (e) {
      setResult(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (params.network && params.contractId) void load(params.network as NetworkId, params.contractId, false);
  }, [params.network, params.contractId]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = contractId.trim().toLowerCase();
    if (!c) return;
    navigate(`/c/${network}/${c}`);
    void load(network, c, true);
  };

  return (
    <section className="container page" aria-labelledby="check-title">
      <p className="eyebrow">No account needed</p>
      <h1 id="check-title" className="serif page-title">
        Check a <em>contract</em>
      </h1>
      <p className="muted lede">Paste a NEAR contract id. Qorvex reads the chain (read-only) and tells you what it can watch, whether it can pause, and what you would sign to let it.</p>
      <form className="check-form" onSubmit={submit}>
        <select className="auth-input mono" value={network} onChange={(e) => setNetwork(e.target.value as NetworkId)} aria-label="Network">
          {networks.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <input className="auth-input mono" placeholder="e.g. wrap.testnet" value={contractId} onChange={(e) => setContractId(e.target.value)} aria-label="Contract id" spellCheck={false} autoCapitalize="off" />
        <button className="btn btn-primary" disabled={busy || !contractId.trim()}>
          {busy ? "Reading the chain…" : "Check"}
        </button>
      </form>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {result && <CheckResult r={result} onRefresh={() => load(result.detection.network, result.detection.contractId, true)} />}
    </section>
  );
}

export function LevelBadge({ level }: { level: 0 | 1 | 2 | 3 }) {
  return <span className={`pill ${level >= 2 ? "pill-lime" : level === 1 ? "pill-warn" : "pill-outline-lime"}`}>{`Level ${level} · ${PROTECTION_LEVELS[level].name}`}</span>;
}

function CheckResult({ r, onRefresh }: { r: ContractCheck; onRefresh: () => void }) {
  const d = r.detection;
  const navigate = useNavigate();
  const [claimError, setClaimError] = useState<{ msg: string; hint?: string } | null>(null);
  const [claiming, setClaiming] = useState(false);
  const target = PROTECTION_LEVELS[d.recommended.level];

  const claim = async () => {
    setClaimError(null);
    const who = await me().catch(() => null);
    if (!who) return navigate("/sign-in", { state: { from: `/c/${d.network}/${d.contractId}` } });
    if (!who.workspace) return navigate("/app", { state: { claim: { network: d.network, contractId: d.contractId } } });
    if (d.network === "sandbox" && who.kind !== "admin") return setClaimError({ msg: "Wallets can't sign for the local demo network. Sign in with the operator token to claim demo contracts." });
    setClaiming(true);
    try {
      const out = await withStepUp(d.network, (headers) => api<{ protocolId: string }>("/api/claims", { body: { network: d.network, contractId: d.contractId }, headers }));
      navigate(`/app/contracts/${out.protocolId}`);
    } catch (e) {
      setClaimError({ msg: errorText(e) });
    } finally {
      setClaiming(false);
    }
  };

  if (!d.hasContract) return <div className="card panel">No contract is deployed on {d.contractId} ({d.network}).</div>;
  return (
    <div className="check-grid">
      <div className="card panel">
        <div className="row-between">
          <h2 className="mono h-contract">{d.contractId}</h2>
          <LevelBadge level={d.level} />
        </div>
        <p className="faint mono small">
          {d.network} · {d.kind} · code {d.codeHash?.slice(0, 10)}… · checked {new Date(d.at).toLocaleTimeString()}{" "}
          <button className="text-link" onClick={onRefresh}>
            re-check
          </button>
        </p>
        {d.owner && (
          <p>
            Controlled by <code className="mono">{d.owner.accountId}</code> {d.owner.isDao ? `(a Sputnik DAO, ${d.owner.council.length} council members)` : ""} <span className="faint">· read from {d.owner.via}</span>
          </p>
        )}
        <h3 className="h-small">Recommended: level {d.recommended.level}, {target.name}</h3>
        <p className="muted">{d.recommended.explain}</p>
        <div className="cando">
          <div>
            <p className="mono small ok">Qorvex can</p>
            <ul>{target.can.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
          <div>
            <p className="mono small bad">Qorvex cannot</p>
            <ul>{target.cannot.map((c) => <li key={c}>{c}</li>)}</ul>
          </div>
        </div>
        {r.claimed ? (
          <p className="muted">A workspace has already verified control of this contract.{r.statusPageId && <> Its public status data: <a href={`/api/status/${r.statusPageId}`}>/api/status/{r.statusPageId}</a>.</>}</p>
        ) : (
          <div className="stack">
            <button className="btn btn-primary" onClick={claim} disabled={claiming}>
              {claiming ? "Waiting for the wallet…" : "I control this contract: claim and protect it"}
            </button>
            <p className="faint small">
              You sign a one-time message with {d.owner?.isDao ? "a council member's account" : d.owner ? <code className="mono">{d.owner.accountId}</code> : "the account that controls the contract"}. Free, nothing on-chain.
            </p>
          </div>
        )}
        {claimError && (
          <p className="auth-error" role="alert">
            {claimError.msg}
            {claimError.hint && <><br />{claimError.hint}</>}
          </p>
        )}
      </div>
      <div className="card panel">
        <h3 className="h-small">Rules that fit</h3>
        {r.templates.map((t) => (
          <div key={t.id} className="tpl">
            <p className="tpl-title">{t.title}</p>
            <p className="muted small">{t.explain}</p>
            <p className="faint small">Why: {t.because}</p>
          </div>
        ))}
        <details className="probes">
          <summary className="mono small">How we know ({d.probes.length} read-only probes)</summary>
          <ul className="mono small">
            {d.probes.map((p, i) => (
              <li key={i}>
                <span className={`dot ${p.ok ? "dot-ok" : "dot-warn"}`} /> {p.name} {p.ok && p.value !== undefined ? <span className="faint">→ {JSON.stringify(p.value).slice(0, 120)}</span> : <span className="faint">→ not available</span>}{" "}
                <span className="pill pill-outline-lime tiny">{p.source}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
