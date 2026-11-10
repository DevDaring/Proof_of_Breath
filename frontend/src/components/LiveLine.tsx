import { useEffect, useRef } from 'react';

/** A live line over a sliding time window. Single series, so the card title names it and there is no legend. */
export function LiveLine({ points, windowS, color = 'var(--accent)', height = 160, label, fixed }: {
  points: number[][]; windowS: number; color?: string; height?: number; label: string; fixed?: [number, number];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    const h = el.clientHeight;
    el.width = width * ratio;
    el.height = h * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const styles = getComputedStyle(el);
    const stroke = color.startsWith('var(') ? styles.getPropertyValue(color.slice(4, -1)).trim() || '#6fd6c4' : color;
    const grid = styles.getPropertyValue('--grid').trim() || '#2a3440';
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(h * f) + 0.5);
      ctx.lineTo(width, Math.round(h * f) + 0.5);
      ctx.stroke();
    }
    if (points.length < 2) return;
    const end = points[points.length - 1][0];
    const start = end - windowS;
    const shown = points.filter((p) => p[0] >= start);
    const values = shown.map((p) => p[1]);
    let [low, high] = fixed ?? [Math.min(...values), Math.max(...values)];
    if (high - low < 1e-6) { low -= 1; high += 1; }
    const pad = 12;
    const x = (t: number) => ((t - start) / windowS) * width;
    const y = (v: number) => h - pad - ((v - low) / (high - low)) * (h - 2 * pad);
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, `${stroke}40`);
    gradient.addColorStop(1, `${stroke}00`);
    ctx.beginPath();
    shown.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
    ctx.lineTo(x(shown[shown.length - 1][0]), h);
    ctx.lineTo(x(shown[0][0]), h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    shown.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    const last = shown[shown.length - 1];
    ctx.beginPath();
    ctx.arc(x(last[0]), y(last[1]), 4, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();
  }, [points, windowS, color, fixed]);
  return <canvas ref={canvas} className="live-line" style={{ height }} role="img" aria-label={label} />;
}
