import { useEffect, useRef, useState } from 'react';
import { Phase } from '../lib/api';
import { play } from '../lib/audio';

const WORDS: Record<string, string> = { delay: 'Get ready', inhale: 'Breathe in', exhale: 'Breathe out', pause: 'Hold gently' };

function phaseAt(phases: Phase[], t: number) {
  let elapsed = 0;
  for (const p of phases) {
    if (t < elapsed + p.duration) return { kind: p.kind, left: elapsed + p.duration - t, duration: p.duration };
    elapsed += p.duration;
  }
  return null;
}

/** Expanding circle driven by the target pattern, on the clock the server announced. */
export function Pacer({ phases, target, t0Perf, state }: { phases: Phase[] | null; target: number[] | null; t0Perf: number | null; state: string }) {
  const circle = useRef<HTMLDivElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [ripple, setRipple] = useState(0);
  const [label, setLabel] = useState('');
  const [sub, setSub] = useState('');
  const lastPhase = useRef<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const t = t0Perf === null ? -1 : (performance.now() - t0Perf) / 1000;
      let level = 0;
      let word = '';
      let detail = '';
      let progress = 0;
      let kind = state;
      if (state === 'arming') {
        word = 'Starting';
        detail = 'Waiting for the sensor';
      } else if (state === 'warmup' || (state === 'running' && t < 0)) {
        word = 'Sit still';
        detail = t < 0 ? `Pacer starts in ${Math.ceil(-t)} s` : '';
      } else if (state === 'running' && phases && target) {
        const current = phaseAt(phases, t);
        const index = Math.min(target.length - 1, Math.max(0, Math.floor(t * 10)));
        level = target[index] ?? 0;
        if (current) {
          word = WORDS[current.kind];
          detail = `${Math.ceil(current.left)} s`;
          progress = current.duration > 0 ? 1 - current.left / current.duration : 0;
          kind = current.kind;
          if (lastPhase.current !== current.kind) {
            lastPhase.current = current.kind;
            setRipple((n) => n + 1);
            if (current.kind !== 'delay') play(current.kind as 'inhale' | 'exhale' | 'pause');
          }
        } else {
          word = 'Almost done';
          detail = 'Keep breathing normally';
        }
      } else if (state === 'verifying') {
        word = 'Checking';
        detail = 'The server is scoring this attempt';
      }
      if (circle.current) circle.current.style.transform = `scale(${0.5 + 0.5 * level})`;
      if (ring.current) ring.current.style.strokeDashoffset = String(1 - progress);
      if (root.current && root.current.dataset.phase !== kind) root.current.dataset.phase = kind;
      root.current?.style.setProperty('--level', level.toFixed(3));
      setLabel((prev) => (prev === word ? prev : word));
      setSub((prev) => (prev === detail ? prev : detail));
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [phases, target, t0Perf, state]);

  useEffect(() => {
    lastPhase.current = null;
  }, [phases]);

  return (
    <div className="pacer" data-testid="pacer" ref={root}>
      <div className="pacer-ring" />
      <div className="pacer-halo" aria-hidden="true" />
      <svg className="pacer-progress" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="48.5" pathLength={1} className="track" />
        <circle cx="50" cy="50" r="48.5" pathLength={1} className="bar" ref={ring} />
      </svg>
      {ripple > 0 && <span className="pacer-ripple" key={ripple} aria-hidden="true" />}
      <div className="pacer-circle" ref={circle} />
      <div className="pacer-text">
        <div className="pacer-word" aria-live="polite" data-testid="pacer-word">{label}</div>
        <div className="pacer-sub">{sub}</div>
      </div>
    </div>
  );
}
