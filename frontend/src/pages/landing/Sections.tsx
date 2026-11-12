import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  IconArrow,
  IconBell,
  IconCheck,
  IconCode,
  IconEye,
  IconKey,
  IconPause,
  IconPulse,
  IconRelay,
  IconShield,
  IconSpark,
  IconUser,
  IconVote,
  IconX,
} from "../../components/icons";
import { docPath } from "../../lib/docs-index";
import { DEMO_BREACH, DEMO_RELAYER } from "./demo-run";

function SectionHead({ eyebrow, title, lead, id, center }: { eyebrow: string; title: ReactNode; lead?: ReactNode; id: string; center?: boolean }) {
  return (
    <header className={`section-head reveal${center ? " is-center" : ""}`}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="serif section-title">
        {title}
      </h2>
      {lead && <p className="section-lead">{lead}</p>}
    </header>
  );
}

/* ------------------------------------------------------------------ problem */

const COMPARE = [
  {
    incident: "NEAR Intents ghost balances",
    source: "https://thecoding.substack.com/p/near-intents-ghost-fund-postmortem",
    before: { value: "~40 h", label: "running unnoticed" },
    after: { value: "4 blocks", label: "to pause, replayed on sandbox" },
  },
  {
    incident: "Trezu sponsor relayer",
    source: "https://github.com/NEAR-DevHub/trezu/issues/1871",
    before: { value: "2×", label: "drained, fixed by hand, drained again" },
    after: { value: "92 / 100", label: "drain calls refused" },
  },
];

export function Problem() {
  return (
    <section className="section" aria-labelledby="problem-title">
      <div className="container">
        <SectionHead
          id="problem-title"
          eyebrow="The problem"
          center
          title={
            <>
              One missing check. <em>$3.8M unbacked.</em>
            </>
          }
          lead="Two NEAR incidents this autumn. Both would have been stopped by a single rule."
        />
        <div className="compare reveal" role="table" aria-label="Incidents without and with Qorvex">
          <div className="compare-row compare-header" role="row">
            <span role="columnheader" className="sr-only">
              Incident
            </span>
            <span role="columnheader" className="mono compare-col-before">
              <span className="dot dot-bad" /> Without a breaker
            </span>
            <span role="columnheader" className="mono compare-col-after">
              <span className="dot dot-lime" /> With Qorvex
            </span>
          </div>
          {COMPARE.map((c) => (
            <div className="compare-row" role="row" key={c.incident}>
              <a className="compare-incident" role="rowheader" href={c.source} target="_blank" rel="noreferrer">
                {c.incident} <IconArrow size={14} />
              </a>
              <div className="compare-cell is-before" role="cell">
                <span className="serif compare-value">{c.before.value}</span>
                <span className="compare-label">{c.before.label}</span>
              </div>
              <div className="compare-cell is-after" role="cell">
                <span className="serif compare-value">{c.after.value}</span>
                <span className="compare-label">{c.after.label}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- benefits */

function RelayMini() {
  const total = DEMO_RELAYER.without.sponsored;
  const r = DEMO_RELAYER.with;
  return (
    <div className="mini mini-relay" aria-hidden="true">
      {Array.from({ length: 20 }, (_, i) => (
        <span key={i} className={i < Math.round((r.sponsored / total) * 20) ? "chip-ok" : "chip-refused"} />
      ))}
      <p className="mono mini-caption">
        <span>{r.sponsored} sponsored</span>
        <span className="lime">{r.refused} refused</span>
      </p>
    </div>
  );
}

function BlocksMini() {
  return (
    <div className="mini mini-blocks" aria-hidden="true">
      <div className="mini-track">
        {DEMO_BREACH.timeline.map((t, i) => (
          <span key={t.block} className={i === 0 ? "is-breach" : i === DEMO_BREACH.timeline.length - 1 ? "is-paused" : undefined} />
        ))}
      </div>
      <p className="mono mini-caption">
        <span>#{DEMO_BREACH.breachBlock} breach</span>
        <span className="lime">#{DEMO_BREACH.pausedBlock} paused</span>
      </p>
    </div>
  );
}

function StatusMini() {
  return (
    <div className="mini mini-status" aria-hidden="true">
      <div className="mini-status-row">
        <span className="dot dot-ok" />
        <span>USDC owed ≤ held</span>
        <span className="mono lime">Passing</span>
      </div>
      <div className="mini-status-row">
        <span className="dot dot-ok" />
        <span>Outflow under cap</span>
        <span className="mono lime">Passing</span>
      </div>
      <p className="mono mini-caption">
        <span>every value → raw RPC read</span>
      </p>
    </div>
  );
}

const BENEFITS = [
  { visual: <RelayMini />, tag: "Prevent", title: "Block bad payments before they’re signed.", doc: docPath("relayer-sdk") },
  { visual: <BlocksMini />, tag: "Detect and stop", title: "Pause the moment the books break.", doc: docPath("watcher-and-guardian") },
  { visual: <StatusMini />, tag: "Verify", title: "Prove your protocol is backed.", doc: docPath("status-pages") },
];

export function Approach() {
  return (
    <section className="section" id="approach" aria-labelledby="approach-title">
      <div className="container">
        <SectionHead
          id="approach-title"
          eyebrow="Why Qorvex"
          title={
            <>
              Limits before money moves. <em>A breaker</em> when it breaks.
            </>
          }
        />
        <div className="benefit-grid">
          {BENEFITS.map((b) => (
            <Link key={b.tag} to={b.doc} className="card benefit reveal">
              {b.visual}
              <p className="mono benefit-tag">{b.tag}</p>
              <h3 className="benefit-title">{b.title}</h3>
              <span className="text-link benefit-link">
                Learn more <IconArrow size={14} />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- how it works */

const STEPS = [
  { icon: <IconSpark size={22} />, who: "AI", title: "Drafts", body: "Rules from your contract, tested on its history." },
  { icon: <IconUser size={22} />, who: "You", title: "Approve", body: "Alert, pause or reject. Your call." },
  { icon: <IconCode size={22} />, who: "Code", title: "Enforces", body: "Every block. No AI on the pause path." },
];

export function HowItWorks() {
  return (
    <section className="section" id="how-it-works" aria-labelledby="how-title">
      <div className="container">
        <SectionHead
          id="how-title"
          eyebrow="How it works"
          center
          title={
            <>
              AI drafts. You approve. <em>Code enforces.</em>
            </>
          }
          lead="From contract ID to protected in minutes."
        />
        <ol className="flow-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flow-step reveal" style={{ transitionDelay: `${i * 80}ms` }}>
              <span className={`flow-icon flow-icon-${i}`}>{s.icon}</span>
              <p className="mono flow-who">
                {String(i + 1).padStart(2, "0")} · {s.who}
              </p>
              <h3 className="serif flow-title">{s.title}</h3>
              <p className="muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- capabilities */

const CAPABILITIES = [
  { icon: <IconShield />, title: "Contract guard", line: "Caps and same-tx pause", doc: docPath("contract-guard") },
  { icon: <IconRelay />, title: "Relayer SDK", line: "Budgets before signing", doc: docPath("relayer-sdk") },
  { icon: <IconPulse />, title: "Block watcher", line: "Checks every block", doc: docPath("watcher-and-guardian") },
  { icon: <IconPause />, title: "Guardian contract", line: "Pause-only, on record", doc: docPath("watcher-and-guardian", "guardian") },
  { icon: <IconVote />, title: "DAO firewall", line: "Rejects off-policy proposals", doc: docPath("security-policies", "proposal-policy") },
  { icon: <IconSpark />, title: "AI rule drafting", line: "Validated and backtested", doc: docPath("security-policies", "drafting") },
  { icon: <IconBell />, title: "Instant alerts", line: "Telegram and webhooks", doc: docPath("watcher-and-guardian", "alerts") },
  { icon: <IconEye />, title: "Status pages", line: "Public, verifiable health", doc: docPath("status-pages") },
];

export function Capabilities() {
  return (
    <section className="section" id="capabilities" aria-labelledby="cap-title">
      <div className="container">
        <SectionHead
          id="cap-title"
          eyebrow="Capabilities"
          title={
            <>
              Everything you need. <em>Nothing you don’t.</em>
            </>
          }
        />
        <ul className="cap-grid">
          {CAPABILITIES.map((c) => (
            <li key={c.title} className="reveal">
              <Link to={c.doc} className="card cap">
                <span className="cap-icon">{c.icon}</span>
                <span className="cap-text">
                  <span className="cap-title">{c.title}</span>
                  <span className="cap-line">{c.line}</span>
                </span>
                <IconArrow size={16} />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- trust model */

const CANNOT = ["Move funds", "Unpause", "Change limits", "Approve proposals"];

export function TrustModel() {
  return (
    <section className="section" id="trust" aria-labelledby="trust-title">
      <div className="container">
        <SectionHead
          id="trust-title"
          eyebrow="Security model"
          center
          title={
            <>
              It can pause. <em>It can’t touch funds.</em>
            </>
          }
          lead="Qorvex holds one key. NEAR itself limits it to a single method."
        />
        <figure className="chain reveal" aria-labelledby="chain-caption">
          <div className="chain-node">
            <span className="chain-icon">
              <IconPulse />
            </span>
            <span className="chain-name">Qorvex watcher</span>
            <span className="mono faint">off-chain</span>
          </div>
          <div className="chain-link">
            <span className="chain-line" aria-hidden="true" />
            <span className="chain-key mono">
              <IconKey size={14} /> pause only
            </span>
          </div>
          <div className="chain-node">
            <span className="chain-icon">
              <IconPause />
            </span>
            <span className="chain-name">Guardian</span>
            <span className="mono faint">records every pause</span>
          </div>
          <div className="chain-link">
            <span className="chain-line" aria-hidden="true" />
            <span className="chain-key mono">pause()</span>
          </div>
          <div className="chain-node is-yours">
            <span className="chain-icon">
              <IconShield />
            </span>
            <span className="chain-name">Your contract</span>
            <span className="mono faint">you unpause</span>
          </div>
          <figcaption id="chain-caption" className="sr-only">
            The Qorvex watcher holds a key limited to the guardian contract’s pause method. The guardian records each pause and forwards it to your
            contract. Only you can unpause.
          </figcaption>
        </figure>
        <div className="cannot reveal">
          <span className="mono faint">Qorvex can’t</span>
          <ul>
            {CANNOT.map((x) => (
              <li key={x} className="pill pill-bad">
                <IconX size={12} /> {x}
              </li>
            ))}
          </ul>
          <Link to={docPath("security-model")} className="text-link">
            Security model and limits <IconArrow size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- verification */

export function Verification() {
  return (
    <section className="section" id="verification" aria-labelledby="verify-title">
      <div className="container verify-grid">
        <div className="verify-copy">
          <SectionHead
            id="verify-title"
            eyebrow="Public verification"
            title={
              <>
                Don’t trust the dashboard. <em>Verify it.</em>
              </>
            }
            lead="Give depositors a public status page. Every number links to the on-chain read behind it."
          />
          <ul className="verify-points reveal">
            <li>
              <IconCheck size={18} /> No account needed
            </li>
            <li>
              <IconCheck size={18} /> Reproducible with one curl
            </li>
            <li>
              <IconCheck size={18} /> Pause history read from chain
            </li>
          </ul>
          <Link to={docPath("status-pages")} className="text-link reveal">
            How status pages work <IconArrow size={14} />
          </Link>
        </div>

        <div className="verify-visual">
          <article className="card status-card reveal" aria-label="Example status page from the recorded demo">
            <header className="status-head">
              <div>
                <p className="status-name">Demo ledger</p>
                <p className="mono faint">ledger.test.near</p>
              </div>
              <span className="pill pill-bad">
                <span className="dot dot-bad" /> Paused
              </span>
            </header>
            <div className="status-check">
              <div className="status-check-top">
                <span className="dot dot-bad" />
                <p>USDC owed must never exceed USDC held</p>
              </div>
              <dl className="status-values mono">
                <div>
                  <dt>owed</dt>
                  <dd>{DEMO_BREACH.evidence.owed}</dd>
                </div>
                <div>
                  <dt>held</dt>
                  <dd>{DEMO_BREACH.evidence.held}</dd>
                </div>
                <div>
                  <dt>shortfall</dt>
                  <dd className="bad">{DEMO_BREACH.evidence.shortfall}</dd>
                </div>
              </dl>
            </div>
            <div className="status-raw mono">
              <span className="raw-chip">
                <IconCheck size={12} /> raw RPC read
              </span>
              <span className="raw-chip">
                <IconCheck size={12} /> curl to reproduce
              </span>
              <span className="faint">paused at #{DEMO_BREACH.pausedBlock}</span>
            </div>
          </article>
          <p className="mono faint verify-note">Recorded sandbox demo values.</p>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- final CTA */

export function FinalCta() {
  return (
    <section className="final-cta" aria-labelledby="final-title">
      <div className="final-glow" aria-hidden="true" />
      <div className="container final-inner reveal">
        <h2 id="final-title" className="serif">
          Make runtime security part of your <em>infrastructure.</em>
        </h2>
        <p className="section-lead">
          Enforce security rules, monitor critical invariants, and give users independently verifiable visibility into protocol health.
        </p>
        <div className="hero-ctas">
          <Link to="/docs/getting-started" className="btn btn-primary btn-lg">
            Get started <IconArrow size={16} />
          </Link>
          <Link to="/docs" className="btn btn-secondary btn-lg">
            Read the documentation
          </Link>
        </div>
      </div>
    </section>
  );
}
