// The bridge only captures and forwards. All decisions stay on the backend.
// No frames ever leave this process: video stays inside the SDK on this device.
import { readFileSync, existsSync } from 'node:fs';

const FLUSH_MS = 250;
const MAX_RESTARTS = 2;
const emptyBuffer = () => ({ breath: [], pulse: [], pressure: [], rate: [] });
const ONE_DAY_US = 86_400_000_000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const PING_MS = 5000;
const SILENCE_LIMIT_MS = 15000;

/** Tolerant .env reader. Values are never logged. */
export function loadEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Primary key first, then the fallback. Empty values are dropped. */
export function apiKeys(env) {
  return [env.PRESAGE_API_KEY, env.PRESAGE_API_KEY2].filter(Boolean);
}

/** SDK timestamps decode as Long objects. Field values may be missing. */
export function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  return Number(String(value));
}

/** Maps SDK timestamps onto this machine's clock, in microseconds. */
export class TimestampMapper {
  constructor(nowUs = () => Date.now() * 1000) {
    this.nowUs = nowUs;
    this.offset = null;
  }

  map(ts) {
    if (this.offset === null) {
      // Documented as epoch microseconds. File input can be relative, so anchor those to now.
      this.offset = Math.abs(ts - this.nowUs()) < ONE_DAY_US ? 0 : this.nowUs() - ts;
    }
    return ts + this.offset;
  }
}

/** Pull new samples out of one decoded metrics packet. Resent samples are dropped. */
export class SampleExtractor {
  constructor(mapper) {
    this.mapper = mapper;
    this.last = { breath: -Infinity, pulse: -Infinity, pressure: -Infinity, rate: -Infinity };
  }

  extract(metrics) {
    const out = { breath: [], pulse: [], pressure: [], rate: [] };
    const upper = metrics?.breathing?.upperTrace;
    const trace = upper && upper.length ? upper : metrics?.breathing?.lowerTrace;
    for (const s of trace ?? []) {
      const t = this.mapper.map(toNumber(s.timestamp));
      if (Number.isFinite(t) && t > this.last.breath) { this.last.breath = t; out.breath.push([t, s.value]); }
    }
    for (const s of metrics?.cardio?.pulseRate ?? []) {
      const t = this.mapper.map(toNumber(s.timestamp));
      if (Number.isFinite(t) && t > this.last.pulse) { this.last.pulse = t; out.pulse.push([t, s.value, s.confidence ?? 0]); }
    }
    for (const s of metrics?.cardio?.arterialPressureTrace ?? []) {
      const t = this.mapper.map(toNumber(s.timestamp));
      if (Number.isFinite(t) && t > this.last.pressure) { this.last.pressure = t; out.pressure.push([t, s.value]); }
    }
    // Breathing rate in breaths per minute, shown to the person. It never decides anything.
    for (const s of metrics?.breathing?.rate ?? []) {
      const t = this.mapper.map(toNumber(s.timestamp));
      if (Number.isFinite(t) && t > this.last.rate) { this.last.rate = t; out.rate.push([t, s.value, s.confidence ?? 0]); }
    }
    return out;
  }
}

/**
 * One capture at a time. The SDK's native state is process-global, so every lifecycle step
 * is chained and each capture gets a new instance with its own telemetry setting.
 */
export class Capture {
  /** input is 'device' (camera or file, opened by the SDK) or 'custom' (frames pushed with pushFrame). */
  constructor({ sdkModule, keys, send, env = {}, log = () => {}, input = 'device' }) {
    Object.assign(this, { sdkModule, keys, send, env, log, input });
    this.sdk = null;
    this.captureId = null;
    this.buffer = emptyBuffer();
    this.timer = null;
    this.chain = Promise.resolve();
  }

  enqueue(step) {
    this.chain = this.chain.then(step).catch((err) => this.log(`capture step failed: ${err?.message ?? err}`));
    return this.chain;
  }

  start(captureId, enableTelemetry) {
    // Set at once, before the queued steps run, so a browser that connects quickly is still recognised.
    this.wanted = captureId;
    return this.enqueue(async () => {
      await this.teardown();
      this.captureId = captureId;
      this.enableTelemetry = enableTelemetry;
      this.keyIndex = 0;
      this.restarts = 0;
      await this.open();
    });
  }

  stop(captureId) {
    if (this.wanted === captureId) this.wanted = null;
    return this.enqueue(async () => {
      if (this.captureId === captureId) await this.teardown();
    });
  }

  async open() {
    const { SmartSpectraSDK, CameraSelection, breathingMetrics, cardioMetrics, decodeMetrics, ProcessingStatus, SmartSpectraErrorCode } = this.sdkModule;
    const captureId = this.captureId;
    const extractor = new SampleExtractor(new TimestampMapper());
    const sdk = new SmartSpectraSDK({
      apiKey: this.keys[this.keyIndex],
      requestedMetrics: [...breathingMetrics, ...cardioMetrics],
      enableTelemetry: this.enableTelemetry === true,
    });
    this.sdk = sdk;
    let ready = false;
    this.markReady = () => {
      if (ready || this.captureId !== captureId) return;
      ready = true;
      this.send({ type: 'capture_ready', capture_id: captureId });
    };
    // With pushed frames the SDK is running before any frame exists, so ready waits for the first frame.
    sdk.on('processingStatus', (status) => {
      if (status === ProcessingStatus.kRunning && this.input !== 'custom') this.markReady();
    });
    // The SDK reports this on every frame, so only forward changes.
    let lastStatus = null;
    sdk.on('validationStatus', (code, _ts, hint) => {
      const status = `${code}:${hint}`;
      if (status === lastStatus) return;
      lastStatus = status;
      this.send({ type: 'validation', capture_id: captureId, code, hint, bridge_ts_us: Date.now() * 1000 });
    });
    sdk.on('metrics', (buf) => {
      const decoded = decodeMetrics(buf);
      if (Buffer.isBuffer(decoded)) return;
      const fresh = extractor.extract(decoded);
      for (const name of Object.keys(this.buffer)) this.buffer[name].push(...fresh[name]);
    });
    sdk.on('error', (code, message, retryable) => {
      const keyProblem = code === SmartSpectraErrorCode.kAuthenticationFailed || code === SmartSpectraErrorCode.kCreditExhausted;
      if (keyProblem && this.keyIndex + 1 < this.keys.length && this.captureId === captureId) {
        this.log('the primary API key was refused, switching to the fallback key');
        this.keyIndex += 1;
        this.enqueue(async () => {
          if (this.captureId !== captureId) return;
          await this.closeSdk();
          await this.open();
        });
        return;
      }
      // Seen live: the SDK sometimes reports kProcessingFailed a few seconds into an otherwise good feed, and a
      // fresh SDK instance on the same frames carries on. Restart quietly, a bounded number of times.
      const transient = retryable === true || [SmartSpectraErrorCode.kProcessingFailed, SmartSpectraErrorCode.kServerError, SmartSpectraErrorCode.kNetworkError].includes(code);
      if (transient && this.restarts < MAX_RESTARTS && this.captureId === captureId) {
        this.restarts += 1;
        this.log(`sdk error ${code} (retryable=${retryable}), restarting the SDK (${this.restarts} of ${MAX_RESTARTS})`);
        this.enqueue(async () => {
          if (this.captureId !== captureId) return;
          await this.closeSdk();
          await this.open();
        });
        return;
      }
      this.send({ type: 'capture_error', capture_id: captureId, message: friendlyError(code, this.sdkModule) });
      this.enqueue(async () => { if (this.captureId === captureId) await this.teardown(); });
      this.log(`sdk error ${code}: ${String(message).slice(0, 200)}`);
    });
    this.timer ??= setInterval(() => this.flush(), FLUSH_MS);
    if (this.input === 'custom') {
      sdk.useCustomInput();
    } else if (this.env.POB_BRIDGE_VIDEO_FILE) {
      sdk.useFile(this.env.POB_BRIDGE_VIDEO_FILE, { interframeDelayMs: 33 });
    } else if (this.env.POB_CAMERA_ID) {
      sdk.useCamera(CameraSelection.byId(this.env.POB_CAMERA_ID));
    } else {
      sdk.useCamera(CameraSelection.default);
    }
    try {
      sdk.start();
    } catch (err) {
      this.send({ type: 'capture_error', capture_id: captureId, message: friendlyError(err?.code, this.sdkModule) });
      await this.teardown();
    }
  }

  /** Custom input only. Returns true when the SDK accepted the frame. */
  pushFrame(rgb, width, height, timestampUs) {
    const sdk = this.sdk;
    if (!sdk || this.input !== 'custom') return false;
    let accepted = false;
    try {
      accepted = sdk.sendFrame(rgb, width, height, width * 3, this.sdkModule.PixelFormat.kRGB, timestampUs);
    } catch (err) {
      this.log(`frame refused: ${err?.message ?? err}`);
    }
    if (accepted) this.markReady?.();
    return accepted;
  }

  flush() {
    const { breath, pulse, pressure, rate } = this.buffer;
    if (!breath.length && !pulse.length && !pressure.length && !rate.length) return;
    this.send({ type: 'metrics', capture_id: this.captureId, breath, pulse, pressure, rate });
    this.buffer = emptyBuffer();
  }

  async closeSdk() {
    const sdk = this.sdk;
    this.sdk = null;
    this.markReady = null;
    if (!sdk) return;
    try { await sdk.stopAsync(); } catch (err) { this.log(`stop: ${err?.message}`); }
    try { await sdk.destroy(); } catch (err) { this.log(`destroy: ${err?.message}`); }
  }

  async teardown() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.flush();
    this.captureId = null;
    this.buffer = emptyBuffer();
    await this.closeSdk();
  }
}

function friendlyError(code, sdkModule) {
  const c = sdkModule.SmartSpectraErrorCode ?? {};
  switch (code) {
    case c.kAuthenticationFailed: return 'The Presage API key was refused.';
    case c.kCreditExhausted: return 'The Presage account is out of credit.';
    case c.kNetworkError: return 'The SDK could not reach the Presage service.';
    case c.kInputUnavailable: return 'The camera could not be opened. Is another app using it?';
    case c.kServerError: return 'The Presage service had a problem. Run the check again.';
    case c.kProcessingFailed: return 'The sensor could not process the camera feed. Run the check again, and keep your face and upper chest in view.';
    case c.kTimestampGap: return 'Camera frames arrived with a long gap. Keep this tab in front and run the check again.';
    default: return 'The sensor reported an error. Run the check again.';
  }
}

/** Connection loop: authenticate, obey start and stop, and reconnect with backoff. */
export function runBridge({ WebSocketImpl, sdkModule, env, log = console.log, token = env.POB_BRIDGE_TOKEN, hello = {}, input = 'device', onStop = () => {} }) {
  const url = `${env.POB_BACKEND_WS.replace(/\/$/, '')}/ws/bridge`;
  const keys = apiKeys(env);
  let ws = null;
  let stopped = false;
  let delay = RECONNECT_MIN_MS;
  let pingTimer = null;
  let reconnectTimer = null;

  const send = (payload) => {
    if (ws && ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify(payload));
  };
  const capture = new Capture({ sdkModule, keys, send, env, log, input });

  const connect = () => {
    if (stopped) return;
    ws = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    let lastHeard = Date.now();
    ws.on('open', () => {
      delay = RECONNECT_MIN_MS;
      lastHeard = Date.now();
      send({ type: 'hello', sdk_version: sdkModule.SmartSpectraSDK.version, ...hello });
      // A silent network drop raises no close event, and the backend's stop_capture would never
      // arrive, so the camera must not depend on it. Ending the socket here releases the camera.
      pingTimer = setInterval(() => {
        if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
          log('the backend went silent, closing the connection');
          ws.terminate();
          return;
        }
        send({ type: 'ping' });
      }, PING_MS);
      log(input === 'custom' ? 'connected to the backend. Waiting for browser camera checks.' : 'connected to the backend. The camera stays off until a check starts.');
    });
    ws.on('message', (raw) => {
      lastHeard = Date.now();
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'start_capture') {
        send({ type: 'clock_ack', capture_id: msg.capture_id, bridge_now_us: Date.now() * 1000 });
        log('camera on');
        capture.start(msg.capture_id, msg.enable_telemetry === true);
      } else if (msg.type === 'stop_capture') {
        log('camera off');
        onStop(msg.capture_id);
        capture.stop(msg.capture_id);
      }
    });
    ws.on('close', (code) => {
      clearInterval(pingTimer);
      // Losing the backend must never leave the camera running.
      capture.wanted = null;
      capture.enqueue(() => capture.teardown());
      if (code === 4401) log('the backend refused the bridge token');
      if (!stopped) {
        reconnectTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      }
    });
    ws.on('error', (err) => log(`connection problem: ${err.code ?? 'unknown'}`));
  };
  connect();
  return {
    capture,
    close: async () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearInterval(pingTimer);
      await capture.enqueue(() => capture.teardown());
      ws?.close();
    },
  };
}
