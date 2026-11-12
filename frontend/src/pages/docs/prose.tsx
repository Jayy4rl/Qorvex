import type { ReactNode } from "react";
import { Link } from "react-router";
import { docPath } from "../../lib/docs-index";

/** Section heading with a stable id and a hover anchor. Collected by the "On this page" list. */
export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="doc-h2">
      <a href={`#${id}`} className="anchor" aria-hidden="true" tabIndex={-1}>
        #
      </a>
      {children}
    </h2>
  );
}

export function H3({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="doc-h3">
      {children}
    </h3>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="doc-lead">{children}</p>;
}

export function Callout({ tone = "note", title, children }: { tone?: "note" | "warn" | "ok"; title?: string; children: ReactNode }) {
  return (
    <aside className={`callout callout-${tone}`}>
      {title && <p className="callout-title mono">{title}</p>}
      <div>{children}</div>
    </aside>
  );
}

/** Link to another docs page (and optional anchor). */
export function DocLink({ slug, anchor, children }: { slug: string; anchor?: string; children: ReactNode }) {
  return <Link to={docPath(slug, anchor)}>{children}</Link>;
}

/** Inline code. */
export function C({ children }: { children: ReactNode }) {
  return <code className="ic">{children}</code>;
}

/** Path in the Qorvex repository, shown as code. */
export function RepoPath({ path }: { path: string }) {
  return <code className="ic repo-path">{path}</code>;
}
