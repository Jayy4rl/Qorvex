import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { AuthorityClaim, NetworkInfo, Protocol, StatusView } from "@qorvex/shared";
import { api } from "../lib/api";
import { errorText, pauseReason } from "../lib/errors";
import { useLiveEvents, useThrottled } from "../lib/live";
import { ago } from "../lib/format";
import { STALE_EVALUATION_MS, STALE_WATCHER_MS, VERDICT_CLASS, VERDICT_LABEL, type Verdict } from "../lib/verify";
import { useTitle } from "../lib/hooks";

interface IncidentRow {
  id: string;
  protocolId: string;
  contractId: string;
  network: string;
  explain: string;
  detectedAt: string;
  triggerBlock: number;
  response: string;
  pause?: { status: string; pausedAtBlock?: number; blocksAfterBreach?: number; error?: string };
  vote?: { status: string; blocksAfterProposal?: number };
}

interface Row {
  p: Protocol;
  status: StatusView | null;
  claim: AuthorityClaim | undefined;
  state: { verdict: Verdict; text: string };
}

/** At most this many contracts are read live on the overview (each read touches the chain). */
const LIVE_LIMIT = 15;

/**
 * Overview: the first screen after sign-in. Is anything paused or failing,
 * what needs setting up, and is monitoring itself reporting?
 */
export default function Overview() {
  useTitle("Overview");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [networks, setNetworks] = useState<NetworkInfo[]>([]);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [protocols, claims, nets, inc] = await Promise.all([
        api<Protocol[]>("/api/protocols"),
        api<AuthorityClaim[]>("/api/claims").catch(() => [] as AuthorityClaim[]),
        api<NetworkInfo[]>("/api/networks").catch(() => [] as NetworkInfo[]),
        api<IncidentRow[]>("/api/breaches").catch(() => [] as IncidentRow[]),
      ]);
      const statuses = await Promise.all(protocols.slice(0, LIVE_LIMIT).map((p) => api<StatusView>(`/api/protocols/${p.id}/status`).catch(() => null)));
      setRows(
        protocols.map((p, i) => {
          const status = statuses[i] ?? null;
          return { p, status, claim: claims.find((c) => c.network === p.network && c.contractId === p.contractId), state: contractState(status, i >= LIVE_LIMIT) };
        }),
      );
      setNetworks(nets);
      setIncidents(inc);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const refresh = useThrottled(() => void load(), 15_000);
  useLiveEvents((e) => {
    if (e.type === "breach" || e.type === "protocol" || e.type === "rules") refresh();
  });

  if (error && !rows) return <p className="auth-error">{error}</p>;
  if (!rows) return <p className="faint">Loading your contracts…</p>;

  const paused = rows.filter((r) => r.status?.paused === true).length;
  const failing = rows.reduce((n, r) => n + (r.status?.checks.filter((c) => c.evaluation && !c.evaluation.ok).length ?? 0), 0);
  const last24h = incidents.filter((i) => Date.now() - Date.parse(i.detectedAt) < 24 * 3600_000).length;
  const todo = rows.flatMap((r) => setupTodo(r));

  return (
    <div className="stack-lg">
      <div className="row-between">
        <h1 className="serif page-title">Overview</h1>
        <Link to="/check" className="btn btn-primary">
          Add a contract
        </Link>
      </div>

      <div className="stat-grid">
        <Stat label="Contracts" value={rows.length} />
        <Stat label="Failing checks" value={failing} tone={failing ? "bad" : undefined} />
        <Stat label="Paused" value={paused} tone={paused ? "warn" : undefined} />
        <Stat label="Incidents, last 24 h" value={last24h} tone={last24h ? "warn" : undefined} />
      </div>

      <div className="card panel">
        <h2 className="h-small">Monitoring</h2>
        {networks.length === 0 && <p className="faint small">No network is being monitored on this server.</p>}
        <ul className="summary">
          {networks.map((n) => {
            const age = n.progress ? Date.now() - Date.parse(n.progress.at) : Infinity;
            const verdict: Verdict = !n.progress ? "unknown" : age > STALE_WATCHER_MS ? "unavailable" : "confirmed";
            return (
              <li key={n.id} className="summary-row">
                <span className="summary-label">{n.id}</span>
                <span className={`pill tiny ${VERDICT_CLASS[verdict]}`}>{verdict === "confirmed" ? "Reporting" : verdict === "unavailable" ? "Behind" : "Not started"}</span>
                <span className="small">
                  {n.progress ? `Last block seen ${n.progress.lastBlock.toLocaleString()}, ${ago(n.progress.at)}.` : "No block seen yet."}{" "}
                  {n.guardianId ? (n.watcherKeyLoaded ? "Automatic pause can be sent." : "Automatic pause can't be sent: the pause key isn't set up on this server.") : "Automatic pause isn't set up for this network."}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="card list">
        <div className="list-row list-head">
          <span>Contract</span>
          <span>Network</span>
          <span>State</span>
        </div>
        {rows.length === 0 && (
          <div className="list-row">
            <span className="faint">No contracts yet. Add one from the contract check.</span>
          </div>
        )}
        {rows.map((r) => (
          <Link key={r.p.id} to={`/app/contracts/${r.p.id}`} className="list-row">
            <span>
              <span className="mono">{r.p.contractId}</span>
              <br />
              <span className="faint small">{r.state.text}</span>
            </span>
            <span className="faint small">{r.p.network}</span>
            <span className={`pill tiny ${r.status?.paused ? "pill-warn" : VERDICT_CLASS[r.state.verdict]}`}>{r.status?.paused ? "Paused" : VERDICT_LABEL[r.state.verdict]}</span>
          </Link>
        ))}
      </div>

      {todo.length > 0 && (
        <div className="card panel">
          <h2 className="h-small">To finish setting up</h2>
          <ul className="todo">
            {todo.map((t) => (
              <li key={t.key}>
                <Link to={t.to}>{t.text}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card panel">
        <h2 className="h-small">Recent incidents</h2>
        {incidents.length === 0 && <p className="faint small">No incidents.</p>}
        <ul className="rules">
          {incidents.slice(0, 8).map((i) => (
            <li key={i.id}>
              <Link to={`/app/incidents/${i.id}`}>{i.explain}</Link>
              <p className="faint small">
                <span className="mono">{i.contractId}</span> · block {i.triggerBlock.toLocaleString()} · {ago(i.detectedAt)} ·{" "}
                {i.pause?.status === "landed"
                  ? `paused ${i.pause.blocksAfterBreach} blocks later`
                  : i.vote?.status === "landed"
                    ? `proposal voted down ${i.vote.blocksAfterProposal} blocks later`
                    : i.response === "alert"
                      ? "alert only"
                      : i.vote
                        ? "alerted; no reject vote was needed or cast"
                        : `not paused: ${pauseReason(i.pause?.error, i.pause?.status)}`}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "bad" | "warn" }) {
  return (
    <div className={`card stat ${tone ? `stat-${tone}` : ""}`}>
      <p className="stat-value mono">{value}</p>
      <p className="faint small">{label}</p>
    </div>
  );
}

/** One line per contract, from evidence only (the same rules as the public status page). */
function contractState(s: StatusView | null, notRead: boolean): { verdict: Verdict; text: string } {
  if (notRead) return { verdict: "unknown", text: "Open the contract to read its state." };
  if (!s) return { verdict: "unavailable", text: "Its state could not be read just now." };
  if (s.paused) return { verdict: "failed", text: "Paused: outflows are stopped." };
  if (!s.checks.length) return { verdict: "absent", text: "No checks approved yet." };
  const failed = s.checks.filter((c) => c.evaluation && !c.evaluation.ok).length;
  if (failed) return { verdict: "failed", text: `${failed} check${failed > 1 ? "s" : ""} failing.` };
  const fresh = s.checks.filter((c) => c.evaluation && (c.type === "proposal_policy" || Date.now() - Date.parse(c.evaluation.at) < STALE_EVALUATION_MS)).length;
  if (fresh === s.checks.length) return { verdict: "confirmed", text: `${fresh} check${fresh > 1 ? "s" : ""} passing.` };
  return { verdict: "unknown", text: `${fresh} of ${s.checks.length} checks have recent evidence.` };
}

function setupTodo(r: Row): { key: string; text: string; to: string }[] {
  const out: { key: string; text: string; to: string }[] = [];
  const base = `/app/contracts/${r.p.id}`;
  if (!r.claim) out.push({ key: `${r.p.id}-claim`, text: `Prove you control ${r.p.contractId} (claim it)`, to: `/c/${r.p.network}/${r.p.contractId}` });
  else if (r.claim.status !== "verified") out.push({ key: `${r.p.id}-lapsed`, text: `Your control of ${r.p.contractId} is no longer verified: re-verify it`, to: `${base}?tab=status` });
  if (r.status && !r.status.checks.length) out.push({ key: `${r.p.id}-rules`, text: `Approve a rule for ${r.p.contractId}`, to: `${base}?tab=rules` });
  if (r.claim?.status === "verified" && r.claim.method !== "admin-token" && r.claim.evidence.council && !r.claim.evidence.council.matches)
    out.push({ key: `${r.p.id}-council`, text: `Automatic pause isn't allowed for ${r.p.contractId}: your account isn't the guardian's council`, to: `${base}?tab=status` });
  if (r.p.status !== "protected" && r.claim?.status === "verified") out.push({ key: `${r.p.id}-guardian`, text: `Authorise the guardian on ${r.p.contractId}`, to: `${base}?tab=setup` });
  return out;
}
