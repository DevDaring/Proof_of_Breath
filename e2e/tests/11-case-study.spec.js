// The case study: real SDK output from a recorded person, challenged by the real verifier on the live site.
import { test, expect, click, ready } from './helpers.js';

test('case study: real trace, fresh challenges are all scored and rejected, links work', async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId('home-case')).toBeVisible();
  await page.getByTestId('home-case-open').click();
  await expect(page).toHaveURL(/\/case-study$/);
  await expect(page.getByTestId('case-breath').locator('path.series')).toHaveCount(1);
  await expect(page.getByTestId('case-pulse-count')).toContainText(/\d{3}/);
  await expect(page.getByTestId('case-agg-passed')).toContainText('/ 200');
  await expect(page.getByTestId('case-source')).toContainText('no frame or image');

  // Hovering a chart shows the value under the pointer.
  const box = await page.getByTestId('case-breath').locator('svg').boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await expect(page.getByTestId('case-breath').locator('.tip')).toContainText('Chest trace');

  for (let i = 1; i <= 3; i += 1) {
    await click(page, 'case-challenge');
    await expect(page.getByTestId('case-tally')).toContainText(`drawn ${i} pattern`);
    await expect(page.getByTestId('case-verdict')).toHaveText(/Rejected|Passed by chance/);
    await expect(page.getByTestId('case-result').getByTestId('scores')).toBeVisible();
  }
  await expect(page.getByTestId('case-challenge')).toHaveText('Draw another pattern');

  await page.getByTestId('case-to-measure').click();
  await expect(page).toHaveURL(/\/measure$/);
  await page.goto('/case-study');
  await click(page, 'case-practice');
  await expect(page).toHaveURL(/\/gate\//);
  await expect(page.getByTestId('start-check')).toBeVisible();

  await page.goto('/evaluation');
  await expect(page.getByTestId('sim-benchmark')).toContainText('Simulated signals, not people');
  await page.getByTestId('eval-case').click();
  await expect(page).toHaveURL(/\/case-study$/);
});

test('case study needs a sign-in', async ({ request }) => {
  expect((await request.get('/api/case-study')).status()).toBe(401);
  expect((await request.post('/api/case-study/challenge')).status()).toBe(401);
});
