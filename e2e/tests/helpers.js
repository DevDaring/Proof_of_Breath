import { test as base, expect } from '@playwright/test';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..', '..');
// Kept outside test-results, which Playwright empties at the start of each run.
export const COVERAGE = path.join(here, '..', '.coverage', 'clicked.txt');
mkdirSync(path.dirname(COVERAGE), { recursive: true });

export function readEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export const HOST_ENV = () => readEnv(process.env.POB_E2E_ENV || '/home/Debz/Host/pob/.env');
const require = createRequire(import.meta.url);
export const WebSocket = require('ws');

/** Every test fails on an uncaught error, a CSP violation, or a 5xx response. */
export const test = base.extend({
  page: async ({ page }, use) => {
    // Most specs walk the simulated flows, so a fresh browser starts on the simulated sensor. A spec that picks a
    // sensor keeps its choice, because the app saves it.
    await page.addInitScript(() => {
      try { if (!localStorage.getItem('pob.sensor')) localStorage.setItem('pob.sensor', 'sim'); } catch { /* storage blocked */ }
    });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      const text = m.text();
      if (/Failed to load resource: the server responded with a status of 4\d\d/.test(text)) return;
      if (m.type() === 'warning' && !/Content Security Policy|unique "key"|React/.test(text)) return;
      problems.push(`console ${m.type()}: ${text}`);
    });
    page.on('response', (r) => { if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`); });
    await use(page);
    expect(problems, 'no browser errors').toEqual([]);
  },
});
export { expect };

/** Click by test id and record it for the button coverage check. */
export async function click(page, testid, nth) {
  appendFileSync(COVERAGE, `${testid}\n`);
  const loc = page.getByTestId(testid);
  await (nth === undefined ? loc.first() : loc.nth(nth)).click();
}

/** Click a switch as a person would, then wait for the server-confirmed state. */
export async function flip(locator, expected) {
  await locator.locator('xpath=following-sibling::span[contains(@class,"switch")]').click();
  await expect(locator).toBeChecked({ checked: expected });
}

/** A simulated follower passes about 99% of the time, so allow the retries a person would have. */
export async function followUntilPassed(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.getByTestId('scenario').selectOption('follower');
    await click(page, 'start-check');
    const done = page.getByTestId('verdict-title').or(page.getByTestId('result-panel'));
    await expect(done).toBeVisible({ timeout: 70_000 });
    if (await page.getByTestId('verdict-title').count()) return;
    await expect(page.getByTestId('start-check')).toBeEnabled();
  }
}

export async function signInJury(page, target = '/') {
  await page.goto(target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`);
  await click(page, 'sign-in');
  await expect(page.getByTestId('sign-in')).toHaveCount(0);
}

export async function agree(page) {
  await page.getByTestId('consent-gate').check();
  await click(page, 'i-agree');
  await expect(page.getByTestId('calibrate-start')).toBeVisible();
}

/** Signed-in jury, past the consent screen, on the overview page. */
export async function ready(page) {
  await signInJury(page);
  await expect(page).toHaveURL(/onboarding/);
  await agree(page);
  await page.goto('/');
  await expect(page.getByTestId('command-input')).toBeVisible();
}

export async function openGate(page, command = 'terraform destroy -auto-approve') {
  await page.goto('/');
  await page.getByTestId('command-input').fill(command);
  await click(page, 'command-submit');
  await expect(page).toHaveURL(/\/gate\//);
  await expect(page.getByTestId('command')).toContainText(command);
}

export const api = (page, method, url, data) => page.evaluate(async ([m, u, d]) => {
  const r = await fetch(u, { method: m, headers: d ? { 'Content-Type': 'application/json' } : undefined, body: d ? JSON.stringify(d) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, data]);
