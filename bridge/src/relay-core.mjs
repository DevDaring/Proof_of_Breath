// Browser camera relay. It runs next to the backend and feeds frames from the person's browser into
// the SDK's custom input. Frames are decoded in memory, handed to the SDK and dropped. Nothing is stored.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { runBridge } from './core.mjs';

export const MAX_FRAME_BYTES = 600_000;
export const MAX_PIXELS = 1280 * 960;
/** The size every frame reaches the SDK at: 4:3, which the SDK frames well (16:9 at 640x360 fails). */
export const FRAME_W = 640;
export const FRAME_H = 480;
const MIN_FRAME_GAP_US = 20_000; // drops anything faster than 50 frames a second
const MAX_QUEUE = 4;
const STALL_MS = 4000;
// Below about 20 frames a second the SDK refuses frames and then fails with kProcessingFailed about 10 s in
// (reproduced offline at 14 fps). Slow uploads and dim webcams deliver 10 to 15 fps, so short gaps are filled
// by repeating the last real frame at evenly spaced times: sample and hold, as any frame-rate converter does.
// Measurements still come only from real frames. Longer gaps are left alone, so a stall still shows as one.
const FILL_STEP_US = 33_333;
const FILL_MAX_GAP_US = 400_000;

/** Ticket: `<capture_id>.<slot>.<expiry_s>.<hex hmac>`, signed by the backend with the relay token. */
export function signTicket(secret, captureId, slot, expS) {
  const payload = `${captureId}.${slot}.${expS}`;
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export function verifyTicket(secret, ticket, nowS = Date.now() / 1000) {
  if (typeof ticket !== 'string' || ticket.length > 200) return null;
  const parts = ticket.split('.');
  if (parts.length !== 4) return null;
  const [captureId, slot, exp, mac] = parts;
  const expected = createHmac('sha256', secret).update(`${captureId}.${slot}.${exp}`).digest();
  let given;
  try { given = Buffer.from(mac, 'hex'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!(Number(exp) > nowS)) return null;
  return { captureId, slot: Number(slot), exp: Number(exp) };
}

/** Browser capture times mapped onto this machine's clock, strictly increasing as the SDK requires. */
export class FrameClock {
  constructor(nowUs = () => Date.now() * 1000) {
    this.nowUs = nowUs;
    this.offset = null;
    this.lastBrowser = -Infinity;
    this.last = -Infinity;
  }

  /** Returns null for a frame that arrives too soon after the previous one or out of order. */
  map(browserUs) {
    if (!Number.isFinite(browserUs)) return null;
    if (browserUs - this.lastBrowser < MIN_FRAME_GAP_US) return null;
    this.lastBrowser = browserUs;
    // Fixed at the first frame, so the spacing between frames is the browser's own capture spacing.
    if (this.offset === null) this.offset = this.nowUs() - browserUs;
    let t = Math.round(browserUs + this.offset);
    if (t <= this.last) t = this.last + 1;
    this.last = t;
    return t;
  }
}

const BROWSER_ERRORS = {
  denied: 'Camera access was blocked in the browser. Allow the camera for this site and try again.',
  unavailable: 'No camera was found, or another app is using it.',
  hidden: 'The tab went to the background, so the camera stopped. Keep this tab in front during the check.',
};

/** One browser socket feeding one capture. */
export class BrowserFeed {
  constructor({ capture, captureId, ws, decode, log = () => {}, clock = new FrameClock() }) {
    Object.assign(this, { capture, captureId, ws, decode, log, clock });
    this.queue = 0;
    this.chain = Promise.resolve();
    this.lastFrameAt = 0;
    this.closed = false;
    this.stats = { received: 0, accepted: 0, dropped: 0, filled: 0 };
    this.prev = null;
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.onClose());
    ws.on('error', () => undefined);
    this.watch = setInterval(() => {
      if (!this.current()) return this.close(4000);
      if (this.lastFrameAt && Date.now() - this.lastFrameAt > STALL_MS) this.fail('Camera frames stopped arriving. Keep this tab in front during the check.');
    }, 1000);
  }

  current() {
    return !this.closed && this.capture.wanted === this.captureId;
  }

  onMessage(data, isBinary) {
    if (!this.current()) return;
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(String(data).slice(0, 500)); } catch { return; }
      if (msg?.type === 'camera_error') this.fail(BROWSER_ERRORS[msg.reason] ?? 'The browser could not open the camera.');
      return;
    }
    this.stats.received += 1;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 16 || buf.length > MAX_FRAME_BYTES || this.queue >= MAX_QUEUE) {
      this.stats.dropped += 1;
      return;
    }
    const ts = this.clock.map(buf.readDoubleLE(0));
    if (ts === null) {
      this.stats.dropped += 1;
      return;
    }
    this.queue += 1;
    const jpeg = buf.subarray(8);
    // Decoded one at a time, so frames reach the SDK in capture order.
    this.chain = this.chain
      .then(async () => {
        if (!this.current()) return;
        const frame = await this.decode(jpeg);
        if (!this.current()) return;
        if (frame.width * frame.height > MAX_PIXELS) throw new Error('frame too large');
        // The SDK cannot take a change of frame size mid-capture (it aborts in optical flow), so the
        // first frame fixes the size and any other size is dropped.
        this.size ??= `${frame.width}x${frame.height}`;
        if (this.size !== `${frame.width}x${frame.height}`) throw new Error('frame size changed');
        const prev = this.prev;
        const gap = prev ? ts - prev.ts : 0;
        if (prev && gap > FILL_STEP_US * 1.5 && gap <= FILL_MAX_GAP_US) {
          const copies = Math.round(gap / FILL_STEP_US) - 1;
          for (let k = 1; k <= copies; k++) {
            if (!this.current()) return;
            if (this.capture.pushFrame(prev.data, prev.width, prev.height, prev.ts + Math.round((k * gap) / (copies + 1)))) this.stats.filled += 1;
          }
        }
        this.prev = { data: frame.data, width: frame.width, height: frame.height, ts };
        if (this.capture.pushFrame(frame.data, frame.width, frame.height, ts)) {
          this.stats.accepted += 1;
          this.lastFrameAt = Date.now();
        } else {
          this.stats.dropped += 1;
        }
      })
      .catch(() => { this.stats.dropped += 1; })
      .finally(() => { this.queue -= 1; });
  }

  fail(message) {
    if (!this.current()) return;
    this.log(`browser feed ended: ${message}`);
    this.capture.send({ type: 'capture_error', capture_id: this.captureId, message });
    this.capture.stop(this.captureId);
    this.close(4000);
  }

  onClose() {
    if (this.closed) return;
    clearInterval(this.watch);
    const wasCurrent = this.current();
    this.closed = true;
    this.report();
    if (wasCurrent) {
      this.capture.send({ type: 'capture_error', capture_id: this.captureId, message: 'The browser camera stopped.' });
      this.capture.stop(this.captureId);
    }
  }

  report() {
    if (this.reported) return;
    this.reported = true;
    const { received, accepted, dropped, filled } = this.stats;
    this.log(`browser feed closed: ${received} frames received, ${accepted} accepted, ${dropped} dropped, ${filled} held to keep the rate up`);
    this.prev = null;
  }

  close(code = 4000) {
    clearInterval(this.watch);
    this.closed = true;
    this.report();
    try { this.ws.close(code, 'done'); } catch { /* already closed */ }
  }
}

/**
 * Starts one relay slot: a bridge link to the backend plus a WebSocket endpoint for the browser.
 * The SDK's native state is process-global, so each slot is its own process with one capture at a time.
 */
export function startRelay({ env, slot, port, sdkModule, decode, WebSocketImpl, WebSocketServer, log = console.log }) {
  const secret = env.POB_RELAY_TOKEN;
  const origin = new URL(env.POB_PUBLIC_URL).origin;
  let feed = null;
  const bridge = runBridge({
    WebSocketImpl, sdkModule, env, log, token: secret, hello: { kind: 'relay', slot }, input: 'custom',
    onStop: (captureId) => { if (feed && feed.captureId === captureId) feed.close(4000); },
  });
  const capture = bridge.capture;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 1024, perMessageDeflate: false });
  const server = createServer((_req, res) => { res.writeHead(404).end(); });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://relay');
    const ticket = verifyTicket(secret, url.searchParams.get('t'));
    const reject = (code) => { socket.write(`HTTP/1.1 ${code} No\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (url.pathname !== `/ws/camera/${slot}`) return reject(404);
    if (req.headers.origin !== origin) return reject(403);
    if (!ticket || ticket.slot !== slot) return reject(401);
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Only the capture the backend started, and only one browser socket for it.
      if (capture.wanted !== ticket.captureId || (feed && feed.captureId === ticket.captureId && !feed.closed)) {
        ws.close(4409, 'not expected');
        return;
      }
      feed?.close(4000);
      feed = new BrowserFeed({ capture, captureId: ticket.captureId, ws, decode, log });
      ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  server.listen(port, '127.0.0.1', () => log(`relay slot ${slot} listening on 127.0.0.1:${port}`));
  return {
    server, bridge, get feed() { return feed; },
    close: async () => { feed?.close(4000); server.close(); await bridge.close(); },
  };
}
