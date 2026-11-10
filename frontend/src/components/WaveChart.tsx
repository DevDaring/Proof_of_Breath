import { MutableRefObject, useEffect, useRef } from 'react';

const TARGET = '#8a97a8';
const MEASURED = '#6fd6c4';
const GRID = '#2a3440';

/** Target and measured breathing, overlaid. Each is scaled to its own range for shape only. */
export function WaveChart({ target, trace, lengthS, t0Perf }: { target: number[] | null; trace: MutableRefObject<number[][]>; lengthS: number; t0Perf: number | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const draw = () => {
      const el = canvas.current;
      if (!el) return;
      const ctx = el.getContext('2d');
      if (!ctx) return;
      const ratio = window.devicePixelRatio || 1;
      const width = el.clientWidth;
      const height = el.clientHeight;
      if (el.width !== width * ratio || el.height !== height * ratio) {
        el.width = width * ratio;
        el.height = height * ratio;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const pad = 10;
      const span = Math.max(lengthS + 3, 1);
      const x = (t: number) => (t / span) * width;
      const y = (v: number) => height - pad - v * (height - 2 * pad);
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y(0));
      ctx.lineTo(width, y(0));
      ctx.stroke();
      if (target?.length) {
        ctx.strokeStyle = TARGET;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        target.forEach((v, i) => (i ? ctx.lineTo(x(i / 10), y(v)) : ctx.moveTo(x(0), y(v))));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const points = trace.current;
      if (points.length > 1) {
        const values = points.map((p) => p[1]);
        const low = Math.min(...values);
        const range = Math.max(...values) - low || 1;
        ctx.strokeStyle = MEASURED;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        points.forEach((p, i) => {
          const py = y((p[1] - low) / range);
          if (i) ctx.lineTo(x(p[0]), py);
          else ctx.moveTo(x(p[0]), py);
        });
        ctx.stroke();
      }
      if (t0Perf !== null) {
        const t = (performance.now() - t0Perf) / 1000;
        if (t >= 0 && t <= span) {
          ctx.strokeStyle = '#4d5b6b';
          ctx.beginPath();
          ctx.moveTo(x(t), 0);
          ctx.lineTo(x(t), height);
          ctx.stroke();
        }
      }
    };
    draw();
    const timer = setInterval(draw, 100);
    return () => clearInterval(timer);
  }, [target, trace, lengthS, t0Perf]);

  return (
    <figure className="wave">
      <canvas ref={canvas} role="img" aria-label="The target breathing pattern with the measured breathing trace on top" data-testid="wave" />
      <figcaption>
        <span className="key"><i style={{ borderTop: `2px dashed ${TARGET}` }} /> Target pattern</span>
        <span className="key"><i style={{ borderTop: `3px solid ${MEASURED}` }} /> Your breathing</span>
      </figcaption>
    </figure>
  );
}
