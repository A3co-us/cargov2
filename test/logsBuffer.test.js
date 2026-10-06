// Unit tests for the in-memory server error ring buffer behind GET /api/logs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordServerError, getServerErrors } from '../server/logsBuffer.js';

test('the ring buffer keeps the most recent 100 entries', () => {
  for (let i = 0; i < 105; i++) recordServerError({ method: 'GET', path: `/p${i}`, status: 500 });
  const entries = getServerErrors();
  assert.equal(entries.length, 100);
  assert.equal(entries[0].path, '/p5'); // oldest five evicted
  assert.equal(entries[entries.length - 1].path, '/p104');
});

test('entries get an ISO timestamp and returned copies do not alias the buffer', () => {
  // The ring is already full from the previous test, so the oldest entry is
  // evicted rather than the length growing.
  const before = getServerErrors();
  recordServerError({ method: 'POST', path: '/mutate', status: 400, message: 'boom' });
  const entries = getServerErrors();
  assert.equal(entries.length, before.length);
  const last = entries[entries.length - 1];
  assert.equal(last.path, '/mutate');
  assert.ok(!Number.isNaN(Date.parse(last.time)), 'time must be an ISO timestamp');
  assert.equal(last.status, 400);
  assert.equal(last.message, 'boom');
  // Mutating a returned entry must not affect what the buffer serves later.
  last.status = 999;
  assert.equal(getServerErrors()[getServerErrors().length - 1].status, 400);
});
