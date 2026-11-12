import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { getToken } from "../lib/session";
import { Logo } from "./Logo";

const NAV = [
  { to: "/#approach", label: "Product", match: (path: string, hash: string) => path === "/" && ["#approach", "#how-it-works", "#capabilities", "#trust", "#verification"].includes(hash) },
  { to: "/docs", label: "Documentation", match: (path: string) => path.startsWith("/docs") },
];

export function SiteHeader() {
  const { pathname, hash } = useLocation();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // Re-read on every navigation, so sign-in and sign-out are reflected immediately.
  const signedIn = !!getToken();
  const account = signedIn ? { to: "/app", label: "Console" } : { to: "/sign-in", label: "Sign in" };

  useEffect(() => setOpen(false), [pathname, hash]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className={`site-header${scrolled ? " is-scrolled" : ""}${open ? " is-open" : ""}`}>
      <div className="container site-header-inner">
        <Logo />
        <nav className="site-nav" aria-label="Primary">
          <ul>
            {NAV.map((n) => {
              const active = n.match(pathname, hash);
              return (
                <li key={n.label}>
                  <Link to={n.to} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="site-actions">
          <NavLink to={account.to} className="btn btn-secondary btn-sm">
            {account.label}
          </NavLink>
          <Link to="/docs/getting-started" className="btn btn-primary btn-sm">
            Get started
          </Link>
        </div>
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <span />
          <span />
        </button>
      </div>
      <div id="mobile-menu" className="mobile-menu" hidden={!open}>
        <nav aria-label="Mobile">
          {NAV.map((n) => (
            <Link key={n.label} to={n.to}>
              {n.label}
            </Link>
          ))}
          <div className="mobile-menu-actions">
            <Link to={account.to} className="btn btn-secondary">
              {account.label}
            </Link>
            <Link to="/docs/getting-started" className="btn btn-primary">
              Get started
            </Link>
          </div>
        </nav>
      </div>
    </header>
  );
}
