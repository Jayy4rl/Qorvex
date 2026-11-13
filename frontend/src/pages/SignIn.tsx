import { type FormEvent, useEffect, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { setToken, verifyToken } from "../lib/session";
import { api, me } from "../lib/api";
import { signInWithWallet, type WalletNetwork } from "../lib/wallet";
import { useTitle } from "../lib/hooks";
import "../styles/auth.css";
import "../styles/app.css";
import { errorText, UserFacingError } from "../lib/errors";

type Mode = "wallet" | "email" | "token";

export default function SignIn() {
  useTitle("Sign in");
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/app";
  const [mode, setMode] = useState<Mode>("wallet");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    me()
      .then((m) => live && m && navigate(from, { replace: true }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [from, navigate]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      navigate(from, { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="auth-page container" aria-labelledby="signin-title">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-card card">
        <p className="eyebrow">Sign in</p>
        <h1 id="signin-title" className="serif auth-title">
          Sign in to <em>Qorvex</em>
        </h1>
        <div className="seg" role="tablist" aria-label="Sign-in method">
          {(["wallet", "email", "token"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={`seg-btn ${mode === m ? "on" : ""}`} onClick={() => (setMode(m), setError(null))}>
              {m === "wallet" ? "NEAR wallet" : m === "email" ? "Email" : "Operator token"}
            </button>
          ))}
        </div>
        {mode === "wallet" && <WalletForm busy={busy} onGo={(n) => run(async () => void (await signInWithWallet(n)))} />}
        {mode === "email" && <EmailForm busy={busy} onGo={(path, body) => run(async () => void (await api(path, { body })))} />}
        {mode === "token" && (
          <TokenForm
            busy={busy}
            onGo={(t) =>
              run(async () => {
                const r = await verifyToken(t);
                if (!r.ok) throw new UserFacingError(r.message);
                setToken(t.trim());
              })
            }
          />
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <p className="auth-foot faint">
          Just looking? <Link to="/check">Check any contract</Link> without an account.
        </p>
      </div>
    </section>
  );
}

function WalletForm({ busy, onGo }: { busy: boolean; onGo: (n: WalletNetwork) => void }) {
  const [network, setNetwork] = useState<WalletNetwork>("mainnet");
  return (
    <div className="stack">
      <p className="muted">Your wallet signs a one-time message for this site. Nothing is sent on-chain and no fee is charged. A full-access key is required.</p>
      <label className="auth-label mono">
        Network
        <select className="auth-input mono" value={network} onChange={(e) => setNetwork(e.target.value as WalletNetwork)}>
          <option value="mainnet">mainnet</option>
          <option value="testnet">testnet</option>
        </select>
      </label>
      <button className="btn btn-primary auth-submit" disabled={busy} onClick={() => onGo(network)}>
        {busy ? "Waiting for the wallet…" : "Connect wallet and sign in"}
      </button>
    </div>
  );
}

function EmailForm({ busy, onGo }: { busy: boolean; onGo: (path: string, body: object) => void }) {
  const [signUp, setSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const ids = { e: useId(), p: useId(), n: useId() };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onGo(signUp ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email", signUp ? { email, password, name: name || email.split("@")[0] } : { email, password });
  };
  return (
    <form onSubmit={submit} className="stack">
      {signUp && (
        <>
          <label htmlFor={ids.n} className="auth-label mono">
            Name
          </label>
          <input id={ids.n} className="auth-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </>
      )}
      <label htmlFor={ids.e} className="auth-label mono">
        Email
      </label>
      <input id={ids.e} className="auth-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
      <label htmlFor={ids.p} className="auth-label mono">
        Password {signUp && <span className="faint">(at least 12 characters)</span>}
      </label>
      <input id={ids.p} className="auth-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signUp ? "new-password" : "current-password"} minLength={signUp ? 12 : undefined} required />
      <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
        {busy ? "…" : signUp ? "Create account" : "Sign in"}
      </button>
      <button type="button" className="text-link" onClick={() => setSignUp((s) => !s)}>
        {signUp ? "I already have an account" : "Create an account"}
      </button>
    </form>
  );
}

function TokenForm({ busy, onGo }: { busy: boolean; onGo: (t: string) => void }) {
  const [token, setValue] = useState("");
  const id = useId();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onGo(token);
      }}
    >
      <p className="muted">
        Self-hosted, single-tenant servers have one operator token, printed at startup (<code className="mono">QORVEX_ADMIN_TOKEN</code>). It is kept for this tab only.
      </p>
      <label htmlFor={id} className="auth-label mono">
        Operator token
      </label>
      <input id={id} type="password" className="auth-input mono" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setValue(e.target.value)} required />
      <button type="submit" className="btn btn-primary auth-submit" disabled={busy}>
        {busy ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}
