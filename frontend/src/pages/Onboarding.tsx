import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../App';
import { api, message, Settings } from '../lib/api';
import { Button, Toggle, useToast } from '../components/ui';
import { CameraPanel } from '../components/CameraPanel';
import { SensorPicker } from '../components/SensorPicker';
import { useBrowserCamera } from '../lib/camera';
import { useCalibration } from '../lib/calibration';
import { allowedSensors, savedSensor, saveSensor, Sensor, useSensorStatus } from '../lib/sensors';

export function ConsentText() {
  return (
    <div className="prose">
      <h3>What the camera is used for</h3>
      <p>Only to measure breathing movement and a live pulse signal while a check or a live reading is running, using the Presage SmartSpectra SDK. It checks presence and attention, nothing else, and it does not identify you.</p>
      <h3>Where the video goes</h3>
      <p>There are two ways to run the SDK. With <strong>your camera</strong> in the browser, frames (640 pixels wide, about 30 a second) travel to this server over an encrypted connection, are decoded in memory, handed to the SDK and dropped at once. They are never written to disk or kept. With the <strong>desktop bridge</strong>, the SDK runs on your own machine and video never leaves it. The simulated sensor uses no camera at all.</p>
      <h3>When the camera is on</h3>
      <p>Only during a check, calibration or live reading you started, with a visible camera indicator, or while you preview your own framing (a preview stays in your browser). It stops as soon as the window ends. There is no background or idle capture.</p>
      <h3>What is measured</h3>
      <p>A breathing waveform, a pulse-rate reading with its confidence, and the SDK's framing and lighting status.</p>
      <h3>What is stored</h3>
      <p>A receipt for each decision: request id, a SHA-256 hash of the command, source, timestamps, scores, decision, method and the previous receipt's hash. The command's text is stored only if you turn that on in Settings.</p>
      <h3>What is never stored</h3>
      <p>Video, images, or raw measurements in normal use. Live readings are shown and then discarded. Evaluation mode is the one exception and has its own opt-in below: it stores resampled breathing and pulse series for each research trial, and you can delete them at any time.</p>
      <h3>SDK telemetry</h3>
      <p>The SDK can send one aggregate summary per session: SDK build, platform, session shape, performance counts and counts of on-device quality states. It never includes video, measured values, or identifiers. This app turns it off by default by setting <code>enableTelemetry: false</code>. You can change that below or in Settings.</p>
      <h3>AI services</h3>
      <p>No AI service sees your data by default, and no AI ever decides whether a command is gated. One optional feature, off by default, sends a gated command's text to NanoGPT to explain it in plain language.</p>
      <h3>Retention and deletion</h3>
      <p>Receipts stay until you delete them. Settings has "Export receipts" and "Delete all data". Jury sandboxes are removed automatically after 7 days without use.</p>
    </div>
  );
}

type Step = 'consent' | 'calibrate' | 'practice';

export function Onboarding() {
  const { me, refresh } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<Step>(me?.consents.includes('gate') ? 'calibrate' : 'consent');
  const [gate, setGate] = useState(false);
  const [evaluation, setEvaluation] = useState(false);
  const [telemetryOn, setTelemetryOn] = useState(false);
  const status = useSensorStatus();
  const [picked, setPicked] = useState<Sensor | null>(savedSensor());
  const [previewing, setPreviewing] = useState(false);
  const calibration = useCalibration(() => refresh(), (text) => toast(text, 'error'));
  const run = calibration.run;
  // The jury may calibrate the simulated sensor. The owner's sign guards real commands, so it needs a real camera.
  const options = allowedSensors(me?.role, me?.role === 'jury', status);
  const sensor: Sensor = (options.find((o) => o.id === picked) ?? options.find((o) => o.ready) ?? options[0]).id;
  const cam = useBrowserCamera(run?.camera ?? null, previewing && sensor === 'camera' && !calibration.running);

  const agree = async () => {
    try {
      await api.post('/api/consent', { scope: 'gate' });
      if (evaluation) await api.post('/api/consent', { scope: 'evaluation' });
      await api.put<Settings>('/api/settings', { telemetry_opt_out: !telemetryOn });
      await refresh();
      setStep('calibrate');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const calibrate = () => calibration.start(sensor);

  const practice = async () => {
    try {
      const created = await api.post<any>('/api/gate/requests', { practice: true });
      navigate(`/gate/${created.request_id}`);
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const steps: Step[] = ['consent', 'calibrate', 'practice'];
  const running = calibration.running;

  return (
    <main className="page narrow">
      <ol className="steps" aria-label="Setup steps">
        {['Consent', 'One-breath calibration', 'Practice'].map((name, i) => (
          <li key={name} className={steps[i] === step ? 'current' : steps.indexOf(step) > i ? 'done' : ''}>{name}</li>
        ))}
      </ol>

      {step === 'consent' && (
        <section className="card">
          <h1>Before the camera ever starts</h1>
          <ConsentText />
          <div className="stack">
            <label className="check">
              <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} data-testid="consent-gate" />
              <span>I agree to camera use for breath checks, as described above. <em>Required</em></span>
            </label>
            <label className="check">
              <input type="checkbox" checked={evaluation} onChange={(e) => setEvaluation(e.target.checked)} data-testid="consent-eval" />
              <span>Also allow evaluation mode, which stores resampled series for research trials. <em>Optional</em></span>
            </label>
            <Toggle checked={telemetryOn} onChange={setTelemetryOn} testid="consent-telemetry" label="Share SDK telemetry" description="Off sets enableTelemetry: false. This is the default." />
          </div>
          <div className="row end">
            <Button className="btn primary" disabled={!gate} onAct={agree} busyLabel="Saving…" data-testid="i-agree">I agree</Button>
          </div>
        </section>
      )}

      {step === 'calibrate' && (
        <section className="card">
          <h1>One slow breath</h1>
          <p>Some cameras report inhaling as a rising signal and some as a falling one. Press start, sit still with your face and upper chest in view, and take one slow breath in until the timer ends.</p>
          <div className="control-head">
            <span className="muted small">Sensor</span>
            <SensorPicker options={options} value={sensor} onChange={(s) => { setPicked(s); saveSensor(s); }} disabled={running} />
          </div>
          {sensor === 'sim' && <p className="note">Simulated sensor: this sets the sign to the default without using a camera. Checks with your camera will ask for a real calibration first.</p>}
          {sensor === 'camera' && (
            <CameraPanel stream={cam.stream} status={cam.status} error={cam.error} fps={cam.fps} hint={run?.message}
              onPreview={setPreviewing} previewing={previewing} canPreview={!running} />
          )}
          <div className="calibration" data-testid="calibration-state">
            {!run && <span className="muted">Not started</span>}
            {run?.state === 'arming' && <span>Starting the camera…</span>}
            {run?.state === 'warmup' && <span>Sit still… {run.seconds_left.toFixed(0)} s</span>}
            {run?.state === 'inhale' && <strong className="good">Breathe in slowly… {run.seconds_left.toFixed(0)} s</strong>}
            {run?.state === 'settling' && <span>Finishing…</span>}
            {run?.state === 'done' && <strong className="good">Calibrated. {run.message}</strong>}
            {run?.state === 'failed' && <span className="bad">{run.message}</span>}
          </div>
          <div className="row between">
            <Button className="btn" onAct={() => setStep('practice')} data-testid="calibrate-skip">{run?.state === 'done' ? 'Next' : 'Skip for now'}</Button>
            <Button className="btn primary" disabled={!!running || !options.find((o) => o.id === sensor)?.ready} onAct={calibrate} data-testid="calibrate-start">{run ? 'Run again' : 'Start calibration'}</Button>
          </div>
        </section>
      )}

      {step === 'practice' && (
        <section className="card">
          <h1>Try one practice round</h1>
          <p>A practice round follows a real random pattern, but it is not an approval and nothing runs afterwards.</p>
          <div className="row between">
            <Button className="btn" onAct={() => navigate('/')} data-testid="onboarding-finish">Finish</Button>
            <Button className="btn primary" onAct={practice} busyLabel="Starting…" data-testid="practice-start">Start practice round</Button>
          </div>
        </section>
      )}
    </main>
  );
}
