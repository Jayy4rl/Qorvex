/** A small inline chart of one series; a red dot marks points where the rule failed. */
export function Sparkline({ values, fails, label, height = 36 }: { values: number[]; fails?: boolean[]; label: string; height?: number }) {
  if (values.length < 2) return <span className="faint small">collecting data…</span>;
  const w = 160;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} width={w} height={height} role="img" aria-label={label}>
      <path d={d} fill="none" stroke="var(--lime)" strokeWidth="1.5" />
      {fails?.map((f, i) => (f ? <circle key={i} cx={x(i)} cy={y(values[i])} r="2.5" fill="var(--bad)" /> : null))}
    </svg>
  );
}
