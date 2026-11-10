import { readFileSync } from 'node:fs';
import { test, expect, click, ready, api, flip } from './helpers.js';

test('receipts: empty state, chain badge, export, details, load more', async ({ page }) => {
  await ready(page);
  await page.goto('/receipts');
  await expect(page.getByText('No decisions yet')).toBeVisible();
  await expect(page.getByTestId('chain-badge')).toContainText('Chain verified · 0');

  for (let i = 0; i < 27; i += 1) {
    const out = await api(page, 'POST', '/api/gate/requests', { command: `DROP TABLE t${i}` });
    await api(page, 'POST', `/api/gate/requests/${out.body.request_id}/deny`);
  }
  await click(page, 'verify-chain');
  await expect(page.getByTestId('chain-badge')).toContainText('Chain verified · 27');
  await expect(page.getByTestId('receipts-table').locator('tbody tr')).toHaveCount(25);
  await click(page, 'receipt-details');
  await expect(page.getByTestId('receipt-detail')).toContainText('prev_hash');
  await click(page, 'receipt-details');
  await expect(page.getByTestId('receipt-detail')).toHaveCount(0);
  await click(page, 'load-more');
  await expect(page.getByTestId('receipts-table').locator('tbody tr')).toHaveCount(27);
  await expect(page.getByTestId('load-more')).toHaveCount(0);

  const [download] = await Promise.all([page.waitForEvent('download'), click(page, 'export-receipts')]);
  expect(download.suggestedFilename()).toBe('pob-receipts.json');
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(data.count).toBe(27);
  expect(data.receipts[0].prev_hash).toMatch(/^0{64}$/);
  expect(JSON.stringify(data)).not.toContain('DROP TABLE');
});

test('rules: list, add, live test, edit, toggle, delete', async ({ page }) => {
  await ready(page);
  await page.goto('/rules');
  await expect(page.getByTestId('rule-row')).toHaveCount(16);
  await expect(page.getByTestId('rule-row').first().getByTestId('rule-delete')).toHaveCount(0);

  await click(page, 'add-rule');
  await expect(page.getByTestId('rule-save')).toBeDisabled();
  await click(page, 'rule-cancel');
  await expect(page.getByTestId('rule-form')).toHaveCount(0);

  await click(page, 'add-rule');
  await page.getByTestId('rule-pattern').fill('(');
  await page.getByTestId('rule-sample').fill('make nuke');
  await expect(page.getByTestId('rule-test-result')).toContainText('Invalid pattern');
  await page.getByTestId('rule-reason').fill('Removes everything');
  await click(page, 'rule-save');
  await expect(page.getByTestId('toast-error')).toContainText('Invalid pattern');
  await page.getByTestId('rule-pattern').fill('\\bmake\\s+nuke\\b');
  await expect(page.getByTestId('rule-test-result')).toContainText('Gated');
  await page.getByTestId('rule-sample').fill('make build');
  await expect(page.getByTestId('rule-test-result')).toContainText('Not gated');
  await page.getByTestId('rule-scope').selectOption('git');
  await page.getByTestId('rule-severity').selectOption('critical');
  await click(page, 'rule-save');
  await expect(page.getByTestId('rule-row')).toHaveCount(17);
  const custom = page.getByTestId('rule-row').last();
  await expect(custom).toContainText('Removes everything');
  await expect(custom).toContainText('custom');

  expect((await api(page, 'POST', '/api/gate/requests', { command: 'make nuke' })).body.gated).toBe(true);
  await flip(custom.getByTestId('rule-toggle'), false);
  await expect.poll(async () => (await api(page, 'POST', '/api/gate/requests', { command: 'make nuke' })).body.gated).toBe(false);
  await flip(custom.getByTestId('rule-toggle'), true);
  await expect.poll(async () => (await api(page, 'POST', '/api/gate/requests', { command: 'make nuke' })).body.gated).toBe(true);

  await custom.getByTestId('rule-edit').click();
  await page.getByTestId('rule-reason').fill('Edited reason');
  await click(page, 'rule-save');
  await expect(custom).toContainText('Edited reason');

  await page.getByTestId('rule-row').first().getByTestId('rule-edit').click();
  await expect(page.getByRole('heading', { name: 'Edit rule' })).toBeVisible();
  await click(page, 'rule-cancel');
  await flip(page.getByTestId('rule-row').first().getByTestId('rule-toggle'), false);
  await page.reload();
  await expect(page.getByTestId('rule-row').first().getByTestId('rule-toggle')).not.toBeChecked();
  await flip(page.getByTestId('rule-row').first().getByTestId('rule-toggle'), true);

  await page.getByTestId('rule-row').last().getByTestId('rule-delete').click();
  await click(page, 'confirm-cancel');
  await expect(page.getByTestId('rule-row')).toHaveCount(17);
  await page.getByTestId('rule-row').last().getByTestId('rule-delete').click();
  await click(page, 'confirm-ok');
  await expect(page.getByTestId('rule-row')).toHaveCount(16);
});
