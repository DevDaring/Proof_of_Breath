import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { useSession } from '../App';
import { api, downloadJson, message } from '../lib/api';
import { useGate } from '../lib/useGate';
import { Pacer } from '../components/Pacer';
import { WaveChart } from '../components/WaveChart';
import { Button, Confirm, Empty, useToast } from '../components/ui';
import { CameraPanel } from '../components/CameraPanel';
import { Readout } from '../components/Readout';
import { useBrowserCamera } from '../lib/camera';

const GENUINE = '#3987e5';
const ATTACK = '#d95926';
const GRID = '#2a3440';
const AXIS = '#9aa7b6';
const SCORE_LABELS: Record<string, string> = { s_decoy: 'Margin over decoys', s_xcorr: 'Pattern match', s_phase: 'Timing', s_live: 'Live pulse', s_coupling: 'Pulse follows pattern' };

// From docs/evaluation-results.md (seed 20261107, 150 synthetic trials per condition). Simulated signals, not people.
const SIM_BENCHMARK: [string, 'FRR' | 'FAR', number, number, number, string][] = [
  ['Following the pacer, normal light', 'FRR', 1.3, 0.4, 4.7, '2 / 150'],
  ['Following the pacer, dim light', 'FRR', 1.3, 0.4, 4.7, '2 / 150'],
  ['Ignoring the pacer', 'FAR', 0.0, 0.0, 2.5, '0 / 150'],
  ['Steady slow breathing near 6 per minute', 'FAR', 6.7, 3.7, 11.8, '10 / 150'],
  ['Photo held to the camera', 'FAR', 0.0, 0.0, 2.5, '0 / 150'],
  ['Screen replay of an earlier session', 'FAR', 3.3, 1.4, 7.6, '5 / 150'],
  ['Virtual camera replay', 'FAR', 4.0, 1.8, 8.5, '6 / 150'],
  ['Empty chair', 'FAR', 0.0, 0.0, 2.5, '0 / 150'],
];

function Benchmark() {
  const max = 15;
  return (
    <section className="card" data-testid="sim-benchmark">
      <div className="row between wrap">
        <h2>Bundled benchmark</h2>
        <span className="pill sim">Simulated signals, not people</span>
      </div>
      <p className="muted small">The verifier against 1,200 synthetic trials. Bars show the rate, whiskers the 95% interval. Synthetic signals are far cleaner than a webcam, so read these as an upper bound.</p>
      <div className="ranges">
        {SIM_BENCHMARK.map(([label, metric, rate, low, high, kn]) => (
          <div className="range-row" key={label} title={`${label}: ${metric} ${rate}% (95% CI ${low}% to ${high}%), ${kn}`}>
            <span className="range-label">{label} <em className="small">{metric}</em></span>
            <span className="range-track">
              <i className="range-bar" style={{ left: `${(low / max) * 100}%`, width: `${Math.max(0.6, ((high - low) / max) * 100)}%`, background: metric === 'FRR' ? '#3987e555' : '#d9592655' }} />
              <i className="range-median" style={{ left: `${(rate / max) * 100}%` }} />
            </span>
            <span className="range-value mono">{rate.toFixed(1)}%</span>
          </div>
        ))}
      </div>
      <p className="muted small">Scale 0 to {max}%. Blue rows are genuine followers (false reject rate), orange rows are attacks (false accept rate).</p>
    </section>
  );
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(1)}%`);
const fix = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '–' : v.toFixed(d));

function TrialRunner({ requestId, label, instruction, onDone }: { requestId: string; label: string; instruction: string; onDone: () => void }) {
  const gate = useGate(requestId);
  const cam = useBrowserCamera(gate.run.camera, false);
  // A trial starts before this page connects, so a first snapshot with no running check means it ended.
  const finished = gate.run.state === 'done' || !!gate.aborted || (!!gate.view && gate.run.state === 'idle');
  useEffect(() => {
    if (finished) onDone();
    // Runs once when the trial ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);
  return (
    <section className="card" data-testid="trial-runner">
      <h3>{label}</h3>
      <p className="note">{instruction}</p>
      <div className="gate-grid">
        <Pacer phases={gate.run.phases} target={gate.run.target} t0Perf={gate.run.t0Perf} state={gate.run.state} />
        <WaveChart target={gate.run.target} trace={gate.trace} lengthS={gate.run.lengthS} t0Perf={gate.run.t0Perf} />
      </div>
      {gate.run.sensor && gate.run.sensor !== 'sim' && (
        <div className="sensor-row">
          {gate.run.sensor === 'camera' && <div className="camera-card"><CameraPanel stream={cam.stream} status={cam.status} error={cam.error} fps={cam.fps} hint={gate.hint} /></div>}
          <Readout values={gate.readout} live={gate.run.state !== 'idle' && gate.run.state !== 'done'} compact />
        </div>
      )}
      {gate.run.cameraOn && <span className="pill camera"><i aria-hidden="true" /> Camera on</span>}
      {gate.aborted && <div className="note warn" role="alert">{gate.aborted}</div>}
      {gate.result && <p data-testid="trial-result"><strong className={gate.result.passed ? 'good' : 'bad'}>{gate.result.passed ? 'Passed' : 'Rejected'}</strong> · margin over decoys {gate.result.scores.s_decoy.toFixed(2)}</p>}
    </section>
  );
}

function ScoreRanges({ ranges }: { ranges: Record<string, any[]> }) {
  const [score, setScore] = useState('s_decoy');
  const rows = ranges[score] ?? [];
  const values = rows.flatMap((r) => [r.low, r.high]).filter((v) => v !== null);
  const low = Math.min(0, ...values);
  const high = Math.max(1, ...values);
  const x = (v: number) => ((v - low) / (high - low)) * 100;
  return (
    <div>
      <div className="row between wrap">
        <h3>Score by condition</h3>
        <label className="inline">Score
          <select value={score} onChange={(e) => setScore(e.target.value)} data-testid="range-score">
            {Object.keys(SCORE_LABELS).map((k) => <option key={k} value={k}>{SCORE_LABELS[k]}</option>)}
          </select>
        </label>
      </div>
      <p className="muted small">Bar spans the 10th to 90th percentile. The tick marks the median.</p>
      <div className="ranges" data-testid="score-ranges">
        {rows.map((r) => (
          <div className="range-row" key={r.id} title={r.n ? `${r.label}: median ${fix(r.median)}, n=${r.n}` : `${r.label}: no trials`}>
            <span className="range-label">{r.label}</span>
            <span className="range-track">
              {r.n > 0 && (
                <>
                  <i className="range-bar" style={{ left: `${x(r.low)}%`, width: `${Math.max(0.5, x(r.high) - x(r.low))}%`, background: r.genuine ? GENUINE : ATTACK }} />
                  <i className="range-median" style={{ left: `${x(r.median)}%` }} />
                </>
              )}
            </span>
            <span className="mono small range-value">{r.n ? fix(r.median) : 'no data'}</span>
          </div>
        ))}
      </div>
      <div className="legend-row small">
        <span className="key"><i style={{ background: GENUINE, height: 10, width: 10, borderRadius: 2 }} /> Genuine</span>
        <span className="key"><i style={{ background: ATTACK, height: 10, width: 10, borderRadius: 2 }} /> Attack or not following</span>
      </div>
    </div>
  );
}

function Results({ data }: { data: any }) {
  if (!data) return null;
  if (data.n_trials === 0) return <Empty>No {data.data_class} trials yet.</Empty>;
  const roc = data.roc.map((p: any) => ({ fpr: p.fpr, tpr: p.tpr }));
  return (
    <div className="stack-lg" data-testid="eval-results">
      <div className={`note ${data.data_class === 'simulated' ? 'warn' : ''}`} data-testid="data-label"><strong>{data.label}</strong> n = {data.n_trials} trials, {data.n_participants} participant code{data.n_participants === 1 ? '' : 's'}. Thresholds are {data.thresholds_calibrated ? 'calibrated' : 'provisional'}.</div>
      <div className="tiles">
        <div className="tile"><span>False accept rate</span><strong data-testid="far">{pct(data.far.rate)}</strong><small>95% CI {pct(data.far.ci_low)} to {pct(data.far.ci_high)} · {data.far.k}/{data.far.n}</small></div>
        <div className="tile"><span>False reject rate</span><strong data-testid="frr">{pct(data.frr.rate)}</strong><small>95% CI {pct(data.frr.ci_low)} to {pct(data.frr.ci_high)} · {data.frr.k}/{data.frr.n}</small></div>
        <div className="tile"><span>Time to approve</span><strong>{data.time_to_approve.median_s === null ? '–' : `${data.time_to_approve.median_s.toFixed(0)} s`}</strong><small>p90 {fix(data.time_to_approve.p90_s, 0)} s · {data.time_to_approve.note}</small></div>
        <div className="tile"><span>Coupling AUC</span><strong>{fix(data.coupling_auc)}</strong><small>Gate only if ≥ 0.80 on live trials</small></div>
      </div>

      <div className="grid-2">
        <div>
          <h3>Margin over decoys</h3>
          <p className="muted small">Genuine trials should sit right of the gate at 0.</p>
          <div className="chart" data-testid="decoy-histogram">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.s_decoy_histogram} barGap={2} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="bin" stroke={AXIS} tick={{ fontSize: 12 }} interval={3} />
                <YAxis stroke={AXIS} tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#10151b', border: `1px solid ${GRID}`, color: '#e8edf2' }} cursor={{ fill: '#ffffff0d' }} labelFormatter={(v) => `From ${v}`} />
                <Legend />
                <ReferenceLine x={0} stroke={AXIS} strokeDasharray="4 4" />
                <Bar dataKey="genuine" name="Genuine" fill={GENUINE} radius={[4, 4, 0, 0]} />
                <Bar dataKey="attack" name="Attack or not following" fill={ATTACK} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div>
          <h3>ROC for the margin over decoys</h3>
          <p className="muted small">AUC {fix(data.auc.s_decoy, 3)}</p>
          <div className="chart" data-testid="roc">
            {roc.length ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={roc} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
                  <CartesianGrid stroke={GRID} />
                  <XAxis type="number" dataKey="fpr" domain={[0, 1]} stroke={AXIS} tick={{ fontSize: 12 }} tickFormatter={(v) => `${Math.round(v * 100)}%`} name="False accept" />
                  <YAxis type="number" domain={[0, 1]} stroke={AXIS} tick={{ fontSize: 12 }} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
                  <Tooltip contentStyle={{ background: '#10151b', border: `1px solid ${GRID}`, color: '#e8edf2' }} formatter={(v: number) => pct(v)} labelFormatter={(v) => `False accept ${pct(v as number)}`} />
                  <Line type="stepAfter" dataKey="tpr" name="True accept" stroke={GENUINE} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : <Empty>Needs both genuine and attack trials.</Empty>}
          </div>
        </div>
      </div>

      <ScoreRanges ranges={data.score_ranges} />

      <div>
        <h3>By condition</h3>
        <div className="table-wrap">
          <table data-testid="condition-table">
            <thead><tr><th>Condition</th><th>Metric</th><th>Rate</th><th>95% CI</th><th>k / n</th><th>Median margin</th></tr></thead>
            <tbody>
              {data.conditions.map((c: any) => (
                <tr key={c.id}><td>{c.label}</td><td>{c.metric}</td><td>{pct(c.rate)}</td><td>{c.n ? `${pct(c.ci_low)} to ${pct(c.ci_high)}` : '–'}</td><td>{c.k} / {c.n}</td><td>{fix(c.s_decoy_median)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h3>AUC per score</h3>
        <ul className="plain mono small">{Object.entries(data.auc).map(([k, v]) => <li key={k}>{SCORE_LABELS[k] ?? k}: {fix(v as number, 3)}</li>)}</ul>
      </div>
    </div>
  );
}

export function Evaluation() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const [conditions, setConditions] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [trials, setTrials] = useState<any[]>([]);
  const [results, setResults] = useState<any>(null);
  const [dataClass, setDataClass] = useState<'simulated' | 'live'>('simulated');
  const [code, setCode] = useState('P01');
  const [lighting, setLighting] = useState('normal');
  const [live, setLive] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [condition, setCondition] = useState('genuine_normal');
  const [running, setRunning] = useState<{ requestId: string; label: string; instruction: string } | null>(null);
  const [askDelete, setAskDelete] = useState(false);
  const [calibration, setCalibration] = useState<any>(null);
  const optedIn = !!me?.consents.includes('evaluation');

  const loadResults = useCallback(async (which: string) => {
    setResults(await api.get(`/api/eval/results?data=${which}`));
  }, []);

  const load = useCallback(async () => {
    try {
      const [c, s, t] = await Promise.all([api.get<any[]>('/api/eval/conditions'), api.get<any[]>('/api/eval/sessions'), api.get<any[]>('/api/eval/trials?limit=50')]);
      setConditions(c);
      setSessions(s);
      setTrials(t);
      setSessionId((current) => (s.some((x) => x.id === current) ? current : s.find((x) => x.participant_code !== 'synthetic')?.id ?? ''));
    } catch (err) {
      toast(message(err), 'error');
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadResults(dataClass).catch((err) => toast(message(err), 'error'));
  }, [dataClass, loadResults, toast]);

  const session = useMemo(() => sessions.find((s) => s.id === sessionId), [sessions, sessionId]);
  const conditionInfo = useMemo(() => conditions.find((c) => c.id === condition), [conditions, condition]);

  const act = async (work: () => Promise<unknown>, done?: string) => {
    try {
      await work();
      if (done) toast(done);
    } catch (err) {
      toast(message(err), 'error');
    }
  };
  const refreshAll = async () => {
    await load();
    await loadResults(dataClass);
  };

  const onTrialDone = useCallback(() => {
    setTimeout(() => {
      load();
      loadResults(dataClass).catch(() => undefined);
    }, 300);
    setTimeout(() => setRunning(null), 2500);
  }, [load, loadResults, dataClass]);

  if (!optedIn) {
    return (
      <main className="page narrow">
        <h1>Evaluation lab</h1>
        <section className="card">
          <h2>Evaluation mode needs its own opt-in</h2>
          <p>It stores resampled breathing and pulse series for each trial so results can be analysed. Participants use codes only, never names. You can delete any trial, or all of them, at any time.</p>
          <Button className="btn primary" onAct={() => act(async () => { await api.post('/api/consent', { scope: 'evaluation' }); await refresh(); }, 'Evaluation mode allowed')} busyLabel="Saving…" data-testid="eval-optin">Opt in to evaluation mode</Button>
        </section>
        <section className="card home-case">
          <div>
            <span className="eyebrow">Real SDK output</span>
            <h2>See the verifier on a real person</h2>
            <p className="muted">A recorded person read by the Presage SDK on this server, challenged with fresh patterns. No one followed, so every pattern should fail.</p>
          </div>
          <div className="row end"><Link className="btn primary" to="/case-study" data-testid="eval-case">Open the case study</Link></div>
        </section>
        <Benchmark />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="row between wrap">
        <h1>Evaluation lab</h1>
        <div className="row wrap">
          <Button className="btn" onAct={() => act(() => downloadJson('/api/eval/export', 'pob-evaluation.json'), 'Export downloaded')} busyLabel="Exporting…" data-testid="eval-export">Export results</Button>
          <button type="button" className="btn danger" onClick={() => setAskDelete(true)} data-testid="eval-delete-all">Delete all evaluation data</button>
        </div>
      </div>
      <p className="muted">Fresh patterns for every trial. False accept and false reject rates carry Wilson 95% intervals. Simulated and live results are never mixed, and only live trials can calibrate thresholds.</p>

      <div className="grid-2">
        <section className="card">
          <h2>1. Start a session</h2>
          <label>Participant code
            <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} data-testid="eval-code" />
            <small className="muted">A code, never a name.</small>
          </label>
          <label>Lighting
            <select value={lighting} onChange={(e) => setLighting(e.target.value)} data-testid="eval-lighting">
              <option value="normal">normal</option>
              <option value="dim">dim</option>
              <option value="bright">bright</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} data-testid="eval-live" /><span>Live trials with a real sensor: your browser camera{me?.role === 'owner' ? ', or the desktop bridge when it is connected' : ''}</span></label>
          <Button className="btn primary" onAct={() => act(async () => {
            const s = await api.post<any>('/api/eval/sessions', { participant_code: code, lighting, live });
            await load();
            setSessionId(s.id);
          }, 'Session created')} busyLabel="Creating…" data-testid="eval-create-session">Create session</Button>
          {sessions.length > 0 && (
            <ul className="plain small session-list" data-testid="eval-sessions">
              {sessions.map((s) => (
                <li className="row between" key={s.id}>
                  <span>{s.participant_code} · {s.lighting} · {s.simulated ? 'simulated' : 'live'} · {s.trials} trials</span>
                  <Button className="link bad" onAct={() => act(async () => { await api.del(`/api/eval/sessions/${s.id}`); await refreshAll(); }, 'Session deleted')} data-testid="eval-delete-session">Delete</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <h2>2. Run a trial</h2>
          <label>Session
            <select value={sessionId} onChange={(e) => setSessionId(e.target.value)} data-testid="eval-session-select">
              <option value="">Choose a session</option>
              {sessions.filter((s) => s.participant_code !== 'synthetic').map((s) => <option key={s.id} value={s.id}>{s.participant_code} ({s.simulated ? 'simulated' : 'live'})</option>)}
            </select>
          </label>
          <label>Condition
            <select value={condition} onChange={(e) => setCondition(e.target.value)} data-testid="eval-condition">
              {conditions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          {conditionInfo && <p className="note small">{conditionInfo.instruction}</p>}
          <Button className="btn primary" disabled={!sessionId || !!running || !session} onAct={() => act(async () => {
            const out = await api.post<any>('/api/eval/trials', { session_id: sessionId, condition });
            setRunning({ requestId: out.request_id, label: out.condition.label, instruction: session?.simulated ? `Simulated: ${out.condition.label}` : out.condition.instruction });
          })} busyLabel="Starting…" data-testid="eval-run-trial">{running ? 'Trial running…' : 'Run trial'}</Button>
          <hr />
          <h3>Instant synthetic batch</h3>
          <p className="muted small">30 trials per condition through the real verifier, using synthetic signals with no person involved. Always labelled simulated.</p>
          <Button className="btn" onAct={() => act(async () => { await api.post('/api/eval/synthetic', { per_condition: 30 }); await refreshAll(); if (dataClass !== 'simulated') setDataClass('simulated'); }, 'Synthetic batch added')} busyLabel="Scoring 240 trials…" data-testid="eval-synthetic">Generate synthetic batch</Button>
        </section>
      </div>

      {running && <TrialRunner key={running.requestId} {...running} onDone={onTrialDone} />}

      <section className="card">
        <div className="row between wrap">
          <h2>3. Results</h2>
          <div className="row wrap">
            <div className="segmented" role="group" aria-label="Data class">
              <button type="button" className={dataClass === 'simulated' ? 'on' : ''} aria-pressed={dataClass === 'simulated'} onClick={() => setDataClass('simulated')} data-testid="view-simulated">Simulated</button>
              <button type="button" className={dataClass === 'live' ? 'on' : ''} aria-pressed={dataClass === 'live'} onClick={() => setDataClass('live')} data-testid="view-live">Live</button>
            </div>
            <Button className="btn" onAct={() => act(refreshAll, 'Results updated')} data-testid="eval-refresh">Refresh</Button>
            <Button className="btn" onAct={() => act(async () => { setCalibration(await api.post('/api/eval/calibrate')); await refresh(); }, 'Thresholds calibrated')} busyLabel="Calibrating…" data-testid="eval-calibrate">Calibrate from live trials</Button>
          </div>
        </div>
        {calibration && <div className="note" data-testid="calibration-report">Calibrated on {calibration.fit_trials} trials. Hold-out ({calibration.holdout_trials}): FRR {pct(calibration.holdout_frr.rate)}, FAR {pct(calibration.holdout_far.rate)}.</div>}
        <Results data={results} />
      </section>

      {trials.length > 0 && (
        <section className="card">
          <h2>Latest trials</h2>
          <div className="table-wrap">
            <table data-testid="trials-table">
              <thead><tr><th>Condition</th><th>Participant</th><th>Data</th><th>Result</th><th>Margin</th><th>Series stored</th><th aria-label="Delete" /></tr></thead>
              <tbody>
                {trials.slice(0, 20).map((t) => (
                  <tr key={t.id}>
                    <td>{t.condition_label}</td><td>{t.participant_code}</td><td>{t.simulated ? 'simulated' : 'live'}</td>
                    <td className={t.passed ? 'good' : 'bad'}>{t.passed ? 'passed' : 'rejected'}</td><td className="mono">{t.s_decoy.toFixed(2)}</td><td>{t.stored_series ? 'yes' : 'no'}</td>
                    <td><Button className="link bad" onAct={() => act(async () => { await api.del(`/api/eval/trials/${t.id}`); await refreshAll(); }, 'Trial deleted')} data-testid="eval-delete-trial">Delete</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {askDelete && (
        <Confirm title="Delete all evaluation data?" body="This removes every evaluation session, trial and stored series in this workspace." confirmLabel="Delete evaluation data" onConfirm={() => act(async () => { await api.del('/api/eval/data'); setAskDelete(false); setRunning(null); await refreshAll(); }, 'Evaluation data deleted')} onCancel={() => setAskDelete(false)} />
      )}
    </main>
  );
}
