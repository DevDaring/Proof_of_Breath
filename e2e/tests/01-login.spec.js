import { test, expect, click, api } from './helpers.js';

test('login page is prefilled with the jury credentials and every button works', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByTestId('username')).toHaveValue('DevTest');
  await expect(page.getByTestId('password')).toHaveValue('DevTest11$');
  await expect(page.getByTestId('jury-note')).toContainText('Jury access');

  await click(page, 'owner-signin');
  await expect(page.getByTestId('username')).toHaveValue('');
  await expect(page.getByTestId('password')).toHaveValue('');

  await page.getByTestId('username').fill('DevTest');
  await page.getByTestId('password').fill('wrong-password');
  await click(page, 'sign-in');
  await expect(page.getByTestId('login-error')).toContainText('not right');

  await click(page, 'fill-jury');
  await expect(page.getByTestId('password')).toHaveValue('DevTest11$');
  await expect(page.getByTestId('login-error')).toHaveCount(0);

  await click(page, 'sign-in');
  await expect(page).toHaveURL(/onboarding/);
  await expect(page.getByTestId('sim-banner')).toContainText('Nothing here can approve a real command');
});

test('sign out ends the session and protected pages redirect back with next', async ({ page }) => {
  await page.goto('/login');
  await click(page, 'sign-in');
  await expect(page).toHaveURL(/onboarding/);
  await click(page, 'sign-out');
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/receipts');
  await expect(page).toHaveURL(/\/login\?next=%2Freceipts/);
  await click(page, 'sign-in');
  await expect(page).toHaveURL(/onboarding/);
  expect((await api(page, 'GET', '/api/session')).body.role).toBe('jury');
});

test('a next parameter cannot send a person to another site', async ({ page }) => {
  await page.goto('/login?next=//evil.example/x');
  await click(page, 'sign-in');
  await page.waitForURL(/koushikdeb\.com|127\.0\.0\.1/);
  expect(new URL(page.url()).host).not.toContain('evil');
});

test('unknown pages show a way back', async ({ page }) => {
  await page.goto('/login');
  await click(page, 'sign-in');
  await expect(page).toHaveURL(/onboarding/);
  await page.goto('/does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to overview' }).click();
  await expect(page).toHaveURL(/onboarding/);
});
