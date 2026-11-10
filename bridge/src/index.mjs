import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as sdkModule from '@smartspectra/node-sdk';
import { apiKeys, loadEnvFile, runBridge } from './core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = {
  ...loadEnvFile(path.join(here, '..', '..', '.env')),
  ...loadEnvFile(path.join(here, '..', '.env')),
  ...process.env,
};
env.POB_BACKEND_WS ??= 'wss://pob.koushikdeb.com';

for (const [name, ok] of [['POB_BRIDGE_TOKEN', env.POB_BRIDGE_TOKEN], ['PRESAGE_API_KEY', apiKeys(env).length > 0]]) {
  if (!ok) { console.error(`${name} is missing. See bridge/.env.example.`); process.exit(1); }
}
const bridge = runBridge({ WebSocketImpl: WebSocket, sdkModule, env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await bridge.close(); process.exit(0); });
}
