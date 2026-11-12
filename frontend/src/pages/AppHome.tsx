import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import type { Health } from "@qorvex/shared";
import { clearToken, getToken } from "../lib/session";
import { useTitle } from "../lib/hooks";
import "../styles/auth.css";

/**
 * Authenticated entry point. The operator console is being rebuilt; until then this page
 * confirms the session and shows the server's real health, with no placeholder data.
 */
export default function AppHome() {
  useTitle("Console");
  const navigate = useNavigate();
  const token = getToken();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((h: Health) => live && setHealth(h))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [token]);

  if (!token) return <Navigate to="/sign-in" replace state={{ from: "/app" }} />;

  const signOut = () => {
    clearToken();
    navigate("/", { replace: true });
  };

  return (
    <section className="auth-page container" aria-labelledby="app-title">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-card card app-card">
        <p className="eyebrow">Signed in</p>
        <h1 id="app-title" className="serif auth-title">
          Operator <em>console</em>
        </h1>
        <p className="muted">
          You’re signed in to this Qorvex server. The console interface is being rebuilt. Until it returns, every operator action is available through
          the API in <Link to="/docs/connecting-contracts">Connecting contracts</Link>.
        </p>
        <div className="server-health" aria-live="polite">
          <p className="mono health-title">This server</p>
          {error && <p className="auth-error">Couldn’t read /api/health: {error}</p>}
          {!health && !error && <p className="faint">Reading /api/health…</p>}
          {health && (
            <dl className="health-grid mono">
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`dot ${health.ok ? "dot-ok" : "dot-bad"}`} /> {health.ok ? "OK" : "Not OK"}
                </dd>
              </div>
              <div>
                <dt>Networks</dt>
                <dd>{health.networks.join(", ") || "none"}</dd>
              </div>
              <div>
                <dt>AI mode</dt>
                <dd>
                  {health.ai.mode}
                  {health.ai.live ? " · live key" : ""}
                </dd>
              </div>
              <div>
                <dt>Alerts</dt>
                <dd>{health.alerts.length ? health.alerts.join(", ") : "none configured"}</dd>
              </div>
              <div>
                <dt>Demo world</dt>
                <dd>{health.demo ? "local sandbox" : "off"}</dd>
              </div>
            </dl>
          )}
        </div>
        <div className="auth-actions">
          <Link to="/docs/connecting-contracts" className="btn btn-primary">
            Operator API guide
          </Link>
          <button type="button" className="btn btn-secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </section>
  );
}
