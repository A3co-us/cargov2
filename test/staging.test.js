import test from 'node:test';
import assert from 'node:assert/strict';
import * as cargo from '../public/js/cargo.js';
import { getContainer } from '../public/js/container.js';

const box = (id, x = 0, y = 0, dims = { l: 2, w: 2, h: 2 }, extra = {}) => ({
  id, catalogItemId: 'cat', name: id, x, y, z: 0, dims, weight: 10,
  category: 'general', hazmatClass: 'none', ...extra,
});

const spec = () => getContainer('20STD');

test('a staged item placed back into an empty container lands on the floor', () => {
  const spot = cargo.findFreePlacementAnyOrientation([], spec(), { l: 2, w: 2, h: 2 });
  assert.deepEqual({ x: spot.x, y: spot.y, z: spot.z }, { x: 0, y: 0, z: 0 });
  assert.equal(spot.layer, 0);
});

test('a staged item stacks on a sturdy base when the floor footprint is covered', () => {
  const s = spec();
  // One slab covering the entire floor: the only legal rest is on top of it.
  const slab = box('slab', 0, 0, { l: s.length, w: s.width, h: 2 });
  const spot = cargo.findFreePlacement([slab], s, { l: 1, w: 1, h: 1 });
  assert.ok(spot, 'expected a stacked spot');
  assert.equal(spot.y, 2); // on top of the 2-ft slab
  assert.equal(spot.layer, 1);
});

test('stacking on a fragile base is rejected (fragile cannot support cargo)', () => {
  // A 4x4 item whose footprint is entirely on a fragile 4x4 base: the only
  // possible rest is on the fragile base, which is illegal.
  const frag = box('frag', 0, 0, { l: 4, w: 4, h: 2 }, { category: 'fragile' });
  const top = box('top');
  assert.equal(cargo.restingY(0, 0, { l: 4, w: 4, h: 1 }, [frag], spec(), top), null);
  // The whole-layout validator flags the equivalent stacked layout too.
  const stacked = [frag, box('top', 0, 2, { l: 4, w: 4, h: 1 })];
  assert.match(cargo.layoutError(stacked, spec()), /unsupported/);
});

test('a staged item can stack across two adjacent bases of nearly equal height', () => {
  // Real layouts often have neighboring stacks a hair apart in height. The
  // item should rest on the HIGHER top, supported (within tolerance) by both.
  const a = box('a', 0, 0, { l: 2, w: 2, h: 2 });
  const b = box('b', 0, 0, { l: 2, w: 2, h: 2.02 }, { z: 2 });
  const y = cargo.restingY(0, 0, { l: 2, w: 4, h: 1 }, [a, b], spec(), box('top'));
  assert.equal(y, 2.02);
});

test('an unaligned legal floor slot is still found (grid-scan does not miss gaps)', () => {
  // Two full-height columns leave a 2.05 ft gap starting at x=2.05 — not on
  // the 0.5 ft scan grid, but a 2 ft item fits legally at x=2.05.
  const s = spec();
  const left = box('left', 0, 0, { l: 2.05, w: 8, h: s.height });
  const right = box('right', 4.05, 0, { l: 4, w: 8, h: s.height });
  const spot = cargo.findFreePlacement([left, right], s, { l: 2, w: 2, h: 1 });
  assert.ok(spot, 'a legal slot exists in the gap and must be found');
  assert.equal(spot.y, 0);
  // Whatever spot was chosen, it must actually be collision-free and in-bounds.
  const cand = { x: spot.x, y: 0, z: spot.z, dims: { l: 2, w: 2, h: 1 } };
  assert.equal(cargo.collidesAny(cand, [left, right]), false);
  assert.ok(spot.x >= 0 && spot.x + 2 <= s.length && spot.z >= 0 && spot.z + 2 <= s.width);
});

test('small overhang is rejected at 0% but allowed within the scenario allowance', () => {
  const base = box('base', 0, 0);
  const top = box('top');
  assert.equal(cargo.restingY(0.1, 0, { l: 2, w: 2, h: 2 }, [base], spec(), top, null, undefined, 0), null);
  assert.equal(cargo.restingY(0.1, 0, { l: 2, w: 2, h: 2 }, [base], spec(), top, null, undefined, 5), 2);
});

test('a hazmat-incompatible staged item cannot be placed into the container', () => {
  const flammable = box('flam', 0, 0, { l: 2, w: 2, h: 2 }, { hazmatClass: '3' });
  const spot = cargo.findFreePlacement([flammable], spec(), { l: 2, w: 2, h: 2 }, { item: { hazmatClass: '5.1' } });
  assert.equal(spot, null);
  // Compatible classes are unaffected.
  const ok = cargo.findFreePlacement([flammable], spec(), { l: 2, w: 2, h: 2 }, { item: { hazmatClass: 'none' } });
  assert.ok(ok);
});
