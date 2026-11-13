import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { Health, Protocol } from "@qorvex/shared";
import { api } from "../lib/api";
import { useLiveEvents, useThrottled } from "../lib/live";
import { amount } from "../lib/format";

interface DemoInfo {
  root: string;
  accounts: Record<string, string>;
  trapAccount: string;
  relayerId?: string;
  treasury?: string;
}
interface LedgerState {
  target: string;
  owed: string;
  held: string;
  paused: boolean;
  balances: { alice: string; mallory: string };
  guardianRegistration: unknown;
}
interface BreachRow {
  id: string;
  protocolId: string;
  contractId: string;
  explain: string;
  detectedAt: string;
  triggerBlock: number;
  pause?: { status: string; pausedAtBlock?: number; blocksAfterBreach?: number; msAfterDetection?: number; error?: string };
  vote?: { status: string; blocksAfterProposal?: number };
}
const USDC = { decimals: 6, symbol: "USDC" };

/**
 * Sandbox demo (local `npm run demo` only): replay the two incidents from the
 * PRD on contracts that carry the same bugs, and watch Qorvex contain them.
 * Every button runs a real transaction on the local nearcore sandbox.
 */
export default function Simulations() {
  const [health, setHealth] = useState<Health | null>(null);
  const [info, setInfo] = useState<DemoInfo | null>(null);
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [ledger, setLedger] = useState<LedgerState | null>(null);
  const [vault, setVault] = useState<LedgerState | null>(null);
  const [breaches, setBreaches] = useState<BreachRow[]>([]);
  const [log, setLog] = useState<{ at: string; text: string; bad?: boolean }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const A = info?.accounts;
  const loadState = useCallback(async () => {
    if (!A) return;
    const [l, v, b] = await Promise.all([
      api<LedgerState>("/api/demo/action/ledger-state", { body: { target: A.ledger } }),
      api<LedgerState>("/api/demo/action/ledger-state", { body: { target: A.vault } }),
      api<BreachRow[]>("/api/breaches"),
    ]);
    setLedger(l);
    setVault(v);
    setBreaches(b);
  }, [A]);
  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => {});
    api<DemoInfo>("/api/demo").then(setInfo).catch(() => {});
    api<Protocol[]>("/api/protocols").then(setProtocols).catch(() => {});
  }, []);
  useEffect(() => void loadState().catch(() => {}), [loadState]);
  const refresh = useThrottled(() => void loadState().catch(() => {}), 1500);
  useLiveEvents((e) => {
    if (e.type === "breach" || e.type === "evaluation" || e.type === "proposal") refresh();
  }, !!info);

  if (health && !health.demo) return <p className="muted">Simulations run only on the local sandbox demo (<code className="mono">npm run demo</code>).</p>;
  if (!info || !A) return <p className="faint">Loading the demo world…</p>;

  const say = (text: string, bad = false) => setLog((l) => [{ at: new Date().toLocaleTimeString(), text, bad }, ...l].slice(0, 40));
  const run = (label: string, fn: () => Promise<string>) => async () => {
    setBusy(label);
    try {
      say(await fn());
    } catch (e) {
      say(`${label}: ${(e as Error).message}`, true);
    } finally {
      setBusy(null);
      void loadState().catch(() => {});
    }
  };
  const act = (name: string, params: object) => api<any>(`/api/demo/action/${name}`, { body: params });
  const watched = (contract: string) => protocols.find((p) => p.contractId === contract);
  const latest = (contract: string) => breaches.find((b) => b.contractId === contract);
  const lb = latest(A.ledger);
  const vb = latest(A.vault);
  const daoB = latest(A.treasury);

  return (
    <div className="stack-lg">
      <div>
        <h1 className="serif page-title">
          Simulations <span className="pill pill-warn tiny">Simulated · local sandbox</span>
        </h1>
        <p className="muted lede">Replays of the two incidents in the PRD, on contracts with the same bugs. Each button sends a real transaction to the local nearcore sandbox; Qorvex reacts exactly as it would on mainnet.</p>
        {(!watched(A.ledger) || !watched(A.vault)) && (
          <p className="notice">
            Connect the ledger and vault first (Check a contract → sandbox → claim), approve a solvency rule as “alert + auto-pause” and authorise the guardian, or run <code className="mono">npm run demo -- --auto</code> once.
          </p>
        )}
      </div>

      <div className="check-grid">
        <div className="card panel">
          <h2 className="h-small">1 · NEAR Intents ghost balance, watcher-protected ledger</h2>
          <p className="muted small">
            The ledger credits a deposit before its notification settles and keeps the credit when the deposit is refunded: the Sep–Oct 2026 Intents bug that ran for 40 hours. Qorvex's solvency rule (owed ≤ held) should catch the first ghost credit and pause through the guardian.
          </p>
          <LedgerBox s={ledger} />
          <div className="row">
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("deposit", async () => ((await act("deposit", { target: A.ledger, amount: 1000 })).ok ? "Alice deposited 1,000 USDC: the books still balance." : "deposit failed"))}>
              Alice deposits 1,000
            </button>
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("withdraw", async () => { const r = await act("withdraw", { target: A.ledger, who: "alice", amount: 500 }); return r.ok ? "Alice withdrew 500 USDC." : `Alice's withdrawal was refused: ${r.error}`; })}>
              Alice withdraws 500
            </button>
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={run("ghost", async () => `Mallory's ghost deposit (40,000 USDC, failing notification) sent: ${(await api<{ txHash: string }>("/api/demo/ghost", { body: { target: A.ledger, amount: 40_000 } })).txHash}`)}>
              Run the exploit as Mallory
            </button>
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("cash out", async () => { const r = await act("withdraw", { target: A.ledger, who: "mallory", amount: 40_000 }); return r.ok ? "Mallory cashed out 40,000 USDC: the ledger was NOT paused in time." : `Mallory's withdrawal was rejected: ${r.error}`; })}>
              Mallory tries to cash out
            </button>
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("rearm", async () => `Recovered: ${(await act("rearm", {})).steps.join("; ")}.`)}>
              Recover and re-arm
            </button>
          </div>
          {lb && <Outcome b={lb} />}
        </div>

        <div className="card panel">
          <h2 className="h-small">2 · Same bug, vault with qorvex-guard</h2>
          <p className="muted small">The vault embeds the guard crate with self-accounting on. It should pause itself inside the ghost-deposit transaction, before the watcher even sees the block.</p>
          <LedgerBox s={vault} />
          <div className="row">
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={run("vault ghost", async () => `Ghost deposit into the vault sent: ${(await api<{ txHash: string }>("/api/demo/ghost", { body: { target: A.vault, amount: 40_000 } })).txHash}. Check “Paused” above.`)}>
              Run the exploit on the vault
            </button>
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("dao unpause", async () => { const r = await act("dao-unpause", { target: A.vault }); return `Treasury DAO proposal #${r.proposalId} approved: vault ${r.paused ? "still paused" : "unpaused"}.`; })}>
              DAO votes to unpause
            </button>
          </div>
          {vb && <Outcome b={vb} />}
        </div>
      </div>

      <div className="check-grid">
        <div className="card panel">
          <h2 className="h-small">3 · Trezu sponsor drain (issue #1871)</h2>
          <p className="muted small">An attacker's DAO asks the sponsor relayer to pay for 100 storage deposits into the attacker's own token. Without Qorvex the sponsor pays for all of them; with check() it stops at its budget.</p>
          <div className="row">
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("trezu open", async () => trezuLine("Without check()", await api("/api/demo/trezu", { body: { mode: "unguarded", receivers: 100 } })))}>
              Drain without check()
            </button>
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={run("trezu guarded", async () => trezuLine("With check()", await api("/api/demo/trezu", { body: { mode: "guarded", receivers: 100 } })))}>
              Drain with check()
            </button>
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("relay vote", async () => { const r = await act("relay-vote", { mode: "guarded" }); return `Relayed approval of the attacker's proposal #${r.proposal}: ${JSON.stringify(r).slice(0, 200)}`; })}>
              Relay the attacker's approval vote (guarded)
            </button>
          </div>
        </div>

        <div className="card panel">
          <h2 className="h-small">4 · Treasury DAO proposal firewall</h2>
          <p className="muted small">Proposals that break the treasury policy are voted down by Qorvex's reject-only role before the council can approve them. An ordinary invoice passes.</p>
          <div className="row">
            <button className="btn btn-sm btn-primary" disabled={!!busy} onClick={run("propose", async () => { const r = await act("propose", { kind: "big-transfer" }); return `Mallory proposed an over-cap transfer: proposal #${r.id}.`; })}>
              Over-cap transfer
            </button>
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("propose", async () => { const r = await act("propose", { kind: "drain-call" }); return `Mallory proposed a 200-action drain call: proposal #${r.id}.`; })}>
              200-action drain call
            </button>
            <button className="btn btn-sm btn-secondary" disabled={!!busy} onClick={run("propose", async () => { const r = await act("propose", { kind: "invoice" }); return `Alice proposed a normal invoice: proposal #${r.id}.`; })}>
              Normal invoice
            </button>
            <button
              className="btn btn-sm btn-secondary"
              disabled={!!busy}
              onClick={run("approve", async () => {
                const last = (await api<any[]>(`/api/protocols/${watched(A.treasury)?.id}/proposals`).catch(() => []))[0];
                if (!last) return "No proposal to approve yet.";
                const r = await act("council-approve", { id: last.proposalId });
                return r.error ? `Council approval of #${last.proposalId} failed: ${r.error}` : `Council approved #${last.proposalId}: status ${r.status}.`;
              })}
            >
              Council approves the last proposal
            </button>
          </div>
          {daoB && <Outcome b={daoB} />}
        </div>
      </div>

      <div className="card panel">
        <h2 className="h-small">Log</h2>
        {busy && <p className="small">Running “{busy}”…</p>}
        <ul className="mono small sim-log">
          {log.map((l, i) => (
            <li key={i} className={l.bad ? "bad" : ""}>
              {l.at} {l.text}
            </li>
          ))}
          {!log.length && <li className="faint">Nothing yet.</li>}
        </ul>
      </div>
    </div>
  );
}

function trezuLine(label: string, r: any): string {
  return `${label}: sponsored ${r.sponsored}, refused ${r.refused}; sponsor balance ${r.sponsorBalanceBefore} → ${r.sponsorBalanceAfter}${r.firstRefusal ? `; first refusal: ${r.firstRefusal}` : ""}`;
}

function LedgerBox({ s }: { s: LedgerState | null }) {
  if (!s) return <p className="faint small">Reading…</p>;
  const short = BigInt(s.owed) > BigInt(s.held);
  return (
    <div className="figures">
      <div>
        <p className="mono small faint">Owed to users</p>
        <p className={`figure mono ${short ? "bad" : ""}`}>{amount(s.owed, USDC)}</p>
      </div>
      <div>
        <p className="mono small faint">Held</p>
        <p className="figure mono">{amount(s.held, USDC)}</p>
      </div>
      <div>
        <p className="mono small faint">State</p>
        <p className={`figure mono ${s.paused ? "bad" : "ok"}`}>{s.paused ? "PAUSED" : "running"}</p>
      </div>
      <div>
        <p className="mono small faint">Mallory's balance</p>
        <p className="figure mono">{amount(s.balances.mallory, USDC)}</p>
      </div>
    </div>
  );
}

function Outcome({ b }: { b: BreachRow }) {
  return (
    <div className="outcome">
      {b.pause?.status === "landed" ? (
        <p>
          <b className="ok">Paused at block {b.pause.pausedAtBlock?.toLocaleString()}</b>, {b.pause.blocksAfterBreach} blocks after the breaking block{b.pause.msAfterDetection !== undefined ? ` (~${(b.pause.msAfterDetection / 1000).toFixed(1)} s after detection)` : ""}.{" "}
          <span className="faint">The Intents exploit ran for ~40 hours.</span>
        </p>
      ) : b.vote?.status === "landed" ? (
        <p>
          <b className="ok">Voted down</b> {b.vote.blocksAfterProposal} blocks after the proposal.
        </p>
      ) : (
        <p className="small">
          Latest incident: {b.explain} · pause {b.pause?.status ?? "—"}
          {b.pause?.error ? ` (${b.pause.error})` : ""}
        </p>
      )}
      <Link to={`/app/incidents/${b.id}`} className="small">
        Open the incident →
      </Link>
    </div>
  );
}
