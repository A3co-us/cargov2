// Projects REST route behavior: duplication, the read-visibility matrix and
// PUT validation. Same isolation pattern as security.test.js: env is set
// before any dynamic import so tests never touch a real database.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'test-admin-password';
process.env.JWT_SECRET = 'isolated-projects-test-signing-key';
const { default: db } = await import('../server/db.js');
const { signToken } = await import('../server/auth.js');
const { default: users } = await import('../server/routes/users.routes.js');
const { default: projects } = await import('../server/routes/projects.routes.js');
const app = express();
app.use(express.json());
app.use('/users', users);
app.use('/projects', projects);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});
const admin = db.prepare('SELECT * FROM users LIMIT 1').get();
const adminToken = signToken(admin);
function user(name, role = 'viewer') {
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(name, admin.password_hash, role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
}
const viewer = user('plain-viewer');
const editor = user('plain-editor', 'editor');
async function request(method, path, body, token = adminToken) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('duplicate copies content, defaults the name and is restricted with no viewers', async () => {
  const source = (await request('POST', '/projects', {
    name: 'Source', visibility: 'public', viewers: [viewer.id],
    data: { catalog: [], scenarios: [] },
  })).body.project;
  const dup = await request('POST', `/projects/${source.id}/duplicate`, undefined, signToken(editor));
  assert.equal(dup.status, 201);
  assert.equal(dup.body.project.name, 'Source (Copy)');
  assert.equal(dup.body.project.owner_id, editor.id);
  // Safe defaults even though the source was public and shared.
  assert.equal(dup.body.project.visibility, 'restricted');
  assert.deepEqual(dup.body.project.viewers, []);
  assert.equal(dup.body.project.data.catalog.length, 0);
  const named = await request('POST', `/projects/${source.id}/duplicate`, { name: 'My Copy' });
  assert.equal(named.body.project.name, 'My Copy');
  const tooLong = await request('POST', `/projects/${source.id}/duplicate`, { name: 'x'.repeat(201) });
  assert.equal(tooLong.status, 400);
});

test('duplicate refuses missing or unreadable sources and viewers cannot copy', async () => {
  assert.equal((await request('POST', '/projects/999999/duplicate')).status, 404);
  const secret = (await request('POST', '/projects', { name: 'Secret' })).body.project;
  assert.equal((await request('POST', `/projects/${secret.id}/duplicate`, undefined, signToken(viewer))).status, 403);
  assert.equal((await request('POST', `/projects/${secret.id}/duplicate`, undefined, signToken(editor))).status, 403);
  const shared = (await request('POST', '/projects', { name: 'Shared', viewers: [editor.id] })).body.project;
  // A shared editor can read (and therefore duplicate) a restricted project.
  assert.equal((await request('POST', `/projects/${shared.id}/duplicate`, undefined, signToken(editor))).status, 201);
});

test('read visibility matrix: owner, public, shared viewers and admins', async () => {
  const own = (await request('POST', '/projects', { name: 'Own' }, signToken(editor))).body.project;
  const publicP = (await request('POST', '/projects', { name: 'Public', visibility: 'public' })).body.project;
  const restricted = (await request('POST', '/projects', { name: 'Restricted' })).body.project;
  const shared = (await request('POST', '/projects', { name: 'Shared', viewers: [viewer.id] })).body.project;

  // GET /:id
  assert.equal((await request('GET', `/projects/${own.id}`, undefined, signToken(editor))).status, 200);
  assert.equal((await request('GET', `/projects/${publicP.id}`, undefined, signToken(viewer))).status, 200);
  assert.equal((await request('GET', `/projects/${shared.id}`, undefined, signToken(viewer))).status, 200);
  assert.equal((await request('GET', `/projects/${restricted.id}`, undefined, signToken(viewer))).status, 403);
  assert.equal((await request('GET', `/projects/${restricted.id}`, undefined, signToken(editor))).status, 403);
  assert.equal((await request('GET', `/projects/${restricted.id}`, undefined, adminToken)).status, 200);
  assert.equal((await request('GET', '/projects/999999', undefined, adminToken)).status, 404);

  // GET / list only contains projects the caller may read. Duplicates from the
  // earlier tests are restricted and owned by the editor, so only the editor
  // and admin see them; the public 'Source' is visible to everyone.
  const forViewer = (await request('GET', '/projects', undefined, signToken(viewer))).body.projects;
  assert.deepEqual(forViewer.map((p) => p.name).sort(), ['Public', 'Shared', 'Source']);
  const forEditor = (await request('GET', '/projects', undefined, signToken(editor))).body.projects;
  assert.deepEqual(forEditor.map((p) => p.name).sort(),
    ['Own', 'Public', 'Shared', 'Shared (Copy)', 'Source', 'Source (Copy)']);
  const forAdmin = (await request('GET', '/projects', undefined, adminToken)).body.projects;
  // The admin sees every project in the database.
  assert.equal(forAdmin.length, db.prepare('SELECT COUNT(*) AS n FROM projects').get().n);
  // canEdit flag reflects ownership for editors.
  assert.equal(forEditor.find((p) => p.id === own.id).canEdit, true);
  assert.equal(forEditor.find((p) => p.id === publicP.id).canEdit, false);
});

test('editors cannot modify projects they do not own, viewers cannot create', async () => {
  const foreign = (await request('POST', '/projects', { name: 'Foreign' })).body.project;
  const attempt = await request('PUT', `/projects/${foreign.id}`, { revision: foreign.revision, name: 'Hijack' }, signToken(editor));
  assert.equal(attempt.status, 403);
  assert.equal((await request('PUT', `/projects/${foreign.id}`, { revision: foreign.revision }, signToken(viewer))).status, 403);
  assert.equal((await request('DELETE', `/projects/${foreign.id}`, undefined, signToken(editor))).status, 403);
  assert.equal((await request('POST', '/projects', { name: 'Nope' }, signToken(viewer))).status, 403);
  // The admin may always delete, and deleting twice returns 404.
  assert.equal((await request('DELETE', `/projects/${foreign.id}`, undefined, adminToken)).status, 200);
  assert.equal((await request('DELETE', `/projects/${foreign.id}`, undefined, adminToken)).status, 404);
});

test('PUT validates name and visibility, and blank renames keep the current name', async () => {
  const p = (await request('POST', '/projects', { name: 'Original' })).body.project;
  assert.equal((await request('PUT', `/projects/${p.id}`, { revision: p.revision, name: 'x'.repeat(201) })).status, 400);
  assert.equal((await request('PUT', `/projects/${p.id}`, { revision: p.revision, visibility: 'secret' })).status, 400);
  assert.equal((await request('PUT', `/projects/${p.id}`, { revision: p.revision, data: { catalog: [{}] } })).status, 400);
  const blank = await request('PUT', `/projects/${p.id}`, { revision: p.revision, name: '   ' });
  assert.equal(blank.status, 200);
  assert.equal(blank.body.project.name, 'Original');
  assert.equal(blank.body.project.revision, p.revision + 1);
});

test('viewers arrays are strictly validated before any write happens', async () => {
  const p = (await request('POST', '/projects', { name: 'Strict' })).body.project;
  for (const bad of [['nope'], [0], [-1], [1.5], Array(1001).fill(viewer.id), 'viewer']) {
    const res = await request('PUT', `/projects/${p.id}`, { revision: p.revision, viewers: bad });
    assert.equal(res.status, 400, `expected 400 for viewers=${JSON.stringify(bad).slice(0, 30)}`);
  }
  assert.equal((await request('POST', '/projects', { name: 'Strict2', viewers: [viewer.id, viewer.id] })).status, 201);
  const saved = (await request('GET', '/projects', undefined, signToken(viewer))).body.projects.find((x) => x.name === 'Strict2');
  assert.deepEqual((await request('GET', `/projects/${saved.id}`, undefined, adminToken)).body.project.viewers.map((v) => v.id), [viewer.id]);
});
