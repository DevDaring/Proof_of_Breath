import { readFileSync } from 'node:fs';
import { test, expect, click, ready, api } from './helpers.js';

test('evaluation: opt-in, sessions, a real-time trial, synthetic batch, results, export, delete', async ({ page }) => {
  await ready(page);
  await page.goto('/evaluation');
  await click(page, 'eval-optin');
  await expect(page.getByTestId('eval-create-session')).toBeVisible();

  await page.getByTestId('eval-code').fill('Jane Doe');
  await click(page, 'eval-create-session');
  await expect(page.getByTestId('toast-error')).toContainText('never a name');
  await page.getByTestId('eval-code').fill('P01');
  await page.getByTestId('eval-lighting').selectOption('dim');
  await click(page, 'eval-create-session');
  await expect(page.getByTestId('eval-sessions')).toContainText('P01 · dim · simulated · 0 trials');

  await expect(page.getByTestId('view-simulated')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('eval-condition').selectOption('photo');
  await expect(page.getByText('Hold a photo of a face')).toBeVisible();
  await click(page, 'eval-run-trial');
  await expect(page.getByTestId('trial-runner')).toBeVisible();
  await expect(page.getByTestId('eval-run-trial')).toBeDisabled();
  await expect(page.getByTestId('trial-result')).toContainText('Rejected', { timeout: 70_000 });
  await expect(page.getByTestId('trials-table')).toContainText('Printed or phone photo', { timeout: 10_000 });
  await expect(page.getByTestId('trials-table')).toContainText('yes');
  await expect(page.getByTestId('trial-runner')).toHaveCount(0, { timeout: 10_000 });

  await click(page, 'eval-synthetic');
  await expect(page.getByTestId('toast-ok').first()).toContainText('Synthetic batch added', { timeout: 60_000 });
  await expect(page.getByTestId('data-label')).toContainText('not measurements of a person');
  await expect(page.getByTestId('data-label')).toContainText('n = 241');
  await expect(page.getByTestId('decoy-histogram').locator('svg.recharts-surface').first()).toBeVisible();
  await expect(page.getByTestId('roc').locator('svg.recharts-surface').first()).toBeVisible();
  await expect(page.getByTestId('condition-table').locator('tbody tr')).toHaveCount(8);
  await expect(page.getByTestId('far')).not.toHaveText('–');
  await page.getByTestId('range-score').selectOption('s_live');
  await expect(page.getByTestId('score-ranges')).toContainText('Empty chair');
  for (const option of ['s_xcorr', 's_phase', 's_coupling', 's_decoy']) await page.getByTestId('range-score').selectOption(option);

  await click(page, 'view-live');
  await expect(page.getByText('No live trials yet.')).toBeVisible();
  await click(page, 'view-simulated');
  await expect(page.getByTestId('eval-results')).toBeVisible();
  await click(page, 'eval-refresh');
  await expect(page.getByTestId('toast-ok').first()).toBeVisible();

  await click(page, 'eval-calibrate');
  await expect(page.getByTestId('toast-error')).toContainText('Simulated trials never count');
  expect((await api(page, 'GET', '/api/settings')).body.thresholds_calibrated).toBe(false);

  const [download] = await Promise.all([page.waitForEvent('download'), click(page, 'eval-export')]);
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(data.simulated.trials.length).toBe(241);
  expect(data.live.trials.length).toBe(0);

  await click(page, 'eval-delete-trial');
  await expect(page.getByTestId('data-label')).toContainText('n = 240');
  const sessions = page.getByTestId('eval-sessions').locator('li');
  await expect(sessions).toHaveCount(2);
  await sessions.filter({ hasText: 'synthetic' }).getByTestId('eval-delete-session').click();
  await expect(sessions).toHaveCount(1);
  await expect(page.getByText('No simulated trials yet.').or(page.getByTestId('data-label'))).toBeVisible();

  await click(page, 'eval-delete-all');
  await click(page, 'confirm-cancel');
  await expect(page.getByTestId('eval-sessions')).toBeVisible();
  await click(page, 'eval-delete-all');
  await click(page, 'confirm-ok');
  await expect(page.getByTestId('eval-sessions')).toHaveCount(0);
  await expect(page.getByText('No simulated trials yet.')).toBeVisible();
});
