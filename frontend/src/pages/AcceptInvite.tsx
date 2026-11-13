import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, me } from "../lib/api";
import { errorText } from "../lib/errors";
import { useTitle } from "../lib/hooks";
import "../styles/auth.css";
import "../styles/app.css";

interface InvitationView {
  id: string;
  email: string;
  role: string;
  organizationName?: string;
  inviterEmail?: string;
  status: string;
  expiresAt: string;
}

/** Where invitation links land: sign in (or create an account), then join the workspace. */
export default function AcceptInvite() {
  useTitle("Join a workspace");
  const { id } = useParams();
  const navigate = useNavigate();
  const [inv, setInv] = useState<InvitationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const who = await me().catch(() => null);
      if (!who) return navigate("/sign-in", { replace: true, state: { from: `/accept-invite/${id}` } });
      try {
        const v = await api<InvitationView>(`/api/auth/organization/get-invitation?id=${encodeURIComponent(id ?? "")}`);
        if (live) setInv(v);
      } catch (e) {
        if (live) setError(errorText(e) + " Make sure you're signed in with the email address the invitation was sent to.");
      }
    })();
    return () => {
      live = false;
    };
  }, [id, navigate]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ invitation?: { organizationId: string }; member?: { organizationId: string } }>("/api/auth/organization/accept-invitation", { body: { invitationId: id } });
      const ws = r.member?.organizationId ?? r.invitation?.organizationId;
      if (ws) await api("/api/workspaces/active", { body: { workspaceId: ws } }).catch(() => {});
      navigate("/app", { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const decline = async () => {
    await api("/api/auth/organization/reject-invitation", { body: { invitationId: id } }).catch(() => {});
    navigate("/app", { replace: true });
  };

  return (
    <section className="auth-page container" aria-labelledby="invite-title">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-card card">
        <p className="eyebrow">Invitation</p>
        <h1 id="invite-title" className="serif auth-title">
          Join {inv?.organizationName ? <em>{inv.organizationName}</em> : "a workspace"}
        </h1>
        {!inv && !error && <p className="faint">Checking the invitation…</p>}
        {inv && (
          <>
            <p className="muted">
              {inv.inviterEmail ? `${inv.inviterEmail} invited you` : "You were invited"} as <b>{inv.role}</b>. The invitation is valid until {new Date(inv.expiresAt).toLocaleString()}.
            </p>
            <div className="auth-actions">
              <button className="btn btn-primary" onClick={accept} disabled={busy}>
                {busy ? "Joining…" : "Accept and join"}
              </button>
              <button className="btn btn-secondary" onClick={decline} disabled={busy}>
                Decline
              </button>
            </div>
          </>
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
