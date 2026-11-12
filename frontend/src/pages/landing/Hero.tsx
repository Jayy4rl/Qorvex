import { Link } from "react-router";
import { IconArrow } from "../../components/icons";
import { DEMO_BREACH, DEMO_RELAYER, DEMO_RULES } from "./demo-run";

const STATS_LEFT = [
  { value: "4 blocks", label: "Breach to pause" },
  { value: "1 tx", label: "In-contract self-pause" },
];
const STATS_RIGHT = [
  { value: "0", label: "Keys that can move funds" },
  { value: "92%", label: "Drain calls refused" },
];

function Stats({ items, side }: { items: typeof STATS_LEFT; side: "left" | "right" }) {
  return (
    <dl className={`hero-stats hero-stats-${side}`}>
      {items.map((s) => (
        <div key={s.label}>
          <dt className="mono">{s.label}</dt>
          <dd className="serif">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-beams" aria-hidden="true" />
      <div className="container hero-inner">
        <Stats items={STATS_LEFT} side="left" />
        <div className="hero-copy">
          <p className="eyebrow hero-fade" style={{ animationDelay: "0ms" }}>
            Runtime security for NEAR
          </p>
          <h1 id="hero-title" className="serif hero-title hero-fade" style={{ animationDelay: "60ms" }}>
            Stop exploits in <br className="br-wide" />
            <em>blocks,</em> <span className="nowrap">not hours.</span>
          </h1>
          <p className="hero-sub hero-fade" style={{ animationDelay: "140ms" }}>
            Spending limits and circuit breakers for NEAR contracts, treasuries and relayers.
          </p>
          <div className="hero-ctas hero-fade" style={{ animationDelay: "220ms" }}>
            <Link to="/docs/getting-started" className="btn btn-primary btn-lg">
              Get started <IconArrow size={16} />
            </Link>
            <Link to="/docs" className="btn btn-secondary btn-lg">
              Explore documentation
            </Link>
          </div>
        </div>
        <Stats items={STATS_RIGHT} side="right" />
      </div>
      <HeroPreview />
    </section>
  );
}

const TRACK_LABELS = ["Breach", "Broadcast", "Tx lands", "Recorded", "Paused"];

function HeroPreview() {
  const total = DEMO_RELAYER.without.sponsored;
  return (
    <figure className="hero-preview container" aria-labelledby="preview-caption">
      <div className="preview-glow" aria-hidden="true" />
      <div className="preview-grid">
        <article className="card preview-card preview-left" aria-label="Approved rules">
          <header className="preview-head">
            <span className="dot dot-lime" /> <span className="mono">Approved rules</span>
          </header>
          <ul className="rule-list">
            {DEMO_RULES.map((r) => (
              <li key={r.id}>
                <span className="rule-kind mono" aria-hidden="true">
                  {r.kind}
                </span>
                <span className="rule-main">
                  <span className="rule-id mono">{r.id}</span>
                  <span className="rule-meta">{r.type}</span>
                </span>
                <span className={`pill ${r.response === "Pause" ? "pill-lime" : r.response === "Reject" ? "pill-outline-lime" : ""}`}>{r.response}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="card preview-card preview-center" aria-label="Breach to pause">
          <header className="preview-head">
            <span className="dot dot-lime" /> <span className="mono">Breach to pause</span>
            <span className="pill pill-outline-lime breach-pill">Auto-pause</span>
          </header>
          <div className="breach-headline">
            <span className="serif breach-number">{DEMO_BREACH.blocks}</span>
            <span className="breach-unit">
              blocks <span className="faint mono">· {DEMO_BREACH.secondsAfterDetection.toFixed(1)} s</span>
            </span>
          </div>
          <ol className="block-track">
            {DEMO_BREACH.timeline.map((t, i) => (
              <li key={t.block} className={i === 0 ? "is-breach" : i === DEMO_BREACH.timeline.length - 1 ? "is-paused" : undefined}>
                <span className="block-bar" aria-hidden="true" />
                <span className="block-num mono">#{t.block}</span>
                <span className="block-label">{TRACK_LABELS[i]}</span>
              </li>
            ))}
          </ol>
        </article>

        <article className="card preview-card preview-right" aria-label="Relayer check results">
          <header className="preview-head">
            <span className="dot dot-lime" /> <span className="mono">Relayer check()</span>
          </header>
          <div className="relay-rows">
            {(
              [
                ["Without Qorvex", DEMO_RELAYER.without],
                ["With Qorvex", DEMO_RELAYER.with],
              ] as const
            ).map(([label, r]) => (
              <div className="relay-row" key={label}>
                <div className="relay-label">
                  <span>{label}</span>
                  <span className={`mono ${r.refused ? "lime" : "faint"}`}>{r.refused} refused</span>
                </div>
                <div className="relay-bar" role="img" aria-label={`${r.sponsored} sponsored, ${r.refused} refused`}>
                  <span className="relay-sponsored" style={{ width: `${(r.sponsored / total) * 100}%` }} />
                  <span className="relay-refused" style={{ width: `${(r.refused / total) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
      <figcaption id="preview-caption" className="preview-caption mono">
        <span className="dot" /> From the recorded sandbox demo. Recorded values, not live data.
      </figcaption>
    </figure>
  );
}
