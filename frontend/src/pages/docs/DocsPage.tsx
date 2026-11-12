import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useParams } from "react-router";
import { IconArrow } from "../../components/icons";
import { DOC_GROUPS, DOCS, docPath, findDoc } from "../../lib/docs-index";
import { useTitle } from "../../lib/hooks";
import NotFound from "../NotFound";
import { DOC_CONTENT } from "./content";
import "../../styles/docs.css";

interface TocItem {
  id: string;
  text: string;
}

export default function DocsPage() {
  const { slug = "" } = useParams();
  const meta = findDoc(slug);
  const Content = meta ? DOC_CONTENT[meta.slug] : undefined;
  useTitle(meta ? (meta.slug ? `${meta.title} · Docs` : "Documentation") : "Page not found");

  const articleRef = useRef<HTMLElement>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = articleRef.current;
    if (!root) return setToc([]);
    const heads = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2[id]"));
    setToc(heads.map((h) => ({ id: h.id, text: (h.textContent ?? "").replace(/^#/, "").trim() })));
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px" },
    );
    heads.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [slug]);

  if (!meta || !Content) return <NotFound />;

  const index = DOCS.indexOf(meta);
  const prev = DOCS[index - 1];
  const next = DOCS[index + 1];

  return (
    <div className="docs container">
      <aside className="docs-sidebar" aria-label="Documentation">
        <details className="docs-nav-mobile" key={slug}>
          <summary>
            <span className="mono faint">Docs</span> {meta.title}
          </summary>
          <DocsNav />
        </details>
        <div className="docs-nav-desktop">
          <DocsNav />
        </div>
      </aside>

      <article ref={articleRef} className="docs-article prose" aria-labelledby="doc-title">
        <p className="eyebrow">{meta.group}</p>
        <h1 id="doc-title" className="serif doc-title">
          {meta.title}
        </h1>
        <Content />
        <nav className="doc-pager" aria-label="Previous and next pages">
          {prev ? (
            <Link to={docPath(prev.slug)} className="pager-link">
              <span className="mono faint">Previous</span>
              <span>{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to={docPath(next.slug)} className="pager-link pager-next">
              <span className="mono faint">Next</span>
              <span>
                {next.title} <IconArrow size={14} />
              </span>
            </Link>
          )}
        </nav>
      </article>

      <aside className="docs-toc" aria-label="On this page">
        {toc.length > 0 && (
          <>
            <p className="mono">On this page</p>
            <ul>
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className={activeId === t.id ? "active" : undefined}>
                    {t.text}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

function DocsNav() {
  return (
    <nav className="docs-nav">
      {DOC_GROUPS.map((g) => (
        <div key={g} className="docs-nav-group">
          <p className="mono">{g}</p>
          <ul>
            {DOCS.filter((d) => d.group === g).map((d) => (
              <li key={d.slug}>
                <NavLink to={docPath(d.slug)} end>
                  {d.title}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
