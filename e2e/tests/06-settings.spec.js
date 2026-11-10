import { readFileSync } from 'node:fs';
import { test, expect, click, ready, signInJury, api, flip } from './helpers.js';

test('settings: thresholds, gates, sensor', async ({ page }) => {
  await ready(page);
  await page.goto('/settings');
  await expect(page.getByTestId('threshold-label')).toHaveText('Provisional');
  await expect(page.getByTestId('th-s_decoy')).toHaveValue('0');

  await page.getByTestId('th-s_xcorr').fill('5');
  await click(page, 'save-thresholds');
  await expect(page.getByTestId('toast-error')).toContainText('between 0 and 1');
  await page.getByTestId('th-s_xcorr').fill('');
  await click(page, 'save-thresholds');
  await expect(page.getByTestId('toast-error').last()).toContainText('between 0 and 1');
  await page.getByTestId('th-s_xcorr').fill('0.75');
  await click(page, 'save-thresholds');
  await expect(page.getByTestId('toast-ok').first()).toContainText('Thresholds saved');
  await page.reload();
  await expect(page.getByTestId('th-s_xcorr')).toHaveValue('0.75');
  await click(page, 'reset-thresholds');
  await expect(page.getByTestId('th-s_xcorr')).toHaveValue('0.6');

  for (const gate of ['xcorr', 'phase', 'cycles', 'live', 'decoy', 'coupling']) {
    const box = page.getByTestId(`gate-${gate}`);
    const before = await box.isChecked();
    await flip(box, !before);
    await flip(box, before);
  }
  await click(page, 'polarity-down');
  await expect(page.getByText('Trace sign: inhale falls')).toBeVisible();
  await click(page, 'polarity-up');
  await expect(page.getByText('Trace sign: inhale rises')).toBeVisible();
  await click(page, 'recalibrate');
  await expect(page).toHaveURL(/onboarding/);
  await expect(page.getByTestId('calibrate-start')).toBeVisible();
});

test('settings: privacy toggles, consent, export, delete all', async ({ page }) => {
  await ready(page);
  await page.goto('/settings');
  const telemetry = page.getByTestId('telemetry');
  await expect(telemetry).not.toBeChecked();
  await flip(telemetry, true);
  await flip(telemetry, false);

  const store = page.getByTestId('store-text');
  await flip(store, true);
  await flip(store, false);

  const llm = page.getByTestId('runtime-llm');
  await expect(llm).toBeEnabled();
  const llmSwitch = llm.locator('xpath=following-sibling::span[contains(@class,"switch")]');
  await llmSwitch.click();
  await expect(page.getByRole('dialog')).toContainText('NanoGPT');
  await click(page, 'confirm-cancel');
  await expect(llm).not.toBeChecked();
  await llmSwitch.click();
  await click(page, 'confirm-ok');
  await expect(llm).toBeChecked();
  await flip(llm, false);

  await click(page, 'grant-eval');
  await expect(page.getByTestId('consent-list')).toContainText('Evaluation mode: accepted');
  await click(page, 'revoke-eval');
  await expect(page.getByTestId('consent-list')).toContainText('Evaluation mode: not accepted');

  const [download] = await Promise.all([page.waitForEvent('download'), click(page, 'settings-export')]);
  expect(JSON.parse(readFileSync(await download.path(), 'utf8')).count).toBe(0);

  await click(page, 'revoke-gate');
  await expect(page).toHaveURL(/onboarding/);
  await page.getByTestId('consent-gate').check();
  await click(page, 'i-agree');

  const made = await api(page, 'POST', '/api/gate/requests', { command: 'DROP TABLE t' });
  await api(page, 'POST', `/api/gate/requests/${made.body.request_id}/deny`);
  await page.goto('/settings');
  await click(page, 'delete-all');
  await expect(page.getByRole('dialog')).toContainText('cannot be undone');
  await click(page, 'confirm-cancel');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await api(page, 'GET', '/api/receipts')).body.total).toBe(1);
  await click(page, 'delete-all');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click(page, 'delete-all');
  await click(page, 'confirm-ok');
  await expect(page).toHaveURL(/onboarding/);
  expect((await api(page, 'GET', '/api/receipts')).body.total).toBe(0);
  expect((await api(page, 'GET', '/api/session')).body.consents).toEqual([]);
});

test('settings: sign out button', async ({ page }) => {
  await signInJury(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await click(page, 'settings-signout');
  await expect(page).toHaveURL(/\/login/);
});
