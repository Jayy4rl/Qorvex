// Public status page (S1) and raw-read evidence page (S2).
const root = document.getElementById("root");
const meta = document.getElementById("meta");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (s) => {
  try { return BigInt(s).toLocaleString("en-US"); } catch { return esc(s); }
};
const ago = (iso) => {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

const [, kind, id] = location.pathname.split("/");
if (kind === "evidence") renderEvidence(id);
else renderStatus(id);

async function renderEvidence(readId) {
  const r = await fetch(`/api/reads/${readId}`);
  if (!r.ok) {
    root.innerHTML = `<div class="panel">This read is not available (it may have rotated out of the evidence store).</div>`;
    return;
  }
  const x = await r.json();
  meta.textContent = `raw RPC read ${readId}`;
  let resultText = "";
  try {
    resultText = new TextDecoder().decode(new Uint8Array(x.raw.response.result.result));
  } catch { /* not a call_function read */ }
  root.innerHTML = `
    <div class="panel">
      <h2>${esc(x.label)}: ${esc(x.contract)}.${esc(x.view)}(${esc(JSON.stringify(x.args))})</h2>
      <div class="kv">
        <div>Value</div><div class="mono">${fmt(x.value)}</div>
        <div>Block height</div><div class="mono">${esc(x.blockHeight)}</div>
        <div>Provider</div><div class="mono">${esc(x.raw.provider)}</div>
        <div>Decoded result</div><div class="mono">${esc(resultText)}</div>
      </div>
      <h3>Reproduce it yourself</h3>
      <p class="small muted">The request is pinned to the same block, so anyone with access to an archival or recent-state RPC gets the same answer. <code>args_base64</code> is the base64 of the JSON args; <code>result</code> in the response is the UTF-8 bytes of the returned JSON.</p>
      <pre id="curl">${esc(x.raw.curl)}</pre>
      <button id="copy">Copy curl</button>
      <h3>Exact request</h3><pre>${esc(JSON.stringify(x.raw.request, null, 2))}</pre>
      <h3>Raw response</h3><pre>${esc(JSON.stringify(x.raw.response, null, 2))}</pre>
    </div>`;
  document.getElementById("copy").onclick = () => navigator.clipboard.writeText(x.raw.curl);
}

async function renderStatus(pid) {
  const load = async () => {
    const r = await fetch(`/api/status/${pid}`);
    if (!r.ok) {
      root.innerHTML = `<div class="panel">No published status page with this id.</div>`;
      return;
    }
    draw(await r.json());
  };
  await load();
  const es = new EventSource("/api/events");
  let t = null;
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.protocolId === pid) {
      clearTimeout(t);
      t = setTimeout(load, 300);
    }
  };
  setInterval(load, 15000);
}

function draw(s) {
  const p = s.protocol;
  document.title = `${p.name} · Qorvex status`;
  meta.textContent = `${p.contractId} on ${p.network}${s.watcher ? ` · watcher at block ${s.watcher.lastBlock}` : ""}`;
  const failing = s.checks.filter((c) => c.evaluation && !c.evaluation.ok && c.type !== "proposal_policy");
  const lastPause = s.breaches.find((b) => b.pause && b.pause.status === "landed");
  let banner;
  if (s.paused === true) {
    const ph = s.pauseHistory?.at?.(-1);
    banner = `<div class="banner bad">Paused${lastPause ? ` at block ${lastPause.pause.pausedAtBlock}` : ph ? ` at block ${ph.block_height}` : ""}<div class="sub">Outflows are stopped. Unpausing is up to the protocol's owner or DAO.</div></div>`;
  } else if (failing.length) {
    banner = `<div class="banner bad">${failing.length} check${failing.length > 1 ? "s" : ""} failing<div class="sub">${esc(failing.map((c) => c.explain).join(" · "))}</div></div>`;
  } else if (s.checks.length === 0) {
    banner = `<div class="banner warn">No approved checks yet</div>`;
  } else {
    banner = `<div class="banner ok">All ${s.checks.length} checks passing${s.paused === false ? " · not paused" : ""}</div>`;
  }
  const unofficial = p.unofficial
    ? `<div class="banner warn" style="font-size:14px">Unofficial page built by Qorvex from public on-chain data. Read-only: Qorvex holds no pause key for this contract. Not affiliated with the protocol.</div>`
    : "";

  const checks = s.checks
    .map((c) => {
      const ev = c.evaluation;
      let values = `<span class="muted">waiting for the first evaluation</span>`;
      if (ev && c.type === "solvency") {
        const link = (label) => {
          const r = ev.reads.find((x) => x.label === label);
          return r ? `<a href="/evidence/${r.id}" title="${esc(r.contract)}.${esc(r.view)} at block ${ev.blockHeight}">${fmt(r.value)}</a>` : "?";
        };
        values = `owed ${link("owed")} · held ${link("held")} · margin ${ev.marginBps === null ? "n/a" : (ev.marginBps / 100).toFixed(2) + "%"} <span class="muted small">(block ${ev.blockHeight}, ${ago(ev.at)})</span>`;
      } else if (ev && c.type === "proposal_policy") {
        values = `last proposal checked: #${ev.proposalId} — ${esc(ev.summary)} → ${ev.ok ? "within policy" : esc(ev.violations.join("; "))}`;
      } else if (ev) {
        values = `${fmt(ev.total)} out in the last ${ev.windowSec}s (max ${fmt(ev.max)}) · ${ev.count} transfers <span class="muted small">(block ${ev.blockHeight})</span>`;
      }
      const bt = c.backtest && c.type === "proposal_policy"
        ? `Backtest: would have flagged ${c.backtest.fires} of the DAO's ${c.backtest.samples} past proposals.`
        : c.backtest
        ? `Backtest: fired ${c.backtest.fires} time${c.backtest.fires === 1 ? "" : "s"} over ${c.backtest.samples} samples (${c.backtest.days} days). <span class="muted">${esc(c.backtest.method)}</span>`
        : "No backtest recorded.";
      return `<div class="rule">
        <div class="row"><span class="chip ${ev ? (ev.ok || c.type === "proposal_policy" ? "ok" : "bad") : ""}">${c.type === "proposal_policy" ? "active" : ev ? (ev.ok ? "passing" : "FAILING") : "pending"}</span><span class="sentence">${esc(c.explain)}</span><span class="chip">${c.response === "pause" ? "auto-pause" : c.response === "reject" ? "auto-reject proposals" : "alert only"}</span></div>
        <div class="small" style="margin:6px 0">${values}</div>
        <div class="small muted">Last passed: ${c.lastPassed ? `block ${c.lastPassed.blockHeight} (${ago(c.lastPassed.at)})` : "never"}</div>
        <div class="small muted">${bt}</div>
        <details><summary>Exact rule</summary><pre>${esc(JSON.stringify(c.rule, null, 2))}</pre></details>
      </div>`;
    })
    .join("");

  const vetoes = s.breaches
    .filter((b) => b.evaluation.type === "proposal")
    .map((b) => {
      const v = b.vote || {};
      return `<tr><td>#${b.evaluation.proposalId}</td><td>${esc(b.evaluation.proposer)}</td><td>${esc(b.evaluation.summary)}</td><td>${esc(b.evaluation.violations.join("; "))}</td><td>${v.status === "landed" ? `rejected at block ${v.votedAtBlock} (+${v.blocksAfterProposal} blocks)` : esc(v.error ?? v.status ?? "")}</td></tr>`;
    })
    .join("");
  const proposals = (s.proposals ?? [])
    .map((x) => `<tr><td>#${x.id}</td><td>${esc(x.proposer)}</td><td>${esc(x.summary)}</td><td><span class="chip ${x.ok ? "ok" : "bad"}">${x.ok ? "within policy" : "breaks policy"}</span></td></tr>`)
    .join("");
  const incidents = s.breaches
    .filter((b) => b.evaluation.type !== "proposal")
    .map((b) => {
      const pz = b.pause || {};
      const t = pz.status === "landed" ? `${pz.blocksAfterBreach} blocks (${(pz.msAfterDetection / 1000).toFixed(1)} s)` : pz.status === "skipped" ? esc(pz.error) : esc(pz.status);
      return `<div class="rule">
        <div class="sentence">${esc(b.explain)}</div>
        <div class="compare">
          <div><div class="muted small">Qorvex: breach to pause</div><div class="big">${pz.status === "landed" ? `${pz.blocksAfterBreach} blocks` : "–"}</div><div class="small">${t}</div></div>
          <div><div class="muted small">NEAR Intents exploit, Sep 29 to Oct 1 2026</div><div class="big">~40 hours</div><div class="small">unnoticed, then 29 minutes to pause</div></div>
        </div>
        <div class="kv small" style="margin-top:10px">
          <div>Broke at block</div><div>${esc(b.triggerBlock)}</div>
          <div>Values</div><div>${b.evaluation.type === "solvency" ? `owed ${fmt(b.evaluation.owed)} > held ${fmt(b.evaluation.held)} (gap ${fmt((BigInt(b.evaluation.owed) - BigInt(b.evaluation.held)).toString())})` : `outflow ${fmt(b.evaluation.total)} > ${fmt(b.evaluation.max)}`}</div>
          <div>Pause tx</div><div class="mono">${esc(pz.txHash ?? "–")}</div>
          <div>Evidence hash</div><div class="mono">${esc(b.evidenceHash)}</div>
          <div>Receipts</div><div class="mono">${b.triggerReceipts.slice(0, 6).map((r) => esc(`${r.predecessor} → ${r.receiver}${r.method ? "." + r.method : ""}`)).join("<br>")}</div>
        </div>
        ${b.explanation ? `<h3>Explanation (${esc(b.explanation.model)}, written after the pause)</h3><pre>${esc(b.explanation.text)}</pre>` : ""}
      </div>`;
    })
    .join("");

  const history = (s.pauseHistory ?? [])
    .map((h) => `<tr><td>${esc(h.block_height)}</td><td>${esc(h.rule_id)}</td><td class="mono">${esc(h.evidence_hash.slice(0, 20))}…</td><td>${esc(h.watcher)}</td><td>${esc(h.status)}</td></tr>`)
    .join("");

  root.innerHTML = `
    ${unofficial}
    ${banner}
    <div class="panel"><h2>${esc(p.name)}</h2>
      <div class="kv small">
        <div>Contract</div><div class="mono">${esc(p.contractId)} (${esc(p.network)})</div>
        <div>Guardian</div><div class="mono">${esc(p.guardianId ?? "none (read-only)")}</div>
        <div>Pause state</div><div>${s.paused === null ? "contract has no is_paused view" : s.paused ? "paused" : "not paused"}${s.pausedRead ? ` · <span class="muted">${esc(s.pausedRead.provider)}</span>` : ""}</div>
      </div>
    </div>
    <div class="panel"><h2>Checks</h2>${checks || '<p class="muted">No approved checks.</p>'}
      <p class="small muted">${esc(s.scope)} Click any number to see the exact RPC request and raw response behind it.</p></div>
    ${incidents ? `<div class="panel"><h2>Incidents</h2>${incidents}</div>` : ""}
    ${p.kind === "dao" ? `<div class="panel"><h2>Proposal firewall</h2>
      <p class="small muted">${s.firewall?.ok ? "Qorvex is a member of this DAO in a role that can only vote to reject transfer and function-call proposals; one such vote rejects a proposal. It cannot approve anything; the DAO can remove the role with a policy proposal." : "The firewall role is not verified on this DAO; Qorvex can only alert."}</p>
      ${vetoes ? `<h3>Proposals Qorvex rejected</h3><table><tr><th>#</th><th>Proposer</th><th>What it would do</th><th>Why</th><th>Vote</th></tr>${vetoes}</table>` : '<p class="small muted">No proposals rejected.</p>'}
      ${proposals ? `<h3>Recent proposals checked</h3><table><tr><th>#</th><th>Proposer</th><th>What it does</th><th>Verdict</th></tr>${proposals}</table>` : ""}
    </div>` : ""}
    ${p.guardianId ? `<div class="panel"><h2>On-chain pause history</h2><p class="small muted">Read from <code>${esc(p.guardianId)}.pause_history</code>: every pause the guardian forwarded, with its rule and evidence hash.</p>${history ? `<table><tr><th>Block</th><th>Rule</th><th>Evidence</th><th>Watcher</th><th>Status</th></tr>${history}</table>` : '<p class="muted small">No pauses.</p>'}</div>` : ""}
  `;
}
