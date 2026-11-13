import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { PublicLayout } from "../components/PublicLayout";
import { DOCS, docPath } from "../lib/docs-index";
import { DOC_CONTENT } from "../pages/docs/content";
import DocsPage from "../pages/docs/DocsPage";
import Landing from "../pages/landing/Landing";
import NotFound from "../pages/NotFound";
import SignIn from "../pages/SignIn";

/** Server-renders a path through the same route shapes as App.tsx (pages imported eagerly). */
function render(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<Landing />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="docs/:slug" element={<DocsPage />} />
          <Route path="sign-in" element={<SignIn />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const internalLinks = (html: string) => [...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

const pages = new Map<string, string>();
pages.set("/", render("/"));
for (const d of DOCS) pages.set(docPath(d.slug), render(docPath(d.slug)));
pages.set("/sign-in", render("/sign-in"));

describe("docs registry", () => {
  it("has content for every docs entry and no orphan content", () => {
    expect(Object.keys(DOC_CONTENT).sort()).toEqual(DOCS.map((d) => d.slug).sort());
  });

  it("has unique slugs and titles", () => {
    expect(new Set(DOCS.map((d) => d.slug)).size).toBe(DOCS.length);
    expect(new Set(DOCS.map((d) => d.title)).size).toBe(DOCS.length);
  });

  it("renders every page with its title and at least one section", () => {
    for (const d of DOCS) {
      const html = pages.get(docPath(d.slug))!;
      expect(html).toContain(`id="doc-title"`);
      expect(html).toContain(d.title.replace(/&/g, "&amp;"));
      expect(html).toMatch(/class="doc-h2"/);
    }
  });
});

describe("internal links", () => {
  it("every internal link on every page resolves to a real route and anchor", () => {
    const problems: string[] = [];
    for (const [from, html] of pages) {
      for (const href of internalLinks(html)) {
        const [path, anchor] = href.split("#");
        const known = path === "/" || path === "/sign-in" || path === "/app" || path === "/check" || path === "/docs" || DOCS.some((d) => docPath(d.slug) === path);
        if (!known) {
          problems.push(`${from} → ${href}: unknown route`);
          continue;
        }
        if (anchor) {
          const target = pages.get(path);
          if (!target) problems.push(`${from} → ${href}: anchor on a page that wasn't rendered`);
          else if (!ids(target).has(anchor)) problems.push(`${from} → ${href}: no element with id "${anchor}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("header CTAs lead to real flows", () => {
    const html = pages.get("/")!;
    expect(html).toMatch(/href="\/sign-in"[^>]*>Sign in/);
    // Every "Get started" goes to the contract check, which needs no account.
    expect(html).toMatch(/href="\/check"[^>]*>Get started/);
    expect(html).not.toMatch(/href="\/docs\/getting-started"[^>]*>Get started/);
    expect(html).toMatch(/href="\/docs"[^>]*>Explore documentation/);
  });
});

describe("landing page", () => {
  const html = pages.get("/")!;
  it("has one h1 and the required sections", () => {
    expect(html.match(/<h1/g)?.length).toBe(1);
    for (const id of ["approach", "how-it-works", "capabilities", "trust", "verification", "final-title", "problem-title"]) expect(ids(html).has(id)).toBe(true);
    expect(html).toContain("Make runtime security part of your");
  });

  it("labels the preview as recorded data", () => {
    expect(html).toContain("Recorded values, not live data.");
  });

  it("opens external links safely", () => {
    for (const m of html.matchAll(/<a [^>]*href="https?:[^"]*"[^>]*>/g)) expect(m[0]).toContain('rel="noreferrer"');
  });
});

describe("not found", () => {
  it("renders a 404 for unknown paths and docs slugs", () => {
    expect(render("/nope")).toContain("This page doesn’t exist.");
    expect(render("/docs/nope")).toContain("This page doesn’t exist.");
    expect(render("/status/prt_123")).toContain("/api/status/prt_123");
  });
});
