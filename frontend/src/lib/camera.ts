import { useEffect, useRef, useState } from 'react';

/** Where to send frames for one capture. Issued by the server, valid for one check only. */
export interface CameraOffer { path: string; ticket: string }

export type CameraStatus = 'off' | 'preview' | 'connecting' | 'streaming' | 'error';

const WIDTH = 640;
const HEIGHT = 480;
const QUALITY = 0.72;
const MAX_FPS = 30;
const MAX_BUFFERED = 400_000;

// One camera stream for the whole page, so a framing preview can carry straight on into a check.
let shared: MediaStream | null = null;
let pending: Promise<MediaStream> | null = null;
let users = 0;

function live(stream: MediaStream | null) {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
}

export async function acquireCamera(): Promise<MediaStream> {
  users += 1;
  if (live(shared)) return shared!;
  if (!navigator.mediaDevices?.getUserMedia) {
    users -= 1;
    throw Object.assign(new Error('This browser cannot open a camera. Use a recent Chrome, Edge, Firefox or Safari over HTTPS.'), { reason: 'unavailable' });
  }
  pending ??= navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
  });
  try {
    shared = await pending;
    return shared;
  } catch (err: any) {
    users -= 1;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    throw Object.assign(new Error(denied ? 'Camera access was blocked. Allow the camera for this site in the address bar, then try again.' : 'No camera was found, or another app is using it.'), { reason: denied ? 'denied' : 'unavailable' });
  } finally {
    pending = null;
  }
}

export function releaseCamera() {
  users = Math.max(0, users - 1);
  if (users === 0 && shared) {
    shared.getTracks().forEach((t) => t.stop());
    shared = null;
  }
}

/**
 * Opens the camera when a preview is wanted or the server offers a capture, and streams JPEG frames to the
 * relay while the offer lasts. Each frame is 8 bytes of capture time (microseconds, little endian) then the JPEG.
 * The server decodes it in memory for the SDK and drops it. Nothing is recorded.
 */
export function useBrowserCamera(offer: CameraOffer | null, preview: boolean) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('off');
  // While frames stream, decorative motion pauses, so the frame loop is never starved on a slow machine.
  useEffect(() => {
    if (status !== 'streaming') return;
    document.documentElement.classList.add('cam-live');
    return () => document.documentElement.classList.remove('cam-live');
  }, [status]);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const wantCamera = !!offer || preview;
  const ticket = offer?.ticket ?? null;
  const path = offer?.path ?? null;
  const streamRef = useRef<MediaStream | null>(null);

  // The camera itself: on while previewing or capturing, off otherwise.
  useEffect(() => {
    if (!wantCamera) return;
    let cancelled = false;
    let held = false;
    setError(null);
    acquireCamera()
      .then((s) => {
        held = true;
        if (cancelled) return releaseCamera();
        streamRef.current = s;
        setStream(s);
        setStatus((v) => (v === 'off' || v === 'error' ? 'preview' : v));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setStatus('error');
      });
    return () => {
      cancelled = true;
      if (held) releaseCamera();
      streamRef.current = null;
      setStream(null);
      setStatus('off');
      setFps(0);
    };
  }, [wantCamera]);

  // Streaming to the relay for one capture.
  useEffect(() => {
    if (!ticket || !path) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let sent = 0;
    let windowStart = performance.now();
    let lastFrame = 0;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}${path}?t=${encodeURIComponent(ticket)}`);
    ws.binaryType = 'arraybuffer';
    setStatus('connecting');

    const fail = (reason: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'camera_error', reason }));
    };

    const tick = () => {
      if (closed) return;
      timer = setTimeout(tick, 1000 / MAX_FPS / 2);
      const now = performance.now();
      if (busy || now - lastFrame < 1000 / MAX_FPS - 2 || video.readyState < 2 || !ctx) return;
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      // A fixed 4:3 frame, centre-cropped from whatever the camera gives. Webcams often change
      // resolution shortly after opening, and the SDK cannot take a size change mid-capture.
      if (canvas.width !== WIDTH || canvas.height !== HEIGHT) {
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
      }
      const crop = Math.min(vw / WIDTH, vh / HEIGHT);
      const sw = WIDTH * crop;
      const sh = HEIGHT * crop;
      lastFrame = now;
      const capturedUs = (performance.timeOrigin + now) * 1000;
      ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, WIDTH, HEIGHT);
      busy = true;
      canvas.toBlob(async (blob) => {
        try {
          if (!blob || closed || ws.readyState !== WebSocket.OPEN) return;
          const jpeg = new Uint8Array(await blob.arrayBuffer());
          const out = new Uint8Array(8 + jpeg.length);
          new DataView(out.buffer).setFloat64(0, capturedUs, true);
          out.set(jpeg, 8);
          ws.send(out);
          sent += 1;
          if (now - windowStart >= 1000) {
            setFps(Math.round((sent * 1000) / (now - windowStart)));
            sent = 0;
            windowStart = now;
          }
        } finally {
          busy = false;
        }
      }, 'image/jpeg', QUALITY);
    };

    const onHidden = () => { if (document.hidden) fail('hidden'); };
    document.addEventListener('visibilitychange', onHidden);

    ws.onmessage = (event) => {
      let msg: any;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.type !== 'ready') return;
      acquireCamera()
        .then((s) => {
          if (closed) return releaseCamera();
          video.srcObject = s;
          video.play().catch(() => undefined);
          setStatus('streaming');
          tick();
        })
        .catch((err) => {
          setError(err.message);
          setStatus('error');
          fail(err.reason ?? 'unavailable');
        });
    };
    ws.onclose = () => {
      if (!closed) setStatus(streamRef.current ? 'preview' : 'off');
    };

    return () => {
      const holding = !!video.srcObject;
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHidden);
      video.srcObject = null;
      if (holding) releaseCamera();
      try { ws.close(1000); } catch { /* already closed */ }
      setFps(0);
      setStatus(streamRef.current ? 'preview' : 'off');
    };
  }, [ticket, path]);

  return { stream, status, error, fps };
}
