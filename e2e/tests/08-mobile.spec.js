import { test, expect, click, ready, openGate, api } from './helpers.js';

test.use({ viewport: { width: 375, height: 800 } });

async function noSideScroll(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${page.url()} must not scroll sideways`).toBeLessThanOrEqual(0);
}

test('phone width: login, the menu, and every page fit with no sideways scroll', async ({ page }) => {
  await page.goto('/login');
  await noSideScroll(page);
  await ready(page);
  await noSideScroll(page);
  await click(page, 'menu');
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Rules', exact: true })).toBeVisible();
  await page.getByRole('navigation').getByRole('link', { name: 'Rules', exact: true }).click();
  await expect(page).toHaveURL(/rules/);
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Rules', exact: true })).toBeHidden();
  await noSideScroll(page);
  await api(page, 'POST', '/api/consent', { scope: 'evaluation' });
  await api(page, 'POST', '/api/eval/synthetic', { per_condition: 2 });
  for (const path of ['/receipts', '/evaluation', '/settings', '/onboarding']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await noSideScroll(page);
  }
  await openGate(page, 'kubectl delete namespace a-very-long-namespace-name-that-keeps-going-and-going-and-going-to-check-wrapping-works');
  await noSideScroll(page);
  await click(page, 'start-check');
  await expect(page.getByTestId('pacer-word')).toHaveText(/Breathe/, { timeout: 15_000 });
  await noSideScroll(page);
});
