import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { Capture, SampleExtractor, TimestampMapper, apiKeys, loadEnvFile, runBridge, toNumber } from '../src/core.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATUS = { kIdle: 1, kRunning: 3 };
const ERRORS = { kAuthenticationFailed: 2, kCreditExhausted: 4, kNetworkError: 5, kServerError: 6, kInputUnavailable: 7, kProcessingFailed: 8 };

function fakeSdkModule() {
  const instances = [];
  class SmartSpectraSDK {
    static version = 'fake';
    constructor(options) { this.options = options; this.handlers = {}; this.stopped = 0; this.destroyed = 0; instances.push(this); }
    on(name, fn) { this.handlers[name] = fn; return this; }
    useCamera(selection) { this.source = selection; return this; }
    useFile(file) { this.source = { file }; return this; }
    start() { this.started = true; }
    async stopAsync() { this.stopped += 1; }
    async destroy() { this.destroyed += 1; }
  }
  return {
    instances, SmartSpectraSDK, ProcessingStatus: STATUS, SmartSpectraErrorCode: ERRORS,
    CameraSelection: { default: { kind: 'default' }, byId: (id) => ({ kind: 'byId', id }) },
    breathingMetrics: [0], cardioMetrics: [15], decodeMetrics: (b) => b.decoded,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test('env reader tolerates spaces and quotes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pob-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, '# c\nA = 1\nB="two"\n\nC=three\r\nnot a line\n');
  assert.deepEqual(loadEnvFile(file), { A: '1', B: 'two', C: 'three' });
  assert.deepEqual(loadEnvFile(path.join(dir, 'missing')), {});
});

test('primary key comes first and blanks are dropped', () => {
  assert.deepEqual(apiKeys({ PRESAGE_API_KEY: 'a', PRESAGE_API_KEY2: 'b' }), ['a', 'b']);
  assert.deepEqual(apiKeys({ PRESAGE_API_KEY: '', PRESAGE_API_KEY2: 'b' }), ['b']);
  assert.deepEqual(apiKeys({}), []);
});

test('Long timestamps convert', () => {
  assert.equal(toNumber({ toNumber: () => 5 }), 5);
  assert.equal(toNumber({ toString: () => '7' }), 7);
  assert.equal(toNumber(9), 9);
  assert.ok(Number.isNaN(toNumber(undefined)));
});

test('epoch timestamps pass through and relative ones anchor to now', () => {
  const now = 1_800_000_000_000_000;
  assert.equal(new TimestampMapper(() => now).map(now - 500), now - 500);
  const relative = new TimestampMapper(() => now);
  assert.equal(relative.map(1000), now);
  assert.equal(relative.map(2000), now + 1000);
});

test('resent samples are dropped, chest trace is preferred, abdomen is the backup', () => {
  const x = new SampleExtractor(new TimestampMapper(() => 1000));
  const t = (ts, value, confidence) => ({ timestamp: { toNumber: () => ts }, value, confidence });
  const first = x.extract({ breathing: { upperTrace: [t(1, 0.1), t(2, 0.2)], lowerTrace: [t(1, 9)] }, cardio: { pulseRate: [t(1, 70, 90)], arterialPressureTrace: [t(1, 0.5)] } });
  assert.deepEqual(first.breath.map((s) => s[1]), [0.1, 0.2]);
  assert.deepEqual(first.pulse[0].slice(1), [70, 90]);
  assert.equal(first.pressure.length, 1);
  assert.deepEqual(x.extract({ breathing: { upperTrace: [t(2, 0.2), t(3, 0.3)] } }).breath.map((s) => s[1]), [0.3]);
  assert.deepEqual(x.extract({ breathing: { upperTrace: [], lowerTrace: [t(4, 0.4)] } }).breath.map((s) => s[1]), [0.4]);
  assert.deepEqual(x.extract({}), { breath: [], pulse: [], pressure: [], rate: [] });
  const rates = x.extract({ breathing: { rate: [{ ...t(5, 14.5), confidence: 60 }, { ...t(5, 14.5), confidence: 60 }] } }).rate;
  assert.equal(rates.length, 1, 'a resent rate is dropped');
  assert.deepEqual(rates[0].slice(1), [14.5, 60]);
});

function capture(mod, keys = ['primary', 'secondary'], env = {}) {
  const sent = [];
  return { sent, cap: new Capture({ sdkModule: mod, keys, send: (m) => sent.push(m), env }) };
}

test('capture forwards readiness, hints and metrics, then stops the camera', async () => {
  const mod = fakeSdkModule();
  const { sent, cap } = capture(mod);
  await cap.start('c1', false);
  const sdk = mod.instances[0];
  assert.equal(sdk.options.apiKey, 'primary');
  assert.equal(sdk.options.enableTelemetry, false);
  assert.equal(sdk.source.kind, 'default');
  assert.equal(sdk.started, true);
  sdk.handlers.processingStatus(STATUS.kRunning);
  sdk.handlers.validationStatus(1, 0, 'No face found.');
  const stamp = Date.now() * 1000;
  sdk.handlers.metrics({ decoded: { breathing: { upperTrace: [{ timestamp: stamp, value: 1 }] } } });
  await cap.stop('c1');
  assert.equal(sdk.stopped, 1);
  assert.equal(sdk.destroyed, 1);
  assert.deepEqual(sent.map((m) => m.type), ['capture_ready', 'validation', 'metrics']);
  assert.equal(sent[2].breath[0][1], 1);
  assert.equal(cap.timer, null);
});

test('validation repeats on every frame, so only changes are forwarded', async () => {
  const mod = fakeSdkModule();
  const { sent, cap } = capture(mod);
  await cap.start('c1', false);
  const sdk = mod.instances[0];
  for (let i = 0; i < 100; i += 1) sdk.handlers.validationStatus(0, i, 'Hold still and record.');
  sdk.handlers.validationStatus(7, 100, 'Place more of the chest in view.');
  sdk.handlers.validationStatus(7, 101, 'Place more of the chest in view.');
  sdk.handlers.validationStatus(0, 102, 'Hold still and record.');
  assert.deepEqual(sent.filter((m) => m.type === 'validation').map((m) => m.code), [0, 7, 0]);
  await cap.stop('c1');
});

test('telemetry is only on when the backend says so', async () => {
  const mod = fakeSdkModule();
  const { cap } = capture(mod);
  await cap.start('c1', true);
  assert.equal(mod.instances[0].options.enableTelemetry, true);
  await cap.stop('c1');
});

test('a refused key falls back to PRESAGE_API_KEY2', async () => {
  const mod = fakeSdkModule();
  const { sent, cap } = capture(mod);
  await cap.start('c1', false);
  mod.instances[0].handlers.error(ERRORS.kAuthenticationFailed, 'nope', false);
  await settle();
  assert.equal(mod.instances.length, 2);
  assert.equal(mod.instances[1].options.apiKey, 'secondary');
  assert.equal(mod.instances[0].destroyed, 1);
  assert.equal(sent.filter((m) => m.type === 'capture_error').length, 0);
  mod.instances[1].handlers.error(ERRORS.kCreditExhausted, 'empty', false);
  await settle();
  assert.equal(sent.at(-1).type, 'capture_error');
  assert.match(sent.at(-1).message, /out of credit/);
  assert.equal(mod.instances[1].destroyed, 1, 'camera released after the last key fails');
});

test('other errors do not burn the fallback key', async () => {
  const mod = fakeSdkModule();
  const { sent, cap } = capture(mod);
  await cap.start('c1', false);
  mod.instances[0].handlers.error(ERRORS.kInputUnavailable, 'busy', false);
  await settle();
  assert.equal(mod.instances.length, 1);
  assert.match(sent.at(-1).message, /camera could not be opened/);
});

test('a processing failure restarts the SDK quietly, at most twice per capture', async () => {
  const mod = fakeSdkModule();
  const { sent, cap } = capture(mod);
  await cap.start('c1', false);
  for (const i of [0, 1]) {
    mod.instances[i].handlers.error(ERRORS.kProcessingFailed, 'SmartSpectra processing failed.', false);
    await settle();
    assert.equal(mod.instances.length, i + 2, 'a fresh SDK takes over');
    assert.equal(mod.instances[i].destroyed, 1);
    assert.equal(mod.instances[i + 1].options.apiKey, mod.instances[0].options.apiKey, 'same key');
    assert.equal(sent.filter((m) => m.type === 'capture_error').length, 0);
  }
  mod.instances[2].handlers.error(ERRORS.kProcessingFailed, 'SmartSpectra processing failed.', false);
  await settle();
  assert.equal(mod.instances.length, 3);
  assert.equal(sent.at(-1).type, 'capture_error');
  assert.match(sent.at(-1).message, /could not process/);
  // A new capture gets its own restarts.
  await cap.start('c2', false);
  mod.instances[3].handlers.error(ERRORS.kServerError, 'x', true);
  await settle();
  assert.equal(mod.instances.length, 5);
  await cap.stop('c2');
});

test('a stale stop does not end a newer capture', async () => {
  const mod = fakeSdkModule();
  const { cap } = capture(mod);
  await cap.start('c1', false);
  await cap.start('c2', false);
  assert.equal(mod.instances[0].destroyed, 1, 'the earlier capture is closed first');
  await cap.stop('c1');
  assert.equal(mod.instances[1].destroyed, 0);
  await cap.stop('c2');
  assert.equal(mod.instances[1].destroyed, 1);
});

test('video file and camera id sources', async () => {
  const mod = fakeSdkModule();
  const a = capture(mod, ['k'], { POB_BRIDGE_VIDEO_FILE: 'x.mp4' });
  await a.cap.start('c', false);
  assert.deepEqual(mod.instances[0].source, { file: 'x.mp4' });
  await a.cap.stop('c');
  const b = capture(mod, ['k'], { POB_CAMERA_ID: 'cam1' });
  await b.cap.start('c', false);
  assert.deepEqual(mod.instances[1].source, { kind: 'byId', id: 'cam1' });
  await b.cap.stop('c');
});

test('a silent backend ends the connection and releases the camera', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date', 'setTimeout'] });
  FakeSocket.sockets = [];
  const mod = fakeSdkModule();
  const bridge = runBridge({ WebSocketImpl: FakeSocket, sdkModule: mod, env: { POB_BACKEND_WS: 'wss://x', POB_BRIDGE_TOKEN: 't', PRESAGE_API_KEY: 'k' }, log: () => {} });
  const ws = FakeSocket.sockets[0];
  ws.emit('open');
  ws.emit('message', JSON.stringify({ type: 'start_capture', capture_id: 'c', enable_telemetry: false }));
  t.mock.timers.tick(5000);
  ws.emit('message', JSON.stringify({ type: 'pong' }));
  t.mock.timers.tick(10000);
  assert.equal(ws.terminated, undefined, 'still alive while pongs arrive');
  t.mock.timers.tick(20000);
  assert.equal(ws.terminated, true);
  t.mock.timers.reset();
  await settle();
  assert.equal(mod.instances[0].destroyed, 1);
  await bridge.close();
});

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  static sockets = [];
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; this.out = []; FakeSocket.sockets.push(this); }
  send(text) { this.out.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close', 1000); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006); }
}

test('connection loop authenticates, obeys commands, and stops the camera on disconnect', async () => {
  FakeSocket.sockets = [];
  const mod = fakeSdkModule();
  const bridge = runBridge({ WebSocketImpl: FakeSocket, sdkModule: mod, env: { POB_BACKEND_WS: 'wss://x/', POB_BRIDGE_TOKEN: 't', PRESAGE_API_KEY: 'k' }, log: () => {} });
  const ws = FakeSocket.sockets[0];
  assert.equal(ws.url, 'wss://x/ws/bridge');
  assert.equal(ws.options.headers.Authorization, 'Bearer t');
  ws.emit('open');
  assert.equal(ws.out[0].type, 'hello');
  assert.equal(mod.instances.length, 0, 'no SDK or camera before a check starts');
  ws.emit('message', JSON.stringify({ type: 'start_capture', capture_id: 'c', enable_telemetry: false }));
  await settle();
  assert.equal(ws.out[1].type, 'clock_ack');
  assert.equal(mod.instances.length, 1);
  ws.emit('message', 'not json');
  ws.readyState = 3;
  ws.emit('close', 1006);
  await settle();
  assert.equal(mod.instances[0].destroyed, 1, 'camera released when the backend goes away');
  await bridge.close();
});
