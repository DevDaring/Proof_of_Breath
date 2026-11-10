import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, message, Scores } from '../lib/api';
import { Button, useToast } from '../components/ui';
import { ScoreBars } from '../components/ScoreBars';
import { Band, Histogram, TimeChart } from '../components/TimeChart';
import { CountUp } from '../components/Fx';

interface Summary {
  duration_s: number; breath_samples: number; breath_first_s: number; pulse_readings: number; pulse_first_s: number | null;
  pulse_median_bpm: number | null; pulse_confident_share: number; breath_rate_median: number | null;
  pulse_gaps: number[][]; framing_problems: { start: number; end: number; hint: string }[]; confidence_floor: number;
}
interface Aggregate { n: number; seed: number; passed: number; passed_flipped: number; values: Record<string, number[]>; median: Record<string, number>; failure_counts: Record<string, number>; cycles_matched: number }
interface CaseView { source: Record<string, any>; summary: Summary; aggregate: Aggregate | null; breath: number[][]; pulse: number[][]; rate: number[][]; thresholds: Record<string, number> }
interface Challenge { t0: number; length_s: number; spans: [string, number, number][]; fs: number; measured: number[]; target: number[]; scores: Scores & { best_lag_s: number; failure_reasons: string[] }; failures: string[]; thresholds: Record<string, number>; gates: Record<string, boolean> }

const BREATH = '#5fe0c8';
const TARGET = '#aab6c6';
const PULSE = '#ff7d8a';
const RATE = '#8b8cff';
const REASON: Record<string, string> = { xcorr: 'Pattern not followed', phase: 'Timing off', cycles: 'Wrong breath count', live: 'No confident pulse', decoy: 'A decoy fit better' };

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

function Stat({ value, unit, label, test }: { value: string; unit?: string; label: string; test?: string }) {
  return <div className="stat" data-testid={test}><b><CountUp value={value} />{unit && <small>{unit}</small>}</b><span>{label}</span></div>;
}

function PhaseStrip({ spans, length }: { spans: [string, number, number][]; length: number }) {
  return (
    <div className="phase-strip" aria-label="Pattern phases">
      {spans.map(([kind, a, b], i) => <i key={i} className={kind} style={{ left: `${(a / length) * 100}%`, width: `${((b - a) / length) * 100}%` }} title={`${kind} ${(b - a).toFixed(1)} s`} />)}
    </div>
  );
}

export function CaseStudy() {
  const toast = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<CaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Challenge | null>(null);
  const [tally, setTally] = useState({ drawn: 0, passed: 0 });

  useEffect(() => {
    api.get<CaseView>('/api/case-study').then(setData).catch((e) => setError(message(e)));
  }, []);

  const challenge = async () => {
    try {
      const out = await api.post<Challenge>('/api/case-study/challenge', {});
      setRun(out);
      setTally((t) => ({ drawn: t.drawn + 1, passed: t.passed + (out.scores.passed ? 1 : 0) }));
    } catch (e) {
      toast(message(e), 'error');
    }
  };

  const practice = async () => {
    try {
      const out = await api.post<any>('/api/gate/requests', { practice: true });
      navigate(`/gate/${out.request_id}`);
    } catch (e) {
      toast(message(e), 'error');
    }
  };

  const bands = useMemo<Band[]>(() => {
    if (!data) return [];
    const out: Band[] = [
      ...data.summary.framing_problems.map((p) => ({ start: p.start, end: p.end, kind: 'warn' as const, label: `SDK: ${p.hint}` })),
      ...data.summary.pulse_gaps.filter((g) => g[0] > 0).map((g) => ({ start: g[0], end: g[1], kind: 'gap' as const, label: 'No confident pulse here' })),
    ];
    if (run) out.push({ start: run.t0, end: run.t0 + run.length_s, kind: 'focus', label: 'Window of your challenge' });
    return out;
  }, [data, run]);

  const overlay = useMemo(() => {
    if (!run) return null;
    const step = 1 / run.fs;
    const lag = run.scores.best_lag_s ?? 0;
    return {
      measured: run.measured.map((v, i) => [i * step, v]),
      target: run.target.map((v, i) => [i * step + lag, v]),
      length: run.length_s + 2.5,
    };
  }, [run]);

  if (error) return <main className="page narrow"><section className="card"><h1>Case study</h1><p className="muted">{error}</p></section></main>;
  if (!data) return <main className="page"><div className="skeleton tall" aria-busy="true" /></main>;
  const s = data.summary;
  const a = data.aggregate;
  const end = s.duration_s;

  return (
    <main className="page case">
      <header className="page-head">
        <span className="eyebrow">Case study · real SDK output</span>
        <h1>What the gate sees when someone is <span className="grad">not</span> following</h1>
        <p className="lead">A real person, recorded for a public research dataset, run through the Presage SmartSpectra SDK on this server. They never saw a pacer, so the honest answer to every challenge is no. Draw as many patterns as you like and watch the real verifier say it.</p>
      </header>

      <section className="stats" aria-label="What the SDK produced">
        <Stat value={fmtT(end)} label="of video through the SDK" />
        <Stat value={`${Math.round(s.breath_samples / end)}`} unit="/s" label={`breathing samples, from ${s.breath_first_s} s`} />
        <Stat value={`${s.pulse_readings}`} label={`pulse readings, first at ${s.pulse_first_s ?? '–'} s`} test="case-pulse-count" />
        <Stat value={s.pulse_median_bpm ? `${Math.round(s.pulse_median_bpm)}` : '–'} unit="bpm" label="median confident pulse" />
        <Stat value={s.breath_rate_median ? `${s.breath_rate_median}` : '–'} unit="/min" label="median SDK breathing rate" />
      </section>

      <section className="card">
        <div className="row between wrap">
          <h2>Breathing movement</h2>
          <span className="muted small">SDK upper-chest trace, arbitrary units</span>
        </div>
        <TimeChart testId="case-breath" label="The SDK breathing trace over the whole recording" domain={[0, end]} height={230} maxGap={1} robust
          series={[{ id: 'b', label: 'Chest trace', points: data.breath, color: BREATH, digits: 2 }]} bands={bands} ticks={11} />
        <div className="legend small">
          <span><i className="sw band-warn" /> SDK framing warning</span>
          <span><i className="sw band-gap" /> No confident pulse</span>
          <span className="muted">Axis fitted to the middle 98% of values; the largest spikes run off the chart.</span>
          {run && <span><i className="sw band-focus" /> Your challenge window</span>}
        </div>
      </section>

      <section className="grid-2">
        <section className="card">
          <div className="row between wrap"><h2>Pulse rate</h2><span className="muted small">12 s average, bpm</span></div>
          <TimeChart testId="case-pulse" label="SDK pulse rate over the recording" domain={[0, end]} height={190} maxGap={3} ticks={5}
            series={[{ id: 'p', label: 'Pulse', points: data.pulse, color: PULSE, dots: true, unit: 'bpm', digits: 0 }]} bands={bands.filter((b) => b.kind !== 'focus')} />
          <p className="muted small"><i className="dotkey" /> filled: confidence at or above {s.confidence_floor}% · <i className="dotkey weak" /> hollow: below. {Math.round(s.pulse_confident_share * 100)}% of readings were confident.</p>
        </section>
        <section className="card">
          <div className="row between wrap"><h2>Breathing rate</h2><span className="muted small">SDK estimate, per minute</span></div>
          {data.rate.length ? (
            <TimeChart testId="case-rate" label="SDK breathing rate over the recording" domain={[0, end]} height={190} maxGap={3} ticks={5}
              series={[{ id: 'r', label: 'Breathing rate', points: data.rate, color: RATE, unit: '/min', digits: 1 }]} />
          ) : <p className="muted">The SDK did not report a breathing rate for this capture.</p>}
          <p className="muted small">Display only. Neither rate decides anything: the gate scores the shape of the trace against the pattern.</p>
        </section>
      </section>

      <section className="card challenge-card">
        <div className="row between wrap">
          <div>
            <h2>Challenge this recording</h2>
            <p className="muted">A fresh random pattern and 20 decoys, placed at a random point after the 12 s warm-up, scored by the same code and thresholds as a real check.</p>
          </div>
          <Button className="btn primary big" onAct={challenge} busyLabel="Scoring…" data-testid="case-challenge">{run ? 'Draw another pattern' : 'Draw a pattern'}</Button>
        </div>
        {run && overlay && (
          <div className="challenge-out" data-testid="case-result">
            <div className={`verdict-line ${run.scores.passed ? 'pass' : 'fail'}`}>
              <strong data-testid="case-verdict">{run.scores.passed ? 'Passed by chance' : 'Rejected'}</strong>
              <span>{run.scores.passed
                ? 'This one slipped through. That is a false accept, and exactly what the evaluation counts.'
                : `Window ${fmtT(run.t0)} to ${fmtT(run.t0 + run.length_s)}. ${run.failures.join('. ')}.`}</span>
            </div>
            <PhaseStrip spans={run.spans} length={overlay.length} />
            <TimeChart testId="case-overlay" label="What the verifier compared: the pattern and the recorded breathing" domain={[0, overlay.length]} height={200} ticks={6} draw={false}
              series={[
                { id: 't', label: 'Pattern', points: overlay.target, color: TARGET, dashed: true },
                { id: 'm', label: 'Recorded breathing', points: overlay.measured, color: BREATH, width: 2.5 },
              ]} />
            <div className="legend small">
              <span><i className="sw line-target" /> Pattern, shifted by the best lag ({run.scores.best_lag_s.toFixed(1)} s)</span>
              <span><i className="sw line-trace" /> Recorded breathing, filtered and normalised as the verifier sees it</span>
            </div>
            <ScoreBars scores={run.scores} thresholds={run.thresholds} gates={run.gates} />
            <p className="muted small" data-testid="case-tally">You have drawn {tally.drawn} {tally.drawn === 1 ? 'pattern' : 'patterns'} here and {tally.passed} passed.</p>
          </div>
        )}
      </section>

      {a && (
        <section className="card">
          <div className="row between wrap">
            <h2>{a.n} patterns, drawn the same way</h2>
            <span className="muted small">seed {a.seed}, rebuilt with scripts/build_case_study.py</span>
          </div>
          <div className="stats inline">
            <Stat value={`${a.passed} / ${a.n}`} label="passed" test="case-agg-passed" />
            <Stat value={`${a.passed_flipped} / ${a.n}`} label="passed with the trace sign flipped" />
            <Stat value={a.median.s_live.toFixed(2)} label="median live pulse score (pass 0.70)" />
            <Stat value={`${a.cycles_matched} / ${a.n}`} label="had the right breath count" />
          </div>
          <div className="grid-2">
            <div>
              <h3>Pattern match</h3>
              <Histogram testId="case-hist-xcorr" values={a.values.s_xcorr} domain={[0, 1]} threshold={data.thresholds.s_xcorr} label="Distribution of pattern match scores" thresholdLabel={`pass ≥ ${data.thresholds.s_xcorr}`} />
            </div>
            <div>
              <h3>Margin over the 20 decoys</h3>
              <Histogram values={a.values.s_decoy} domain={[-1, 0.5]} bins={30} threshold={data.thresholds.s_decoy} label="Distribution of decoy margins" thresholdLabel={`pass ≥ ${data.thresholds.s_decoy}`} color="#5fa8ff" />
            </div>
          </div>
          <h3>Why they failed</h3>
          <div className="reasons">
            {Object.entries(a.failure_counts).sort((x, y) => y[1] - x[1]).map(([k, n]) => (
              <div key={k} className="reason"><span>{REASON[k] ?? k}</span><span className="reason-bar"><i style={{ width: `${(n / a.n) * 100}%` }} /></span><b>{n}</b></div>
            ))}
          </div>
          <p className="muted small">A pattern usually fails several checks at once. The live pulse check passes most of the time, because a real person really was there: what fails is following.</p>
        </section>
      )}

      <section className="grid-2">
        <section className="card">
          <h2>What this shows</h2>
          <ul className="plain">
            <li>The SDK reads a real breathing trace and pulse from ordinary video of a real person.</li>
            <li>A live, present person who is not following the pattern is rejected. The pulse alone is never enough.</li>
            {s.framing_problems.length > 0 || s.pulse_gaps.some((g) => g[0] > 0)
              ? <li>Framing matters: where the SDK lost the chest or the pulse confidence dropped, the shaded spans show it.</li>
              : <li>The SDK held framing for the whole recording.</li>}
          </ul>
        </section>
        <section className="card">
          <h2>What it does not show</h2>
          <ul className="plain">
            <li>How often a real follower passes. That needs people following the pacer, which is the next step of the evaluation.</li>
            <li>One person, one camera, one room. It is a sanity check, not a false accept rate.</li>
          </ul>
          <div className="row wrap">
            <Link className="btn primary" to="/measure" data-testid="case-to-measure">Read your own signals</Link>
            <Button className="btn" onAct={practice} busyLabel="Starting…" data-testid="case-practice">Follow a pattern yourself</Button>
          </div>
        </section>
      </section>

      <section className="card source" data-testid="case-source">
        <h3>Source</h3>
        <p className="small">{data.source.dataset} (<a href={data.source.dataset_url} target="_blank" rel="noreferrer">dataset page</a>). {data.source.video}. {data.source.sdk}, captured {data.source.captured}.</p>
        <p className="muted small">{data.source.license_note}</p>
      </section>
    </main>
  );
}
