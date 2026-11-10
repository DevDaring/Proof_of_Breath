import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { BrowserFeed, FrameClock, signTicket, startRelay, verifyTicket } from '../src/relay-core.mjs';

const SECRET = 'relay-secret-for-tests-0123456789';
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function frame(tsUs, size = 64) {
  const buf = Buffer.alloc(8 + size, 1);
  buf.writeDoubleLE(tsUs, 0);
  return buf;
}

test('tickets verify, and tampered or expired ones do not', () => {
  const now = 1_000_000;
  const t = signTicket(SECRET, 'cap-1', 2, now + 60);
  assert.deepEqual(verifyTicket(SECRET, t, now), { captureId: 'cap-1', slot: 2, exp: now + 60 });
  assert.equal(verifyTicket(SECRET, t, now + 61), null);
  assert.equal(verifyTicket('another-secret-0123456789abcdef', t, now), null);
  assert.equal(verifyTicket(SECRET, t.replace('cap-1', 'cap-2'), now), null);
  assert.equal(verifyTicket(SECRET, t.replace('.2.', '.3.'), now), null);
  for (const bad of [null, '', 'a.b.c', 'x'.repeat(300), 'a.b.c.zz']) assert.equal(verifyTicket(SECRET, bad, now), null);
});

test('the frame clock keeps browser spacing, drops floods and never goes backwards', () => {
  const clock = new FrameClock(() => 5_000_000);
  assert.equal(clock.map(1_000_000), 5_000_000);
  assert.equal(clock.map(1_033_000), 5_033_000);
  assert.equal(clock.map(1_040_000), null, 'faster than 50 fps is dropped');
  assert.equal(clock.map(900_000), null, 'out of order is dropped');
  assert.equal(clock.map(NaN), null);
  assert.equal(clock.map(1_066_000), 5_066_000);
});

class FakeWs extends EventEmitter {
  constructor() { super(); this.closedWith = null; }
  close(code) { this.closedWith = code; }
  send() {}
}

function fakeCapture() {
  return {
    wanted: 'cap', captureId: 'cap', frames: [], sent: [], stopped: [],
    pushFrame(data, w, h, ts) { this.frames.push({ w, h, ts }); return true; },
    send(msg) { this.sent.push(msg); },
    stop(id) { this.stopped.push(id); this.wanted = null; },
  };
}

test('a feed decodes frames in order and pushes them to the SDK', async () => {
  const capture = fakeCapture();
  const ws = new FakeWs();
  let n = 0;
  const decode = async () => { n += 1; await settle(n % 2 ? 5 : 1); return { data: Buffer.alloc(12), width: 2, height: 2 }; };
  const feed = new BrowserFeed({ capture, captureId: 'cap', ws, decode, clock: new FrameClock(() => 0) });
  ws.emit('message', frame(1_000_000), true);
  ws.emit('message', frame(1_033_000), true);
  ws.emit('message', frame(1_066_000), true);
  await settle(40);
  assert.deepEqual(capture.frames.map((f) => f.ts), [0, 33_000, 66_000]);
  assert.equal(feed.stats.accepted, 3);
  feed.close();
});

test('a feed drops oversized, undecodable and too-large frames without stopping', async () => {
  const capture = fakeCapture();
  const ws = new FakeWs();
  const sizes = [{ width: 2, height: 2 }, { width: 4000, height: 4000 }];
  let i = 0;
  const decode = async (jpeg) => {
    if (jpeg[0] === 9) throw new Error('bad jpeg');
    return { data: Buffer.alloc(3), ...sizes[i++ % 2] };
  };
  const feed = new BrowserFeed({ capture, captureId: 'cap', ws, decode, clock: new FrameClock(() => 0) });
  ws.emit('message', Buffer.alloc(700_000), true);
  ws.emit('message', Buffer.alloc(4), true);
  const broken = frame(1_000_000);
  broken[8] = 9;
  ws.emit('message', broken, true);
  ws.emit('message', frame(1_100_000), true);
  ws.emit('message', frame(1_200_000), true);
  await settle(20);
  assert.equal(capture.frames.length, 1);
  assert.equal(feed.stats.dropped, 4);
  assert.equal(capture.sent.length, 0);
  feed.close();
});

test('a browser error ends the capture with a fixed message, never the browser text', () => {
  const capture = fakeCapture();
  const ws = new FakeWs();
  new BrowserFeed({ capture, captureId: 'cap', ws, decode: async () => ({}) });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'camera_error', reason: '<script>' })), false);
  assert.equal(capture.sent[0].type, 'capture_error');
  assert.equal(capture.sent[0].message, 'The browser could not open the camera.');
  assert.deepEqual(capture.stopped, ['cap']);
  assert.equal(ws.closedWith, 4000);
});

test('the browser closing mid-capture stops it, but closing after it ended does not report', () => {
  const capture = fakeCapture();
  const ws = new FakeWs();
  new BrowserFeed({ capture, captureId: 'cap', ws, decode: async () => ({}) });
  ws.emit('close');
  assert.equal(capture.sent[0].message, 'The browser camera stopped.');
  const later = fakeCapture();
  later.wanted = 'other';
  const ws2 = new FakeWs();
  new BrowserFeed({ capture: later, captureId: 'cap', ws: ws2, decode: async () => ({}) });
  ws2.emit('close');
  assert.equal(later.sent.length, 0);
});

function fakeSdk() {
  const instances = [];
  class SmartSpectraSDK {
    static version = 'fake';
    constructor(options) { this.options = options; this.handlers = {}; this.frames = []; instances.push(this); }
    on(name, fn) { this.handlers[name] = fn; return this; }
    useCustomInput() { this.custom = true; return this; }
    useCamera() { throw new Error('the relay must not open a local camera'); }
    start() { this.handlers.processingStatus?.(3); }
    sendFrame(buf, w, h, stride, fmt, ts) { this.frames.push({ w, h, stride, fmt, ts }); return true; }
    async stopAsync() {}
    async destroy() {}
  }
  return {
    instances, SmartSpectraSDK, ProcessingStatus: { kRunning: 3 }, SmartSpectraErrorCode: {}, PixelFormat: { kRGB: 0 },
    CameraSelection: {}, breathingMetrics: [0], cardioMetrics: [15], decodeMetrics: (b) => b,
  };
}

test('end to end: ticket, origin, frames, ready and stop', async () => {
  const backend = new WebSocketServer({ port: 0 });
  await new Promise((r) => backend.on('listening', r));
  const fromRelay = [];
  let relaySocket;
  backend.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
    relaySocket = ws;
    ws.on('message', (m) => fromRelay.push(JSON.parse(String(m))));
  });
  const sdkModule = fakeSdk();
  const env = { POB_BACKEND_WS: `ws://127.0.0.1:${backend.address().port}`, POB_RELAY_TOKEN: SECRET, POB_PUBLIC_URL: 'https://pob.example', PRESAGE_API_KEY: 'k' };
  const relay = startRelay({
    env, slot: 1, port: 0, sdkModule, WebSocketImpl: WebSocket, WebSocketServer, log: () => {},
    decode: async () => ({ data: Buffer.alloc(640 * 480 * 3), width: 640, height: 480 }),
  });
  await new Promise((r) => relay.server.on('listening', r));
  const port = relay.server.address().port;
  await settle(80);
  assert.deepEqual(fromRelay[0], { type: 'hello', sdk_version: 'fake', kind: 'relay', slot: 1 });

  const open = (ticket, origin = 'https://pob.example', path = '/ws/camera/1') => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?t=${encodeURIComponent(ticket)}`, { headers: { origin } });
    ws.on('open', () => resolve({ ws, ok: true }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false }));
  });
  const exp = Math.floor(Date.now() / 1000) + 60;

  // Nothing started yet: a valid ticket is still refused.
  const early = await open(signTicket(SECRET, 'cap-9', 1, exp));
  const earlyClose = await new Promise((r) => early.ws.on('close', (code) => r(code)));
  assert.equal(earlyClose, 4409);

  relaySocket.send(JSON.stringify({ type: 'start_capture', capture_id: 'cap-9', enable_telemetry: false }));
  await settle(30);
  assert.equal((await open(signTicket(SECRET, 'cap-9', 1, exp), 'https://evil.example')).status, 403);
  assert.equal((await open(signTicket(SECRET, 'cap-9', 2, exp))).status, 401);
  assert.equal((await open('nope')).status, 401);
  assert.equal((await open(signTicket(SECRET, 'cap-9', 1, exp), undefined, '/ws/camera/2')).status, 404);

  const good = await open(signTicket(SECRET, 'cap-9', 1, exp));
  assert.ok(good.ok);
  const closed = new Promise((r) => good.ws.on('close', (code) => r(code)));
  const t = Date.now() * 1000;
  for (let i = 0; i < 3; i += 1) good.ws.send(frame(t + i * 33_000));
  await settle(80);
  const sdk = sdkModule.instances.at(-1);
  assert.ok(sdk.custom);
  assert.equal(sdk.frames.length, 3);
  assert.deepEqual(sdk.frames.map((f) => f.ts - sdk.frames[0].ts), [0, 33_000, 66_000]);
  assert.equal(sdk.frames[0].stride, 640 * 3);
  assert.ok(fromRelay.some((m) => m.type === 'capture_ready' && m.capture_id === 'cap-9'), 'ready only after a frame');

  relaySocket.send(JSON.stringify({ type: 'stop_capture', capture_id: 'cap-9' }));
  assert.equal(await closed, 4000);
  await settle(20);
  assert.ok(!fromRelay.some((m) => m.type === 'capture_error'), 'a normal stop is not an error');
  await relay.close();
  backend.close();
});

test('a feed drops frames whose size differs from the first frame', async () => {
  const sizes = [[4, 3], [4, 3], [2, 2], [4, 3]];
  let i = 0;
  const pushed = [];
  const capture = { wanted: 'cap', pushFrame: (_d, w, h) => { pushed.push(`${w}x${h}`); return true; }, send() {}, stop() {} };
  const ws = new EventEmitter(); ws.close = () => {};
  const decode = async () => { const [w, h] = sizes[i++]; return { data: Buffer.alloc(w * h * 3), width: w, height: h }; };
  const feed = new BrowserFeed({ capture, captureId: 'cap', ws, decode, clock: new FrameClock(() => 0) });
  for (let k = 0; k < sizes.length; k++) {
    const b = Buffer.alloc(32); b.writeDoubleLE(k * 40_000, 0);
    ws.emit('message', b, true);
  }
  await feed.chain;
  assert.ok(pushed.length >= 3 && pushed.every((p) => p === '4x3'), 'no frame of another size reaches the SDK');
  assert.equal(feed.stats.accepted, 3);
  assert.equal(feed.stats.dropped, 1);
  feed.close();
});

test('a slow feed is held up to about 30 frames a second, but a long stall is not filled', async () => {
  const pushed = [];
  const capture = { wanted: 'cap', pushFrame: (d, _w, _h, ts) => { pushed.push([d[0], ts]); return true; }, send() {}, stop() {} };
  const ws = new EventEmitter(); ws.close = () => {};
  let n = 0;
  const decode = async () => { n += 1; return { data: Buffer.from([n, 0, 0]), width: 1, height: 1 }; };
  const feed = new BrowserFeed({ capture, captureId: 'cap', ws, decode, clock: new FrameClock(() => 0) });
  for (const t of [0, 100_000, 1_000_000]) { // 10 fps, then a 0.9 s stall
    const b = Buffer.alloc(32); b.writeDoubleLE(t, 0);
    ws.emit('message', b, true);
  }
  await feed.chain;
  const ts = pushed.map(([, t]) => t);
  assert.deepEqual(pushed.map(([v]) => v), [1, 1, 1, 2, 3], 'two copies of frame 1 fill the 100 ms gap; the stall is left empty');
  assert.ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), 'timestamps strictly increase');
  assert.equal(feed.stats.filled, 2);
  assert.equal(feed.stats.accepted, 3, 'only real frames count as accepted');
  feed.close();
});
