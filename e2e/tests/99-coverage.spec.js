import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test, expect, COVERAGE, ROOT } from './helpers.js';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.tsx')) yield full;
  }
}

/** Opening tags of every button, tracking braces so arrow functions do not end the tag early. */
function buttonTags(source) {
  const tags = [];
  for (const match of source.matchAll(/<(button|Button)\b/g)) {
    let depth = 0;
    for (let i = match.index; i < source.length; i += 1) {
      const c = source[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) {
        tags.push(source.slice(match.index, i + 1));
        break;
      }
    }
  }
  return tags;
}

// Only reachable when the page crashes, so a working app cannot click it.
const CRASH_SCREEN = 'Back to overview';
// Buttons whose id is built from data. Each one is listed here so it is still required to be clicked.
const DYNAMIC = { 'data-testid={`sensor-${o.id}`}': ['sensor-camera', 'sensor-bridge', 'sensor-sim'] };

test('every button in the source was clicked by a test', async () => {
  const ids = new Set();
  const withoutId = [];
  for (const file of walk(path.join(ROOT, 'frontend', 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const tag of buttonTags(source)) {
      const found = tag.match(/data-testid="([a-z0-9-]+)"/);
      const dynamic = Object.keys(DYNAMIC).find((k) => tag.includes(k));
      if (found) ids.add(found[1]);
      else if (dynamic) DYNAMIC[dynamic].forEach((id) => ids.add(id));
      else withoutId.push(`${path.basename(file)}: ${tag.slice(0, 90)}`);
    }
  }
  const specs = readdirSync(path.join(ROOT, 'e2e', 'tests')).filter((f) => f.endsWith('.spec.js')).map((f) => readFileSync(path.join(ROOT, 'e2e', 'tests', f), 'utf8')).join('\n');
  const clicked = new Set(existsSync(COVERAGE) ? readFileSync(COVERAGE, 'utf8').split('\n').filter(Boolean) : []);
  // Buttons inside a table row or list row are clicked through a row locator in the specs.
  const missing = [...ids].filter((id) => !clicked.has(id) && !specs.includes(`getByTestId('${id}').click()`));
  console.log(`Buttons with ids: ${ids.size}. Clicked: ${ids.size - missing.length}.`);
  console.log('Buttons without an id:\n' + withoutId.join('\n'));
  expect(missing, 'buttons never clicked').toEqual([]);
  expect(ids.size).toBeGreaterThan(30);
  // ui.tsx defines the Button component itself: each use of it is checked above.
  const unexplained = withoutId.filter((t) => !t.includes('location.assign') && !t.startsWith('ui.tsx: <button'));
  expect(unexplained, `every other button needs an id so it can be checked (${CRASH_SCREEN} is exempt)`).toEqual([]);
});
