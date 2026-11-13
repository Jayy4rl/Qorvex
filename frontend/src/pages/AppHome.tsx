import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import type { Protocol } from "@qorvex/shared";
import { api, me, signOut, type Me } from "../lib/api";
import { clearToken } from "../lib/session";
import { disconnectWallets, signInWithWallet } from "../lib/wallet";
import { useTitle } from "../lib/hooks";
import ContractPage from "./ContractPage";
import IncidentPage from "./IncidentPage";
import Simulations from "./Simulations";
import Overview from "./Overview";
import Relayers, { RelayerDetail } from "./Relayers";
import Team from "./Team";
import type { Health } from "@qorvex/shared";
import "../styles/auth.css";
import "../styles/app.css";
import { errorText } from "../lib/errors";
import { IconCode, IconEye, IconGauge, IconPulse, IconRelay, IconShield, IconUser } from "../components/icons";

/**
 * Signed-in app shell: workspace switcher, the workspace's contracts, and the
 * per-contract onboarding page. This is the onboarding flow of change request
 * §8, not the full operator console (which you will walk me through).
 */
export default function AppHome() {
  useTitle("Workspace");
  const [who, setWho] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    me()
      .then(setWho)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);

  if (error) return <p className="container page auth-error">We couldn’t load your account. {error}</p>;
  if (who === undefined) return <p className="container page faint">Loading…</p>;
  if (who === null) return <Navigate to="/sign-in" replace state={{ from: "/app" }} />;

  return (
    <section className="container page console">
      <Sidebar who={who} onChange={reload} />
      <div className="console-main">
        {who.warnings?.map((w) => (
          <p key={w} className="notice">
            {w}
          </p>
        ))}
        {!who.workspace ? (
          <CreateWorkspace onDone={reload} />
        ) : (
          <Routes>
          <Route index element={<Overview />} />
          <Route path="contracts" element={<Contracts who={who} />} />
          <Route path="relayers" element={<Relayers />} />
          <Route path="relayers/:id" element={<RelayerDetail />} />
          <Route path="team" element={<Team who={who} />} />
          <Route path="contracts/:id" element={<ContractPage />} />
          <Route path="incidents/:id" element={<IncidentPage />} />
          <Route path="simulations" element={<Simulations />} />
          </Routes>
        )}
      </div>
    </section>
  );
}

/** Console navigation: workspace at the top, sections, then account and sign-out. */
function Sidebar({ who, onChange }: { who: Me; onChange: () => void }) {
  const navigate = useNavigate();
  const [demo, setDemo] = useState(false);
  useEffect(() => void api<Health>("/api/health").then((h) => setDemo(h.demo)).catch(() => {}), []);
  const switchTo = async (id: string) => {
    await api("/api/workspaces/active", { body: { workspaceId: id } });
    onChange();
    navigate("/app");
  };
  const out = async () => {
    clearToken();
    await signOut();
    await disconnectWallets();
    navigate("/", { replace: true });
  };
  const account = who.kind === "admin" ? "Operator token" : (who.user?.email ?? who.nearAccounts.map((a) => a.accountId).join(", ")) || who.user?.name || "Signed in";
  return (
    <aside className="sidebar" aria-label="Console">
      <div className="sidebar-ws">
        <p className="faint tiny-label">Workspace</p>
        {who.workspaces.length > 1 ? (
          <select className="auth-input mono slim" value={who.workspace?.id ?? ""} onChange={(e) => switchTo(e.target.value)} aria-label="Switch workspace">
            {who.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="sidebar-ws-name">{who.workspace?.name ?? "No workspace yet"}</p>
        )}
        {who.workspace && <span className="pill tiny pill-outline-lime">{who.workspace.role}</span>}
      </div>
      {who.workspace && (
        <nav className="sidebar-nav">
          <NavItem to="/app" end icon={<IconGauge size={18} />}>
            Overview
          </NavItem>
          <NavItem to="/app/contracts" icon={<IconShield size={18} />}>
            Contracts
          </NavItem>
          <NavItem to="/app/relayers" icon={<IconRelay size={18} />}>
            Relayers
          </NavItem>
          <NavItem to="/app/team" icon={<IconUser size={18} />}>
            Team
          </NavItem>
          {demo && (
            <NavItem to="/app/simulations" icon={<IconPulse size={18} />}>
              Simulations
            </NavItem>
          )}
        </nav>
      )}
      <nav className="sidebar-nav sidebar-secondary">
        <NavItem to="/check" icon={<IconEye size={18} />}>
          Check a contract
        </NavItem>
        <NavItem to="/docs" icon={<IconCode size={18} />}>
          Docs
        </NavItem>
      </nav>
      <div className="sidebar-account">
        <p className="faint small mono" title={account}>
          {account}
        </p>
        <button className="btn btn-sm btn-secondary" onClick={out}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

function NavItem({ to, end, icon, children }: { to: string; end?: boolean; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `app-nav ${isActive ? "on" : ""}`}>
      {icon}
      <span>{children}</span>
    </NavLink>
  );
}

function CreateWorkspace({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/workspaces", { body: { name } });
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form className="card panel narrow stack" onSubmit={submit}>
      <h1 className="serif page-title">
        Name your <em>workspace</em>
      </h1>
      <p className="muted">A workspace is your team, DAO or company. It owns your contracts, rules, alerts and relayers. You can invite others later.</p>
      <input className="auth-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Protocol" minLength={2} maxLength={60} required />
      <button className="btn btn-primary">Create workspace</button>
      {error && <p className="auth-error">{error}</p>}
    </form>
  );
}

function Contracts({ who }: { who: Me }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [list, setList] = useState<Protocol[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = (location.state as { claim?: { network: string; contractId: string } } | null)?.claim;

  useEffect(() => {
    api<Protocol[]>("/api/protocols")
      .then(setList)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (pending) navigate(`/c/${pending.network}/${pending.contractId}`, { replace: true });
  }, [pending, navigate]);

  return (
    <div className="stack-lg">
      <div className="row-between">
        <h1 className="serif page-title">Contracts</h1>
        <Link to="/check" className="btn btn-primary">
          Add a contract
        </Link>
      </div>
      {error && <p className="auth-error">{error}</p>}
      {list && list.length === 0 && (
        <div className="card panel">
          <p>No contracts yet. Check one by its account id, then claim it with the account that controls it.</p>
        </div>
      )}
      {list && list.length > 0 && (
        <div className="card list">
          {list.map((p) => (
            <Link key={p.id} to={`/app/contracts/${p.id}`} className="list-row">
              <span className="mono">{p.contractId}</span>
              <span className="faint small">{p.network}</span>
              <span className={`pill tiny ${p.status === "protected" ? "pill-lime" : "pill-outline-lime"}`}>{p.status === "protected" ? "guardian authorised" : "watching only"}</span>
            </Link>
          ))}
        </div>
      )}
      {who.kind === "user" && <LinkedAccounts who={who} />}
    </div>
  );
}

function LinkedAccounts({ who }: { who: Me }) {
  const [msg, setMsg] = useState<string | null>(null);
  const link = async (network: "mainnet" | "testnet") => {
    setMsg(null);
    try {
      const r = await signInWithWallet(network, true);
      setMsg(`Linked ${r.accountId}. Reload to see it.`);
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  return (
    <div className="card panel">
      <h2 className="h-small">Your NEAR accounts</h2>
      <p className="muted small">Claims and approvals are signed with these. Link the owner or DAO-council account of each contract you protect.</p>
      <ul className="mono small">
        {who.nearAccounts.length ? who.nearAccounts.map((a) => <li key={`${a.network}:${a.accountId}`}>{a.accountId} <span className="faint">({a.network})</span></li>) : <li className="faint">none yet</li>}
      </ul>
      <div className="row">
        <button className="btn btn-sm btn-secondary" onClick={() => link("testnet")}>
          Link a testnet account
        </button>
        <button className="btn btn-sm btn-secondary" onClick={() => link("mainnet")}>
          Link a mainnet account
        </button>
      </div>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
