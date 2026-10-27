import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInventory } from '../src/inventory.js';

test('adds, removes and totals items', () => {
  const inv = createInventory();
  inv.add('apple', 3, 0.5);
  inv.add('pear', 2, 1.25);
  inv.remove('apple', 1);
  assert.equal(inv.total(), 3.5);
  assert.deepEqual(
    inv.list().map((i) => i.name),
    ['apple', 'pear'],
  );
});

test('rejects removing more than is stocked', () => {
  const inv = createInventory();
  inv.add('apple', 1, 0.5);
  assert.throws(() => inv.remove('apple', 2), /not enough apple/);
});
