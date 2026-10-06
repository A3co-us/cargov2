// Reporting: the load plan's Loading Sequence must be depth-first from the
// doors — furthest-from-door items (and whatever stacks on them) load before
// anything closer to the doors, replacing the old layer-by-layer order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLoadPlan } from '../public/js/reporting.js';
import { getContainer } from '../public/js/container.js';

const spec = getContainer('20STD');

const item = (id, name, { x, y, z, l = 2, w = 2, h = 2 }) => ({
  id, name, catalogItemId: id, category: 'general', hazmatClass: 'none',
  weight: 10, dims: { l, w, h }, x, y, z,
});

test('load plan loads furthest from the doors first, stacking as it goes', () => {
  // Floor items at three depths: near doors (x=18), middle (x=10), nose (x=0).
  // A box stacked on the nose item must be step 2, before the middle item.
  const placements = [
    item('near', 'Near Doors', { x: 18, y: 0, z: 0 }),
    item('mid', 'Middle', { x: 10, y: 0, z: 0 }),
    item('nose', 'Nose Floor', { x: 0, y: 0, z: 0 }),
    item('top', 'Nose Top', { x: 0, y: 2, z: 0 }), // rests on nose
  ];
  const steps = generateLoadPlan({ containerType: '20STD', placements });
  assert.deepEqual(
    steps.map((s) => s.name),
    ['Nose Floor', 'Nose Top', 'Middle', 'Near Doors']
  );
  assert.equal(steps[1].stacked, true);
  assert.equal(steps[1].stackedOn, 'Nose Floor');
  assert.equal(steps[3].step, 4);
});

test('ties at the same depth and height break left-to-right', () => {
  const placements = [
    item('r', 'Right', { x: 0, y: 0, z: 4 }),
    item('l', 'Left', { x: 0, y: 0, z: 0 }),
  ];
  const steps = generateLoadPlan({ containerType: '20STD', placements });
  assert.deepEqual(steps.map((s) => s.name), ['Left', 'Right']);
});
