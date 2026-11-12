import { Link, useLocation } from "react-router";
import { useTitle } from "../lib/hooks";
import "../styles/auth.css";

export default function NotFound() {
  useTitle("Page not found");
  const { pathname } = useLocation();
  const isStatus = pathname.startsWith("/status/");
  return (
    <section className="auth-page container" aria-labelledby="nf-title">
      <div className="auth-card card">
        <p className="eyebrow">404</p>
        <h1 id="nf-title" className="serif auth-title">
          {isStatus ? "Status page not available here yet." : "This page doesn’t exist."}
        </h1>
        <p className="muted">
          {isStatus ? (
            <>
              The web view for public status pages is part of the console rebuild. The page’s data is available now as JSON at{" "}
              <code className="mono">{`/api${pathname}`}</code>.
            </>
          ) : (
            <>
              Nothing lives at <code className="mono">{pathname}</code>.
            </>
          )}
        </p>
        <div className="auth-actions">
          <Link to="/" className="btn btn-primary">
            Go to the home page
          </Link>
          <Link to={isStatus ? "/docs/status-pages" : "/docs"} className="btn btn-secondary">
            {isStatus ? "Status page docs" : "Documentation"}
          </Link>
        </div>
      </div>
    </section>
  );
}
