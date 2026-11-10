import { test, expect, click, ready } from './helpers.js';

test('overview: every sample, routine and gated outcomes, links, and navigation', async ({ page }) => {
  await ready(page);
  const samples = await page.getByTestId('sample').allTextContents();
  expect(samples.length).toBe(7);
  for (let i = 0; i < samples.length; i += 1) {
    await click(page, 'sample', i);
    await expect(page.getByTestId('command-input')).toHaveValue(samples[i]);
  }
  await page.getByTestId('command-input').fill('');
  await expect(page.getByTestId('command-submit')).toBeDisabled();

  await page.getByTestId('command-input').fill('git status');
  await click(page, 'command-submit');
  await expect(page.getByTestId('not-gated')).toContainText('Passed untouched');
  await page.getByTestId('command-input').fill('ls -la');
  await expect(page.getByTestId('not-gated')).toHaveCount(0);

  await page.getByTestId('command-input').fill('ls -la');
  await page.getByTestId('command-input').press('Enter');
  await expect(page.getByTestId('not-gated')).toBeVisible();

  for (const gated of ['DROP TABLE customers;', 'git push --force origin main', 'rm -rf /var/lib/app', 'kubectl delete namespace prod']) {
    await page.goto('/');
    await page.getByTestId('command-input').fill(gated);
    await click(page, 'command-submit');
    await expect(page).toHaveURL(/\/gate\//);
    await expect(page.getByTestId('command')).toContainText(gated);
  }

  await page.goto('/');
  await click(page, 'home-practice');
  await expect(page.getByTestId('source-badge')).toHaveText('Practice round');
  // The sensor picker: the jury sees its own camera and the simulated sensor, never the owner's desktop bridge.
  await expect(page.getByTestId('sensor-camera')).toBeVisible();
  await expect(page.getByTestId('sensor-bridge')).toHaveCount(0);
  await click(page, 'sensor-sim');
  await expect(page.getByTestId('sensor-sim')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('scenario')).toBeVisible();
  await page.goto('/');
  await click(page, 'hero-practice');
  await expect(page.getByTestId('source-badge')).toHaveText('Practice round');
  await page.goto('/');
  await page.getByTestId('hero-measure').click();
  await expect(page).toHaveURL(/\/measure$/);
  await expect(page.getByRole('heading', { name: 'See what the SDK reads from you' })).toBeVisible();
  await expect(page.getByTestId('measure-start')).toBeVisible();

  for (const [name, url, heading] of [['Live reading', /measure/, 'See what the SDK reads from you'], ['Receipts', /receipts/, 'Receipts'], ['Rules', /rules/, 'Rules'], ['Evaluation', /evaluation/, 'Evaluation lab'], ['Settings', /settings/, 'Settings'], ['Overview', /\/$/, null]]) {
    await page.getByRole('navigation').getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(url);
    if (heading) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await page.getByRole('link', { name: 'See the rules' }).click();
  await expect(page).toHaveURL(/rules/);
  await page.goto('/');
  await page.locator('main').getByRole('link', { name: 'Receipts' }).click();
  await expect(page).toHaveURL(/receipts/);
  await page.goto('/');
  await page.locator('main').getByRole('link', { name: 'Evaluation' }).click();
  await expect(page).toHaveURL(/evaluation/);
  await page.locator('.brand').click();
  await expect(page.getByTestId('command-input')).toBeVisible();
});
