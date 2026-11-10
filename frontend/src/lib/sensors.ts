import { useEffect, useState } from 'react';
import { api } from './api';

export type Sensor = 'camera' | 'bridge' | 'sim';

export interface SensorStatus {
  connected: boolean; busy: boolean; sdk_version: string | null;
  camera: { available: boolean; free: boolean; slots: number; sdk_version: string | null };
}

const KEY = 'pob.sensor';

/** Polls which real sensors exist right now. The server re-checks everything when a check starts. */
export function useSensorStatus(intervalMs = 4000) {
  const [status, setStatus] = useState<SensorStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<SensorStatus>('/api/bridge/status').then((s) => alive && setStatus(s)).catch(() => undefined);
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return status;
}

export function savedSensor(): Sensor | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'camera' || v === 'bridge' || v === 'sim' ? v : null;
  } catch {
    return null;
  }
}

export function saveSensor(sensor: Sensor) {
  try { localStorage.setItem(KEY, sensor); } catch { /* private mode */ }
}

/** The sensors this sign-in may use for this kind of check, in order of preference. */
export function allowedSensors(role: string | undefined, sandbox: boolean, status: SensorStatus | null): { id: Sensor; label: string; detail: string; ready: boolean }[] {
  const out: { id: Sensor; label: string; detail: string; ready: boolean }[] = [];
  out.push({
    id: 'camera', label: 'Your camera',
    detail: status?.camera.available ? (status.camera.free ? 'Real SDK reading from this browser' : 'All camera slots are busy right now') : 'The camera service is offline',
    ready: !!status?.camera.available && status.camera.free,
  });
  if (role === 'owner') {
    out.push({ id: 'bridge', label: 'Desktop bridge', detail: status?.connected ? 'The SDK on your own machine' : 'Not connected', ready: !!status?.connected && !status.busy });
  }
  if (sandbox) out.push({ id: 'sim', label: 'Simulated', detail: 'Synthetic signal, no camera', ready: true });
  return out;
}
