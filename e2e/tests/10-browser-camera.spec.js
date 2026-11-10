// The browser camera path end to end: real Chrome, a real recorded face fed in as the webcam, the relay on the
// server, the real Presage SDK, and the live site. Set POB_E2E_CAMERA_FILE to an MJPEG of a person with the face
// and upper chest in view (Chrome loops it as a fake webcam). The person in that recording is not following any
// pacer, so the honest outcome of a check is a rejection; what this proves is that real values arrive.
import { existsSync } from 'node:fs';
import { test, expect, click, signInJury, agree } from './helpers.js';

const FILE = process.env.POB_E2E_CAMERA_FILE;
test.skip(!FILE || !existsSync(FILE), 'needs POB_E2E_CAMERA_FILE');
test.use({
  permissions: ['camera'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${FILE}`] },
});

async function juryReady(page) {
  await signInJury(page, '/onboarding');
  await agree(page);
}

test('live reading: the SDK reads a real pulse and breathing rate from the browser camera', async ({ page }) => {
  test.setTimeout(150_000);
  await juryReady(page);
  await page.goto('/measure');
  await click(page, 'sensor-camera');
  await click(page, 'camera-preview');
  await expect(page.getByTestId('camera-status')).toContainText('Preview only');
  await click(page, 'measure-start');
  await expect(page.getByTestId('camera-status')).toContainText('Streaming to the SDK', { timeout: 30_000 });
  // The SDK's pulse is a 12-second average, so the first value takes a little while.
  await expect(page.getByTestId('readout-pulse')).toHaveText(/^\d{2,3}bpm$/, { timeout: 60_000 });
  await expect(page.getByTestId('readout-breath')).toHaveText(/^\d+(\.\d)?per min$/, { timeout: 40_000 });
  const pulse = Number((await page.getByTestId('readout-pulse').innerText()).replace('bpm', ''));
  expect(pulse).toBeGreaterThan(40);
  expect(pulse).toBeLessThan(140);
  await page.screenshot({ path: 'test-results/live-reading.png', fullPage: true });
  await click(page, 'measure-stop');
  await expect(page.getByTestId('camera-status')).toContainText(/Camera off|Preview only/, { timeout: 15_000 });
  await expect(page.getByTestId('measure-start')).toBeEnabled();
});

test('a practice round through the browser camera: calibration first, then a scored check with real readings', async ({ page }) => {
  test.setTimeout(240_000);
  await juryReady(page);
  await click(page, 'calibrate-skip');
  await click(page, 'practice-start');
  await expect(page.getByTestId('start-check')).toBeVisible();
  await click(page, 'sensor-camera');
  await click(page, 'start-check');
  // A simulated sign is never enough for a real camera, so the gate asks for one slow breath.
  await expect(page.getByTestId('calibrate-inline')).toBeVisible();
  await click(page, 'calibrate-inline-start');
  await expect(page.getByTestId('camera-status')).toContainText('Streaming', { timeout: 30_000 });
  const state = page.getByTestId('calibration-state');
  await expect(state).toContainText(/Calibrated|No clear breathing|went wrong|did not start/, { timeout: 60_000 });
  if (!/Calibrated/.test(await state.innerText())) {
    // The recorded person may not breathe in on cue. Set the sign by hand, as Settings allows.
    const ok = await page.evaluate(() => fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ breath_polarity: 1 }) }).then((r) => r.ok));
    expect(ok).toBe(true);
    await page.reload();
    await click(page, 'sensor-camera');
  }
  await expect(page.getByTestId('start-check')).toBeEnabled({ timeout: 15_000 });
  await click(page, 'start-check');
  await expect(page.getByTestId('camera-status')).toContainText('Streaming', { timeout: 30_000 });
  await expect(page.getByTestId('camera-on')).toBeVisible();
  await expect(page.getByTestId('readout-pulse')).toHaveText(/^\d{2,3}bpm$/, { timeout: 45_000 });
  const done = page.getByTestId('result-panel').or(page.getByTestId('verdict-title')).or(page.getByTestId('aborted'));
  await expect(done).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('aborted')).toHaveCount(0);
  await expect(page.getByTestId('result-readout')).toContainText('bpm');
  await page.screenshot({ path: 'test-results/camera-check.png', fullPage: true });
  await expect(page.getByTestId('camera-status')).toContainText(/Camera off|Preview only/, { timeout: 15_000 });
});
