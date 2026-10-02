// Diagnostics: explainPlacementError must expose the geometry behind a
// rejected placement — the data the "Logs" feature copies for diagnosis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainPlacementError, layoutError } from '../public/js/cargo.js';
import { getContainer } from '../public/js/container.js';

const spec = getContainer('20STD');

const big = {
  id: 'b1', name: 'Big Box', catalogItemId: 'big', category: 'general',
  hazmatClass: 'none', weight: 100, dims: { l: 4, w: 3, h: 3 }, x: 0, y: 0, z: 0,
};
// Small box resting fully on the big box; `shift` slides it sideways.
const small = (shift = 0, y = 3) => ({
  id: 's1', name: 'Small Box', catalogItemId: 'small', category: 'general',
  hazmatClass: 'none', weight: 10, dims: { l: 2, w: 2, h: 2 }, x: 1 + shift, y, z: 0.5,
});

test('a fully supported small-on-large placement explains nothing', () => {
  const s = small(0);
  assert.equal(explainPlacementError(s, [big, s], spec), null);
});

test('overhanging placement reports the overhang numbers and base verdicts', () => {
  const s = small(2.6); // footprint x 3.6–5.6; big covers 0–4 → 80% uncovered
  const exp = explainPlacementError(s, [big, s], spec, () => null, 5);
  assert.equal(exp.rule, 'unsupported');
  assert.equal(exp.message, '"Small Box" would be unsupported');
  assert.equal(exp.detail.overhangPct, 80);
  assert.equal(exp.detail.allowancePct, 5);
  assert.equal(exp.detail.bases.length, 1);
  assert.equal(exp.detail.bases[0].name, 'Big Box');
  assert.equal(exp.detail.bases[0].overlapPct, 20);
  assert.equal(exp.detail.bases[0].verdict, 'legal support');
  // Consistent with the gate the app actually uses.
  assert.ok(layoutError([big, s], spec, () => null, 5));
});

test('fragile base rejection names the stacking reason', () => {
  const frag = { ...big, name: 'Fragile Base', category: 'fragile' };
  const s = small(0);
  const exp = explainPlacementError(s, [frag, s], spec);
  assert.equal(exp.rule, 'unsupported');
  assert.match(exp.detail.bases[0].verdict, /fragile/);
  assert.deepEqual(exp.detail.legalSupports, []);
});

test('item floating above its base reports the bridging-tolerance gap', () => {
  const s = small(0, 4.5); // bottom 4.5 vs base top 3 → 1.5 ft gap
  const exp = explainPlacementError(s, [big, s], spec);
  assert.equal(exp.rule, 'unsupported');
  assert.equal(exp.detail.overhangPct, 100); // no legal supports at all
  assert.match(exp.detail.bases[0].verdict, /1\.5 ft below/);
  assert.equal(exp.detail.restYLegal, 3); // resting on the base is the fix
});

test('out-of-bounds and collision rejections carry their geometry', () => {
  const s = { ...small(0), x: spec.length - 1 };
  const bounds = explainPlacementError(s, [big, s], spec);
  assert.equal(bounds.rule, 'bounds');
  assert.ok(bounds.detail.note.includes('limit'));

  const c = { ...small(0), y: 2 }; // interpenetrates the big box
  const collide = explainPlacementError(c, [big, c], spec);
  assert.equal(collide.rule, 'collision');
  assert.equal(collide.detail.with.name, 'Big Box');
});
