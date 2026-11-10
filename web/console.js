// Operator console: connect → draft (AI) → review/approve → authorise guardian → publish.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (s) => { try { return BigInt(s).toLocaleString("en-US"); } catch { return esc(s); } };
let token = "";
try { token = localStorage.getItem("qorvexToken") || ""; } catch {}
let selected = { kind: null, id: null };
let health = null;

function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast${err ? " err" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add("hidden"), err ? 9000 : 4000);
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { showLogin(); throw new Error("operator token rejected"); }
  if (!r.ok) {
    const e = new Error(j.error || `HTTP ${r.status}`);
    e.details = j.details;
    throw e;
  }
  return j;
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message + (e.details?.errors ? `: ${e.details.errors.join("; ")}` : ""), true); } finally { btn.disabled = false; }
}

function showLogin() { $("login").classList.remove("hidden"); $("app").classList.add("hidden"); $("logout").classList.add("hidden"); }
$("saveToken").onclick = () => { token = $("token").value.trim(); try { localStorage.setItem("qorvexToken", token); } catch {} start(); };
$("logout").onclick = () => { try { localStorage.removeItem("qorvexToken"); } catch {} token = ""; showLogin(); };

async function start() {
  health = await (await fetch("/api/health")).json();
  $("health").textContent = `networks: ${health.networks.join(", ")} · AI: ${health.ai.mode}${health.ai.live ? " (live)" : ""}, drafting ${health.ai.draftModel} · alerts: ${health.alerts.join(", ") || "none"}`;
  $("cNetwork").innerHTML = health.networks.map((n) => `<option>${n}</option>`).join("");
  if (!token) return showLogin();
  try { await refreshLists(); } catch { return; }
  $("login").classList.add("hidden"); $("app").classList.remove("hidden"); $("logout").classList.remove("hidden");
  if (health.demo) setupDemo();
  const es = new EventSource("/api/events");
  let t;
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    clearTimeout(t);
    t = setTimeout(() => {
      refreshLists().catch(() => {});
      if ((selected.kind === "protocol" && e.protocolId === selected.id) || (selected.kind === "relayer" && e.relayerId === selected.id)) renderDetail();
    }, 400);
  };
}

async function refreshLists() {
  const ps = await api("GET", "/api/protocols");
  $("protocols").innerHTML = ps.map((p) => `<li data-id="${p.id}" class="${selected.id === p.id ? "active" : ""}">${esc(p.name)}<br><span class="small muted">${esc(p.contractId)} · ${p.network}</span> <span class="chip ${p.status === "protected" ? "ok" : ""}">${p.status}</span>${p.published ? ' <span class="chip">public</span>' : ""}</li>`).join("") || '<li class="muted small">none yet</li>';
  for (const li of $("protocols").querySelectorAll("li[data-id]")) li.onclick = () => { selected = { kind: "protocol", id: li.dataset.id }; refreshLists(); renderDetail(); };
  const rs = await api("GET", "/api/relayers");
  $("relayers").innerHTML = rs.map((r) => `<li data-id="${r.id}" class="${selected.id === r.id ? "active" : ""}">${esc(r.name)}<br><span class="small muted">${r.budgets.length} budget(s) · fail ${r.failMode}</span></li>`).join("") || '<li class="muted small">none yet</li>';
  for (const li of $("relayers").querySelectorAll("li[data-id]")) li.onclick = () => { selected = { kind: "relayer", id: li.dataset.id }; refreshLists(); renderDetail(); };
}

$("connect").onclick = (ev) => busy(ev.target, async () => {
  const r = await api("POST", "/api/protocols", { network: $("cNetwork").value, contractId: $("cContract").value.trim(), name: $("cName").value.trim() });
  selected = { kind: "protocol", id: r.protocol.id };
  toast(r.needsUpload ? "Connected. No NEP-330 source link: upload the source before drafting." : `Connected. Source: ${r.nep330.link}`);
  await refreshLists(); renderDetail();
});

$("addRelayer").onclick = (ev) => busy(ev.target, async () => {
  const r = await api("POST", "/api/relayers", { name: $("rName").value.trim() || "relayer" });
  alert(`Relayer token (shown once):\n\n${r.token}\n\nSet it as QORVEX_RELAYER_TOKEN in the relayer.`);
  selected = { kind: "relayer", id: r.relayer.id };
  await refreshLists(); renderDetail();
});

function renderDetail() {
  if (selected.kind === "protocol") return renderProtocol(selected.id);
  if (selected.kind === "relayer") return renderRelayer(selected.id);
}

async function renderProtocol(id) {
  const v = await api("GET", `/api/protocols/${id}`);
  const p = v.protocol;
  const lastDraft = v.drafts.at(-1);
  const rules = v.rules.filter((x) => x.rule.status !== "rejected");
  const ruleHtml = rules.map(({ rule, evaluation, backtest, limits }) => {
    const live = evaluation ? (evaluation.type === "solvency"
      ? `owed ${fmt(evaluation.owed)} · held ${fmt(evaluation.held)} · margin ${evaluation.marginBps === null ? "n/a" : (evaluation.marginBps / 100).toFixed(2) + "%"} (block ${evaluation.blockHeight})`
      : evaluation.type === "proposal"
        ? `last proposal #${evaluation.proposalId}: ${esc(evaluation.summary)} → ${evaluation.ok ? "within policy" : esc(evaluation.violations.join("; "))}`
        : `${fmt(evaluation.total)} out in window (max ${fmt(evaluation.max)})`) : (rule.type === "proposal_policy" ? "no proposal checked yet" : "no live value yet");
    const bt = backtest
      ? rule.type === "proposal_policy"
        ? `would have flagged ${backtest.fires} of the DAO's ${backtest.samples} past proposals${backtest.firedAt.length ? ` (#${backtest.firedAt.slice(0, 12).join(", #")})` : ""}`
        : `would have fired ${backtest.fires} time${backtest.fires === 1 ? "" : "s"} over ${backtest.samples} samples (${backtest.days} days)`
      : "not run";
    const origin = rule.origin.kind === "ai" ? `drafted by ${esc(rule.origin.model)}` : `written by ${esc(rule.origin.author)}`;
    const canPause = backtest && backtest.fires === 0;
    return `<div class="rule" data-rule="${esc(rule.id)}">
      <div class="row"><span class="chip ${rule.status === "approved" ? "ok" : "warn"}">${rule.status}</span><span class="sentence">${esc(rule.explain)}</span></div>
      <div class="kv small">
        ${limits ? `<div>Limits (plain units)</div><div><b>${esc(limits)}</b></div>` : ""}
        <div>Live value</div><div>${live} <button data-act="eval" ${rule.type !== "solvency" ? "disabled" : ""}>refresh</button></div>
        <div>Backtest</div><div>${bt} ${backtest ? `<span class="muted">· ${esc(backtest.method)}</span>` : ""} <button data-act="backtest">run</button></div>
        <div>Origin</div><div>${origin}${rule.approvedBy ? ` · approved by ${esc(rule.approvedBy)} as <b>${rule.response}</b>` : ""}</div>
      </div>
      <details><summary>Exact rule (edit)</summary><textarea data-edit>${esc(JSON.stringify(stripLifecycle(rule), null, 2))}</textarea><div class="row"><button data-act="save">Save edit (returns to draft)</button></div></details>
      <div class="row">
        ${rule.type === "proposal_policy"
          ? `<select data-response><option value="reject">alert and vote to reject</option><option value="alert">alert only</option></select>`
          : `<select data-response><option value="alert">alert only</option><option value="pause" ${canPause ? "" : "disabled"}>alert and pause${canPause ? "" : " (needs 0 backtest fires)"}</option></select>`}
        <button class="primary" data-act="approve">Approve</button>
        <button class="danger" data-act="reject">Reject</button>
      </div>
    </div>`;
  }).join("");
  const att = lastDraft?.attestation;
  const draftInfo = lastDraft ? `<div class="small muted">Last draft ${esc(lastDraft.id)}: ${esc(lastDraft.model)} (${lastDraft.source}), ${lastDraft.attempts.length} attempt(s), ${lastDraft.accepted.length} accepted, ${lastDraft.dropped.length} dropped by validation${lastDraft.error ? ` · error: ${esc(lastDraft.error)}` : ""}
     ${att ? (att.signingAddress ? ` · <span class="chip ok">drafted in an attested enclave</span> TEE signing address ${esc(att.signingAddress)} (report stored; verify with NVIDIA NRAS / Intel TDX)` : ` · attestation not captured: ${esc(att.error)}`) : ""}</div>
     ${lastDraft.dropped.length ? `<details><summary>Dropped drafts</summary><pre>${esc(JSON.stringify(lastDraft.dropped, null, 2))}</pre></details>` : ""}` : "";

  const breaches = v.breaches.map((b) => {
    const act = b.vote
      ? `vote ${esc(b.vote.status)}${b.vote.votedAtBlock ? ` @${b.vote.votedAtBlock} (+${b.vote.blocksAfterProposal} blocks) → ${esc(b.vote.proposalStatusAfter ?? "")}` : b.vote.error ? `: ${esc(b.vote.error)}` : ""}`
      : b.pause ? `pause ${esc(b.pause.status)}${b.pause.pausedAtBlock ? ` @${b.pause.pausedAtBlock} (+${b.pause.blocksAfterBreach} blocks)` : ""}` : "";
    const what = b.evaluation.type === "proposal" ? `#${b.evaluation.proposalId} ${esc(b.evaluation.violations[0] ?? "")}` : esc(b.ruleId);
    return `<tr><td>${what}</td><td>${b.triggerBlock}</td><td>${act}</td><td class="mono">${esc(b.vote?.txHash ?? b.pause?.txHash ?? "")}</td><td>${b.alerts.map((a) => `${a.channel}:${a.ok ? "ok" : "failed"}`).join(" ") || "no channels"}</td></tr>`;
  }).join("");

  $("detail").innerHTML = `
    <div class="panel">
      <h2>${esc(p.name)} <span class="chip ${p.status === "protected" ? "ok" : ""}">${p.status}</span></h2>
      <div class="kv small"><div>Contract</div><div class="mono">${esc(p.contractId)} (${p.network})</div>
      <div>Source</div><div>${p.source ? (p.source.kind === "nep330" ? `NEP-330: <a href="${esc(p.source.link)}" target="_blank" rel="noopener">${esc(p.source.link)}</a>` : `uploaded: ${p.source.files.map((f) => esc(f.path)).join(", ")}`) : "none (upload below)"}</div></div>
      <details ${p.source ? "" : "open"}><summary>Upload contract source</summary><p class="small muted">Pick the contract's .rs files. They are sent to the drafting model only.</p><input type="file" id="srcFiles" multiple accept=".rs,.toml,.md"><button id="upload">Upload</button></details>
    </div>
    <div class="panel">
      <h2>1. Draft rules</h2>
      <p class="small muted">The model reads the source, ABI, methods, live state and recent receipts, then proposes rules. Each draft is checked automatically (methods exist, views return amounts, backtest runs) before you see it; failures go back to the model at most twice.</p>
      <div class="row"><button class="primary" id="draft">Draft rules with NEAR AI</button></div>
      ${draftInfo}
      ${ruleHtml || '<p class="muted small">No rules yet.</p>'}
      <details><summary>Write a rule by hand</summary><textarea id="manualRule">${esc(JSON.stringify({ id: "solvency-token", type: "solvency", token: "token.near", owed: { view: "total_owed", args: { token_id: "token.near" } }, held: { contract: "token.near", view: "ft_balance_of", args: { account_id: p.contractId } }, explain: "Tokens owed to users must never exceed tokens held" }, null, 2))}</textarea><button id="addManual">Validate and add</button></details>
    </div>
    <div class="panel">
      <h2>2. ${p.kind === "dao" ? "Add the proposal firewall to the DAO" : "Authorise the guardian"}</h2>
      <div id="guardianBox" class="small muted">Loading…</div>
    </div>
    ${p.kind === "dao" ? `<div class="panel"><h2>Proposals checked</h2><div id="proposalsBox" class="small muted">Loading…</div></div>` : ""}
    <div class="panel">
      <h2>3. Publish</h2>
      <div class="row"><button id="publish">${p.published ? "Unpublish" : "Publish status page"}</button>${p.published ? `<a href="/status/${p.id}" target="_blank">/status/${p.id}</a>` : ""}</div>
    </div>
    <div class="panel"><h2>Incidents</h2>${breaches ? `<table><tr><th>What</th><th>Block</th><th>Action</th><th>Tx</th><th>Alerts</th></tr>${breaches}</table>` : '<p class="muted small">None.</p>'}</div>`;

  $("upload").onclick = (ev) => busy(ev.target, async () => {
    const files = await Promise.all([...$("srcFiles").files].map(async (f) => ({ path: f.name, content: await f.text() })));
    await api("POST", `/api/protocols/${id}/source`, { files });
    toast(`Uploaded ${files.length} file(s)`); renderProtocol(id);
  });
  $("draft").onclick = (ev) => busy(ev.target, async () => {
    try {
      const r = await api("POST", `/api/protocols/${id}/draft`);
      toast(`Drafted ${r.rules.length} rule(s). ${r.notes ?? ""}`);
    } catch (e) {
      if (e.details?.aiMode) toast(`${e.message}`, true); else throw e;
    }
    renderProtocol(id);
  });
  $("addManual").onclick = (ev) => busy(ev.target, async () => {
    await api("POST", `/api/protocols/${id}/rules`, { rule: JSON.parse($("manualRule").value), author: "operator" });
    toast("Rule validated, backtested and added as a draft"); renderProtocol(id);
  });
  $("publish").onclick = (ev) => busy(ev.target, async () => { await api("POST", `/api/protocols/${id}/publish`, { published: !p.published }); renderProtocol(id); refreshLists(); });
  for (const box of $("detail").querySelectorAll("[data-rule]")) {
    const rid = box.dataset.rule;
    for (const b of box.querySelectorAll("button[data-act]")) {
      b.onclick = () => busy(b, async () => {
        const act = b.dataset.act;
        if (act === "approve") await api("POST", `/api/protocols/${id}/rules/${rid}/approve`, { response: box.querySelector("[data-response]").value, approvedBy: "operator" });
        if (act === "reject") await api("POST", `/api/protocols/${id}/rules/${rid}/reject`);
        if (act === "backtest") { toast("Backtest running (archival RPC, may take a few minutes on mainnet)…"); await api("POST", `/api/protocols/${id}/rules/${rid}/backtest`); }
        if (act === "eval") await api("POST", `/api/protocols/${id}/rules/${rid}/evaluate`);
        if (act === "save") await api("PATCH", `/api/protocols/${id}/rules/${rid}`, { rule: JSON.parse(box.querySelector("[data-edit]").value) });
        renderProtocol(id);
      });
    }
  }
  if (p.kind === "dao") {
    renderFirewall(p);
    renderProposals(p);
  } else renderGuardian(p);
}

async function renderProposals(p) {
  const box = $("proposalsBox");
  const list = await api("GET", `/api/protocols/${p.id}/proposals`);
  box.classList.remove("muted");
  box.innerHTML = list.length
    ? `<table><tr><th>#</th><th>Proposer</th><th>What it does</th><th>Verdict</th></tr>${list.slice(0, 40).map((x) => `<tr><td>${x.proposalId}</td><td>${esc(x.proposer)}</td><td>${esc(x.summary)}</td><td><span class="chip ${x.ok ? "ok" : "bad"}">${x.ok ? "within policy" : x.governance ? "governance alert" : "breaks policy"}</span> ${x.ok ? "" : esc(x.violations.join("; "))}</td></tr>`).join("")}</table>`
    : "No proposals checked yet. New proposals are checked in the block they are submitted.";
}

async function renderFirewall(p) {
  const box = $("guardianBox");
  try {
    const g = await api("GET", `/api/protocols/${p.id}/firewall`);
    box.classList.remove("muted");
    box.innerHTML = `<p>${esc(g.explains)}</p>
      <div class="kv"><div>Firewall account</div><div class="mono">${esc(g.firewallAccount)}</div><div>Key loaded</div><div>${g.keyLoaded ? "yes (function-call key, act_proposal on this DAO only)" : "no"}</div></div>
      <h3>Role the DAO votes to add</h3><pre>${esc(JSON.stringify(g.role, null, 2))}</pre>
      <h3>Proposal to submit (a council member)</h3><pre>${esc(JSON.stringify(g.transaction, null, 2))}</pre>
      <div class="row">${g.demoSigning ? '<button id="signFw">Propose and approve with the sandbox council key (local demo only)</button>' : ""}<button class="primary" id="verifyFw">Read the DAO policy back and verify</button></div>
      ${p.firewallVerified ? `<p class="small">Last verified ${esc(p.firewallVerified.at)}: <b>${p.firewallVerified.ok ? "reject-only role confirmed" : "not verified"}</b>${p.firewallVerified.problems.length ? ` · ${esc(p.firewallVerified.problems.join("; "))}` : ""}</p>` : ""}
      <pre id="verifyOut" class="hidden"></pre>`;
    if (g.demoSigning) $("signFw").onclick = (ev) => busy(ev.target, async () => { const r = await api("POST", `/api/protocols/${p.id}/firewall/sign-demo`); toast(`DAO voted the firewall role in: ${r.txHash}`); });
    $("verifyFw").onclick = (ev) => busy(ev.target, async () => {
      const r = await api("POST", `/api/protocols/${p.id}/firewall/verify`);
      const out = $("verifyOut");
      out.classList.remove("hidden");
      out.textContent = JSON.stringify({ ok: r.ok, role: r.role, problems: r.problems, firewallKeyPermission: r.firewallKeyPermission }, null, 2);
      toast(r.ok ? "Firewall verified: the DAO is protected" : "Not verified yet", !r.ok);
      refreshLists();
    });
  } catch (e) {
    box.textContent = e.message;
  }
}

function stripLifecycle(r) {
  const { status, origin, response, approvedBy, approvedAt, ...rest } = r;
  return rest;
}

async function renderGuardian(p) {
  const box = $("guardianBox");
  try {
    const g = await api("GET", `/api/protocols/${p.id}/guardian`);
    box.classList.remove("muted");
    box.innerHTML = `<p>${esc(g.explains)}</p>
      <div class="kv"><div>Guardian</div><div class="mono">${esc(g.guardianId)}</div><div>Watcher</div><div class="mono">${esc(g.watcherAccount ?? "not configured")}</div></div>
      <h3>Transaction to sign (contract owner)</h3><pre>${esc(JSON.stringify(g.transaction, null, 2))}</pre>
      <h3>near-cli-rs</h3><pre>${esc(g.nearCli)}</pre>
      <div class="row">${g.demoSigning ? '<button id="signDemo">Sign with the sandbox owner key (local demo only)</button>' : ""}<button class="primary" id="verify">Read back and verify</button></div>
      ${p.guardianVerified ? `<p class="small">Last verified ${esc(p.guardianVerified.at)}: guardian on contract = <b>${esc(p.guardianVerified.guardianSet ?? "none")}</b>, registered with guardian = <b>${p.guardianVerified.registered}</b>${p.guardianVerified.council ? `, council ${esc(p.guardianVerified.council)}` : ""}</p>` : ""}
      <pre id="verifyOut" class="hidden"></pre>`;
    if (g.demoSigning) $("signDemo").onclick = (ev) => busy(ev.target, async () => { const r = await api("POST", `/api/protocols/${p.id}/guardian/sign-demo`); toast(`Signed: ${r.txHash}`); });
    $("verify").onclick = (ev) => busy(ev.target, async () => {
      const r = await api("POST", `/api/protocols/${p.id}/guardian/verify`);
      const out = $("verifyOut");
      out.classList.remove("hidden");
      out.textContent = JSON.stringify({ ok: r.ok, contractGuardian: r.contractGuardian, registration: r.registration, watcherApproved: r.watcherApproved, watcherKeyPermission: r.watcherKeyPermission, watcherKeyScopeOk: r.watcherKeyScopeOk, contractGuardianError: r.contractGuardianError }, null, 2);
      toast(r.ok ? "Guardian verified: protocol is protected" : "Not verified yet", !r.ok);
      refreshLists();
    });
  } catch (e) {
    box.textContent = e.message;
  }
}

async function renderRelayer(id) {
  const v = await api("GET", `/api/relayers/${id}/admin`);
  const r = v.relayer;
  const rows = v.decisions.slice(0, 120).map((d) => `<tr><td>${new Date(d.at).toLocaleTimeString()}</td><td>${esc(d.beneficiary)}</td><td>${esc(d.action)}</td><td>${esc(d.receiver ?? "")}</td><td><span class="chip ${d.allow ? "ok" : "bad"}">${d.allow ? "allow" : "deny"}</span></td><td>${esc(d.reason)}</td></tr>`).join("");
  const allowN = v.decisions.filter((d) => d.allow).length;
  $("detail").innerHTML = `<div class="panel"><h2>${esc(r.name)}</h2>
    <p class="small muted">The relayer SDK pulls these budgets (cached locally) and calls <code>check(beneficiary, action, cost)</code> before signing each sponsored action. Fail mode applies when Qorvex is unreachable and there is no cache.</p>
    <textarea id="budgets">${esc(JSON.stringify(r.budgets, null, 2))}</textarea>
    <div class="row"><label class="small">Fail mode <select id="failMode"><option ${r.failMode === "closed" ? "selected" : ""}>closed</option><option ${r.failMode === "open" ? "selected" : ""}>open</option></select></label><button class="primary" id="saveBudgets">Save budgets</button></div>
    <p class="small muted">Example: <code>[{"beneficiary":"*","window_sec":3600,"max_cost_yocto":"20000000000000000000000","max_count":{"storage_deposit":8},"allowed_receivers":["usdc.near"]}]</code></p>
    </div>
    <div class="panel"><h2>Decision log</h2><p class="small">${v.decisions.length} decisions · ${allowN} allowed · ${v.decisions.length - allowN} denied</p>
    ${rows ? `<table><tr><th>Time</th><th>Beneficiary</th><th>Action</th><th>Receiver</th><th></th><th>Reason</th></tr>${rows}</table>` : '<p class="muted small">No decisions yet.</p>'}</div>`;
  $("saveBudgets").onclick = (ev) => busy(ev.target, async () => {
    await api("PUT", `/api/relayers/${id}/budgets`, { budgets: JSON.parse($("budgets").value), failMode: $("failMode").value });
    toast("Budgets saved; relayers pick them up within their cache TTL");
  });
}

async function setupDemo() {
  const info = await api("GET", "/api/demo");
  $("demoPanel").classList.remove("hidden");
  const out = $("demoOut");
  const show = (x) => { out.classList.remove("hidden"); out.textContent = typeof x === "string" ? x : JSON.stringify(x, null, 2); };
  $("ghostLedger").onclick = (ev) => busy(ev.target, async () => show(await api("POST", "/api/demo/ghost", { target: info.accounts.ledger, amount: 40000 })));
  $("ghostVault").onclick = (ev) => busy(ev.target, async () => show(await api("POST", "/api/demo/ghost", { target: info.accounts.vault, amount: 40000 })));
  const fmtRun = (r) => ({ ...r, sponsorBalanceBefore: `${(Number(BigInt(r.sponsorBalanceBefore) / 10n ** 19n) / 1e5).toFixed(5)} NEAR`, sponsorBalanceAfter: `${(Number(BigInt(r.sponsorBalanceAfter) / 10n ** 19n) / 1e5).toFixed(5)} NEAR` });
  $("trezuOpen").onclick = (ev) => busy(ev.target, async () => show(fmtRun(await api("POST", "/api/demo/trezu", { mode: "unguarded", receivers: 100 }))));
  $("trezuGuarded").onclick = (ev) => busy(ev.target, async () => show(fmtRun(await api("POST", "/api/demo/trezu", { mode: "guarded", receivers: 100 }))));
  let lastProposal = null;
  for (const [btn, kind] of [["propBig", "big-transfer"], ["propDrain", "drain-call"], ["propInvoice", "invoice"]])
    $(btn).onclick = (ev) => busy(ev.target, async () => { const r = await api("POST", "/api/demo/action/propose", { kind }); lastProposal = r.id; show(r); });
  $("councilApprove").onclick = (ev) => busy(ev.target, async () => show(lastProposal === null ? "submit a proposal first" : await api("POST", "/api/demo/action/council-approve", { id: lastProposal })));
  $("daoUnpause").onclick = (ev) => busy(ev.target, async () => show(await api("POST", "/api/demo/action/dao-unpause", { target: info.accounts.vault })));
  $("relayOpen").onclick = (ev) => busy(ev.target, async () => show(fmtRun(await api("POST", "/api/demo/action/relay-vote", { mode: "unguarded" }))));
  $("relayGuarded").onclick = (ev) => busy(ev.target, async () => show(fmtRun(await api("POST", "/api/demo/action/relay-vote", { mode: "guarded" }))));
}

start();
