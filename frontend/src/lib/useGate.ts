import { useCallback, useEffect, useRef, useState } from 'react';
import { api, GateView, Phase, Scores } from './api';
import type { CameraOffer } from './camera';
import type { ReadoutValues } from '../components/Readout';

export interface RunState {
  state: 'idle' | 'arming' | 'warmup' | 'running' | 'verifying' | 'done';
  simulated: boolean;
  cameraOn: boolean;
  phases: Phase[] | null;
  target: number[] | null;
  lengthS: number;
  t0Perf: number | null;
  attemptNo: number | null;
  sensor: string | null;
  camera: CameraOffer | null;
}

export interface GateResult {
  scores: Scores; passed: boolean; status: string; failures: string[]; attempts_used: number; attempts_left: number;
  thresholds: Record<string, number>; gates: Record<string, boolean>; simulated: boolean; trial_id: string | null;
  sensor?: string; readout?: { pulse_bpm: number | null; pulse_samples: number; breath_rpm: number | null };
}

const IDLE: RunState = { state: 'idle', simulated: false, cameraOn: false, phases: null, target: null, lengthS: 0, t0Perf: null, attemptNo: null, sensor: null, camera: null };

/** Live link to one gate request. The server decides everything; this only renders it. */
export function useGate(requestId: string | null) {
  const [view, setView] = useState<GateView | null>(null);
  const [run, setRun] = useState<RunState>(IDLE);
  const [hint, setHint] = useState('');
  const [pulse, setPulse] = useState(false);
  const [result, setResult] = useState<GateResult | null>(null);
  const [aborted, setAborted] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [readout, setReadout] = useState<ReadoutValues | null>(null);
  const [closedCode, setClosedCode] = useState<number | null>(null);
  const trace = useRef<number[][]>([]);
  const socket = useRef<WebSocket | null>(null);
  const abortedSinceStart = useRef(false);

  const adopt = useCallback((session: any) => {
    setRun({
      state: session.state, simulated: session.simulated, cameraOn: session.camera_on, phases: session.phases, target: session.target,
      lengthS: session.length_s, attemptNo: session.attempt_no, sensor: session.sensor ?? null, camera: session.camera ?? null,
      t0Perf: session.starts_in_s === null ? null : performance.now() + session.starts_in_s * 1000,
    });
    setReadout(session.readout ?? null);
    trace.current = session.trace ?? [];
    setHint(session.hint ?? '');
    setPulse(!!session.pulse_present);
  }, []);

  useEffect(() => {
    if (!requestId) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;

    const open = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/ws/gate/${requestId}`);
      socket.current = ws;
      ws.onopen = () => {
        setConnected(true);
        keepAlive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 20000);
      };
      ws.onmessage = (event) => {
        if (event.data === 'pong') return;
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'snapshot':
            setView(msg.request);
            setBridgeConnected(msg.bridge_connected);
            if (msg.session) adopt(msg.session);
            else setRun((r) => (r.state === 'done' ? r : IDLE));
            break;
          case 'state':
            setRun((r) => ({
              ...r, state: msg.state, simulated: msg.simulated, cameraOn: msg.camera_on, attemptNo: msg.attempt_no,
              sensor: msg.sensor ?? r.sensor, camera: msg.camera ?? null,
              t0Perf: msg.starts_in_s === null ? r.t0Perf : performance.now() + msg.starts_in_s * 1000,
            }));
            break;
          case 'progress':
            trace.current.push(...msg.points);
            setPulse(msg.pulse_present);
            setHint(msg.hint);
            if (msg.readout) setReadout(msg.readout);
            break;
          case 'result':
            setResult(msg);
            setRun((r) => ({ ...r, state: 'done', cameraOn: false, t0Perf: null, camera: null }));
            setView((v) => (v ? { ...v, status: msg.status, attempts_used: msg.attempts_used } : v));
            break;
          case 'aborted':
            abortedSinceStart.current = true;
            setAborted(msg.reason);
            setRun((r) => ({ ...r, state: 'idle', cameraOn: false, t0Perf: null, camera: null }));
            break;
          case 'closed':
            setRun((r) => ({ ...r, state: 'idle', cameraOn: false, camera: null }));
            setView((v) => (v ? { ...v, status: msg.status } : v));
            break;
        }
      };
      ws.onclose = (event) => {
        clearInterval(keepAlive);
        setConnected(false);
        if (stopped) return;
        if (event.code >= 4400 && event.code < 4500) {
          setClosedCode(event.code);
          return;
        }
        retry = setTimeout(open, 1500);
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(keepAlive);
      socket.current?.close();
    };
  }, [requestId, adopt]);

  // The bridge can connect after this page opened, so keep checking rather than trusting the snapshot.
  useEffect(() => {
    if (!requestId) return;
    let alive = true;
    const check = () => api.get<{ connected: boolean }>('/api/bridge/status').then((b) => alive && setBridgeConnected(b.connected)).catch(() => undefined);
    const timer = setInterval(check, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [requestId]);

  /** Call before asking the server to start, so a fast failure is not wiped by the reply. */
  const prepare = useCallback(() => {
    trace.current = [];
    abortedSinceStart.current = false;
    setResult(null);
    setAborted(null);
    setReadout(null);
  }, []);

  const begin = useCallback((phases: Phase[], attemptNo: number, simulated: boolean, sensor: string) => {
    setRun((r) => ({
      ...r, state: !abortedSinceStart.current && (r.state === 'idle' || r.state === 'done') ? 'arming' : r.state, phases, attemptNo, simulated, sensor,
      lengthS: phases.reduce((sum, p) => sum + p.duration, 0), target: buildTarget(phases),
    }));
  }, []);

  return { view, setView, run, hint, pulse, result, aborted, setAborted, connected, bridgeConnected, trace, prepare, begin, closedCode, readout };
}

/** Local copy of the target curve for drawing only. The server's copy is the one verified. */
export function buildTarget(phases: Phase[], fs = 10): number[] {
  const out: number[] = [];
  let level = 0;
  for (const p of phases) {
    const n = Math.round(p.duration * fs);
    for (let i = 1; i <= n; i += 1) {
      const x = i / n;
      if (p.kind === 'inhale') out.push(0.5 * (1 - Math.cos(Math.PI * x)));
      else if (p.kind === 'exhale') out.push(0.5 * (1 + Math.cos(Math.PI * x)));
      else out.push(level);
    }
    if (p.kind === 'inhale') level = 1;
    if (p.kind === 'exhale') level = 0;
  }
  return out;
}
