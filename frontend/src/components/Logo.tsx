import { Link } from "react-router";

/** The Qorvex mark: a "Q" whose tail is a breaker handle. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--lime)" />
      <path d="M16 7.5a8.5 8.5 0 1 0 4.9 15.45l2.6 2.6 2.1-2.1-2.6-2.6A8.5 8.5 0 0 0 16 7.5Zm0 3a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z" fill="var(--lime-ink)" />
    </svg>
  );
}

export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <Link to="/" className="logo" aria-label="Qorvex home" onClick={onClick}>
      <LogoMark />
      <span>Qorvex</span>
    </Link>
  );
}
