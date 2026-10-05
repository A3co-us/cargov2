import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCatalogItem, findFreePlacementAnyOrientation, hazmatIncompatible } from '../public/js/cargo.js';
import { parseCatalogCsv } from '../public/js/catalogCsv.js';
import { getContainer } from '../public/js/container.js';
import { pack } from '../public/js/autoload.js';

test('zero is preserved and negative dimensions are rejected', () => {
  assert.equal(makeCatalogItem({ weight: 0, qtyAvailable: 0 }).weight, 0);
  assert.throws(() => makeCatalogItem({ length: -4 }));
});
test('CSV rejects missing dimensions, preserves zero quantity and weight', () => {
  const bad = parseCatalogCsv('name,length,width,height,weight,qty\nCrate,48,,,0,0');
  assert.equal(bad.items.length, 0);
  assert.equal(bad.errors.length, 1);
  const good = parseCatalogCsv('name,length,width,height,weight,qty\nCrate,48,48,48,0,0');
  assert.equal(good.items[0].weight, 0);
  assert.equal(good.items[0].qtyAvailable, 0);
});
test('manual placement considers all six physical orientations', () => {
  const item = makeCatalogItem({ length: 8, width: 9, height: 2, weight: 100 });
  const spot = findFreePlacementAnyOrientation([], getContainer('40HC'), { l: 8, w: 9, h: 2 }, { item });
  assert.ok(spot);
  assert.ok(spot.dims.w <= getContainer('40HC').width);
});
test('incompatible cargo cannot share a container across different layers', () => {
  const items = [
    { name: 'Base', weight: 1000 },
    { name: 'Flammable', weight: 900, hazmatClass: '3' },
    { name: 'Oxidizer', weight: 800, hazmatClass: '5.1' },
  ].map((item) => makeCatalogItem({ length: 2, width: 2, height: 2, ...item }));
  const result = pack(items, '20STD', { strategy: 'fewest', simulations: 1 });
  assert.equal(result.placements.some((p, i) => result.placements.slice(i + 1)
    .some((q) => hazmatIncompatible(p.hazmatClass, q.hazmatClass))), false);
});
test('catalog edits propagate to placed and staged copies (stats follow the new weight)', async () => {
  const { syncPlacementsFromCatalog } = await import('../public/js/store.js');
  const { scenarioStats } = await import('../public/js/stats.js');
  const item = makeCatalogItem({ name: 'Crate', length: 2, width: 2, height: 2, weight: 100 });
  const placement = (id) => ({
    id, catalogItemId: item.id, name: item.name, category: item.category,
    hazmatClass: item.hazmatClass, weight: item.weight, color: '#fff',
    x: 0, y: 0, z: 0, dims: { l: 2, w: 2, h: 2 }, rot: { rot: 0, tipped: false }, layer: 0,
  });
  const project = {
    catalog: [item], staging: [placement('staged')],
    scenarios: [{ id: 's1', name: 'C', containerType: '20STD', placements: [placement('p1'), placement('p2')] }],
  };
  assert.equal(scenarioStats(project.scenarios[0]).totalWeight, 200);

  // User edits the catalog item's weight (and name) in the Item Catalog.
  Object.assign(item, makeCatalogItem({ ...item, name: 'Crate XL', weight: 250 }));
  const updated = syncPlacementsFromCatalog(project, item);
  assert.equal(updated, 3); // two placements + one staged entry
  assert.equal(scenarioStats(project.scenarios[0]).totalWeight, 500);
  assert.equal(project.scenarios[0].placements[0].name, 'Crate XL');
  assert.equal(project.staging[0].weight, 250);
  // Placements of other catalog items are untouched.
  const other = { ...project, staging: [], scenarios: [{ id: 's2', containerType: '20STD', placements: [{ ...placement('p3'), catalogItemId: 'other' }] }] };
  assert.equal(syncPlacementsFromCatalog(other, item), 0);
});