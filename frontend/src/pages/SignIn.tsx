import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { getToken, setToken, verifyToken } from "../lib/session";
import { useTitle } from "../lib/hooks";
import "../styles/auth.css";

export default function SignIn() {
  useTitle("Sign in");
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/app";
  const inputId = useId();
  const errorId = useId();
  const [token, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in this tab: go straight on.
  useEffect(() => {
    if (getToken()) navigate(from, { replace: true });
  }, [from, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await verifyToken(token);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setToken(token.trim());
    navigate(from, { replace: true });
  };

  return (
    <section className="auth-page container" aria-labelledby="signin-title">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-card card">
        <p className="eyebrow">Operator sign-in</p>
        <h1 id="signin-title" className="serif auth-title">
          Sign in to <em>Qorvex</em>
        </h1>
        <p className="muted">
          Each Qorvex server has one operator token. The server prints it when it starts; set your own with <code className="mono">QORVEX_ADMIN_TOKEN</code>.
        </p>
        <form onSubmit={onSubmit} noValidate>
          <label htmlFor={inputId} className="auth-label mono">
            Operator token
          </label>
          <div className="auth-input-row">
            <input
              id={inputId}
              type={show ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              value={token}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              className="auth-input mono"
              placeholder="Paste the token from the server output"
              required
            />
            <button type="button" className="auth-reveal" onClick={() => setShow((s) => !s)} aria-pressed={show}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
          {error && (
            <p id={errorId} className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>
        <p className="auth-foot faint">
          The token is checked against this server and kept only for this browser tab. No server running yet?{" "}
          <Link to="/docs/getting-started#sign-in">Start one locally</Link>.
        </p>
      </div>
    </section>
  );
}
