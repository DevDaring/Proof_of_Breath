import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message } from './api';
import type { CameraOffer } from './camera';
import type { Sensor } from './sensors';

export interface CalibrationView {
  id: string; state: 'arming' | 'warmup' | 'inhale' | 'settling' | 'done' | 'failed'; message: string; polarity: number | null;
  simulated: boolean; sensor: Sensor; seconds_left: number; camera: CameraOffer | null;
}

/** One slow breath to learn which way this camera reports inhaling. The server runs it; this polls. */
export function useCalibration(onFinished?: (run: CalibrationView) => void, onError?: (text: string) => void) {
  const [run, setRun] = useState<CalibrationView | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>();
  const finished = useRef(onFinished);
  const failed = useRef(onError);
  finished.current = onFinished;
  failed.current = onError;

  useEffect(() => () => clearInterval(timer.current), []);

  const start = useCallback(async (sensor?: Sensor) => {
    try {
      const started = await api.post<CalibrationView>('/api/calibration/polarity', sensor ? { sensor } : {});
      setRun(started);
      clearInterval(timer.current);
      timer.current = setInterval(async () => {
        try {
          const next = await api.get<CalibrationView>(`/api/calibration/polarity/${started.id}`);
          setRun(next);
          if (next.state === 'done' || next.state === 'failed') {
            clearInterval(timer.current);
            finished.current?.(next);
          }
        } catch (err) {
          clearInterval(timer.current);
          failed.current?.(message(err));
        }
      }, 400);
    } catch (err) {
      failed.current?.(message(err));
    }
  }, []);

  const running = !!run && run.state !== 'done' && run.state !== 'failed';
  return { run, start, running, reset: () => setRun(null) };
}

