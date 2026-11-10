import { useEffect, useRef, useState } from 'react';

/** Decorative motion. Everything here is aria-hidden or plain text, and stops for prefers-reduced-motion. */

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Slow drifting colour behind every page. */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <i className="a1" /><i className="a2" /><i className="a3" />
      <span className="aurora-grid" />
    </div>
  );
}

/** Lights up the border of whichever card the pointer is over. One listener for the whole app. */
export function useSpotlight() {
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      const e = last;
      if (!e) return;
      const el = (e.target as Element | null)?.closest?.('.card') as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    const move = (e: PointerEvent) => { last = e; if (!raf) raf = requestAnimationFrame(apply); };
    window.addEventListener('pointermove', move, { passive: true });
    return () => { window.removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, []);
}

/** A breathing cycle used by the decorative visuals: 4 s in, 4 s out. 0 is empty, 1 is full. */
const CYCLE_S = 8;
const breathLevel = (t: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / CYCLE_S);

/**
 * Flowing lines that swell and settle like a breath, with drifting motes. Canvas, sized to its box,
 * paused when off screen.
 */
export function BreathField({ className = '', lines = 16, cue = false }: { className?: string; lines?: number; cue?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [word, setWord] = useState('Breathe in');
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = true;
    const still = reducedMotion();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const motes = Array.from({ length: 46 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.8, s: 0.2 + Math.random() * 0.8, p: Math.random() * 6.28 }));
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const start = performance.now();
    let lastWord = '';
    const frame = (now: number) => {
      const t = still ? 2 : (now - start) / 1000;
      const b = breathLevel(t);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < lines; i++) {
        const f = i / (lines - 1);
        const base = h * (0.18 + 0.64 * f);
        const amp = h * (0.05 + 0.11 * b) * (0.55 + 0.45 * Math.sin(f * 3.1 + 0.6));
        const hue = 168 + 72 * f; // teal to violet
        ctx.strokeStyle = `hsla(${hue}, 85%, ${64 + 10 * b}%, ${0.16 + 0.5 * (1 - Math.abs(f - 0.5) * 1.6) * (0.6 + 0.4 * b)})`;
        ctx.lineWidth = 1.2 + 0.8 * (1 - Math.abs(f - 0.5) * 2);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 6) {
          const u = x / w;
          const env = Math.sin(Math.PI * u) ** 0.8;
          const y = base
            + amp * env * Math.sin(u * 6.2 + t * 0.55 + i * 0.42)
            + amp * 0.35 * env * Math.sin(u * 13.5 - t * 0.9 + i * 0.8);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      for (const m of motes) {
        const y = ((m.y - t * 0.012 * m.s * (0.4 + b)) % 1 + 1) % 1;
        const x = m.x + 0.01 * Math.sin(t * 0.6 + m.p);
        ctx.fillStyle = `rgba(200, 255, 243, ${0.12 + 0.4 * b * Math.sin(Math.PI * y)})`;
        ctx.beginPath();
        ctx.arc(x * w, y * h, m.r * (0.8 + 0.5 * b), 0, 6.283);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      if (cue) {
        const next = Math.sin((2 * Math.PI * t) / CYCLE_S) >= 0 ? 'Breathe in' : 'Breathe out';
        if (next !== lastWord) { lastWord = next; setWord(next); }
        canvas.style.setProperty('--b', b.toFixed(3));
      }
      if (!still && visible) raf = requestAnimationFrame(frame);
    };
    const ro = new ResizeObserver(() => { resize(); if (still) frame(performance.now()); });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      const was = visible;
      visible = e.isIntersecting;
      if (visible && !was && !still) raf = requestAnimationFrame(frame);
    });
    io.observe(canvas);
    resize();
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, [lines, cue]);
  return (
    <div className={`breath-field ${className}`} aria-hidden="true">
      <canvas ref={ref} />
      {cue && <span className="breath-cue" key={word}>{word}</span>}
    </div>
  );
}

/** Counts up to a whole number the first time it is on screen. Other text is shown as it is. */
export function CountUp({ value, ms = 1100 }: { value: string; ms?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const target = /^\d+$/.test(value) ? Number(value) : null;
  const [shown, setShown] = useState(target === null || reducedMotion() ? value : '0');
  useEffect(() => {
    if (target === null || reducedMotion()) { setShown(value); return; }
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        const eased = 1 - (1 - k) ** 3;
        setShown(String(Math.round(target * eased)));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
    io.observe(el);
    // Never left at zero: if it is not seen soon, show the real number.
    const fallback = setTimeout(() => { if (!raf) { io.disconnect(); setShown(value); } }, 1200);
    return () => { io.disconnect(); cancelAnimationFrame(raf); clearTimeout(fallback); };
  }, [value, target, ms]);
  return <span ref={ref}>{shown}</span>;
}

/** A one-off burst of light, for a pattern that was followed. */
export function Burst() {
  const bits = useRef(Array.from({ length: 26 }, (_, i) => ({
    a: (i / 26) * 360 + Math.random() * 10, d: 60 + Math.random() * 90, s: 4 + Math.random() * 5, c: i % 3,
  }))).current;
  if (reducedMotion()) return null;
  return (
    <span className="burst" aria-hidden="true">
      {bits.map((b, i) => <i key={i} className={`c${b.c}`} style={{ ['--a' as any]: `${b.a}deg`, ['--d' as any]: `${b.d}px`, ['--s' as any]: `${b.s}px` }} />)}
    </span>
  );
}

type Line = { kind: 'user' | 'tool' | 'ok' | 'hold' | 'bad' | 'breath' | 'note'; text: string; sub?: string };

// Two short stories, played in turn. The command text and the hook's message are what the real hook prints.
const STORIES: { title: string; lines: Line[] }[] = [
  {
    title: 'A person is at the keyboard',
    lines: [
      { kind: 'user', text: 'tidy up the old staging data' },
      { kind: 'tool', text: 'git status' },
      { kind: 'ok', text: 'Ran untouched', sub: 'no rule matched' },
      { kind: 'tool', text: 'DROP TABLE customers;' },
      { kind: 'hold', text: 'Proof of Breath: complete the check at pob.koushikdeb.com/gate/…', sub: 'held by rule: drop a SQL table' },
      { kind: 'breath', text: 'A new pattern appears. The person follows it.' },
      { kind: 'ok', text: 'Pattern followed, live pulse present', sub: 'one token for this exact command' },
      { kind: 'note', text: 'Receipt added to the chain' },
    ],
  },
  {
    title: 'Nobody is watching',
    lines: [
      { kind: 'user', text: 'free up disk space on the server' },
      { kind: 'tool', text: 'rm -rf /var/lib/app' },
      { kind: 'hold', text: 'Proof of Breath: complete the check at pob.koushikdeb.com/gate/…', sub: 'held by rule: recursive delete' },
      { kind: 'breath', text: 'An old recording is played to the camera.' },
      { kind: 'bad', text: 'Not matched', sub: 'the pattern is new every time, so a replay cannot follow it' },
      { kind: 'note', text: 'The command stays blocked' },
    ],
  },
];

/** A looping terminal that tells the story: routine commands pass, a destructive one waits for a breath. */
export function AgentDemo() {
  const still = reducedMotion();
  const [story, setStory] = useState(0);
  const [count, setCount] = useState(still ? STORIES[0].lines.length : 0);
  const [typed, setTyped] = useState(still ? Infinity : 0);
  const lines = STORIES[story].lines;
  useEffect(() => {
    if (still) return;
    let timer: ReturnType<typeof setTimeout>;
    if (count >= lines.length) {
      timer = setTimeout(() => { setStory((s) => (s + 1) % STORIES.length); setCount(0); setTyped(0); }, 3600);
    } else {
      const line = lines[count];
      const typing = line.kind === 'user' || line.kind === 'tool';
      if (typing && typed < line.text.length) timer = setTimeout(() => setTyped((n) => n + 1), line.kind === 'user' ? 38 : 26);
      else timer = setTimeout(() => { setCount((c) => c + 1); setTyped(0); }, line.kind === 'breath' ? 4200 : line.kind === 'hold' ? 1500 : 650);
    }
    return () => clearTimeout(timer);
  }, [count, typed, lines, still]);
  const visible = lines.slice(0, Math.min(lines.length, count + 1));
  return (
    <div className="term" aria-label="Illustration of an agent session" role="img">
      <div className="term-bar"><i /><i /><i /><span>{STORIES[story].title}</span><em>illustration</em></div>
      <div className="term-body" key={story}>
        {visible.map((l, i) => {
          const active = i === count;
          const text = active && (l.kind === 'user' || l.kind === 'tool') ? l.text.slice(0, typed) : l.text;
          return (
            <div key={i} className={`tl ${l.kind}`}>
              {l.kind === 'user' && <><b className="pr">›</b><span>{text}</span></>}
              {l.kind === 'tool' && <><b className="tag">Bash</b><code>{text}</code></>}
              {(l.kind === 'ok' || l.kind === 'bad' || l.kind === 'hold' || l.kind === 'note') && (
                <><b className="ic">{l.kind === 'ok' ? '✓' : l.kind === 'bad' ? '✕' : l.kind === 'hold' ? '⏸' : '⛓'}</b><span>{text}{l.sub && <small>{l.sub}</small>}</span></>
              )}
              {l.kind === 'breath' && (
                <div className={`mini-pacer ${story === 1 ? 'replay' : ''}`}>
                  <span className="mini-orb" />
                  <svg viewBox="0 0 200 44" preserveAspectRatio="none">
                    <path className="mt" d="M0 38 C 20 38, 28 6, 50 6 S 78 38, 100 38 S 118 10, 140 10 S 170 38, 200 36" />
                    <path className="mr" d={story === 1 ? 'M0 22 C 22 18, 34 30, 54 26 S 84 14, 104 20 S 130 30, 150 24 S 180 16, 200 22' : 'M0 39 C 21 38, 29 9, 51 8 S 79 37, 101 37 S 119 12, 141 12 S 171 37, 200 35'} />
                  </svg>
                  <span className="mini-text">{l.text}</span>
                </div>
              )}
              {active && (l.kind === 'user' || l.kind === 'tool') && <i className="caret" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
