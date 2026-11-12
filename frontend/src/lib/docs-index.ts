/**
 * Documentation table of contents. Metadata only, so the landing page, header and footer can
 * link into the docs without loading their content. Content lives in pages/docs/content.
 */
export interface DocMeta {
  /** URL segment under /docs ("" is the docs home). */
  slug: string;
  title: string;
  /** Short line for cards and link lists. */
  summary: string;
  group: DocGroup;
}

export type DocGroup = "Overview" | "Integrate" | "Operate" | "Reference";

export const DOC_GROUPS: DocGroup[] = ["Overview", "Integrate", "Operate", "Reference"];

export const DOCS: DocMeta[] = [
  { slug: "", title: "Introduction and architecture", summary: "What Qorvex is, its layers and how the pieces fit together.", group: "Overview" },
  { slug: "getting-started", title: "Getting started", summary: "Run Qorvex locally with the sandbox demo, then sign in as an operator.", group: "Overview" },
  { slug: "connecting-contracts", title: "Connecting contracts", summary: "Connect a contract or Sputnik DAO and take it from connected to protected.", group: "Integrate" },
  { slug: "security-policies", title: "Security policies", summary: "Rule types, responses, AI drafting, validation, backtests and approval.", group: "Integrate" },
  { slug: "contract-guard", title: "Contract guard integration", summary: "Embed the qorvex-guard crate for in-contract caps and the self-accounting pause.", group: "Integrate" },
  { slug: "relayer-sdk", title: "Relayer SDK integration", summary: "Check every sponsored action against budgets before the relayer signs.", group: "Integrate" },
  { slug: "watcher-and-guardian", title: "Watcher and guardian", summary: "How breaches are detected, confirmed and paused, and how alerts are sent.", group: "Operate" },
  { slug: "status-pages", title: "Public status pages", summary: "Publish checks anyone can verify from the raw RPC reads.", group: "Operate" },
  { slug: "security-model", title: "Security model and limitations", summary: "What Qorvex can and cannot do, the trust boundaries and known gaps.", group: "Reference" },
];

export function docPath(slug: string, anchor?: string): string {
  const base = slug ? `/docs/${slug}` : "/docs";
  return anchor ? `${base}#${anchor}` : base;
}

export function findDoc(slug: string): DocMeta | undefined {
  return DOCS.find((d) => d.slug === slug);
}
