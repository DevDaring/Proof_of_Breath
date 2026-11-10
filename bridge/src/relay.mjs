// Server-side relay for browser cameras. Usage: POB_RELAY_ENV=/path/.env POB_RELAY_SLOT=0 node src/relay.mjs
import WebSocket, { WebSocketServer } from 'ws';
import * as sdkModule from '@smartspectra/node-sdk';
import { apiKeys, loadEnvFile } from './core.mjs';
import { FRAME_H, FRAME_W, MAX_PIXELS, startRelay } from './relay-core.mjs';

const env = { ...loadEnvFile(process.env.POB_RELAY_ENV), ...process.env };
env.POB_BACKEND_WS ??= 'ws://127.0.0.1:8270';
const slot = Number(env.POB_RELAY_SLOT ?? 0);
const port = Number(env.POB_RELAY_PORT ?? 8271 + slot);

for (const [name, ok] of [['POB_RELAY_TOKEN', (env.POB_RELAY_TOKEN ?? '').length >= 16], ['POB_PUBLIC_URL', env.POB_PUBLIC_URL], ['PRESAGE_API_KEY', apiKeys(env).length > 0]]) {
  if (!ok) { console.error(`${name} is missing.`); process.exit(1); }
}

// sharp is an optional dependency: only the relay needs it, not the desktop bridge.
const { default: sharp } = await import('sharp');
sharp.concurrency(1);
const decode = async (jpeg) => {
  const { data, info } = await sharp(jpeg, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
    // Every frame leaves at exactly FRAME_W x FRAME_H. The SDK's optical flow aborts if the size changes
    // mid-capture, and webcams often switch resolution a second or two after they open.
    .resize(FRAME_W, FRAME_H, { fit: 'cover', position: 'centre' })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error('unexpected channels');
  return { data, width: info.width, height: info.height };
};

const relay = startRelay({ env, slot, port, sdkModule, decode, WebSocketImpl: WebSocket, WebSocketServer });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await relay.close(); process.exit(0); });
}
