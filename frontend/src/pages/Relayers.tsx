import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { Budget, Decision, RelayerView } from "@qorvex/shared";
import { api } from "../lib/api";
import { errorText } from "../lib/errors";
import { useLiveEvents, useThrottled } from "../lib/live";
import { ago, nearToYocto, yoctoToNear } from "../lib/format";
import { useTitle } from "../lib/hooks";

/**
 * Relayers and gas sponsors (PRD P4/P5). Each relayer asks Qorvex before it
 * pays for anything; budgets set here are enforced on the server against one
 * shared spend history, and every decision is logged with its reason.
 */
export default function Relayers() {
  useTitle("Relayers");
  const [list, setList] = useState<RelayerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ relayer: RelayerView; token: string } | null>(null);
  const load = useCallback(() => {
    api<RelayerView[]>("/api/relayers")
      .then(setList)
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="stack-lg">
      <div>
        <h1 className="serif page-title">Relayers</h1>
        <p className="muted lede">A relayer or gas sponsor calls Qorvex before it pays for a sponsored action. Qorvex answers allow or refuse, with a reason, from the budgets you set here. All your relayer instances share one budget.</p>
      </div>
      {error && <p className="auth-error">{error}</p>}
      {created && <CreatedNotice relayer={created.relayer} token={created.token} onClose={() => setCreated(null)} />}
      <CreateRelayer
        onCreated={(r) => {
          setCreated(r);
          load();
        }}
      />
      {list && list.length === 0 && <p className="faint">No relayers yet.</p>}
      {list && list.length > 0 && (
        <div className="card list">
          {list.map((r) => (
            <Link key={r.id} to={`/app/relayers/${r.id}`} className="list-row">
              <span>
                <b>{r.name}</b>
                <br />
                <span className="faint small">
                  {r.budgets.length ? `${r.budgets.length} budget${r.budgets.length > 1 ? "s" : ""}` : "no budget yet: every request is refused"} · if Qorvex is unreachable: {r.failMode === "open" ? "allow small amounts" : "refuse"}
                </span>
              </span>
              <span className="faint small">updated {ago(r.updatedAt)}</span>
              <span className="pill tiny pill-outline-lime">Open</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateRelayer({ onCreated }: { onCreated: (r: { relayer: RelayerView; token: string }) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      onCreated(await api<{ relayer: RelayerView; token: string }>("/api/relayers", { body: { name, failMode: "closed" } }));
      setName("");
    } catch (x) {
      setErr(errorText(x));
    }
  };
  return (
    <form className="card panel row" onSubmit={submit}>
      <input className="auth-input grow" placeholder="Relayer name, e.g. Treasury gas sponsor" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      <button className="btn btn-primary">Add relayer</button>
      {err && <p className="auth-error small">{err}</p>}
    </form>
  );
}

function CreatedNotice({ relayer, token, onClose }: { relayer: RelayerView; token: string; onClose: () => void }) {
  const snippet = `npm install @qorvex/relayer-sdk

import { Qorvex } from "@qorvex/relayer-sdk";

const qorvex = new Qorvex({
  url: "${window.location.origin}",
  relayerId: "${relayer.id}",
  token: process.env.QORVEX_RELAYER_TOKEN!,
});

const d = await qorvex.check({ beneficiary, action: "storage_deposit", cost: depositYocto, receiver });
if (!d.allow) return refuse(d.reason);`;
  return (
    <div className="card panel notice-ok">
      <h2 className="h-small">“{relayer.name}” is ready</h2>
      <p className="small">
        Its token is shown <b>only once</b>. Store it as <code className="mono">QORVEX_RELAYER_TOKEN</code> in your relayer's secrets:
      </p>
      <pre className="code-pre">{token}</pre>
      <p className="small">Then ask Qorvex before each sponsored action:</p>
      <pre className="code-pre">{snippet}</pre>
      <p className="faint small">Next, set its budget: until then every request is refused.</p>
      <div className="row">
        <Link className="btn btn-sm btn-primary" to={`/app/relayers/${relayer.id}`}>
          Set the budget
        </Link>
        <button className="btn btn-sm btn-secondary" onClick={onClose}>
          I've stored the token
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- detail

interface BudgetForm {
  beneficiary: string;
  windowHours: string;
  maxNear: string;
  counts: string; // "storage_deposit=10, add_proposal=5"
  receivers: string; // comma-separated
}

const toForm = (b: Budget): BudgetForm => ({
  beneficiary: b.beneficiary,
  windowHours: String(b.window_sec / 3600),
  maxNear: yoctoToNear(b.max_cost_yocto),
  counts: Object.entries(b.max_count ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", "),
  receivers: (b.allowed_receivers ?? []).join(", "),
});

function fromForm(f: BudgetForm, i: number): Budget {
  const hours = Number(f.windowHours);
  if (!f.beneficiary.trim()) throw new Error(`Budget ${i + 1}: enter who it applies to (an account, or * for everyone).`);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) throw new Error(`Budget ${i + 1}: the window must be between a few minutes and 30 days.`);
  const b: Budget = { beneficiary: f.beneficiary.trim(), window_sec: Math.max(1, Math.round(hours * 3600)) };
  if (f.maxNear.trim()) {
    try {
      b.max_cost_yocto = nearToYocto(f.maxNear);
    } catch {
      throw new Error(`Budget ${i + 1}: "${f.maxNear}" isn't a NEAR amount.`);
    }
  }
  if (f.counts.trim()) {
    b.max_count = {};
    for (const part of f.counts.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [action, n] = part.split("=").map((s) => s.trim());
      if (!action || !/^\d+$/.test(n ?? "")) throw new Error(`Budget ${i + 1}: write limits as action=number, e.g. storage_deposit=10.`);
      b.max_count[action] = Number(n);
    }
  }
  const receivers = f.receivers.split(",").map((s) => s.trim()).filter(Boolean);
  if (receivers.length) b.allowed_receivers = receivers;
  return b;
}

export function RelayerDetail() {
  const { id } = useParams();
  const [relayer, setRelayer] = useState<RelayerView | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [error, setError] = useState<string | null>(null);
  useTitle(relayer ? `${relayer.name} · Relayer` : "Relayer");
  const load = useCallback(async () => {
    try {
      const r = await api<{ relayer: RelayerView; decisions: Decision[] }>(`/api/relayers/${id}/admin`);
      setRelayer(r.relayer);
      setDecisions(r.decisions);
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  const refresh = useThrottled(() => void load(), 3000);
  useLiveEvents((e) => {
    if (e.relayerId === id) refresh();
  });

  if (error && !relayer) return <p className="auth-error">{error}</p>;
  if (!relayer) return <p className="faint">Loading…</p>;
  return (
    <div className="stack-lg">
      <div>
        <p className="faint small">
          <Link to="/app/relayers">Relayers</Link> /
        </p>
        <h1 className="serif page-title">{relayer.name}</h1>
        <p className="faint small mono">{relayer.id}</p>
      </div>
      <Budgets relayer={relayer} onSaved={setRelayer} />
      {relayer.proposalPolicy && (
        <div className="card panel">
          <h2 className="h-small">Proposal policy</h2>
          <p className="muted small">Before sponsoring an approval vote on a DAO proposal, the relayer checks the proposal against this policy.</p>
          <p className="small">{relayer.proposalPolicy.explain}</p>
        </div>
      )}
      <DecisionLog decisions={decisions} />
    </div>
  );
}

function Budgets({ relayer, onSaved }: { relayer: RelayerView; onSaved: (r: RelayerView) => void }) {
  const [rows, setRows] = useState<BudgetForm[]>(() => relayer.budgets.map(toForm));
  const [failMode, setFailMode] = useState(relayer.failMode);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(relayer.budgets.map(toForm)), [relayer.budgets]);
  const set = (i: number, k: keyof BudgetForm, v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    setMsg(null);
    let budgets: Budget[];
    try {
      budgets = rows.map(fromForm);
    } catch (e) {
      return setMsg({ ok: false, text: (e as Error).message });
    }
    setBusy(true);
    try {
      const r = await api<{ relayer: RelayerView }>(`/api/relayers/${relayer.id}/budgets`, { method: "PUT", body: { budgets, failMode } });
      onSaved(r.relayer);
      setMsg({ ok: true, text: "Saved. Relayers use the new budget on their next request." });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const template = async () => {
    setMsg(null);
    try {
      const r = await api<{ relayer: RelayerView }>(`/api/relayers/${relayer.id}/template`, { method: "PUT", body: { dailyNear: "1", storageDeposits: 10 } });
      onSaved(r.relayer);
      setMsg({ ok: true, text: "Applied the gas-sponsor budget: at most 1 NEAR and 10 storage deposits per beneficiary per day. Adjust it below." });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  return (
    <div className="card panel">
      <div className="row-between">
        <h2 className="h-small">Budgets</h2>
        <button className="btn btn-sm btn-secondary" onClick={template}>
          Use the gas-sponsor template
        </button>
      </div>
      <p className="muted small">
        A budget applies to one beneficiary, or to everyone with <span className="mono">*</span>. Within its window it caps the NEAR spent and the number of each action. A request no budget covers is refused.
      </p>
      {rows.length === 0 && <p className="faint small">No budget: every request is refused.</p>}
      {rows.map((r, i) => (
        <div key={i} className="budget">
          <label className="auth-label mono">
            Applies to
            <input className="auth-input mono" value={r.beneficiary} onChange={(e) => set(i, "beneficiary", e.target.value)} placeholder="* or dao.sputnik-dao.near" />
          </label>
          <label className="auth-label mono">
            Window (hours)
            <input className="auth-input mono" value={r.windowHours} onChange={(e) => set(i, "windowHours", e.target.value)} inputMode="decimal" />
          </label>
          <label className="auth-label mono">
            Max NEAR in the window
            <input className="auth-input mono" value={r.maxNear} onChange={(e) => set(i, "maxNear", e.target.value)} placeholder="e.g. 1.5 (empty: no cap)" inputMode="decimal" />
          </label>
          <label className="auth-label mono">
            Max count per action
            <input className="auth-input mono" value={r.counts} onChange={(e) => set(i, "counts", e.target.value)} placeholder="storage_deposit=10" />
          </label>
          <label className="auth-label mono wide">
            Only pay into these contracts
            <input className="auth-input mono" value={r.receivers} onChange={(e) => set(i, "receivers", e.target.value)} placeholder="empty: any contract · usdc.near, wrap.near" />
          </label>
          <button className="text-link small" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
            Remove this budget
          </button>
        </div>
      ))}
      <div className="row">
        <button className="btn btn-sm btn-secondary" onClick={() => setRows((rs) => [...rs, { beneficiary: "*", windowHours: "24", maxNear: "1", counts: "", receivers: "" }])}>
          + Add a budget
        </button>
      </div>
      <label className="auth-label mono">
        If your relayer can't reach Qorvex
        <select className="auth-input mono" value={failMode} onChange={(e) => setFailMode(e.target.value as "open" | "closed")}>
          <option value="closed">Refuse (safest)</option>
          <option value="open">Allow, using the last known budget</option>
        </select>
      </label>
      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save budgets"}
        </button>
      </div>
      {msg && <p className={msg.ok ? "small ok" : "auth-error small"}>{msg.text}</p>}
    </div>
  );
}

function DecisionLog({ decisions }: { decisions: Decision[] }) {
  const [filter, setFilter] = useState("");
  const [onlyRefused, setOnlyRefused] = useState(false);
  const [limit, setLimit] = useState(50);
  const shown = useMemo(() => decisions.filter((d) => (!onlyRefused || !d.allow) && (!filter || d.beneficiary.includes(filter))), [decisions, filter, onlyRefused]);
  const refused = decisions.filter((d) => !d.allow).length;
  return (
    <div className="card panel">
      <div className="row-between">
        <h2 className="h-small">Decisions</h2>
        <span className="faint small">
          {decisions.length} logged · {refused} refused
        </span>
      </div>
      <div className="row">
        <input className="auth-input mono grow" placeholder="Filter by beneficiary" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="small row">
          <input type="checkbox" checked={onlyRefused} onChange={(e) => setOnlyRefused(e.target.checked)} /> Refused only
        </label>
      </div>
      {shown.length === 0 && <p className="faint small">No decisions{decisions.length ? " match" : " yet. They appear here as your relayer calls check()"}.</p>}
      <ul className="decisions">
        {shown.slice(0, limit).map((d) => (
          <li key={d.id} className={d.allow ? "" : "refused"}>
            <span className={`pill tiny ${d.allow ? "pill-lime" : "pill-bad"}`}>{d.allow ? "Allowed" : "Refused"}</span>
            <span className="mono small">{d.action}</span>
            <span className="mono small">{d.beneficiary}</span>
            <span className="mono small">{yoctoToNear(d.cost) || "0"} NEAR</span>
            <span className="faint small">{ago(d.at)}</span>
            <span className="small decision-reason">{d.reason}</span>
          </li>
        ))}
      </ul>
      {shown.length > limit && (
        <button className="btn btn-sm btn-secondary" onClick={() => setLimit((n) => n + 100)}>
          Show {Math.min(100, shown.length - limit)} more
        </button>
      )}
    </div>
  );
}
