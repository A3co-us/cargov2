import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('old databases migrate idempotently without losing users or projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-migration-'));
  const path = join(dir, 'old.sqlite');
  try {
    let db = new Database(path);
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT, created_at TEXT);
      CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER, visibility TEXT, data TEXT, created_at TEXT, updated_at TEXT);
      INSERT INTO users VALUES (1, 'existing', 'hash', 'admin', '2020-01-01');
      INSERT INTO projects VALUES (1, 'Preserve me', 1, 'restricted', '{}', '2020-01-01', '2020-01-01');`);
    db.close();
    for (let i = 0; i < 2; i++) {
      const script = `import db from ${JSON.stringify(new URL('../server/db.js', import.meta.url).href)}; db.close();`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, DB_PATH: path }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    db = new Database(path);
    try {
      assert.equal(db.prepare('SELECT token_version FROM users WHERE id = 1').get().token_version, 0);
      assert.deepEqual(db.prepare('SELECT name, revision FROM projects WHERE id = 1').get(), { name: 'Preserve me', revision: 1 });
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production boot fails fast without a JWT secret or an admin password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-failfast-'));
  const run = (module, dbFile, extraEnv) => {
    const script = `import ${JSON.stringify(module)};`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      // Note: JWT_SECRET/ADMIN_PASSWORD are explicitly blanked so a
      // developer's shell cannot mask the fail-fast behavior under test, and
      // each check gets its own fresh empty database.
      env: { ...process.env, NODE_ENV: 'production', DB_PATH: join(dir, dbFile), JWT_SECRET: '', ADMIN_PASSWORD: '', ...extraEnv },
      encoding: 'utf8', timeout: 10000,
    });
  };
  try {
    // No JWT_SECRET (auth.js refuses the default secret in production).
    const noSecret = run(new URL('../server/auth.js', import.meta.url).href, 'auth.sqlite', { ADMIN_PASSWORD: 'some-password' });
    assert.notEqual(noSecret.status, 0);
    assert.match(noSecret.stderr, /JWT_SECRET/);
    // Empty database and no ADMIN_PASSWORD (db.js refuses to seed a weak admin).
    const noPassword = run(new URL('../server/db.js', import.meta.url).href, 'db.sqlite', {});
    assert.notEqual(noPassword.status, 0);
    assert.match(noPassword.stderr, /ADMIN_PASSWORD/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ADMIN_USERNAME/ADMIN_PASSWORD seed a login-able admin exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a3-seed-'));
  const dbPath = join(dir, 'seed.sqlite');
  const run = () => {
    const script = `import db from ${JSON.stringify(new URL('../server/db.js', import.meta.url).href)}; db.close();`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        ...process.env, NODE_ENV: 'production', DB_PATH: dbPath, JWT_SECRET: 'seed-test-secret',
        ADMIN_USERNAME: 'bootstrap', ADMIN_PASSWORD: 'bootstrap-password',
      },
      encoding: 'utf8', timeout: 10000,
    });
  };
  try {
    assert.equal(run().status, 0);
    assert.equal(run().status, 0); // idempotent: a second boot never re-seeds
    const db = new Database(dbPath);
    try {
      const users = db.prepare('SELECT username, password_hash, role FROM users').all();
      assert.deepEqual(users.map((u) => [u.username, u.role]), [['bootstrap', 'admin']]);
      assert.equal(bcrypt.compareSync('bootstrap-password', users[0].password_hash), true);
      assert.equal(bcrypt.compareSync('wrong', users[0].password_hash), false);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
