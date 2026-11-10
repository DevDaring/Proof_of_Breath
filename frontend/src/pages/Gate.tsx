import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../App';
import { api, GateView, message, STATUS_TEXT } from '../lib/api';
import { isMuted, play, setMuted } from '../lib/audio';
import { useGate } from '../lib/useGate';
import { Pacer } from '../components/Pacer';
import { Burst } from '../components/Fx';
import { WaveChart } from '../components/WaveChart';
import { ScoreBars } from '../components/ScoreBars';
import { Button, Spinner, useToast } from '../components/ui';
import { CameraPanel } from '../components/CameraPanel';
import { Readout } from '../components/Readout';
import { SensorPicker } from '../components/SensorPicker';
import { useBrowserCamera } from '../lib/camera';
import { useCalibration } from '../lib/calibration';
import { allowedSensors, savedSensor, saveSensor, Sensor, useSensorStatus } from '../lib/sensors';
import { ApiError } from '../lib/api';

export function Gate() {
  const { requestId = '' } = useParams();
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const gate = useGate(requestId);
  const { view, setView, run, result } = gate;
  const [scenarios, setScenarios] = useState<{ id: string; label: string }[]>([]);
  const [scenario, setScenario] = useState('follower');
  const [typed, setTyped] = useState('');
  const [left, setLeft] = useState<number | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  const [notFound, setNotFound] = useState(false);
  const [needsCalibration, setNeedsCalibration] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const announced = useRef<string | null>(null);
  const sensors = useSensorStatus();
  const [picked, setPicked] = useState<Sensor | null>(savedSensor());
  const calibration = useCalibration(
    (done) => {
      // The panel stays up with its confirmation until the next check starts.
      if (done.state === 'done') {
        play('chime');
        refresh();
      }
    },
    (text) => toast(text, 'error'),
  );

  useEffect(() => {
    let alive = true;
    api.get<GateView>(`/api/gate/requests/${requestId}`)
      .then((v) => alive && setView(v))
      .catch((err) => { if (alive && err.status === 404) setNotFound(true); });
    api.get<{ id: string; label: string }[]>('/api/gate/scenarios').then((s) => alive && setScenarios(s)).catch(() => undefined);
    return () => { alive = false; };
  }, [requestId, setView]);

  useEffect(() => {
    if (gate.closedCode === 4404) setNotFound(true);
    if (gate.closedCode === 4401) navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
  }, [gate.closedCode, navigate]);

  useEffect(() => {
    if (!result || announced.current === result.status + result.attempts_used) return;
    announced.current = result.status + result.attempts_used;
    if (result.passed) play('chime').then(() => play('approved'));
    else if (result.status === 'denied') play('deny').then(() => play('declined'));
    else play('retry');
  }, [result]);

  useEffect(() => {
    if (run.cameraOn) play('camera');
  }, [run.cameraOn]);

  // The fallback countdown comes from the server's clock; this only displays it.
  const fallbackSeconds = view?.fallback_seconds_left;
  useEffect(() => {
    if (fallbackSeconds === null || fallbackSeconds === undefined) {
      setLeft(null);
      return;
    }
    const end = Date.now() + fallbackSeconds * 1000;
    const tick = () => setLeft(Math.max(0, (end - Date.now()) / 1000));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [fallbackSeconds]);

  const active = run.state !== 'idle' && run.state !== 'done';
  const decided = !!view && view.status !== 'pending';
  const needsConsent = !!me && !me.consents.includes('gate');
  const inFallback = !!view?.fallback_target;
  const options = allowedSensors(me?.role, !!view?.simulated, sensors);
  // The saved choice wins if it is allowed here. Otherwise the first ready option, then the first one.
  const sensor: Sensor = (options.find((o) => o.id === picked) ?? options.find((o) => o.ready) ?? options[0])?.id ?? 'sim';
  const chosen = options.find((o) => o.id === sensor);
  const liveBlocked = !!view && !!sensors && !chosen?.ready;
  const calibrating = calibration.running;
  const offer = run.camera ?? calibration.run?.camera ?? null;
  const cam = useBrowserCamera(offer, previewing && sensor === 'camera' && !active);
  const showCamera = sensor === 'camera' || run.sensor === 'camera';

  const choose = (next: Sensor) => {
    setPicked(next);
    saveSensor(next);
    setNeedsCalibration(false);
  };

  const start = useCallback(async () => {
    gate.prepare();
    try {
      const body = sensor === 'sim' ? { sensor, scenario } : { sensor };
      const started = await api.post<any>(`/api/gate/requests/${requestId}/attempts`, body);
      setNeedsCalibration(false);
      calibration.reset();
      gate.begin(started.phases, started.attempt_no, started.simulated, started.sensor);
      play('follow');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'calibration_required') setNeedsCalibration(true);
      else toast(message(err), 'error');
    }
  }, [requestId, sensor, scenario, gate, toast, calibration]);

  const deny = async () => {
    try {
      setView(await api.post<GateView>(`/api/gate/requests/${requestId}/deny`));
      play('deny');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const startFallback = async () => {
    try {
      setView(await api.post<GateView>(`/api/gate/requests/${requestId}/fallback`, { action: 'start' }));
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const confirmFallback = async () => {
    try {
      setView(await api.post<GateView>(`/api/gate/requests/${requestId}/fallback`, { action: 'confirm', typed }));
      play('chime');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const explain = async () => {
    try {
      const out = await api.post<any>(`/api/gate/requests/${requestId}/explain`);
      setExplanation(out.explanation);
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  if (notFound) {
    return (
      <main className="page narrow">
        <h1>This check was not found</h1>
        <p className="muted">It may belong to another sign-in. Real commands need the owner sign-in.</p>
        <Link className="btn primary" to="/">Back to overview</Link>
      </main>
    );
  }
  if (!view) return <Spinner label="Loading the check…" />;

  const heading = view.purpose === 'practice' ? 'Practice round' : `${view.source_label} wants to run`;
  const scores = result?.scores ?? view.last_attempt;
  const thresholds = result?.thresholds ?? view.thresholds ?? {};
  const gates = result?.gates ?? view.gates ?? {};
  const failures = result?.failures ?? view.last_attempt?.failures ?? [];
  const attemptsLeft = view.max_attempts - view.attempts_used;

  return (
    <main className="page gate">
      <section className="gate-head card">
        <div className="row between wrap">
          <div className="row wrap">
            <span className="pill source" data-testid="source-badge">{heading}</span>
            {view.simulated && <span className="pill sim" data-testid="simulated-badge">Sandbox · cannot approve a real command</span>}
            {view.severity && <span className={`pill sev-${view.severity}`}>{view.severity}</span>}
          </div>
          <div className="row">
            {run.cameraOn && <span className="pill camera" data-testid="camera-on"><i aria-hidden="true" /> Camera on</span>}
            <button type="button" className="link" data-testid="mute" aria-pressed={muted} onClick={() => { setMuted(!muted); setMutedState(!muted); }}>{muted ? 'Sound off' : 'Sound on'}</button>
          </div>
        </div>
        <pre className="command" data-testid="command">{view.command ?? `Command text is no longer in memory. SHA-256: ${view.command_sha256}`}</pre>
        <p className="muted reason">{view.reason}</p>
        {me?.runtime_llm_enabled && view.purpose === 'command' && !decided && (
          <div>
            {explanation ? <p className="note" data-testid="explanation">{explanation} <small className="muted">From NanoGPT. For information only: it does not affect the decision.</small></p>
              : <Button className="link" onAct={explain} busyLabel="Asking…" data-testid="explain">Explain this command in plain language</Button>}
          </div>
        )}
      </section>

      {decided ? (
        <section className={`card verdict ${['approved', 'fallback_approved', 'practice_passed'].includes(view.status) ? 'pass' : 'fail'}`} data-testid="verdict">
          {['approved', 'fallback_approved', 'practice_passed'].includes(view.status) && <Burst />}
          <h2 data-testid="verdict-title">{STATUS_TEXT[view.status] ?? view.status}</h2>
          <p>
            {view.status === 'approved' && 'The command may now run. Its single-use token is bound to this exact command and expires in 30 seconds.'}
            {view.status === 'fallback_approved' && 'Approved through the typed fallback. The receipt records this method.'}
            {view.status === 'practice_passed' && (view.simulated ? 'The pattern was followed. This was a sandbox check, so no token exists and nothing ran.' : 'The pattern was followed. This was practice, so nothing ran.')}
            {view.status === 'denied' && 'The command stays blocked.'}
            {view.status === 'expired' && 'No one finished the check in time, so the command stays blocked.'}
          </p>
          {failures.length > 0 && <ul className="plain">{failures.map((f) => <li key={f}>{f}</li>)}</ul>}
          {run.target && gate.trace.current.length > 1 && (
            <div data-testid="verdict-trace">
              <h3>Your breathing against the pattern</h3>
              <WaveChart target={run.target} trace={gate.trace} lengthS={run.lengthS} t0Perf={null} />
            </div>
          )}
          {scores && <ScoreBars scores={scores} thresholds={thresholds} gates={gates} />}
          <div className="row">
            <Link className="btn primary" to="/" data-testid="back-overview">Back to overview</Link>
            <Link className="btn" to="/receipts" data-testid="to-receipts">View receipt</Link>
          </div>
        </section>
      ) : needsConsent ? (
        <section className="card">
          <h2>Consent comes first</h2>
          <p className="muted">Please read and accept the consent notice before the first check.</p>
          <Button className="btn primary" onAct={() => navigate('/onboarding')} data-testid="to-onboarding">Review consent</Button>
          <Button className="btn" onAct={deny} data-testid="deny">Deny</Button>
        </section>
      ) : inFallback ? (
        <section className="card" data-testid="fallback-panel">
          <h2>Typed confirmation</h2>
          <p>For people who cannot do paced breathing or who decline the camera. Type the exact target below. The delay gives you time to read what you are about to approve.</p>
          <p>Type exactly: <code data-testid="fallback-target">{view.fallback_target}</code></p>
          <input className="mono wide" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the target name" data-testid="fallback-input" autoComplete="off" spellCheck={false} />
          <div className="row between">
            <Button className="btn" onAct={deny} data-testid="deny">Deny</Button>
            <Button className="btn primary" disabled={(left ?? 0) > 0 || !typed} onAct={confirmFallback} busyLabel="Confirming…" data-testid="fallback-confirm">
              {(left ?? 0) > 0 ? `Please wait ${Math.ceil(left ?? 0)} s` : 'Confirm'}
            </Button>
          </div>
        </section>
      ) : (
        <>
          <section className="gate-grid">
            <div className="card pacer-card">
              <Pacer phases={run.phases} target={run.target} t0Perf={run.t0Perf} state={run.state} />
              {!active && !run.phases && <p className="muted center">The pattern is new each time and appears when you start.</p>}
            </div>
            <div className="card">
              <WaveChart target={run.target} trace={gate.trace} lengthS={run.lengthS} t0Perf={run.t0Perf} />
              <div className="presence">
                <span className={`pulse-dot ${gate.pulse ? 'on' : ''}`} aria-hidden="true" />
                <span data-testid="pulse-state">{gate.pulse ? 'Live pulse detected' : active ? 'Looking for a live pulse' : 'Pulse check runs during the window'}</span>
              </div>
              {gate.hint && active && !showCamera && <p className="hint" data-testid="hint">{gate.hint}</p>}
            </div>
          </section>

          {(showCamera || (run.sensor && run.sensor !== 'sim') || gate.readout) && (
            <section className={`sensor-row ${showCamera ? '' : 'no-camera'}`}>
              {showCamera && (
                <div className="card camera-card">
                  <CameraPanel stream={cam.stream} status={cam.status} error={cam.error} fps={cam.fps} hint={gate.hint || calibration.run?.message}
                    onPreview={setPreviewing} previewing={previewing} canPreview={!active && !calibrating} />
                </div>
              )}
              <div className="card readout-card">
                <h3>What the SDK reads {run.sensor === 'sim' || (!run.sensor && sensor === 'sim') ? <span className="pill sim">simulated</span> : <span className="pill live">live</span>}</h3>
                <Readout values={gate.readout} live={active} />
                <p className="muted small">Shown as the Presage SDK reports them. These numbers are for display: the decision uses the breathing pattern and a live pulse signal, scored on the server.</p>
              </div>
            </section>
          )}

          {!view.simulated && !active && sensor !== 'sim' && (
            <div className="note" data-testid="framing-tips">
              Before you start: face and upper chest in view, camera at eye level, even light on your face, and sit still without talking. Plain, lighter clothing works best. The SDK gives no readings until the chest is visible.
            </div>
          )}
          {gate.aborted && <div className="note warn" role="alert" data-testid="aborted">{gate.aborted} This did not use up an attempt.</div>}
          {liveBlocked && (
            <div className="note warn" data-testid="bridge-offline">
              {sensor === 'camera' ? (sensors?.camera.available ? 'Every camera slot is busy right now. Please try again in a minute.' : 'The browser camera service is offline right now.') : 'The sensor bridge is not connected. Start it on the machine with the webcam.'}
              {' '}{view.simulated ? 'You can switch to the simulated sensor.' : 'You can also use the fallback.'}
            </div>
          )}
          {needsCalibration && (
            <section className="card calibrate-inline" data-testid="calibrate-inline">
              <h2>One slow breath first</h2>
              <p>Cameras differ in which way they report an inhale. Sit with your face and upper chest in view, press start, and breathe in slowly until the timer ends. It takes about 15 seconds and is saved for next time.</p>
              <div className="calibration" data-testid="calibration-state">
                {!calibration.run && <span className="muted">Not started</span>}
                {calibration.run?.state === 'arming' && <span>Starting the camera…</span>}
                {calibration.run?.state === 'warmup' && <span>Sit still… {calibration.run.seconds_left.toFixed(0)} s</span>}
                {calibration.run?.state === 'inhale' && <strong className="good">Breathe in slowly… {calibration.run.seconds_left.toFixed(0)} s</strong>}
                {calibration.run?.state === 'settling' && <span>Finishing…</span>}
                {calibration.run?.state === 'done' && <strong className="good">Calibrated. You can start the check.</strong>}
                {calibration.run?.state === 'failed' && <span className="bad">{calibration.run.message}</span>}
              </div>
              <Button className="btn primary" disabled={calibrating} onAct={() => calibration.start(sensor)} busyLabel="Starting…" data-testid="calibrate-inline-start">
                {calibration.run?.state === 'failed' ? 'Try again' : 'Start calibration'}
              </Button>
            </section>
          )}

          {result && (
            <section className={`card verdict ${result.passed ? 'pass' : 'fail'}`} data-testid="result-panel">
              {result.passed && <Burst />}
              <h2>{result.passed ? 'Pattern followed' : 'Not matched'}</h2>
              {result.readout && result.sensor !== 'sim' && (result.readout.pulse_bpm || result.readout.breath_rpm) && (
                <p className="sdk-summary" data-testid="result-readout">
                  During this check the SDK read a pulse of <strong>{result.readout.pulse_bpm ? `${Math.round(result.readout.pulse_bpm)} bpm` : 'nothing confident'}</strong>
                  {' '}and a breathing rate of <strong>{result.readout.breath_rpm ? `${result.readout.breath_rpm.toFixed(1)} per minute` : 'nothing yet'}</strong>.
                </p>
              )}
              {result.failures.length > 0 && <ul className="plain">{result.failures.map((f) => <li key={f}>{f}</li>)}</ul>}
              <ScoreBars scores={result.scores} thresholds={result.thresholds} gates={result.gates} />
              {!result.passed && <p className="muted">{result.attempts_left} {result.attempts_left === 1 ? 'attempt' : 'attempts'} left. Each one uses a new pattern.</p>}
            </section>
          )}

          <section className="card controls">
            <div className="control-head">
              <span className="muted small">Sensor</span>
              <SensorPicker options={options} value={sensor} onChange={choose} disabled={active || calibrating} />
            </div>
            {sensor === 'sim' && (
              <label className="scenario">
                Simulated scenario
                <select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={active} data-testid="scenario">
                  {scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
            )}
            <div className="row wrap">
              <Button className="btn primary big" disabled={active || liveBlocked || attemptsLeft <= 0 || calibrating || (needsCalibration && calibration.run?.state !== 'done')} onAct={start} busyLabel="Starting…" data-testid="start-check">
                {active ? 'Check running…' : view.attempts_used > 0 ? 'Try a new pattern' : 'Start check'}
              </Button>
              <Button className="btn danger" onAct={deny} busyLabel="Denying…" data-testid="deny">Deny</Button>
              <Button className="btn" disabled={active || calibrating} onAct={startFallback} busyLabel="Opening…" data-testid="use-fallback">Use fallback</Button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
