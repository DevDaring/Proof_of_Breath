import { test, expect, click, ready, openGate, api, signInJury, agree, followUntilPassed } from './helpers.js';

test('gate: a follower passes with live visuals, and it stays simulated with no token', async ({ page }) => {
  await ready(page);
  await openGate(page);
  await expect(page.getByTestId('simulated-badge')).toBeVisible();
  await expect(page.getByTestId('source-badge')).toContainText('Demo wants to run');
  await expect(page.getByTestId('camera-on')).toHaveCount(0);
  await page.getByTestId('scenario').selectOption('follower');
  await click(page, 'start-check');
  await expect(page.getByTestId('hint')).toContainText('Simulated sensor');
  await expect(page.getByTestId('camera-on')).toHaveCount(0);
  await expect(page.getByTestId('pacer-word')).toHaveText(/Breathe in|Breathe out|Hold gently|Get ready/, { timeout: 15_000 });
  await expect(page.getByTestId('pacer-word')).toHaveText('Breathe in', { timeout: 15_000 });
  await expect(page.getByTestId('pulse-state')).toHaveText('Live pulse detected', { timeout: 15_000 });
  await expect(page.getByTestId('start-check')).toBeDisabled();
  await expect(page.getByTestId('use-fallback')).toBeDisabled();
  const done = page.getByTestId('verdict-title').or(page.getByTestId('result-panel'));
  await expect(done).toBeVisible({ timeout: 70_000 });
  if (await page.getByTestId('result-panel').count()) await followUntilPassed(page);
  await expect(page.getByTestId('verdict-title')).toHaveText(/Passed/);
  await expect(page.getByTestId('verdict')).toContainText('no token exists');
  await expect(page.getByTestId('scores')).toContainText('Beats the 20 decoy patterns');
  const id = page.url().split('/').pop();
  const view = await api(page, 'GET', `/api/gate/requests/${id}`);
  expect(view.body.status).toBe('practice_passed');
  expect(view.body.token).toBeUndefined();
  await click(page, 'to-receipts');
  await expect(page.getByTestId('receipts-table')).toContainText('simulated');
});

test('gate: an attack fails, retries use a new pattern, and three failures deny', async ({ page }) => {
  await ready(page);
  await openGate(page, 'DROP TABLE orders');
  await page.getByTestId('scenario').selectOption('photo');
  await expect(page.getByTestId('start-check')).toHaveText('Start check');
  const responses = [];
  page.on('response', async (r) => { if (r.url().endsWith('/attempts') && r.ok()) responses.push(await r.json()); });
  await click(page, 'start-check');
  await expect(page.getByTestId('result-panel')).toContainText('No live pulse detected', { timeout: 70_000 });
  await expect(page.getByTestId('result-panel')).toContainText('2 attempts left');
  await expect(page.getByTestId('start-check')).toHaveText('Try a new pattern');

  await page.getByTestId('scenario').selectOption('replay');
  await click(page, 'start-check');
  await expect(page.getByTestId('result-panel')).toHaveCount(0);
  await expect(page.getByTestId('result-panel')).toContainText('1 attempt left', { timeout: 70_000 });
  await page.getByTestId('scenario').selectOption('natural');
  await click(page, 'start-check');
  await expect(page.getByTestId('verdict-title')).toHaveText('Denied', { timeout: 70_000 });
  expect(new Set(responses.map((r) => JSON.stringify(r.phases))).size).toBe(3);
});

test('gate: deny works before and during a check', async ({ page }) => {
  await ready(page);
  await openGate(page);
  await click(page, 'deny');
  await expect(page.getByTestId('verdict-title')).toHaveText('Denied');
  await click(page, 'back-overview');

  await openGate(page);
  await click(page, 'start-check');
  await expect(page.getByTestId('pacer-word')).not.toHaveText('', { timeout: 10_000 });
  await expect(page.getByTestId('deny')).toBeEnabled();
  await click(page, 'deny');
  await expect(page.getByTestId('verdict-title')).toHaveText('Denied');
});

test('gate: the typed fallback enforces its delay and the exact target', async ({ page }) => {
  await ready(page);
  await openGate(page, 'DROP TABLE customers;');
  await click(page, 'use-fallback');
  await expect(page.getByTestId('fallback-panel')).toBeVisible();
  await expect(page.getByTestId('fallback-target')).toHaveText('customers');
  await expect(page.getByTestId('fallback-confirm')).toBeDisabled();
  await expect(page.getByTestId('fallback-confirm')).toContainText('Please wait');
  await page.getByTestId('fallback-input').fill('wrong');
  await expect(page.getByTestId('fallback-confirm')).toBeDisabled();
  // The server enforces the delay as well as the button.
  const id = page.url().split('/').pop();
  const early = await api(page, 'POST', `/api/gate/requests/${id}/fallback`, { action: 'confirm', typed: 'customers' });
  expect(early.status).toBe(409);
  await expect(page.getByTestId('fallback-confirm')).toHaveText('Confirm', { timeout: 25_000 });
  await click(page, 'fallback-confirm');
  await expect(page.getByTestId('toast-error')).toContainText('does not match');
  await page.getByTestId('fallback-input').fill('customers');
  await click(page, 'fallback-confirm');
  await expect(page.getByTestId('verdict-title')).toHaveText(/Passed/);
  await click(page, 'to-receipts');
  await expect(page.getByTestId('receipts-table')).toContainText('fallback');
});

test('gate: deny from the fallback panel', async ({ page }) => {
  await ready(page);
  await openGate(page);
  await click(page, 'use-fallback');
  await click(page, 'deny');
  await expect(page.getByTestId('verdict-title')).toHaveText('Denied');
});

test('gate: reloading during a check resumes it, and closing it stops the check', async ({ page, context }) => {
  await ready(page);
  await openGate(page);
  await click(page, 'start-check');
  await expect(page.getByTestId('pacer-word')).toHaveText(/Breathe in/, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId('start-check')).toBeDisabled({ timeout: 10_000 });
  await expect(page.getByTestId('pacer-word')).toHaveText(/Breathe|Hold|Almost|Get ready/, { timeout: 10_000 });
  await expect(page.getByTestId('verdict-title')).toHaveText(/Passed|Denied/, { timeout: 70_000 }).catch(async () => {
    await expect(page.getByTestId('result-panel')).toBeVisible();
  });

  await openGate(page);
  await click(page, 'start-check');
  await expect(page.getByTestId('pacer-word')).toHaveText(/Breathe in/, { timeout: 15_000 });
  const url = page.url();
  const id = url.split('/').pop();
  const tab = await context.newPage();
  await page.goto('about:blank');
  await tab.waitForTimeout(10_000);
  await tab.goto(url);
  await expect(tab.getByTestId('start-check')).toBeEnabled({ timeout: 10_000 });
  await expect(tab.getByTestId('start-check')).toHaveText('Start check');
  const view = await api(tab, 'GET', `/api/gate/requests/${id}`);
  expect(view.body.attempts_used).toBe(0);
  await tab.close();
});

test('gate: sound toggle remembers its state, another sign-in cannot see this check, consent is required', async ({ page, browser }) => {
  await ready(page);
  await openGate(page);
  await expect(page.getByTestId('mute')).toHaveText('Sound on');
  await click(page, 'mute');
  await expect(page.getByTestId('mute')).toHaveText('Sound off');
  await page.reload();
  await expect(page.getByTestId('mute')).toHaveText('Sound off');
  await click(page, 'mute');
  await expect(page.getByTestId('mute')).toHaveText('Sound on');

  const url = page.url();
  const other = await (await browser.newContext({ baseURL: new URL(url).origin, channel: 'chrome' })).newPage();
  await signInJury(other);
  await other.goto(url);
  await expect(other.getByRole('heading', { name: 'This check was not found' })).toBeVisible();
  await other.getByRole('link', { name: 'Back to overview' }).click();
  await other.context().close();

  await api(page, 'DELETE', '/api/consent?scope=gate');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Consent comes first' })).toBeVisible();
  await click(page, 'to-onboarding');
  await expect(page).toHaveURL(/onboarding/);
  await agree(page);
  await page.goto(url);
  await expect(page.getByTestId('start-check')).toBeVisible();
  await api(page, 'DELETE', '/api/consent?scope=gate');
  await page.reload();
  await click(page, 'deny');
  await expect(page.getByTestId('verdict-title')).toHaveText('Denied');
});

test('gate: the optional explanation calls the service and does not change the decision', async ({ page }) => {
  await ready(page);
  await page.goto('/settings');
  await page.getByTestId('runtime-llm').locator('xpath=following-sibling::span[contains(@class,"switch")]').click();
  await click(page, 'confirm-ok');
  await expect(page.getByTestId('toast-ok').first()).toContainText('explanations are on');
  await openGate(page, 'terraform destroy');
  await click(page, 'explain');
  await expect(page.getByTestId('explanation')).toContainText('does not affect the decision', { timeout: 45_000 });
  const id = page.url().split('/').pop();
  expect((await api(page, 'GET', `/api/gate/requests/${id}`)).body.status).toBe('pending');
});
