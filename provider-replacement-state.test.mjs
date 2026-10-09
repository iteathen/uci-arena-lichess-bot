import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LichessStore } from './lichess-store.mjs';
import { main, prepareProviderReplacementInterlock } from './lichess-adapter.mjs';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
import { NativeResourceHelper } from '@uci-arena/background-service-runtime/native-resource-helper';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-replacement-state-'));
  const store = new LichessStore(path.join(root, 'matches.sqlite'));
  t.after(() => store.close());
  return { root, store };
}

test('durable before-state capture happens before the gate closes inside the same transaction', (t) => {
  const { store } = fixture(t);
  const events = [];
  const result = store.requestProviderReplacement(Date.now(), { allowUnowned: true, beforeEffect(control) {
    events.push('capture');
    assert.equal(control.admission_blocked, 0);
    assert.equal(store.providerLifecycleSnapshot().admissionBlocked, false);
    assert.equal(store.db.isTransaction, true);
  } });
  assert.deepEqual(events, ['capture']);
  assert.equal(result.safe, true);
  assert.equal(store.providerLifecycleSnapshot().admissionBlocked, true);
});

test('failed before-state persistence leaves gate unchanged and invokes no platform effect', async (t) => {
  const { root, store } = fixture(t);
  const before = store.providerLifecycleSnapshot();
  let effects = 0;
  await assert.rejects(prepareProviderReplacementInterlock({ runtimeDir: root, allowUnowned: true,
    capture() { throw new Error('BEFORE_STATE_WRITE_FAILED'); },
    async prepare() { effects += 1; return {}; },
  }), /BEFORE_STATE_WRITE_FAILED/);
  assert.equal(effects, 0);
  assert.deepEqual(store.providerLifecycleSnapshot(), before);
});

test('failed replacement plus failed storage closure preserves the primary cause and unknown cleanup disposition', async (t) => {
  const { root } = fixture(t); const original = LichessStore.prototype.close;
  const primary = Object.assign(new Error('PRIVATE_PRIMARY_CANARY'), { code: 'EACCES' });
  LichessStore.prototype.close = function () { original.call(this);
    throw Object.assign(new Error('PRIVATE_CLEANUP_CANARY'), { code: 'LICHESS_STORAGE_CLOSE_FAILED' }); };
  try {
    await assert.rejects(prepareProviderReplacementInterlock({ runtimeDir: root, allowUnowned: true,
      prepare() { throw primary; } }), (error) => error.code === 'LICHESS_STORAGE_OPERATION_AND_RECOVERY_FAILED'
        && error.cause === primary && !error.message.includes('CANARY'));
  } finally { LichessStore.prototype.close = original; }
});

test('active work prevents both before-state capture and platform effects', async (t) => {
  const { root, store } = fixture(t);
  store.acquireApiLease('https://example.invalid|fixture', 'fixture-owner', 101, Date.now(), 60000, null,
    { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
      start_token: '504911232000000101', executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
  store.claimProviderLifecycle('fixture-owner'); store.beginProviderWork('fixture-owner');
  let captures = 0; let effects = 0;
  await assert.rejects(prepareProviderReplacementInterlock({ runtimeDir: root,
    capture() { captures += 1; }, prepare() { effects += 1; },
  }), (error) => error.code === 'provider_owned_work_active');
  assert.equal(captures, 0); assert.equal(effects, 0);
  assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
  assert.equal(store.providerLifecycleSnapshot().admissionBlocked, false);
});

test('a second fresh API client blocks replacement even when the lifecycle owner is idle', async (t) => {
  const { root, store } = fixture(t); const makeIdentity = (pid) => ({ schema: 'uci_arena_process_instance_identity_v1',
    platform: 'win32', pid, start_token: `504911232000000${pid}`, executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
  store.acquireApiLease('https://example.invalid|owner', 'fixture-owner', 101, Date.now(), 60000, null, makeIdentity(101));
  store.claimProviderLifecycle('fixture-owner');
  store.acquireApiLease('https://example.invalid|probe', 'other-client', 202, Date.now(), 60000, null, makeIdentity(202));
  let effects = 0;
  await assert.rejects(prepareProviderReplacementInterlock({ runtimeDir: root,
    capture() { effects += 1; }, prepare() { effects += 1; } }), (error) => error.code === 'provider_lifecycle_interlock_unavailable');
  assert.equal(effects, 0); assert.equal(store.providerLifecycleSnapshot().admissionBlocked, false);
});

test('normal provider release preserves a closed replacement gate tuple', (t) => {
  const { store } = fixture(t);
  store.acquireApiLease('https://example.invalid|fixture', 'fixture-owner', 101, Date.now(), 60000, null,
    { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
      start_token: '504911232000000101', executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
  store.claimProviderLifecycle('fixture-owner');
  store.requestProviderReplacement(Date.now());
  const before = store.db.prepare('SELECT * FROM provider_lifecycle_control').all();
  store.releaseProviderLifecycle('fixture-owner');
  assert.deepEqual(store.db.prepare('SELECT * FROM provider_lifecycle_control').all(), before);
  store.releaseApiLease('https://example.invalid|fixture', 'fixture-owner');
  assert.equal(store.apiLease('https://example.invalid|fixture'), null);
});

test('legacy release recognition requires gone exact authority, no old lease and the unchanged released tuple', (t) => {
  const { store } = fixture(t);
  const api = 'https://example.invalid|fixture';
  store.acquireApiLease(api, 'fixture-owner', 101, Date.now(), 60000, null,
    { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
      start_token: '504911232000000101', executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
  store.claimProviderLifecycle('fixture-owner');
  let closed;
  store.requestProviderReplacement(Date.now(), { beforeEffect(_control, expected) { closed = expected; } });
  // Only the owned fixture simulates the historical producer's release law.
  store.db.prepare("UPDATE provider_lifecycle_control SET owner_id='',updated_at=updated_at+1 WHERE id=1").run();
  const released = { ...store.db.prepare('SELECT admission_blocked,owner_id,active_work,updated_at FROM provider_lifecycle_control').get() };
  let captures = 0;
  const request = () => store.confirmProviderReplacementRelease(closed, released, () => true, () => { captures += 1; });
  assert.throws(request, 'An old lease still present cannot count as completed release');
  store.releaseApiLease(api, 'fixture-owner');
  assert.throws(() => store.confirmProviderReplacementRelease(closed, released, () => false, () => { captures += 1; }));
  request(); assert.equal(captures, 1);
  assert.deepEqual(store.db.prepare('SELECT admission_blocked,owner_id,active_work,updated_at FROM provider_lifecycle_control').get(), released);
  store.db.prepare('UPDATE provider_lifecycle_control SET updated_at=updated_at+1 WHERE id=1').run();
  assert.throws(request, 'A later changed gate cannot reuse release proof');
  assert.equal(captures, 1);
});

test('recognized legacy release updates only the closed gate evidence and preserves the platform before-image', async (t) => {
  const { captureReplacementState, recordReplacementGateRelease, readReplacementState } = await import('./provider-replacement-state.mjs');
  const { root, store } = fixture(t); const api = 'https://example.invalid|fixture';
  store.acquireApiLease(api, 'fixture-owner', 101, Date.now(), 60000, null,
    { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
      start_token: '504911232000000101', executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
  store.claimProviderLifecycle('fixture-owner');
  let state;
  store.requestProviderReplacement(Date.now(), { beforeEffect(control, closedControl, leaseAuthority) {
    state = captureReplacementState({ runtimeDir: root, previousRoot: path.join(root, 'old'), replacementRoot: path.join(root, 'new'),
      observation, authority, control, closedControl, leaseAuthority });
  } });
  assert.equal(state.lease_authority.process.pid, 101);
  store.db.prepare("UPDATE provider_lifecycle_control SET owner_id='',updated_at=updated_at+1 WHERE id=1").run();
  store.releaseApiLease(api, 'fixture-owner');
  const released = { ...store.db.prepare('SELECT admission_blocked,owner_id,active_work,updated_at FROM provider_lifecycle_control').get() };
  const recorded = store.confirmProviderReplacementRelease(state.interlock_closed, released, () => true,
    (closedControl) => recordReplacementGateRelease(root, state, closedControl));
  assert.deepEqual(recorded.before, state.before); assert.deepEqual(recorded.interlock_before, state.interlock_before);
  assert.deepEqual(recorded.interlock_closed, released); assert.deepEqual(readReplacementState(root), recorded);
  store.completeProviderReplacement(recorded.interlock_before, recorded.interlock_closed);
  assert.equal(store.providerLifecycleSnapshot().admissionBlocked, false);
});

test('pre-replacement refuses missing storage without creating it or invoking capture/platform', async (t) => {
  const { root } = fixture(t); const missing = path.join(root, 'missing.sqlite');
  let effects = 0;
  await assert.rejects(prepareProviderReplacementInterlock({ runtimeDir: root, storeFile: missing, allowUnowned: true,
    capture() { effects += 1; }, prepare() { effects += 1; } }));
  assert.equal(effects, 0); assert.equal(existsSync(missing), false);
});

test('schema-five replacement admission preserves version, expired reservations and history before platform work', async (t) => {
  const { root, store } = fixture(t);
  store.addOwner('fixture'); store.reserve('fixture', 2, 1);
  store.beginGameActivation({ id: 'history01', opponent: 'fixture', audience: 'bot' });
  store.db.exec('UPDATE reservations SET expires_at=0');
  store.db.exec('DROP INDEX games_live_cursor; DROP INDEX games_completion_cursor; DROP INDEX games_archive_cursor; DROP TABLE game_plies; DROP TABLE game_archive_control');
  for (const column of ['backfill_last_attempted_at', 'backfill_attempts', 'engine_component_manifest_sha256',
    'engine_component_version', 'engine_component_id', 'provider_component_manifest_sha256', 'provider_component_version',
    'provider_component_id', 'archive_sha256', 'archive_reason', 'archive_completeness', 'variant', 'initial_fen',
    'completion_cursor', 'archive_cursor']) store.db.exec(`ALTER TABLE games DROP COLUMN ${column}`);
  store.db.exec('UPDATE schema_meta SET version=5');
  const games = store.db.prepare('SELECT * FROM games').all();
  const reservations = store.db.prepare('SELECT * FROM reservations').all();
  await prepareProviderReplacementInterlock({ runtimeDir: root, allowUnowned: true,
    capture() {
      assert.equal(store.db.prepare('SELECT version FROM schema_meta').get().version, 5);
      assert.deepEqual(store.db.prepare('SELECT * FROM reservations').all(), reservations);
      assert.deepEqual(store.db.prepare('SELECT * FROM games').all(), games);
    }, prepare() { assert.equal(store.db.prepare('SELECT version FROM schema_meta').get().version, 5); return {}; } });
  assert.deepEqual(store.db.prepare('SELECT * FROM reservations').all(), reservations);
  assert.deepEqual(store.db.prepare('SELECT * FROM games').all(), games);
});

test('replacement gate completion refuses foreign ownership/work and restores only its admitted baseline', (t) => {
  const { store } = fixture(t);
  const before = { ...store.db.prepare('SELECT admission_blocked,owner_id,active_work,updated_at FROM provider_lifecycle_control').get() };
  let closed;
  store.requestProviderReplacement(Date.now(), { allowUnowned: true, beforeEffect(_before, expected) { closed = expected; } });
  store.db.prepare("UPDATE provider_lifecycle_control SET owner_id='foreign' WHERE id=1").run();
  assert.throws(() => store.completeProviderReplacement(before, closed));
  assert.equal(store.providerLifecycleSnapshot().admissionBlocked, true);
  store.db.prepare("UPDATE provider_lifecycle_control SET owner_id='',active_work=1 WHERE id=1").run();
  assert.throws(() => store.completeProviderReplacement(before, closed));
  assert.equal(store.providerLifecycleSnapshot().activeWork, 1);
  store.db.prepare('UPDATE provider_lifecycle_control SET active_work=0 WHERE id=1').run();
  store.db.prepare('UPDATE provider_lifecycle_control SET updated_at=updated_at+1 WHERE id=1').run();
  assert.throws(() => store.completeProviderReplacement(before, closed), 'Same owner/count cannot clear a changed foreign gate');
  store.db.prepare('UPDATE provider_lifecycle_control SET updated_at=? WHERE id=1').run(closed.updated_at);
  store.completeProviderReplacement(before, closed);
  assert.equal(store.providerLifecycleSnapshot().admissionBlocked, false);
});

test('compensation observation is read-only and preserves every positive-work interlock field', async (t) => {
  const { readProviderReplacementMetadata } = await import('./lichess-storage.mjs');
  const { root, store } = fixture(t);
  store.acquireApiLease('https://example.invalid|fixture', 'fixture-owner', 101, Date.now(), 60000, null,
    { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
      start_token: '504911232000000101', executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
  store.claimProviderLifecycle('fixture-owner'); store.beginProviderWork('fixture-owner');
  const before = store.db.prepare('SELECT * FROM provider_lifecycle_control').all();
  const metadata = readProviderReplacementMetadata(path.join(root, 'matches.sqlite'), {
    databaseFactory(filename, options) { assert.equal(options.readOnly, true); return new DatabaseSync(filename, options); },
  });
  assert.equal(metadata.control.active_work, 1); assert.equal(metadata.control.owner_id, 'fixture-owner');
  assert.equal(metadata.otherClient, false); assert.equal(metadata.leases.length, 1);
  assert.deepEqual(store.db.prepare('SELECT * FROM provider_lifecycle_control').all(), before);
});

const observation = { platform: 'win32', registered: false, enabled: false, active: false,
  definition_text: null, definition_sha256: null, action: null, instances: [] };
const gate = { admission_blocked: 0, owner_id: '', active_work: 0, updated_at: 0 };
const authority = { command: path.resolve('fixture-node24.exe'), arguments: 'startup prepare_replace --fixture-authority',
  working_directory: path.resolve('fixture-controller') };
const actor = (pid) => ({ schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid,
  start_token: `504911232000000${pid}`, executable_path: 'C:\\fixture\\node.exe', boot_id: '' });

test('unfinished controller ownership rejects live/unknown overlap and permits only exact absence or reuse', async (t) => {
  const { captureReplacementState, readReplacementState } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t);
  const options = { runtimeDir: root, previousRoot: path.join(root, 'old'), replacementRoot: path.join(root, 'new'),
    observation, control: gate, authority, controller: actor(101) };
  const first = captureReplacementState(options);
  for (const result of [{ state: 'present', identity: actor(101) }, { state: 'unverifiable' }]) {
    assert.throws(() => captureReplacementState({ ...options, controller: actor(202), probe: () => result }));
    assert.deepEqual(readReplacementState(root), first);
  }
  const next = captureReplacementState({ ...options, controller: actor(202), probe: () => ({ state: 'absent' }) });
  assert.deepEqual(next.controller, actor(202)); assert.deepEqual(next.before, first.before);
  const reused = captureReplacementState({ ...options, controller: actor(303), probe: () =>
    ({ state: 'present', identity: { ...actor(202), start_token: '504911232000000999' } }) });
  assert.deepEqual(reused.controller, actor(303));
  assert.deepEqual(reused.interlock_before, first.interlock_before);
});

test('same-process exported startup calls reject overlap before any second platform or storage admission', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows in-process guarded platform fixture');
  const { root } = fixture(t);
  let release; let reached; const held = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { reached = resolve; });
  const original = WindowsTaskScheduler.prototype.perform; let calls = 0;
  WindowsTaskScheduler.prototype.perform = async (request) => {
    assert.equal(request.operation, 'inspect');
    if (++calls === 1) { reached(); await held; }
    return { outcome: 'completed', observation: { registered: false, enabled: null, action: null,
      definition_xml: null, definition_sha256: null, instance_guids: [], principal: null } };
  };
  const args = ['startup', 'prepare_replace', '--lifecycle-result', 'typed_v1', '--runtime-dir', root,
    '--previous-root', path.join(root, 'old'), '--replacement-root', path.join(root, 'new'),
    '--config', path.join(root, 'no-config.json')];
  let first;
  try {
    first = main(args); await began;
    await assert.rejects(main(args), (error) => error.code === 'LICHESS_STARTUP_REPLACEMENT_BUSY');
    assert.equal(calls, 1);
  } finally {
    release(); if (first) await first; WindowsTaskScheduler.prototype.perform = original;
  }
});

test('v2 capture preserves the original before-image on a repeated unfinished request', async (t) => {
  const { captureReplacementState, readReplacementState } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t);
  const previousRoot = path.join(root, 'old'); const replacementRoot = path.join(root, 'new');
  const first = captureReplacementState({ runtimeDir: root, previousRoot, replacementRoot, observation, control: gate, authority });
  assert.equal(first.schema_version, 2); assert.equal(first.phase, 'preparing');
  const again = captureReplacementState({ runtimeDir: root, previousRoot, replacementRoot,
    observation, control: { ...gate, admission_blocked: 1 }, authority });
  assert.deepEqual(again, first); assert.deepEqual(readReplacementState(root), first);
});

test('foreign unfinished intent and unknown blocked gate cannot be overwritten', async (t) => {
  const { captureReplacementState, readReplacementState } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t);
  const before = { runtimeDir: root, previousRoot: path.join(root, 'old'), replacementRoot: path.join(root, 'new'), observation, control: gate, authority };
  const first = captureReplacementState(before);
  assert.throws(() => captureReplacementState({ ...before, replacementRoot: path.join(root, 'foreign') }));
  assert.deepEqual(readReplacementState(root), first);
  const other = fixture(t);
  assert.throws(() => captureReplacementState({ ...before, runtimeDir: other.root, control: { ...gate, admission_blocked: 1 } }));
  assert.equal(readReplacementState(other.root), null);
});

test('target selection uses captured before/desired authority rather than root equality', async (t) => {
  const { captureReplacementState, selectReplacementTarget } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t);
  const previousRoot = path.join(root, 'old'); const replacementRoot = path.join(root, 'new');
  const state = captureReplacementState({ runtimeDir: root, previousRoot, replacementRoot, observation, control: gate, authority });
  assert.equal(selectReplacementTarget(state, previousRoot, replacementRoot), 'desired');
  assert.equal(selectReplacementTarget(state, previousRoot, previousRoot), 'before');
  assert.throws(() => selectReplacementTarget(state, path.join(root, 'foreign'), previousRoot));
  const sameRoot = fixture(t);
  const same = captureReplacementState({ runtimeDir: sameRoot.root, previousRoot, replacementRoot: previousRoot, observation, control: gate, authority });
  assert.throws(() => selectReplacementTarget(same, previousRoot, previousRoot), 'Equal roots alone cannot select a target');
});

test('private before definition bytes/hash are checked before any write', async (t) => {
  const { captureReplacementState, readReplacementState } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t);
  const text = '<Task>fixture-only</Task>';
  const registered = { ...observation, registered: true, enabled: true, definition_text: text,
    definition_sha256: createHash('sha256').update(text).digest('hex'),
    action: { command: path.join(root, 'old', 'native', 'lichess_adapter_launcher.exe'),
      arguments: 'fixture-only', working_directory: path.join(root, 'old') } };
  assert.throws(() => captureReplacementState({ runtimeDir: root, previousRoot: path.join(root, 'old'),
    replacementRoot: path.join(root, 'new'), observation: { ...registered, definition_sha256: '0'.repeat(64) }, control: gate, authority }));
  assert.equal(readReplacementState(root), null);
});

function registeredObservation(root, node, enabled = false) {
  const action = { command: path.join(root, 'native', 'lichess_adapter_launcher.exe'),
    arguments: `"${node}" "${path.join(root, 'lichess-adapter.mjs')}" run --fixture-runtime`, working_directory: root };
  const definition_text = `<Task><Enabled>${enabled}</Enabled><Action>${JSON.stringify(action)}</Action></Task>`;
  return { ...observation, registered: true, enabled, definition_text, action,
    definition_sha256: createHash('sha256').update(definition_text).digest('hex') };
}

test('disabled but running startup cannot be captured as an implicitly enabled replacement', async (t) => {
  const { captureReplacementState, readReplacementState } = await import('./provider-replacement-state.mjs');
  const { root, store } = fixture(t); const component = path.join(root, 'component');
  const beforeControl = store.providerLifecycleSnapshot();
  const before = { ...registeredObservation(component, process.execPath, false), active: true };
  await assert.rejects(prepareProviderReplacementInterlock({ runtimeDir: root, allowUnowned: true,
    capture(control, closedControl) { captureReplacementState({ runtimeDir: root, previousRoot: component,
      replacementRoot: component, observation: before, control, closedControl, authority }); },
    prepare() { assert.fail('Unsupported running intent must never reach platform effects'); },
  }), /disabled.*running/i);
  assert.equal(readReplacementState(root), null);
  assert.deepEqual(store.providerLifecycleSnapshot(), beforeControl);
});

test('live replacement controller is rejected before runtime evidence preflight', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows guarded source platform');
  const { captureReplacementState, publishReplacementPhase } = await import('./provider-replacement-state.mjs');
  const { root, store } = fixture(t); const component = path.join(root, 'component');
  const configPath = path.resolve('config.uci_arena.template.yml');
  const action = { command: path.join(component, 'native', 'lichess_adapter_launcher.exe'),
    arguments: [process.execPath, path.join(component, 'lichess-adapter.mjs'), 'run', '--config', configPath,
      '--token-file', path.join(root, 'blind-token-locator'), '--expected-account', 'fixture', '--runtime-dir', root]
      .map((value) => `"${value}"`).join(' '), working_directory: component };
  const xml = '<Task><Settings><Enabled>true</Enabled></Settings>opaque guarded SDK snapshot</Task>';
  const observed = { platform: 'win32', registered: true, enabled: true, active: false,
    definition_text: xml, definition_sha256: createHash('sha256').update(xml).digest('hex'), action, instances: [] };
  store.requestProviderReplacement(Date.now(), { allowUnowned: true, beforeEffect(control, closedControl) {
    const state = captureReplacementState({ runtimeDir: root, previousRoot: component, replacementRoot: component,
      observation: observed, control, closedControl, authority, controller: actor(101) });
    publishReplacementPhase(root, state, 'prepared');
  } });
  const before = store.providerLifecycleSnapshot();
  const originalScheduler = WindowsTaskScheduler.prototype.perform;
  const originalQuery = NativeResourceHelper.prototype.queryProcessInstanceSync;
  const { currentProcessIdentity } = await import('./process-instance-identity.mjs');
  const currentIdentity = currentProcessIdentity();
  WindowsTaskScheduler.prototype.perform = async (request) => {
    assert.equal(request.operation, 'inspect', 'No platform effects are allowed');
    return { outcome: 'completed', observation: { registered: true, enabled: true, definition_xml: xml,
      definition_sha256: observed.definition_sha256, instance_guids: [], action,
      principal: { current_user_sid: 'S-1-5-21-1', user_sid: 'S-1-5-21-1', logon_type: 3, run_level: 0 } } };
  };
  NativeResourceHelper.prototype.queryProcessInstanceSync = (pid) => ({
    schema: 'uci_arena_process_instance_query_v1', state: 'present', identity: pid === process.pid ? currentIdentity : actor(pid) });
  try {
    await assert.rejects(main(['startup', 'complete_replace', '--lifecycle-result', 'typed_v1', '--runtime-dir', root,
      '--previous-root', component, '--replacement-root', component, '--config', configPath]),
    (error) => error.code === 'LICHESS_STARTUP_REPLACEMENT_BUSY');
    assert.deepEqual(store.providerLifecycleSnapshot(), before);
  } finally {
    WindowsTaskScheduler.prototype.perform = originalScheduler;
    NativeResourceHelper.prototype.queryProcessInstanceSync = originalQuery;
  }
});

test('registered post target requires actual inventoried provider code before it can execute', async (t) => {
  const { admitReplacementTargetPayload } = await import('./lichess-adapter.mjs');
  const { root } = fixture(t); const target = path.join(root, 'future');
  assert.throws(() => admitReplacementTargetPayload(target, 'win32'));
  mkdirSync(path.join(target, 'native'), { recursive: true });
  const files = [['lichess-adapter.mjs', 'fixture non-executable source'],
    ['native/lichess_adapter_launcher.exe', 'fixture non-executable launcher']];
  for (const [name, bytes] of files) writeFileSync(path.join(target, name), bytes);
  const manifest = { schema: 'arena_install_component_v1', schema_version: 1,
    component_id: 'lichess.adapter', component_version: '1.0.43',
    files: files.map(([name, bytes]) => ({ path: name, size_bytes: Buffer.byteLength(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex') })) };
  writeFileSync(path.join(target, 'arena-component.json'), JSON.stringify(manifest));
  assert.equal(admitReplacementTargetPayload(target, 'win32').component_id, 'lichess.adapter');
  writeFileSync(path.join(target, 'lichess-adapter.mjs'), 'changed target code');
  assert.throws(() => admitReplacementTargetPayload(target, 'win32'), /inventory/i);
});

test('successive same-root dependency transitions capture the current completed baseline', async (t) => {
  const { captureReplacementState, publishReplacementPhase, selectReplacementTarget } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t);
  const component = path.join(root, 'component');
  const before24 = registeredObservation(component, path.join(root, 'node24.exe'));
  const completed26 = registeredObservation(component, path.join(root, 'node26.exe'), true);
  const first = captureReplacementState({ runtimeDir: root, previousRoot: component, replacementRoot: component,
    observation: before24, control: gate, authority });
  publishReplacementPhase(root, first, 'completed', component, completed26);
  const retry = captureReplacementState({ runtimeDir: root, previousRoot: component, replacementRoot: component,
    observation: completed26, control: gate, authority });
  assert.deepEqual(retry.before, before24, 'An identical completed retry retains its original before state');
  publishReplacementPhase(root, retry, 'completed', component, completed26);
  const nextAuthority = { ...authority, command: path.join(root, 'node26.exe') };
  const second = captureReplacementState({ runtimeDir: root, previousRoot: component, replacementRoot: component,
    observation: completed26, control: gate, authority: nextAuthority });
  assert.deepEqual(second.before, completed26, 'The next transition must capture Node26, never stale Node24');
  assert.equal(selectReplacementTarget(second, component, component, completed26.action), 'before');
  const requested27 = registeredObservation(component, path.join(root, 'node27.exe'));
  assert.equal(selectReplacementTarget(second, component, component, requested27.action), 'desired');
});

test('completed platform drift is a new baseline and changed unfinished authority is rejected', async (t) => {
  const { captureReplacementState, publishReplacementPhase, readReplacementState } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t); const component = path.join(root, 'component');
  const before = registeredObservation(component, path.join(root, 'node24.exe'));
  const completed = registeredObservation(component, path.join(root, 'node26.exe'));
  const options = { runtimeDir: root, previousRoot: component, replacementRoot: component, control: gate, authority };
  const first = captureReplacementState({ ...options, observation: before });
  publishReplacementPhase(root, first, 'completed', component, completed);
  const changedEnabled = registeredObservation(component, path.join(root, 'node26.exe'), true);
  const next = captureReplacementState({ ...options, observation: changedEnabled });
  assert.deepEqual(next.before, changedEnabled);
  assert.throws(() => captureReplacementState({ ...options, observation: changedEnabled,
    authority: { ...authority, arguments: 'changed runtime/config authority' } }));
  assert.deepEqual(readReplacementState(root), next);
});

test('changed completed running intent captures the current baseline while a fresh instance preserves a genuine retry', async (t) => {
  const { captureReplacementState, publishReplacementPhase } = await import('./provider-replacement-state.mjs');
  const { root } = fixture(t); const component = path.join(root, 'component');
  const before = registeredObservation(component, path.join(root, 'node24.exe'), true);
  const completed = { ...registeredObservation(component, path.join(root, 'node26.exe'), true),
    active: true, instances: ['11111111-1111-4111-8111-111111111111'] };
  const options = { runtimeDir: root, previousRoot: component, replacementRoot: component, control: gate, authority };
  const first = captureReplacementState({ ...options, observation: before });
  publishReplacementPhase(root, first, 'completed', component, completed);
  const reincarnated = { ...completed, instances: ['22222222-2222-4222-8222-222222222222'] };
  const retry = captureReplacementState({ ...options, observation: reincarnated });
  assert.deepEqual(retry.before, before);
  publishReplacementPhase(root, retry, 'completed', component, reincarnated);
  const stopped = { ...completed, active: false, instances: [] };
  const next = captureReplacementState({ ...options, observation: stopped });
  assert.deepEqual(next.before, stopped);
  publishReplacementPhase(root, next, 'completed', component, stopped);
  const started = captureReplacementState({ ...options, observation: completed });
  assert.deepEqual(started.before, completed);
});

test('a completed forward may admit a new idle convergence gate without replacing the original platform before-image', async (t) => {
  const { captureReplacementState, captureReplacementConvergence, publishReplacementPhase } = await import('./provider-replacement-state.mjs');
  const { root, store } = fixture(t); const component = path.join(root, 'component');
  const before = registeredObservation(component, path.join(root, 'node24.exe'));
  const final = registeredObservation(component, path.join(root, 'node26.exe'));
  const state = captureReplacementState({ runtimeDir: root, previousRoot: component, replacementRoot: component,
    observation: before, control: gate, authority });
  const completed = publishReplacementPhase(root, state, 'completed', component, final);
  let next;
  store.requestProviderReplacement(Date.now(), { allowUnowned: true, beforeEffect(control, closedControl) {
    next = captureReplacementConvergence({ runtimeDir: root, state: completed, control, closedControl });
  } });
  assert.deepEqual(next.before, before);
  assert.deepEqual(next.interlock_closed, store.db.prepare('SELECT admission_blocked,owner_id,active_work,updated_at FROM provider_lifecycle_control').get());
  store.db.prepare('UPDATE provider_lifecycle_control SET updated_at=updated_at+1 WHERE id=1').run();
  assert.throws(() => captureReplacementConvergence({ runtimeDir: root, state: next,
    control: { ...next.interlock_closed, updated_at: next.interlock_closed.updated_at + 1 },
    closedControl: { ...next.interlock_closed, updated_at: next.interlock_closed.updated_at + 1 } }));
});
