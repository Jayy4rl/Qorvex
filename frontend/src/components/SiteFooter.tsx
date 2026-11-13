import { Link } from "react-router";
import { DOCS, docPath } from "../lib/docs-index";
import { LogoMark } from "./Logo";

const PRODUCT = [
  { to: "/#approach", label: "The Qorvex approach" },
  { to: "/#how-it-works", label: "How it works" },
  { to: "/#capabilities", label: "Capabilities" },
  { to: "/#trust", label: "Trust and security model" },
  { to: "/#verification", label: "Public verification" },
];

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Link to="/" className="logo" aria-label="Qorvex home">
              <LogoMark />
              <span>Qorvex</span>
            </Link>
            <p className="muted">
              Spending limits and circuit breakers for NEAR contracts, DAO treasuries and gas relayers. AI drafts the rules, people approve them, and
              deterministic code enforces them.
            </p>
            <p className="footer-license mono faint">Open source · MIT licence</p>
          </div>
          <nav aria-label="Product" className="footer-col">
            <h2>Product</h2>
            <ul>
              {PRODUCT.map((l) => (
                <li key={l.to}>
                  <Link to={l.to}>{l.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Documentation" className="footer-col">
            <h2>Documentation</h2>
            <ul>
              {DOCS.map((d) => (
                <li key={d.slug}>
                  <Link to={docPath(d.slug)}>{d.title}</Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Operators" className="footer-col">
            <h2>Operators</h2>
            <ul>
              <li>
                <Link to="/sign-in">Sign in</Link>
              </li>
              <li>
                <Link to="/check">Get started</Link>
              </li>
            </ul>
          </nav>
        </div>
        <div className="footer-base">
          <span className="mono faint">© {new Date().getFullYear()} Qorvex</span>
          <span className="mono faint">Built for NEAR</span>
        </div>
      </div>
    </footer>
  );
}
