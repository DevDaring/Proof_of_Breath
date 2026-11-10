import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../App';
import { api, message } from '../lib/api';
import { useBrowserCamera, CameraOffer } from '../lib/camera';
import { allowedSensors, savedSensor, saveSensor, Sensor, useSensorStatus } from '../lib/sensors';
import { Button, useToast } from '../components/ui';
import { CameraPanel } from '../components/CameraPanel';
import { Readout, ReadoutValues } from '../components/Readout';
import { SensorPicker } from '../components/SensorPicker';
import { LiveLine } from '../components/LiveLine';
import { play } from '../lib/audio';

interface MeasureView {
  id: string; state: 'arming' | 'running' | 'done' | 'failed'; message: string; sensor: Sensor; camera: CameraOffer | null;
  elapsed_s: number; seconds_left: number | null; readout: ReadoutValues;
  history: { pulse: number[][]; rate: number[][] }; trace: number[][];
}

/** A free reading of what the SDK sees. No pattern, no decision, nothing stored. */
export function Measure() {
  const { me } = useSession();
  const toast = useToast();
  const status = useSensorStatus();
  const [picked, setPicked] = useState<Sensor | null>(savedSensor());
  const [run, setRun] = useState<MeasureView | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>();
  const options = allowedSensors(me?.role, false, status);
  const sensor: Sensor = (options.find((o) => o.id === picked) ?? options.find((o) => o.ready) ?? options[0]).id;
  const chosen = options.find((o) => o.id === sensor);
  const active = !!run && (run.state === 'arming' || run.state === 'running');
  const cam = useBrowserCamera(run?.camera ?? null, previewing && sensor === 'camera' && !active);

  useEffect(() => () => clearInterval(timer.current), []);

  const poll = (id: string) => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const next = await api.get<MeasureView>(`/api/measure/${id}`);
        setRun(next);
        if (next.state === 'done' || next.state === 'failed') clearInterval(timer.current);
      } catch (err) {
        clearInterval(timer.current);
        toast(message(err), 'error');
      }
    }, 500);
  };

  const start = async () => {
    try {
      const started = await api.post<MeasureView>('/api/measure', { sensor });
      setRun(started);
      play('camera');
      poll(started.id);
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const stop = async () => {
    if (!run) return;
    try {
      clearInterval(timer.current);
      setRun(await api.post<MeasureView>(`/api/measure/${run.id}/stop`));
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const trace = run?.trace ?? [];
  const pulses = (run?.history.pulse ?? []).filter((p) => p[1] > 0);
  const live = run?.state === 'running';

  return (
    <main className="page measure">
      <section className="page-head">
        <span className="eyebrow">Real signals, live</span>
        <h1>See what the SDK reads from you</h1>
        <p className="lead">Your camera runs through the Presage SmartSpectra SDK for one minute and shows your pulse rate, breathing rate and breathing movement as they arrive. No pattern, no decision, and nothing is recorded.</p>
      </section>

      <section className="measure-grid">
        <div className="card camera-card">
          {sensor === 'camera' ? (
            <CameraPanel stream={cam.stream} status={cam.status} error={cam.error} fps={cam.fps} hint={run?.message}
              onPreview={setPreviewing} previewing={previewing} canPreview={!active} />
          ) : (
            <div className="camera-panel"><div className="camera-frame"><div className="camera-empty"><span className="camera-glyph" aria-hidden="true" /><p>The desktop bridge uses the webcam on your own machine. {run?.message}</p></div></div></div>
          )}
          <div className="control-head">
            <span className="muted small">Sensor</span>
            <SensorPicker options={options} value={sensor} onChange={(s) => { setPicked(s); saveSensor(s); }} disabled={active} />
          </div>
          <div className="row wrap">
            {active ? (
              <Button className="btn danger big" onAct={stop} busyLabel="Stopping…" data-testid="measure-stop">Stop</Button>
            ) : (
              <Button className="btn primary big" disabled={!chosen?.ready} onAct={start} busyLabel="Starting…" data-testid="measure-start">
                {run ? 'Read again' : 'Start a 60 second reading'}
              </Button>
            )}
            {live && run?.seconds_left !== null && <span className="countdown" data-testid="measure-left">{Math.ceil(run!.seconds_left ?? 0)} s left</span>}
            {run?.state === 'arming' && <span className="muted">Starting the camera…</span>}
          </div>
          {run?.state === 'failed' && <p className="note warn" role="alert" data-testid="measure-error">{run.message}</p>}
          {!chosen?.ready && !active && <p className="note warn">{chosen?.detail}.</p>}
        </div>

        <div className="stack-col">
          <div className="card">
            <h3>Right now</h3>
            <Readout values={run?.readout ?? null} live={live} />
          </div>
          <div className="card">
            <div className="row between"><h3>Breathing movement</h3><small className="muted">last 30 s, chest trace</small></div>
            <LiveLine points={trace} windowS={30} label="Breathing movement over the last 30 seconds" />
            {!trace.length && <p className="muted small">The trace starts about a second after your face and upper chest are in view.</p>}
          </div>
          <div className="card">
            <div className="row between"><h3>Pulse rate</h3><small className="muted">SDK 12 s average, bpm</small></div>
            <LiveLine points={pulses} windowS={Math.max(30, run?.elapsed_s ?? 30)} color="var(--pulse)" height={110} label="Pulse rate over the reading" />
            {!pulses.length && <p className="muted small">The first pulse value arrives after about 12 seconds.</p>}
          </div>
        </div>
      </section>

      <section className="card fine-print">
        <h3>How to read this</h3>
        <ul className="plain small">
          <li>Values come straight from the SDK with its own confidence. Above 45% is what the SDK marks as stable.</li>
          <li>The pulse rate is a 12-second average, so it moves slowly. Breathing rate needs a few full breaths.</li>
          <li>This is a presence signal for an attention gate. It is not a measure of fitness or wellbeing.</li>
          <li>Frames go to this server over an encrypted connection, are decoded in memory for the SDK and are dropped at once.</li>
        </ul>
        <Link className="btn" to="/">Try the breath gate</Link>
      </section>
    </main>
  );
}
