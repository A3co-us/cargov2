// Frontend API wrapper (public/js/api.js): token injection, JSON error
// propagation and body serialization, with a mocked fetch/localStorage.
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser shims: api.js reads the token from localStorage and the
// store; the logError path only records in memory (no DOM is touched).
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const { api, loadToken, saveToken } = await import('../public/js/api.js');
const { state } = await import('../public/js/store.js');

let calls = [];
let respondWith = () => ({ ok: true, status: 200, json: async () => ({ fine: true }) });
globalThis.fetch = (path, init) => {
  calls.push({ path, init });
  return respondWith();
};
const originalFetch = globalThis.fetch;

test.beforeEach(() => { calls = []; });
test.afterEach(() => { calls = []; state.token = null; storage.clear(); globalThis.fetch = originalFetch; respondWith = () => ({ ok: true, status: 200, json: async () => ({ fine: true }) }); });

test('requests carry the token from state or localStorage and serialize bodies', async () => {
  state.token = 'state-token';
  await api.get('/api/projects');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer state-token');
  assert.equal(calls[0].init.body, undefined);

  state.token = null;
  saveToken('stored-token');
  assert.equal(loadToken(), 'stored-token');
  await api.put('/api/projects/1', { revision: 1, data: { a: 1 } });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer stored-token');
  assert.equal(calls[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].init.body), { revision: 1, data: { a: 1 } });

  state.token = null;
  saveToken(null);
  await api.del('/api/projects/1');
  assert.equal(calls[2].init.headers.Authorization, undefined);
});

test('login posts credentials to /api/login and returns the session', async () => {
  respondWith = () => ({ ok: true, status: 200, json: async () => ({ token: 't', user: { id: 1 } }) });
  const session = await api.login('admin', 'pw');
  assert.deepEqual(session, { token: 't', user: { id: 1 } });
  assert.equal(calls[0].path, '/api/login');
  assert.deepEqual(JSON.parse(calls[0].init.body), { username: 'admin', password: 'pw' });
});

test('HTTP errors surface the server message and status code', async () => {
  respondWith = () => ({ ok: false, status: 409, json: async () => ({ error: 'Project changed elsewhere. Export your local changes before reloading.' }) });
  await assert.rejects(api.put('/api/projects/1', { revision: 0 }), (err) =>
    err.status === 409 && /Project changed elsewhere/.test(err.message));
});

test('non-JSON error bodies fall back to a status-only message', async () => {
  respondWith = () => ({ ok: false, status: 502, json: async () => { throw new Error('not JSON'); } });
  await assert.rejects(api.get('/api/projects'), (err) => err.status === 502 && /Request failed \(502\)/.test(err.message));
});

test('network failures are rethrown for callers to handle', async () => {
  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED simulated'));
  await assert.rejects(api.get('/api/projects'), /ECONNREFUSED/);
});
