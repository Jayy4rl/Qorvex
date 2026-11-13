import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { NetworkId } from "@qorvex/shared";
import { api, type Me } from "../lib/api";
import { errorText, UserFacingError } from "../lib/errors";
import { withStepUp } from "../lib/wallet";
import { ago } from "../lib/format";
import { useTitle } from "../lib/hooks";

const ROLES = ["owner", "admin", "responder", "viewer"] as const;
const ROLE_HELP: Record<string, string> = {
  owner: "everything, including deleting the workspace",
  admin: "add contracts, approve rules, authorise the guardian, manage relayers and keys",
  responder: "act on incidents and alerts",
  viewer: "read only",
};
const SCOPES: Record<string, string> = {
  "contracts:read": "Read contracts and rules",
  "alerts:ack": "Read and acknowledge alerts",
};

interface Member {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  user: { name: string; email: string };
}
interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}
interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  scopes: string[];
  expiresAt: string | null;
  createdAt: string;
  lastRequest: string | null;
}
interface AuditRow {
  seq: number;
  at: string;
  actor: string;
  method: string;
  action: string;
  target: string | null;
  signedMessage: unknown;
}

const isPlaceholder = (email: string) => email.endsWith(".placeholder.invalid");
const displayEmail = (email: string) => (isPlaceholder(email) ? "signed in with a NEAR wallet" : email);

/** Team & access: who is in the workspace, what they can do, API keys, alerts and the audit log. */
export default function Team({ who }: { who: Me }) {
  useTitle("Team");
  if (who.kind !== "user" || !who.workspace) {
    return (
      <div className="stack-lg">
        <h1 className="serif page-title">Team</h1>
        <p className="muted">The operator-token workspace has no members. Sign in with a wallet or email to create a team workspace and invite people.</p>
      </div>
    );
  }
  const ws = who.workspace;
  const canManage = ws.role === "owner" || ws.role === "admin";
  return (
    <div className="stack-lg">
      <div>
        <h1 className="serif page-title">Team</h1>
        <p className="muted lede">
          Who can see and change <b>{ws.name}</b>. You are {ws.role === "admin" ? "an" : "a"} <b>{ws.role}</b>: {ROLE_HELP[ws.role] ?? ""}.
        </p>
      </div>
      <Members workspaceId={ws.id} myUserId={who.user!.id} myRole={ws.role} canManage={canManage} />
      {canManage && <ApiKeys who={who} />}
      <Alerts canManage={canManage} />
      <AuditLog workspaceId={ws.id} />
    </div>
  );
}

// ------------------------------------------------------------------ members

function Members({ workspaceId, myUserId, myRole, canManage }: { workspaceId: string; myUserId: string; myRole: string; canManage: boolean }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const q = `organizationId=${encodeURIComponent(workspaceId)}`;
  const load = useCallback(async () => {
    try {
      const m = await api<{ members: Member[] }>(`/api/auth/organization/list-members?${q}`);
      setMembers(m.members);
      if (canManage) setInvites((await api<Invitation[]>(`/api/auth/organization/list-invitations?${q}`)).filter((i) => i.status === "pending"));
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }, [q, canManage]);
  useEffect(() => void load(), [load]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  const inviteLink = (id: string) => `${window.location.origin}/accept-invite/${id}`;

  return (
    <div className="card panel">
      <h2 className="h-small">Members</h2>
      {!members && <p className="faint small">Loading…</p>}
      <ul className="members">
        {members?.map((m) => {
          const me = m.userId === myUserId;
          const canEdit = canManage && !me && (myRole === "owner" || m.role !== "owner");
          return (
            <li key={m.id}>
              <span>
                <b>{m.user.name}</b> {me && <span className="faint small">(you)</span>}
                <br />
                <span className="faint small">{displayEmail(m.user.email)}</span>
              </span>
              {canEdit ? (
                <select className="auth-input mono slim" value={m.role} onChange={(e) => act(() => api("/api/auth/organization/update-member-role", { body: { memberId: m.id, role: e.target.value, organizationId: workspaceId } }), `${m.user.name} is now ${e.target.value}.`)}>
                  {ROLES.filter((r) => myRole === "owner" || r !== "owner").map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="pill tiny">{m.role}</span>
              )}
              {canEdit ? (
                <button className="text-link small" onClick={() => confirm(`Remove ${m.user.name} from this workspace?`) && act(() => api("/api/auth/organization/remove-member", { body: { memberIdOrEmail: m.id, organizationId: workspaceId } }), `${m.user.name} was removed.`)}>
                  Remove
                </button>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>

      {canManage && (
        <>
          <h3 className="h-small">Invite someone</h3>
          <InviteForms
            workspaceId={workspaceId}
            myRole={myRole}
            onInvited={(text, link) => {
              setMsg({ ok: true, text, link });
              void load();
            }}
            onError={(text) => setMsg({ ok: false, text })}
          />
          {invites.length > 0 && (
            <>
              <h3 className="h-small">Waiting to accept</h3>
              <ul className="members">
                {invites.map((i) => (
                  <li key={i.id}>
                    <span>
                      {i.email}
                      <br />
                      <span className="faint small">expires {new Date(i.expiresAt).toLocaleString()}</span>
                    </span>
                    <span className="pill tiny">{i.role}</span>
                    <span className="row">
                      <button className="text-link small" onClick={() => void navigator.clipboard?.writeText(inviteLink(i.id)).then(() => setMsg({ ok: true, text: "Invite link copied." }))}>
                        Copy link
                      </button>
                      <button className="text-link small" onClick={() => act(() => api("/api/auth/organization/cancel-invitation", { body: { invitationId: i.id } }), "Invitation cancelled.")}>
                        Cancel
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {msg && (
        <div className={msg.ok ? "small ok" : "auth-error small"}>
          <p>{msg.text}</p>
          {msg.link && <pre className="code-pre">{msg.link}</pre>}
        </div>
      )}
    </div>
  );
}

function InviteForms({ workspaceId, myRole, onInvited, onError }: { workspaceId: string; myRole: string; onInvited: (text: string, link?: string) => void; onError: (text: string) => void }) {
  const [by, setBy] = useState<"email" | "near">("email");
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState<NetworkId>("testnet");
  const [role, setRole] = useState("viewer");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (by === "email") {
        const inv = await api<{ id: string }>("/api/auth/organization/invite-member", { body: { email: email.trim(), role, organizationId: workspaceId } });
        setEmail("");
        onInvited(`Invitation created for ${email.trim()}. No email service is set up yet, so send them this link (valid 48 hours):`, `${window.location.origin}/accept-invite/${inv.id}`);
      } else {
        await api("/api/invites/near", { body: { network, accountId: account.trim(), role } });
        setAccount("");
        onInvited(`${account.trim()} joins as ${role} the first time it signs in with its wallet on ${network} (within 48 hours).`);
      }
    } catch (x) {
      onError(errorText(x));
    }
  };
  return (
    <form className="invite" onSubmit={submit}>
      <select className="auth-input mono slim" value={by} onChange={(e) => setBy(e.target.value as "email" | "near")} aria-label="Invite by">
        <option value="email">by email</option>
        <option value="near">by NEAR account</option>
      </select>
      {by === "email" ? (
        <input className="auth-input grow" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
      ) : (
        <>
          <select className="auth-input mono slim" value={network} onChange={(e) => setNetwork(e.target.value as NetworkId)} aria-label="Network">
            <option value="testnet">testnet</option>
            <option value="mainnet">mainnet</option>
          </select>
          <input className="auth-input mono grow" placeholder="name.testnet" value={account} onChange={(e) => setAccount(e.target.value)} required />
        </>
      )}
      <select className="auth-input mono slim" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" title={ROLE_HELP[role]}>
        {ROLES.filter((r) => r !== "owner" || (myRole === "owner" && by === "email")).map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button className="btn btn-sm btn-primary">Invite</button>
      <p className="faint small wide">
        {role}: {ROLE_HELP[role]}.
      </p>
    </form>
  );
}

// ------------------------------------------------------------------ API keys

function ApiKeys({ who }: { who: Me }) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["contracts:read"]);
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => {
    api<ApiKeyRow[]>("/api/apikeys")
      .then(setKeys)
      .catch((e: unknown) => setMsg({ ok: false, text: errorText(e) }));
  }, []);
  useEffect(load, [load]);
  const network = (who.nearAccounts[0]?.network ?? "testnet") as NetworkId;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setCreated(null);
    try {
      if (!who.nearAccounts.length) throw new UserFacingError("Creating an API key is confirmed with your NEAR wallet. Link a NEAR account first (Contracts page).");
      const out = await withStepUp(network, (headers) => api<{ key: string }>("/api/apikeys", { body: { name: name.trim(), scopes, expiresInDays: Number(days) }, headers }));
      setCreated(out.key);
      setName("");
      load();
    } catch (x) {
      setMsg({ ok: false, text: errorText(x) });
    }
  };
  const revoke = async (k: ApiKeyRow) => {
    if (!confirm(`Revoke the key “${k.name ?? k.start}”? Anything using it stops working immediately.`)) return;
    try {
      await api(`/api/apikeys/${k.id}`, { method: "DELETE" });
      setMsg({ ok: true, text: "Key revoked." });
      load();
    } catch (x) {
      setMsg({ ok: false, text: errorText(x) });
    }
  };
  return (
    <div className="card panel">
      <h2 className="h-small">API keys</h2>
      <p className="muted small">For scripts and dashboards that read this workspace. Keys can only read and acknowledge alerts; they can never approve rules or authorise pauses.</p>
      {keys && keys.length === 0 && <p className="faint small">No keys.</p>}
      {keys && keys.length > 0 && (
        <ul className="members">
          {keys.map((k) => (
            <li key={k.id}>
              <span>
                <b>{k.name ?? "unnamed"}</b> <span className="mono faint small">{k.start ?? k.prefix ?? ""}…</span>
                <br />
                <span className="faint small">
                  {k.scopes.map((s) => SCOPES[s] ?? s).join(", ")} · {k.expiresAt ? `expires ${new Date(k.expiresAt).toLocaleDateString()}` : "no expiry"} · {k.lastRequest ? `last used ${ago(k.lastRequest)}` : "never used"}
                </span>
              </span>
              <span />
              <button className="text-link small" onClick={() => revoke(k)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="invite" onSubmit={create}>
        <input className="auth-input grow" placeholder="Key name, e.g. CI dashboard" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        <select className="auth-input mono slim" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Expires after">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
        </select>
        <button className="btn btn-sm btn-primary">Create key</button>
        <span className="wide row">
          {Object.entries(SCOPES).map(([s, label]) => (
            <label key={s} className="small row">
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((xs) => (e.target.checked ? [...xs, s] : xs.filter((x) => x !== s)))} /> {label}
            </label>
          ))}
        </span>
        <p className="faint small wide">Your wallet asks you to confirm before the key is created.</p>
      </form>
      {created && (
        <div className="small ok">
          <p>
            Here is the key. It is shown <b>only once</b>: store it in your secret manager.
          </p>
          <pre className="code-pre">{created}</pre>
        </div>
      )}
      {msg && <p className={msg.ok ? "small ok" : "auth-error small"}>{msg.text}</p>}
    </div>
  );
}

// -------------------------------------------------------------------- alerts

interface AlertSettings {
  serverBot: boolean;
  telegram: { chatId: string; ownBot: boolean } | null;
  webhook: { url: string; secretSet: boolean } | null;
}

/** Where this workspace's incidents go: its own Telegram chat and/or a signed webhook. */
function Alerts({ canManage }: { canManage: boolean }) {
  const [cfg, setCfg] = useState<AlertSettings | null>(null);
  const [chatId, setChatId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [hook, setHook] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const show = (c: AlertSettings) => {
    setCfg(c);
    setChatId(c.telegram?.chatId ?? "");
    setHook(c.webhook?.url ?? "");
    setBotToken("");
  };
  useEffect(() => {
    api<AlertSettings>("/api/alerts")
      .then(show)
      .catch((e: unknown) => setMsg({ ok: false, text: errorText(e) }));
  }, []);
  const save = (body: object, done: string) => async (e?: FormEvent) => {
    e?.preventDefault();
    setMsg(null);
    setSecret(null);
    setBusy(true);
    try {
      const out = await api<AlertSettings & { webhookSecret?: string }>("/api/alerts", { method: "PUT", body });
      show(out);
      if (out.webhookSecret) setSecret(out.webhookSecret);
      setMsg({ ok: true, text: done });
    } catch (x) {
      setMsg({ ok: false, text: errorText(x) });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const out = await api<{ results: { channel: string; ok: boolean; error?: string }[] }>("/api/alerts/test", { body: {} });
      const bad = out.results.filter((r) => !r.ok);
      setMsg(bad.length ? { ok: false, text: `Not delivered to ${bad.map((r) => r.channel).join(" and ")}. Check the chat ID, that the bot is in the chat, or that the webhook answers with a 2xx.` } : { ok: true, text: `Test alert sent to ${out.results.map((r) => r.channel).join(" and ")}.` });
    } catch (x) {
      setMsg({ ok: false, text: errorText(x) });
    } finally {
      setBusy(false);
    }
  };
  if (!cfg) return null;
  return (
    <div className="card panel">
      <h2 className="h-small">Alerts</h2>
      <p className="muted small">Incidents on this workspace's contracts and relayers are sent here, and only here, the moment they happen.</p>
      {!canManage && (
        <p className="small">
          Telegram: {cfg.telegram ? <span className="mono">{cfg.telegram.chatId}</span> : "not set"} · Webhook: {cfg.webhook ? <span className="mono">{cfg.webhook.url}</span> : "not set"}
        </p>
      )}
      {canManage && (
        <>
          <form className="invite" onSubmit={save({ telegram: { chatId: chatId.trim(), ...(botToken.trim() ? { botToken: botToken.trim() } : {}) } }, "Telegram saved.")}>
            <input className="auth-input mono grow" placeholder="Telegram chat ID, e.g. -1001234567890" value={chatId} onChange={(e) => setChatId(e.target.value)} required aria-label="Telegram chat ID" />
            <input
              className="auth-input mono grow"
              type="password"
              autoComplete="off"
              placeholder={cfg.telegram?.ownBot ? "Bot token saved (enter a new one to replace it)" : cfg.serverBot ? "Your own bot token (optional)" : "Bot token from @BotFather"}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              aria-label="Telegram bot token"
            />
            <button className="btn btn-sm btn-primary" disabled={busy}>
              Save Telegram
            </button>
            {cfg.telegram && (
              <button type="button" className="text-link small" onClick={() => void save({ telegram: null }, "Telegram removed.")()}>
                Remove
              </button>
            )}
            <p className="faint small wide">
              {cfg.serverBot
                ? "Add Qorvex's bot to your group, or use your own bot from @BotFather. "
                : "Create a bot with @BotFather, add it to your group, and paste its token. "}
              The token is stored on the server and never shown again.
            </p>
          </form>
          <form className="invite" onSubmit={save({ webhook: { url: hook.trim() } }, "Webhook saved.")}>
            <input className="auth-input mono grow" type="url" placeholder="https://your-service.example/qorvex" value={hook} onChange={(e) => setHook(e.target.value)} required aria-label="Webhook URL" />
            <button className="btn btn-sm btn-primary" disabled={busy}>
              Save webhook
            </button>
            {cfg.webhook && (
              <button type="button" className="text-link small" onClick={() => void save({ webhook: null }, "Webhook removed.")()}>
                Remove
              </button>
            )}
            <p className="faint small wide">Each alert is a JSON POST signed with HMAC-SHA256 in the x-qorvex-signature header.</p>
          </form>
          {secret && (
            <div className="small ok">
              <p>
                Webhook signing secret. It is shown <b>only once</b>: store it where your service can check signatures.
              </p>
              <pre className="code-pre">{secret}</pre>
            </div>
          )}
          {(cfg.telegram || cfg.webhook) && (
            <div className="row">
              <button className="btn btn-sm btn-secondary" onClick={test} disabled={busy}>
                Send test alert
              </button>
            </div>
          )}
        </>
      )}
      {msg && <p className={msg.ok ? "small ok" : "auth-error small"}>{msg.text}</p>}
    </div>
  );
}

// ----------------------------------------------------------------- audit log

const ACTION_TEXT: Record<string, string> = {
  "workspace.create": "created the workspace",
  "contract.watch": "added a contract",
  "contract.claim": "claimed a contract",
  "claim.lapsed": "lost verified control of a contract",
  "rule.approve": "approved a rule",
  "rule.from-template": "created a rule from a template",
  "guardian.authorised": "authorised the guardian",
  "status.publish": "published a status page",
  "status.unpublish": "unpublished a status page",
  "relayer.create": "added a relayer",
  "relayer.budgets": "changed a relayer budget",
  "apikey.create": "created an API key",
  "apikey.revoke": "revoked an API key",
  "member.invite": "invited a NEAR account",
  "alerts.update": "changed where alerts are sent",
};

function AuditLog({ workspaceId }: { workspaceId: string }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<AuditRow[]>("/api/audit")
      .then(setRows)
      .catch((e: unknown) => setErr(errorText(e)));
    api<{ members: Member[] }>(`/api/auth/organization/list-members?organizationId=${encodeURIComponent(workspaceId)}`)
      .then((m) => setNames(Object.fromEntries(m.members.map((x) => [x.userId, x.user.name]))))
      .catch(() => {});
  }, [workspaceId]);
  const actor = (r: AuditRow) =>
    r.actor === "admin-token" ? "Operator" : r.actor.startsWith("api-key:") ? "An API key" : r.actor === "qorvex" ? "Qorvex" : (names[r.actor.replace(/^user:/, "")] ?? "A former member");
  return (
    <div className="card panel">
      <h2 className="h-small">Activity</h2>
      <p className="muted small">Every change to this workspace, newest first. It can't be edited or deleted. Actions confirmed with a wallet keep the signed message as proof.</p>
      {err && <p className="auth-error small">{err}</p>}
      {rows && rows.length === 0 && <p className="faint small">Nothing yet.</p>}
      <ul className="audit">
        {rows?.slice(0, 100).map((r) => (
          <li key={r.seq}>
            <span className="faint small">{ago(r.at)}</span>
            <span className="small">
              {actor(r)} {ACTION_TEXT[r.action] ?? r.action.replace(/[._]/g, " ")}
              {r.target && r.action !== "workspace.create" ? (
                <>
                  {" "}
                  <span className="mono">{r.target.replace(/^(mainnet|testnet|sandbox):/, "")}</span>
                </>
              ) : null}
            </span>
            {r.signedMessage ? <span className="pill tiny pill-outline-lime">signed with wallet</span> : <span />}
          </li>
        ))}
      </ul>
    </div>
  );
}
