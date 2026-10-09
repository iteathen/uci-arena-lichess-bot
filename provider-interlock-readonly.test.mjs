import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { LichessStore } from './lichess-store.mjs';

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('read-only interlock reads current WAL without changing schema, gate, work or expired reservation', async (t) => {
  const { readProviderInterlockSnapshot } = await import('./lichess-storage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-interlock-readonly-'));
  const file = path.join(root, 'matches.sqlite');
  const seed = new LichessStore(file);
  try { seed.addOwner('fixture'); seed.reserve('fixture', 2, 1); } finally { seed.close(); }
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec("UPDATE reservations SET expires_at=0; UPDATE provider_lifecycle_control SET admission_blocked=1,owner_id='fixture-owner',active_work=2,updated_at=77");
  const facts = () => ({
    schema: writer.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
    gate: writer.prepare('SELECT * FROM provider_lifecycle_control').all(),
    reservations: writer.prepare('SELECT * FROM reservations').all(),
    mainSha: digest(file), walSha: digest(`${file}-wal`), files: readdirSync(root).sort(),
  });
  const before = facts();
  let selectedOptions;
  const result = readProviderInterlockSnapshot(file, { databaseFactory: (filename, options) => {
    selectedOptions = options;
    const reader = new DatabaseSync(filename, options);
    assert.throws(() => reader.exec('UPDATE provider_lifecycle_control SET active_work=0'), /readonly|read-only/iu);
    return reader;
  } });
  assert.deepEqual(result, { state: 'ready', admissionBlocked: true, owned: true, activeWork: 2 });
  assert.equal(selectedOptions.readOnly, true);
  assert.deepEqual(facts(), before);
});

test('missing database creates nothing; stopped WAL database stays logically unchanged', async () => {
  const { readProviderInterlockSnapshot } = await import('./lichess-storage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-interlock-missing-'));
  const file = path.join(root, 'matches.sqlite');
  assert.deepEqual(readProviderInterlockSnapshot(file), { state: 'unavailable', reason: 'storage_absent' });
  assert.deepEqual(readdirSync(root), []);
  const seed = new LichessStore(file);
  seed.close();
  const before = digest(file);
  assert.deepEqual(readProviderInterlockSnapshot(file), { state: 'ready', admissionBlocked: false, owned: false, activeWork: 0 });
  assert.equal(digest(file), before);
  assert.ok(readdirSync(root).every((name) => ['matches.sqlite', 'matches.sqlite-wal', 'matches.sqlite-shm'].includes(name)));
});

test('read-only interlock rejects malformed schema without repair', async (t) => {
  const { readProviderInterlockSnapshot } = await import('./lichess-storage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-interlock-malformed-'));
  const file = path.join(root, 'matches.sqlite');
  const seed = new LichessStore(file);
  seed.close();
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec('CREATE TABLE foreign_authority(value INTEGER)');
  const before = digest(`${file}-wal`);
  assert.throws(() => readProviderInterlockSnapshot(file), { code: 'LICHESS_STORAGE_SCHEMA_MALFORMED' });
  assert.equal(digest(`${file}-wal`), before);
});

test('public startup status exposes only bounded interlock fields and never creates missing database', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-interlock-status-'));
  const before = readdirSync(root);
  const child = spawnSync(process.execPath, ['--import', './test-fixtures/absent-startup-platform.mjs',
    'lichess-adapter.mjs', 'startup', 'status', '--runtime-dir', root],
  { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout).startup.replacementInterlock,
    { state: 'unavailable', reason: 'storage_absent' });
  assert.deepEqual(readdirSync(root), before);
});

test('unsafe interlock integer and failed closure remain failures without provider repair', async (t) => {
  const { readProviderInterlockSnapshot } = await import('./lichess-storage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-interlock-unsafe-'));
  const file = path.join(root, 'matches.sqlite');
  const seed = new LichessStore(file);
  seed.close();
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec('UPDATE provider_lifecycle_control SET active_work=9007199254740992');
  const before = digest(`${file}-wal`);
  assert.throws(() => readProviderInterlockSnapshot(file), { code: 'LICHESS_STORAGE_ROW_INVALID' });
  assert.equal(digest(`${file}-wal`), before);
  assert.throws(() => readProviderInterlockSnapshot(file, { databaseFactory: (filename, options) => {
    const reader = new DatabaseSync(filename, options);
    const close = reader.close.bind(reader);
    reader.close = () => { close(); throw new Error('fixture closure failure'); };
    return reader;
  } }), (error) => error.code === 'LICHESS_STORAGE_OPERATION_AND_RECOVERY_FAILED'
    && error.cause.code === 'LICHESS_STORAGE_ROW_INVALID');
});

test('historical schema-five interlock is observed without archive migration', async (t) => {
  const { readProviderInterlockSnapshot } = await import('./lichess-storage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-interlock-schema-five-'));
  const file = path.join(root, 'matches.sqlite');
  const seed = new LichessStore(file);
  seed.close();
  const writer = new DatabaseSync(file);
  t.after(() => writer.close());
  writer.exec('DROP INDEX games_live_cursor; DROP INDEX games_completion_cursor; DROP INDEX games_archive_cursor; DROP TABLE game_plies; DROP TABLE game_archive_control');
  for (const column of ['backfill_last_attempted_at', 'backfill_attempts',
    'engine_component_manifest_sha256', 'engine_component_version', 'engine_component_id',
    'provider_component_manifest_sha256', 'provider_component_version', 'provider_component_id',
    'archive_sha256', 'archive_reason', 'archive_completeness', 'variant', 'initial_fen',
    'completion_cursor', 'archive_cursor']) writer.exec(`ALTER TABLE games DROP COLUMN ${column}`);
  writer.exec('UPDATE schema_meta SET version=5');
  const before = digest(`${file}-wal`);
  assert.deepEqual(readProviderInterlockSnapshot(file),
    { state: 'ready', admissionBlocked: false, owned: false, activeWork: 0 });
  assert.equal(writer.prepare('SELECT version FROM schema_meta').get().version, 5);
  assert.equal(digest(`${file}-wal`), before);
});

test('unsafe database and coordination targets fail before SQLite opening', async () => {
  const { readProviderInterlockSnapshot } = await import('./lichess-storage.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-interlock-path-'));
  const file = path.join(root, 'matches.sqlite');
  mkdirSync(file);
  assert.throws(() => readProviderInterlockSnapshot(file), { code: 'LICHESS_STORAGE_PATH_TYPE_INVALID' });
  const other = path.join(root, 'valid.sqlite');
  const seed = new LichessStore(other);
  seed.close();
  mkdirSync(`${other}-wal`);
  let opens = 0;
  assert.throws(() => readProviderInterlockSnapshot(other, { databaseFactory: () => { opens++; } }),
    { code: 'LICHESS_STORAGE_PATH_TYPE_INVALID' });
  assert.equal(opens, 0);
});
