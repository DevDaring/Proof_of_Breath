import { test, expect, click, signInJury, flip, followUntilPassed } from './helpers.js';

test('onboarding: consent, calibration, practice round', async ({ page }) => {
  await signInJury(page);
  await expect(page).toHaveURL(/onboarding/);
  await expect(page.getByText('What the camera is used for')).toBeVisible();
  await expect(page.getByText('enableTelemetry: false').first()).toBeVisible();
  await expect(page.getByTestId('i-agree')).toBeDisabled();
  await page.getByTestId('consent-eval').check();
  await flip(page.getByTestId('consent-telemetry'), true);
  await flip(page.getByTestId('consent-telemetry'), false);
  await page.getByTestId('consent-gate').check();
  await click(page, 'i-agree');

  await click(page, 'calibrate-start');
  await expect(page.getByTestId('calibration-state')).toContainText('Calibrated');
  await click(page, 'calibrate-start');
  await expect(page.getByTestId('calibration-state')).toContainText('Calibrated');
  await click(page, 'calibrate-skip');

  await click(page, 'practice-start');
  await expect(page).toHaveURL(/\/gate\//);
  await expect(page.getByTestId('source-badge')).toHaveText('Practice round');
  await expect(page.getByTestId('simulated-badge')).toBeVisible();
  await followUntilPassed(page);
  await expect(page.getByTestId('verdict-title')).toHaveText(/Passed/);
  await click(page, 'back-overview');
  await expect(page.getByTestId('command-input')).toBeVisible();
});

test('onboarding finish and skip paths', async ({ page }) => {
  await signInJury(page);
  await page.getByTestId('consent-gate').check();
  await click(page, 'i-agree');
  await click(page, 'calibrate-skip');
  await click(page, 'onboarding-finish');
  await expect(page.getByTestId('command-input')).toBeVisible();
  await expect(page.getByTestId('sensor-status')).toContainText('Simulated');
});
