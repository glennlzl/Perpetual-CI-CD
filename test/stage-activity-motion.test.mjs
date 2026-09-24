import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = (await readFile(new URL('../client/src/pipeline.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
const journeyCard = await readFile(new URL('../client/src/JourneyCard.jsx', import.meta.url), 'utf8');

// Declarations that apply to one selector, in source order, so a later rule wins.
function declarations(selector) {
  const result = {};
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').map(item => item.trim()).includes(selector)) continue;
    for (const declaration of body.split(';')) {
      const index = declaration.indexOf(':');
      if (index > 0) result[declaration.slice(0, index).trim()] = declaration.slice(index + 1).trim();
    }
  }
  return result;
}
const keyframes = name => new RegExp(`@keyframes ${name} \\{([^{}]*\\{[^{}]*\\})*\\s*\\}`).exec(css)?.[0] || '';

test('a running journey card draws its ring inside its own overflow clip', () => {
  assert.match(journeyCard, /className="journey-card[^"]*\boverflow-hidden\b/, 'The card clips overflow, so an outward ring would be invisible.');
  const ring = declarations('.journey-card[data-status="running"]::after');
  assert.equal(declarations('.journey-card[data-status="running"]').position, 'relative');
  assert.equal(ring.content, '""');
  assert.equal(ring.position, 'absolute');
  assert.equal(ring.inset, '0');
  assert.match(ring['box-shadow'], /^inset\b/);
  assert.equal(ring['pointer-events'], 'none');
  assert.match(ring.animation, /^pipeline-working\b/);
});

test('the pipeline stage keeps its outward ring because it does not clip', () => {
  assert.equal(declarations('.delivery-app .pipeline-stage').overflow, 'visible');
  const ring = declarations('.delivery-app .pipeline-stage[data-activity]::after');
  assert.equal(ring.inset, '-3px');
  assert.doesNotMatch(ring['box-shadow'], /\binset\b/);
});

test('activity rings animate opacity only', () => {
  const working = keyframes('pipeline-working');
  assert.match(working, /opacity/);
  assert.doesNotMatch(working.replace(/opacity\s*:[^;}]*;?/g, ''), /:/);
});
