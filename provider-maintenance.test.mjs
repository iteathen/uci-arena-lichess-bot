import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LichessStore } from './lichess-store.mjs';

const identity = (pid, start = `504911232000000${pid}`) => ({ schema: 'uci_arena_process_instance_identity_v1',
  platform: 'win32', pid, start_token: start, executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
const authority = 'https://lichess.org|fixture';

test('additive service and operation 1.2 publish one closed maintenance response and packaged runtime', () => {
  const read = (file) => JSON.parse(readFileSync(path.join(import.meta.dirname, file), 'utf8'));
  const service = read('contracts/service-contract.json');
  const operations = read('contracts/manager-operations-schema.json');
  assert.equal(service.service.contract_version, '1.2');
  assert.equal(operations.version, '1.2');
  assert.deepEqual(operations.operations.maintenance_recover.arguments, ['maintenance', 'recover']);
  assert.equal(operations.operations.maintenance_recover.credential, 'external_file_path_only');
  assert.equal(operations.operations.maintenance_recover.response_schema, service.maintenance_recovery_schema);
  const schema = read(service.maintenance_recovery_schema);
  assert.equal(schema.$id, 'uci_arena_lichess_maintenance_recovery_v1');
  assert.ok(schema.oneOf.every((branch) => branch.additionalProperties === false));
  assert.ok(read('packaging/component-definition.json').include.some((row) => row.source === 'provider-maintenance.mjs'));
});

function fixture(t) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'bot-maintenance-')), 'matches.sqlite');
  const seed = new LichessStore(file);
  try {
    seed.addOwner('fixture'); seed.reserve('fixture', 2, 1);
    seed.acquireApiLease(authority, 'previous-owner', 101, Date.now(), 60000, null, identity(101));
    seed.claimProviderLifecycle('previous-owner'); seed.beginProviderWork('previous-owner');
    seed.beginGameActivation({ id: 'history01', opponent: 'fixture', audience: 'bot' });
  } finally { seed.close(); }
  const raw = new DatabaseSync(file);
  raw.exec('UPDATE reservations SET expires_at=0');
  t.after(() => raw.close());
  return { file, raw };
}

test('maintenance store admission does not prune reservations or change lifecycle work', (t) => {
  const { file, raw } = fixture(t);
  const before = raw.prepare('SELECT * FROM provider_lifecycle_control').all();
  const store = new LichessStore(file, { mode: 'maintenance' });
  try {
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
    assert.deepEqual(raw.prepare('SELECT * FROM provider_lifecycle_control').all(), before);
  } finally { store.close(); }
});

test('maintenance admission neither creates a missing database nor migrates an older schema', (t) => {
  const { file, raw } = fixture(t);
  const missing = path.join(path.dirname(file), 'missing.sqlite');
  assert.throws(() => new LichessStore(missing, { mode: 'maintenance' }));
  assert.equal(existsSync(missing), false);
  raw.exec('UPDATE schema_meta SET version=5');
  assert.throws(() => new LichessStore(file, { mode: 'maintenance' }));
  assert.equal(raw.prepare('SELECT version FROM schema_meta').get().version, 5);
  assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
});

test('an admitted schema-five lifecycle extension remains usable without migration or history change', (t) => {
  const { file, raw } = fixture(t);
  raw.exec('DROP INDEX games_live_cursor; DROP INDEX games_completion_cursor; DROP INDEX games_archive_cursor; DROP TABLE game_plies; DROP TABLE game_archive_control');
  for (const column of ['backfill_last_attempted_at', 'backfill_attempts',
    'engine_component_manifest_sha256', 'engine_component_version', 'engine_component_id',
    'provider_component_manifest_sha256', 'provider_component_version', 'provider_component_id',
    'archive_sha256', 'archive_reason', 'archive_completeness', 'variant', 'initial_fen',
    'completion_cursor', 'archive_cursor']) raw.exec(`ALTER TABLE games DROP COLUMN ${column}`);
  raw.exec('UPDATE schema_meta SET version=5');
  const before = raw.prepare('SELECT * FROM games').all();
  const store = new LichessStore(file, { mode: 'maintenance' });
  try {
    assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
    assert.equal(raw.prepare('SELECT version FROM schema_meta').get().version, 5);
    assert.deepEqual(raw.prepare('SELECT * FROM games').all(), before);
    assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
  } finally { store.close(); }
});

test('maintenance constructor closes storage when initial lease projection fails', (t) => {
  const { file } = fixture(t);
  let closes = 0;
  const original = LichessStore.prototype.listApiLeaseRows;
  LichessStore.prototype.listApiLeaseRows = () => { throw new Error('PRIVATE_PROJECTION_FAILURE'); };
  try {
    assert.throws(() => new LichessStore(file, { mode: 'maintenance', databaseFactory(filename, options) {
      const db = new DatabaseSync(filename, options);
      const close = db.close.bind(db);
      db.close = () => { closes += 1; close(); };
      return db;
    } }), /PRIVATE_PROJECTION_FAILURE/);
    assert.equal(closes, 1);
  } finally { LichessStore.prototype.listApiLeaseRows = original; }
});

async function deferredCase(t, overrides = {}, setup = () => {}) {
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const { file, raw } = fixture(t);
  setup(raw);
  const store = new LichessStore(file, { mode: 'maintenance' });
  t.after(() => store.close());
  const before = { control: raw.prepare('SELECT * FROM provider_lifecycle_control').all(),
    games: raw.prepare('SELECT * FROM games').all(), reservations: raw.prepare('SELECT * FROM reservations').all() };
  const calls = [];
  const base = { store, authority, expectedAccount: 'fixture', ownerId: 'maintenance-owner', pid: 102,
    processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'absent' }), client: { async json(endpoint) {
      calls.push(endpoint);
      return endpoint === 'api/account' ? { username: 'fixture', title: 'BOT' }
        : endpoint === 'api/challenge' ? { in: [], out: [] } : { nowPlaying: [], nbMyTurn: 0 };
    } } };
  const result = await recoverProviderMaintenance({ ...base, ...overrides });
  assert.notEqual(result.status, 'recovered');
  assert.deepEqual({ control: raw.prepare('SELECT * FROM provider_lifecycle_control').all(),
    games: raw.prepare('SELECT * FROM games').all(), reservations: raw.prepare('SELECT * FROM reservations').all() }, before);
  assert.ok(!JSON.stringify(result).includes('previous-owner'));
  return { result, calls };
}

for (const state of ['present', 'unverifiable']) {
  test(`a ${state} prior instance prevents recovery even after lease expiry`, async (t) => {
    const { result, calls } = await deferredCase(t, {
      ownerProcessProbe: () => ({ state, identity: identity(101) }),
    }, (raw) => raw.exec('UPDATE api_client_leases SET expires_at=0'));
    assert.equal(result.reason, 'prior_process_not_proven_absent');
    assert.deepEqual(calls, []);
  });
}

test('missing old lease without retained exact process identity defers', async (t) => {
  const { result } = await deferredCase(t, {}, (raw) => raw.exec('DELETE FROM api_client_leases'));
  assert.equal(result.reason, 'prior_ownership_unavailable');
});

test('missing old lease can recover from retained dead runtime identity', async (t) => {
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const { file, raw } = fixture(t);
  raw.exec('DELETE FROM api_client_leases');
  const store = new LichessStore(file, { mode: 'maintenance' });
  t.after(() => store.close());
  const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), priorProcessIdentity: identity(101),
    startupObservation: { installed: false }, ownerProcessProbe: () => ({ state: 'absent' }),
    client: { async json(endpoint) { return endpoint === 'api/account' ? { username: 'fixture', title: 'BOT' }
      : endpoint === 'api/challenge' ? { in: [], out: [] } : { nowPlaying: [], nbMyTurn: 0 }; } } });
  assert.equal(result.status, 'recovered');
  assert.equal(store.providerLifecycleSnapshot().activeWork, 0);
});

test('exact PID reuse permits recovery while a fresh unrelated API owner prevents reads', async (t) => {
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const { file } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' }); t.after(() => store.close());
  const base = { store, authority, expectedAccount: 'fixture', ownerId: 'maintenance-owner', pid: 102,
    processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'present', identity: identity(101, '504911233000000101') }),
    client: { async json(endpoint) { return endpoint === 'api/account' ? { username: 'fixture', title: 'BOT' }
      : endpoint === 'api/challenge' ? { in: [], out: [] } : { nowPlaying: [], nbMyTurn: 0 }; } } };
  const result = await recoverProviderMaintenance(base);
  assert.equal(result.status, 'recovered');
  const conflict = await deferredCase(t, { client: { async json() { assert.fail('Must not use API under another live authority'); } } },
    (raw) => raw.prepare(`INSERT INTO api_client_leases
      (authority_key,owner_id,pid,process_identity_json,heartbeat_at,expires_at) VALUES(?,?,?,?,?,?)`)
      .run('https://example.invalid|fixture', 'live-owner', 103, JSON.stringify(identity(103)), Date.now(), Date.now() + 60000));
  assert.notEqual(conflict.result.status, 'recovered');
});

for (const condition of ['pending_challenge', 'pending_game', 'malformed', 'scope', 'network']) {
  test(`${condition} preserves old work and history`, async (t) => {
    const { result } = await deferredCase(t, { client: { async json(endpoint) {
      if (endpoint === 'api/account') return { username: 'fixture', title: 'BOT' };
      if (condition === 'scope' || condition === 'network') throw Object.assign(new Error('PRIVATE_REMOTE_BODY'), { status: 403 });
      if (condition === 'malformed') return {};
      if (endpoint === 'api/challenge') return { in: [], out: condition === 'pending_challenge' ? [{}] : [] };
      return { nowPlaying: condition === 'pending_game' ? [{}] : [], nbMyTurn: 0 };
    } } });
    assert.ok(!JSON.stringify(result).includes('PRIVATE_REMOTE_BODY'));
  });
}

test('already cancelled maintenance makes no account requests', async (t) => {
  const controller = new AbortController(); controller.abort();
  const { result, calls } = await deferredCase(t, { signal: controller.signal });
  assert.equal(result.reason, 'cancelled_or_timeout'); assert.deepEqual(calls, []);
});

test('an aborted in-flight read releases the exact owned lease without clearing work', async (t) => {
  const controller = new AbortController();
  const { result } = await deferredCase(t, { signal: controller.signal, client: { async json(_endpoint, { signal }) {
    controller.abort();
    signal.throwIfAborted();
  } } });
  assert.equal(result.reason, 'cancelled_or_timeout');
});

test('lease loss after a remote read prevents any further authenticated read', async (t) => {
  const { file, raw } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' }); t.after(() => store.close());
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const calls = [];
  const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'absent' }), client: { async json(endpoint) {
      calls.push(endpoint); raw.exec('DELETE FROM api_client_leases');
      return { username: 'fixture', title: 'BOT' };
    } } });
  assert.deepEqual(calls, ['api/account']);
  assert.notEqual(result.status, 'recovered');
  assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
});

test('lease authority is rechecked at actual queued request dispatch', async (t) => {
  const { file, raw } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' }); t.after(() => store.close());
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  let issued = 0;
  const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'absent' }), client: { async json(_endpoint, options) {
      // Simulated queue delay: exclusive ownership was lost after enqueue.
      raw.exec('DELETE FROM api_client_leases');
      options.beforeDispatch?.();
      issued += 1;
      return { username: 'fixture', title: 'BOT' };
    } } });
  assert.equal(issued, 0);
  assert.notEqual(result.status, 'recovered');
  assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
});

for (const installed of [{ installed: true, enabled: true, active: false }, { installed: true, enabled: false, active: true }]) {
  test(`non-quiescent startup ${JSON.stringify(installed)} makes no API requests`, async (t) => {
    const { result, calls } = await deferredCase(t, { startupObservation: installed });
    assert.equal(result.reason, 'startup_not_quiescent'); assert.deepEqual(calls, []);
  });
}

test('denied exact process observation and ambiguous durable work make no API requests', async (t) => {
  const denied = await deferredCase(t, { ownerProcessProbe() { throw new Error('PRIVATE_DENIED'); } });
  assert.equal(denied.result.reason, 'prior_process_not_proven_absent'); assert.deepEqual(denied.calls, []);
  const pending = await deferredCase(t, {}, (raw) => raw.exec(`INSERT INTO challenge_attempts
    (challenge_id,opponent,audience,direction,status,created_at,updated_at) VALUES('pending00','fixture','bot','outbound','pending',1,1)`));
  assert.equal(pending.result.reason, 'durable_work_ambiguous'); assert.deepEqual(pending.calls, []);
});

test('an uncertain storage completion is failed rather than forged as recovered', async (t) => {
  const { file } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' }); t.after(() => store.close());
  store.completeMaintenanceRecovery = () => { throw new Error('PRIVATE_UNCERTAIN_COMMIT'); };
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'absent' }), client: { async json(endpoint) {
      return endpoint === 'api/account' ? { username: 'fixture', title: 'BOT' }
        : endpoint === 'api/challenge' ? { in: [], out: [] } : { nowPlaying: [], nbMyTurn: 0 };
    } } });
  assert.equal(result.status, 'failed'); assert.equal(result.completion, 'unconfirmed');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_UNCERTAIN_COMMIT'));
});

test('an uncertain lease claim retains failed disposition and releases only its exact possible ownership', async (t) => {
  const { file } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' }); t.after(() => store.close());
  const acquire = store.acquireApiLease.bind(store);
  store.acquireApiLease = (...args) => { acquire(...args); throw new Error('PRIVATE_POST_COMMIT_LEASE_FAILURE'); };
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'absent' }), client: { async json() { assert.fail('No remote request after uncertain claim'); } } });
  assert.equal(result.status, 'failed');
  assert.equal(store.apiLease(authority), null);
  assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_POST_COMMIT_LEASE_FAILURE'));
});

test('new ambiguous durable challenge after remote read prevents reclamation', async (t) => {
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const { file, raw } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' });
  t.after(() => store.close());
  const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'absent' }), client: { async json(endpoint) {
      if (endpoint === 'api/account') return { username: 'fixture', title: 'BOT' };
      if (endpoint === 'api/challenge') return { in: [], out: [] };
      store.recordChallenge({ id: 'pending01', opponent: 'fixture', audience: 'bot',
        direction: 'outbound', status: 'pending' });
      return { nowPlaying: [], nbMyTurn: 0 };
    } } });
  assert.notEqual(result.status, 'recovered');
  assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
});

for (const mutation of ['active_work=2', 'admission_blocked=1']) {
  test(`final ${mutation} race is preserved`, async (t) => {
    const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
    const { file, raw } = fixture(t);
    const store = new LichessStore(file, { mode: 'maintenance' });
    t.after(() => store.close());
    const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
      ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), startupObservation: { installed: false },
      ownerProcessProbe: () => ({ state: 'absent' }), client: { async json(endpoint) {
        if (endpoint === 'api/account') return { username: 'fixture', title: 'BOT' };
        if (endpoint === 'api/challenge') return { in: [], out: [] };
        raw.exec(`UPDATE provider_lifecycle_control SET ${mutation}`);
        return { nowPlaying: [], nbMyTurn: 0 };
      } } });
    assert.notEqual(result.status, 'recovered');
    assert.equal(store.providerLifecycleSnapshot().activeWork, mutation.startsWith('active_work') ? 2 : 1);
    assert.equal(store.providerLifecycleSnapshot().admissionBlocked, mutation.startsWith('admission') ? true : false);
  });
}

test('late live prior instance and lease cleanup failure never report recovered', async (t) => {
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const { file } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' });
  t.after(() => store.close());
  store.releaseApiLease = () => { throw new Error('PRIVATE_CLEANUP_MESSAGE'); };
  let probes = 0;
  const result = await recoverProviderMaintenance({ store, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102), startupObservation: { installed: false },
    ownerProcessProbe: () => ++probes < 3 ? { state: 'absent' } : { state: 'present', identity: identity(101) },
    client: { async json(endpoint) { return endpoint === 'api/account' ? { username: 'fixture', title: 'BOT' }
      : endpoint === 'api/challenge' ? { in: [], out: [] } : { nowPlaying: [], nbMyTurn: 0 }; } } });
  assert.equal(result.status, 'failed');
  assert.equal(result.cleanup, 'lease_release_failed');
  assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_CLEANUP_MESSAGE'));
});

test('explicit maintenance CLI bypasses unusable engine qualification and cannot launch a child or POST', (t) => {
  const { file, raw } = fixture(t);
  const root = path.dirname(file);
  const config = JSON.parse(readFileSync(path.join(import.meta.dirname, 'config.uci_arena.template.yml'), 'utf8'));
  config.url = 'http://127.0.0.1:1';
  raw.exec("UPDATE api_client_leases SET authority_key='http://127.0.0.1:1|fixture'");
  config.engine.executable = path.join(root, 'MUST_NOT_RUN.exe');
  config.engine.single_game_profile = path.join(root, 'MUST_NOT_READ.json');
  const configPath = path.join(root, 'fixture-config.json');
  const credentialPath = path.join(root, 'fixture-credential.txt');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(credentialPath, 'fixture-only-key');
  const before = raw.prepare('SELECT * FROM games').all();
  const child = spawnSync(process.execPath, ['--import', './test-fixtures/maintenance-platform.mjs',
    'lichess-adapter.mjs', 'maintenance', 'recover', '--config', configPath, '--runtime-dir', root,
    '--token-file', credentialPath, '--expected-account', 'fixture'],
  { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'recovered');
  assert.equal(result.schema, 'uci_arena_lichess_maintenance_recovery_v1');
  assert.equal(raw.prepare('SELECT active_work FROM provider_lifecycle_control').get().active_work, 0);
  assert.deepEqual(raw.prepare('SELECT * FROM games').all(), before);
  assert.ok(!child.stdout.includes('fixture-only-key'));
});

test('guarded maintenance CLI contains unknown input and reports storage close failure after confirmed completion', (t) => {
  const { file, raw } = fixture(t);
  const root = path.dirname(file);
  const config = JSON.parse(readFileSync(path.join(import.meta.dirname, 'config.uci_arena.template.yml'), 'utf8'));
  config.url = 'http://127.0.0.1:1';
  raw.exec("UPDATE api_client_leases SET authority_key='http://127.0.0.1:1|fixture'");
  const configPath = path.join(root, 'fixture-config.json');
  const credentialPath = path.join(root, 'fixture-credential.txt');
  writeFileSync(configPath, JSON.stringify(config)); writeFileSync(credentialPath, 'fixture-only-key');
  const args = ['--import', './test-fixtures/maintenance-platform.mjs', 'lichess-adapter.mjs', 'maintenance',
    'recover', '--config', configPath, '--runtime-dir', root, '--token-file', credentialPath, '--expected-account', 'fixture'];
  const invalid = spawnSync(process.execPath, [...args, '--PRIVATE_CANARY_OPTION', 'PRIVATE_CANARY_VALUE'],
    { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(invalid.status, 1); assert.equal(invalid.stderr, '');
  assert.equal(JSON.parse(invalid.stdout).completion, 'not_attempted');
  assert.ok(!invalid.stdout.includes('PRIVATE_CANARY'));
  assert.equal(raw.prepare('SELECT active_work FROM provider_lifecycle_control').get().active_work, 1);
  const closed = spawnSync(process.execPath, args, { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true,
    timeout: 20000, env: { ...process.env, BOT_MAINTENANCE_FIXTURE_CLOSE_FAILURE: '1' } });
  assert.equal(closed.status, 1); assert.equal(closed.stderr, '');
  const result = JSON.parse(closed.stdout);
  assert.equal(result.status, 'failed'); assert.equal(result.completion, 'confirmed');
  assert.equal(result.cleanup, 'storage_close_failed');
  assert.equal(raw.prepare('SELECT active_work FROM provider_lifecycle_control').get().active_work, 0);
});

test('guarded CLI retains both failed lease release and storage closure facts', (t) => {
  const { file, raw } = fixture(t);
  const root = path.dirname(file);
  const config = JSON.parse(readFileSync(path.join(import.meta.dirname, 'config.uci_arena.template.yml'), 'utf8'));
  config.url = 'http://127.0.0.1:1';
  raw.exec("UPDATE api_client_leases SET authority_key='http://127.0.0.1:1|fixture'");
  const configPath = path.join(root, 'fixture-config.json');
  const credentialPath = path.join(root, 'fixture-credential.txt');
  writeFileSync(configPath, JSON.stringify(config)); writeFileSync(credentialPath, 'fixture-only-key');
  const child = spawnSync(process.execPath, ['--import', './test-fixtures/maintenance-platform.mjs',
    'lichess-adapter.mjs', 'maintenance', 'recover', '--config', configPath, '--runtime-dir', root,
    '--token-file', credentialPath, '--expected-account', 'fixture'],
  { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env,
    BOT_MAINTENANCE_FIXTURE_CLOSE_FAILURE: '1', BOT_MAINTENANCE_FIXTURE_RELEASE_FAILURE: '1' } });
  assert.equal(child.status, 1); assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'remote_work_pending');
  assert.equal(result.cleanup, 'lease_and_storage_close_failed');
  assert.equal(raw.prepare('SELECT active_work FROM provider_lifecycle_control').get().active_work, 1);
});

test('maintenance recovery requires dead process, empty challenges then games and exact final ownership', async (t) => {
  const { recoverProviderMaintenance } = await import('./provider-maintenance.mjs');
  const { file, raw } = fixture(t);
  const store = new LichessStore(file, { mode: 'maintenance' });
  t.after(() => store.close());
  const calls = [];
  const client = { async json(endpoint) {
    calls.push(endpoint);
    if (endpoint === 'api/account') return { username: 'fixture', title: 'BOT' };
    if (endpoint === 'api/challenge') return { in: [], out: [] };
    if (endpoint === 'api/account/playing?nb=50') return { nowPlaying: [], nbMyTurn: 0 };
    throw new Error('Forbidden endpoint');
  } };
  const result = await recoverProviderMaintenance({ store, client, authority, expectedAccount: 'fixture',
    ownerId: 'maintenance-owner', pid: 102, processIdentity: identity(102),
    startupObservation: { installed: false },
    ownerProcessProbe: () => ({ state: 'absent' }) });
  assert.equal(result.status, 'recovered');
  assert.deepEqual(calls, ['api/account', 'api/challenge', 'api/account/playing?nb=50']);
  assert.equal(store.providerLifecycleSnapshot().activeWork, 0);
  assert.equal(store.providerLifecycleSnapshot().admissionBlocked, false);
  assert.equal(store.providerLifecycleSnapshot().owned, false);
  assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM reservations').get().count, 1);
});
