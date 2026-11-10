import { useMemo, useRef, useState } from 'react';

export interface Series { id: string; label: string; points: number[][]; color: string; dashed?: boolean; dots?: boolean; width?: number; unit?: string; digits?: number }
export interface Band { start: number; end: number; kind: 'warn' | 'gap' | 'focus'; label: string }

const W = 1000;

function nearest(points: number[][], t: number): number[] | null {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo][0] - t) <= Math.abs(points[hi][0] - t) ? points[lo] : points[hi];
}

const fmtT = (t: number, long = false) => (t >= 60 || long ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : `${t.toFixed(t < 10 ? 1 : 0)} s`);

/** Lines over time in SVG, one shared y-axis, with bands, a crosshair and a tooltip. */
export function TimeChart({ series, bands = [], domain, yDomain, height = 220, label, ticks = 6, yTicks, testId, draw = true, maxGap, robust }: {
  series: Series[]; bands?: Band[]; domain: [number, number]; yDomain?: [number, number]; height?: number; label: string;
  ticks?: number; yTicks?: number[]; testId?: string; draw?: boolean; maxGap?: number;
  /** Fit the y-axis to the 1st to 99th percentile so a few spikes do not flatten the rest. Spikes are clipped. */
  robust?: boolean;
}) {
  const long = domain[1] - domain[0] > 90;
  const clip = useMemo(() => `c${Math.random().toString(36).slice(2, 8)}`, []);
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const H = height;
  const [t0, t1] = domain;
  const [lo, hi] = useMemo(() => {
    if (yDomain) return yDomain;
    const vals = series.flatMap((s) => s.points.filter((p) => p[0] >= t0 && p[0] <= t1).map((p) => p[1]));
    if (!vals.length) return [0, 1];
    const sorted = robust ? [...vals].sort((p, q) => p - q) : vals;
    let a = robust ? sorted[Math.floor(sorted.length * 0.01)] : Math.min(...vals);
    let b = robust ? sorted[Math.ceil(sorted.length * 0.99) - 1] : Math.max(...vals);
    if (b - a < 1e-6) { a -= 1; b += 1; }
    const m = (b - a) * (robust ? 0.25 : 0.08);
    return [a - m, b + m];
  }, [series, yDomain, t0, t1, robust]);
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const paths = useMemo(() => series.map((s) => {
    let d = '';
    let prev: number | null = null;
    for (const p of s.points) {
      if (p[0] < t0 || p[0] > t1) continue;
      const jump = prev === null || (maxGap !== undefined && p[0] - prev > maxGap);
      d += `${jump ? 'M' : 'L'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`;
      prev = p[0];
    }
    return d;
    // x and y depend only on the values listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [series, t0, t1, lo, hi, H, maxGap]);
  const xt = Array.from({ length: ticks + 1 }, (_, i) => t0 + ((t1 - t0) * i) / ticks);
  const yt = yTicks ?? [lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15];

  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
    setHover(t < t0 || t > t1 ? null : t);
  };
  const hits = hover === null ? [] : series.map((s) => ({ s, p: nearest(s.points.filter((p) => p[0] >= t0 && p[0] <= t1), hover) }));
  const band = hover === null ? undefined : bands.find((b) => hover >= b.start && hover <= b.end);
  const left = hover === null ? 0 : ((x(hover) / W) * 100);

  return (
    <div className="tchart" data-testid={testId}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height: H }}
        onPointerMove={move} onPointerLeave={() => setHover(null)}>
        <defs><clipPath id={clip}><rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H - pad.t - pad.b} /></clipPath></defs>
        {bands.map((b, i) => (
          <rect key={i} className={`band ${b.kind}`} x={x(Math.max(b.start, t0))} y={pad.t} width={Math.max(1, x(Math.min(b.end, t1)) - x(Math.max(b.start, t0)))} height={H - pad.t - pad.b} />
        ))}
        {yt.map((v, i) => <line key={i} className="grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />)}
        {series.map((s, i) => (
          <path key={s.id} d={paths[i]} clipPath={`url(#${clip})`} className={`series ${draw && !s.dashed ? 'draw' : ''}`} pathLength={draw && !s.dashed ? 1 : undefined} fill="none" stroke={s.color} strokeWidth={s.width ?? 2}
            strokeDasharray={s.dashed ? '7 6' : undefined} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {series.filter((s) => s.dots).map((s) => s.points.filter((p) => p[0] >= t0 && p[0] <= t1).map((p, i) => (
          <circle key={`${s.id}${i}`} cx={x(p[0])} cy={y(p[1])} r={3.2} className={p[2] !== undefined && p[2] < 45 ? 'dot weak' : 'dot'} style={{ ['--c' as any]: s.color }} />
        )))}
        {hover !== null && <line className="cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="tchart-y" aria-hidden="true">{yt.map((v, i) => <span key={i} style={{ top: `${(y(v) / H) * 100}%` }}>{Math.abs(hi - lo) >= 10 ? Math.round(v) : v.toFixed(1)}</span>)}</div>
      <div className="tchart-x" aria-hidden="true">{xt.map((t, i) => <span key={i} style={{ left: `${(x(t) / W) * 100}%` }}>{fmtT(t, long)}</span>)}</div>
      {hover !== null && (
        <div className={`tip ${left > 60 ? 'flip' : ''}`} style={{ left: `${left}%` }} role="status">
          <strong>{fmtT(hover, long)}</strong>
          {hits.map(({ s, p }) => p && (
            <span key={s.id}><i style={{ background: s.color }} />{s.label} <b>{p[1].toFixed(s.digits ?? 2)}{s.unit ? ` ${s.unit}` : ''}</b>{p[2] !== undefined && <em> · {Math.round(p[2])}% conf.</em>}</span>
          ))}
          {band && <span className="tip-band">{band.label}</span>}
        </div>
      )}
    </div>
  );
}

/** Values binned into a histogram with one threshold line. */
export function Histogram({ values, domain, bins = 20, threshold, label, thresholdLabel, color = 'var(--accent-2)', testId }: {
  values: number[]; domain: [number, number]; bins?: number; threshold: number; label: string; thresholdLabel: string; color?: string; testId?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [a, b] = domain;
  const width = (b - a) / bins;
  const counts = Array.from({ length: bins }, () => 0);
  for (const v of values) counts[Math.min(bins - 1, Math.max(0, Math.floor((v - a) / width)))] += 1;
  const top = Math.max(1, ...counts);
  const pos = (v: number) => ((v - a) / (b - a)) * 100;
  return (
    <div className="hist" data-testid={testId} role="img" aria-label={label}>
      <div className="hist-plot">
        {counts.map((c, i) => (
          <i key={i} className={`hist-bar ${a + (i + 1) * width > threshold ? 'over' : ''}`} style={{ left: `${pos(a + i * width)}%`, width: `calc(${100 / bins}% - 2px)`, height: `${(c / top) * 100}%`, ['--c' as any]: color }}
            onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
        ))}
        <span className="hist-th" style={{ left: `${pos(threshold)}%` }}><em>{thresholdLabel}</em></span>
        {hover !== null && (
          <span className="tip" style={{ left: `${pos(a + (hover + 0.5) * width)}%` }}>
            <strong>{(a + hover * width).toFixed(2)} to {(a + (hover + 1) * width).toFixed(2)}</strong>
            <span>{counts[hover]} of {values.length} patterns</span>
          </span>
        )}
      </div>
      <div className="hist-x"><span>{a.toFixed(1)}</span><span>{((a + b) / 2).toFixed(1)}</span><span>{b.toFixed(1)}</span></div>
    </div>
  );
}
