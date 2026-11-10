// The real-command path on the deployed site. The follower here is a test double standing in
// for the bridge, because this server has no camera. The real SDK runs in the second test.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, click, api, HOST_ENV, ROOT, WebSocket, readEnv } from './helpers.js';

const BASE = process.env.POB_E2E_URL || 'https://pob.koushikdeb.com';
const hook = path.join(ROOT, 'interceptors', 'claude-code', 'pob_pre_tool_use.py');

async function ownerLogin(page) {
  const env = HOST_ENV();
  await page.goto('/login');
  await click(page, 'owner-signin');
  await page.getByTestId('username').fill('owner');
  await page.getByTestId('password').fill(env.POB_OWNER_PASSWORD);
  await click(page, 'sign-in');
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
  await api(page, 'DELETE', '/api/data');
  await page.goto('/onboarding');
  await page.getByTestId('consent-gate').check();
  await click(page, 'i-agree');
  await api(page, 'PUT', '/api/settings', { breath_polarity: 1 });
}

function runHook(command) {
  const env = HOST_ENV();
  const child = spawn('python3', [hook], { env: { ...process.env, POB_URL: BASE, POB_INTERCEPTOR_TOKEN: env.POB_INTERCEPTOR_TOKEN, BROWSER: 'true', HOME: '/nonexistent-home' } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', () => resolve(out)));
  child.stdin.end(JSON.stringify({ tool_name: 'Bash', cwd: '/tmp', tool_input: { command }, hook_event_name: 'PreToolUse' }));
  return done;
}

/** Test double for the bridge: streams a follower of the given pattern in real time. */
function fakeBridge(token) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws/bridge`, { headers: { Authorization: `Bearer ${token}` } });
  const state = { phases: null, capture: null, readyAt: null, stops: 0, starts: 0, timer: null, telemetry: null };
  const target = (t) => {
    let elapsed = 0;
    let level = 0;
    for (const p of state.phases) {
      if (t < elapsed + p.duration) {
        const x = (t - elapsed) / p.duration;
        if (p.kind === 'inhale') return 0.5 * (1 - Math.cos(Math.PI * x));
        if (p.kind === 'exhale') return 0.5 * (1 + Math.cos(Math.PI * x));
        return level;
      }
      elapsed += p.duration;
      if (p.kind === 'inhale') level = 1;
      if (p.kind === 'exhale') level = 0;
    }
    return 0;
  };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', sdk_version: 'e2e-test-double' })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'start_capture') {
      state.starts += 1;
      state.capture = msg.capture_id;
      state.telemetry = msg.enable_telemetry;
      ws.send(JSON.stringify({ type: 'clock_ack', capture_id: msg.capture_id, bridge_now_us: Date.now() * 1000 }));
      ws.send(JSON.stringify({ type: 'capture_ready', capture_id: msg.capture_id }));
      ws.send(JSON.stringify({ type: 'validation', capture_id: msg.capture_id, code: 0, hint: 'Hold still and record.', bridge_ts_us: Date.now() * 1000 }));
      state.readyAt = Date.now();
      state.timer = setInterval(() => {
        if (!state.phases) return;
        const now = Date.now();
        const t = (now - state.readyAt - 12000) / 1000 - 0.8;
        const value = t < 0 ? 0 : target(t) + (Math.random() - 0.5) * 0.04;
        ws.send(JSON.stringify({ type: 'metrics', capture_id: state.capture, breath: [[now * 1000, value]], pulse: [[now * 1000, 72, 90]], pressure: [] }));
      }, 100);
    }
    if (msg.type === 'stop_capture') {
      state.stops += 1;
      clearInterval(state.timer);
    }
  });
  return { ws, state, close: () => { clearInterval(state.timer); ws.close(); } };
}

test('real command: blocked until the live check passes, then the token frees it', async ({ page }) => {
  const env = HOST_ENV();
  await ownerLogin(page);
  const command = `terraform destroy -target=e2e-${Date.now()}`;

  // Bridge offline: start is blocked and the page says why.
  const db = await page.request.get('/api/bridge/status');
  expect((await db.json()).connected).toBe(false);
  const created = await page.request.post('/api/gate/requests', { data: { command: 'DROP TABLE browser_made' } });
  expect((await created.json()).simulated).toBe(true);
  const direct = await fetch(`${BASE}/api/gate/requests`, { method: 'POST', headers: { Authorization: `Bearer ${env.POB_INTERCEPTOR_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `${command}-direct`, source: 'cli' }) });
  const request = await direct.json();
  await page.goto(`/gate/${request.request_id}`);
  await expect(page.getByTestId('source-badge')).toContainText('pob CLI wants to run');
  await expect(page.getByTestId('simulated-badge')).toHaveCount(0);
  // A real request offers only real sensors: the browser camera and the desktop bridge.
  await expect(page.getByTestId('sensor-sim')).toHaveCount(0);
  await click(page, 'sensor-bridge');
  await expect(page.getByTestId('bridge-offline')).toBeVisible();
  await expect(page.getByTestId('start-check')).toBeDisabled();
  await expect(page.getByTestId('scenario')).toHaveCount(0);
  await click(page, 'deny');
  await expect(page.getByTestId('verdict-title')).toHaveText('Denied');

  // An owner cannot calibrate on a simulated sensor: that would satisfy real checks.
  await page.goto('/onboarding');
  await expect(page.getByTestId('sensor-sim')).toHaveCount(0);
  await expect(page.getByTestId('calibrate-start')).toBeDisabled();
  const simCalibration = await api(page, 'POST', '/api/calibration/polarity', { sensor: 'sim' });
  expect(simCalibration.status).toBe(422);

  // The bridge can connect after the page opened, and Start must enable with no reload.
  const later = await fetch(`${BASE}/api/gate/requests`, { method: 'POST', headers: { Authorization: `Bearer ${env.POB_INTERCEPTOR_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: `${command}-later`, source: 'cli' }) }).then((r) => r.json());
  await page.goto(`/gate/${later.request_id}`);
  await expect(page.getByTestId('start-check')).toBeDisabled();

  // Bridge online: the actual hook script waits while a person passes the check in the browser.
  const bridge = fakeBridge(env.POB_BRIDGE_TOKEN);
  await new Promise((resolve) => bridge.ws.once('open', resolve));
  await expect(page.getByTestId('start-check')).toBeEnabled({ timeout: 8000 });
  await expect(page.getByTestId('bridge-offline')).toHaveCount(0);
  await click(page, 'deny');
  await expect(page.getByTestId('verdict-title')).toHaveText('Denied');
  await page.goto('/');
  await expect(page.getByTestId('sensor-status')).toContainText('Bridge connected');
  await expect(page.getByTestId('sensor-status')).toContainText('e2e-test-double');

  const hookDone = runHook(command);
  await page.waitForTimeout(2500);
  // Find the request the hook is waiting on. The hook would normally open this URL itself.
  const pg = spawn('docker', ['exec', 'pob-db', 'psql', '-U', 'pob', '-d', 'proof_of_breath', '-Atc',
    "SELECT id FROM gate_requests WHERE status='pending' AND source='claude-code' ORDER BY created_at DESC LIMIT 1"]);
  let idText = '';
  pg.stdout.on('data', (d) => { idText += d; });
  await new Promise((resolve) => pg.on('close', resolve));
  const id = idText.trim();
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  await page.goto(`/gate/${id}`);
  await expect(page.getByTestId('source-badge')).toContainText('Claude Code wants to run');
  await expect(page.getByTestId('command')).toContainText(command);
  await expect(page.getByTestId('simulated-badge')).toHaveCount(0);
  const [attempt] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/attempts')), click(page, 'start-check')]);
  bridge.state.phases = (await attempt.json()).phases;
  await expect(page.getByTestId('camera-on')).toBeVisible();
  await expect(page.getByTestId('hint')).toHaveText('Hold still and record.');
  await expect(page.getByTestId('pulse-state')).toHaveText('Live pulse detected', { timeout: 20_000 });
  await expect(page.getByTestId('pacer-word')).toHaveText('Breathe in', { timeout: 25_000 });
  await expect(page.getByTestId('verdict-title')).toHaveText('Approved', { timeout: 70_000 });
  await expect(page.getByTestId('camera-on')).toHaveCount(0);
  await expect(page.getByTestId('verdict')).toContainText('single-use token');
  expect(bridge.state.stops, 'camera told to stop after the window').toBe(1);
  expect(bridge.state.telemetry, 'telemetry off by default').toBe(false);

  const output = JSON.parse(await hookDone);
  expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
  const view = await api(page, 'GET', `/api/gate/requests/${id}`);
  expect(view.body.token).toBeUndefined();
  await click(page, 'to-receipts');
  await expect(page.getByTestId('receipts-table')).toContainText('breath');
  await expect(page.getByTestId('chain-badge')).toContainText('Chain verified');

  // Evaluation with the owner's live option.
  await page.goto('/evaluation');
  await click(page, 'eval-optin');
  await page.getByTestId('eval-code').fill('P99');
  await page.getByTestId('eval-live').check();
  await click(page, 'eval-create-session');
  await expect(page.getByTestId('eval-sessions')).toContainText('live');
  bridge.close();
  await page.waitForTimeout(500);
  await api(page, 'DELETE', '/api/data');
});

async function realBridgeRun(page, video, check) {
  const env = HOST_ENV();
  await ownerLogin(page);
  const bridgeDir = path.join(ROOT, 'bridge');
  const bridgeEnv = readEnv(path.join(bridgeDir, '.env'));
  const log = [];
  const bridge = spawn('node', ['src/index.mjs'], { cwd: bridgeDir, env: { ...process.env, ...bridgeEnv, POB_BACKEND_WS: BASE.replace('http', 'ws'), POB_BRIDGE_VIDEO_FILE: video } });
  bridge.stdout.on('data', (d) => log.push(String(d)));
  bridge.stderr.on('data', (d) => log.push(String(d)));
  try {
    await expect.poll(async () => (await page.request.get('/api/bridge/status')).json().then((b) => b.connected), { timeout: 30_000 }).toBe(true);
    const made = await fetch(`${BASE}/api/gate/requests`, { method: 'POST', headers: { Authorization: `Bearer ${env.POB_INTERCEPTOR_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'terraform destroy', source: 'cli' }) }).then((r) => r.json());
    await page.goto(`/gate/${made.request_id}`);
    await click(page, 'sensor-bridge');
    await expect(page.getByTestId('framing-tips')).toContainText('upper chest');
    await expect(page.getByTestId('start-check')).toBeEnabled();
    await click(page, 'start-check');
    await expect(page.getByTestId('camera-on')).toBeVisible({ timeout: 20_000 });
    await check();
    await expect(page.getByTestId('camera-on')).toHaveCount(0);
    expect(log.join('')).toContain('camera on');
    expect(log.join('')).toContain('camera off');
    for (const line of log) for (const key of Object.values(bridgeEnv)) if (key.length > 20) expect(line, 'bridge logs no secrets').not.toContain(key);
    const view = await api(page, 'GET', `/api/gate/requests/${made.request_id}`);
    expect(view.body.status).toBe('pending');
    await api(page, 'DELETE', '/api/data');
  } finally {
    bridge.kill('SIGTERM');
  }
}

test('real SDK through the shipped bridge: a video with no face is rejected', async ({ page }) => {
  test.skip(!process.env.POB_E2E_VIDEO || !existsSync(process.env.POB_E2E_VIDEO), 'needs POB_E2E_VIDEO');
  await realBridgeRun(page, process.env.POB_E2E_VIDEO, async () => {
    await expect(page.getByTestId('hint')).toContainText(/face/i, { timeout: 30_000 });
    await expect(page.getByTestId('result-panel')).toContainText('No live pulse detected', { timeout: 100_000 });
    await expect(page.getByTestId('result-panel')).toContainText('Not matched');
  });
});

test('real SDK through the shipped bridge: a real person not following is rejected on the pattern, with a live pulse seen', async ({ page }) => {
  test.skip(!process.env.POB_E2E_FACE_VIDEO || !existsSync(process.env.POB_E2E_FACE_VIDEO), 'needs POB_E2E_FACE_VIDEO');
  await realBridgeRun(page, process.env.POB_E2E_FACE_VIDEO, async () => {
    await expect(page.getByTestId('pulse-state')).toHaveText('Live pulse detected', { timeout: 40_000 });
    await expect(page.getByTestId('result-panel')).toContainText('Not matched', { timeout: 100_000 });
    await expect(page.getByTestId('result-panel')).toContainText('Pattern not followed');
    await expect(page.getByTestId('result-panel')).not.toContainText('No live pulse detected');
  });
});
