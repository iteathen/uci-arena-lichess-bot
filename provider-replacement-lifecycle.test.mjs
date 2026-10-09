import assert from "node:assert/strict";
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LichessStore } from "./lichess-store.mjs";
import { providerLifecycleResult } from "./lichess-adapter.mjs";
import { setTimeout as wait } from 'node:timers/promises';

const root = path.dirname(fileURLToPath(import.meta.url));

test("successful Windows launch request with inactive task cannot publish typed install ready", (t) => {
  if (process.platform !== "win32") return t.skip("Windows mocked-platform install fixture");
  const result = spawnSync(process.execPath, [path.join(root, "test-fixtures", "inactive-install-platform.mjs")],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /inactive installation cannot publish typed active success/);
});

for (const [platform, active, enabled] of [["win32", true, true], ["linux", "active", "enabled"]]) {
  test(`typed ${platform} install reports ready only from observed installed enabled activity`, () => {
    const startup = { installed: true, active, enabled };
    const result = providerLifecycleResult("install", "ready", null, startup, platform);
    assert.equal(result.observed.activity, "active");
    for (const invalid of [
      { ...startup, installed: false },
      { ...startup, installed: undefined },
      { ...startup, active: platform === "win32" ? false : "inactive", started: true },
      { ...startup, active: "unknown", started: true },
      { ...startup, enabled: platform === "win32" ? false : "disabled" },
      { ...startup, enabled: "unknown" },
      null,
    ]) {
      assert.throws(() => providerLifecycleResult("install", "ready", null, invalid, platform),
        /installed, enabled, and active startup/);
    }
  });
}

function fixture(t) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "uci-arena-inactive-replacement-"));
  const initial = lstatSync(runtimeDir);
  t.after(() => {
    const actual = realpathSync(runtimeDir); const temporary = realpathSync(os.tmpdir());
    const relative = path.relative(temporary, actual); const current = lstatSync(actual);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.ok(path.basename(actual).startsWith('uci-arena-inactive-replacement-'));
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === initial.dev && current.ino === initial.ino);
    rmSync(actual, { recursive: true, force: true });
  });
  const previousRoot = path.join(runtimeDir, "previous");
  const replacementRoot = path.join(runtimeDir, "replacement");
  const seed = new LichessStore(path.join(runtimeDir, 'matches.sqlite')); seed.close();
  const run = (action, replacement = replacementRoot, state = "", environment = {}, node = process.execPath) => spawnSync(node, [
    "--import", pathToFileURL(path.join(root, "test-fixtures", "absent-startup-platform.mjs")).href,
    path.join(root, "lichess-adapter.mjs"), "startup", action,
    "--lifecycle-result", "typed_v1", "--runtime-dir", runtimeDir,
    "--previous-root", previousRoot, "--replacement-root", replacement,
    "--config", path.join(runtimeDir, "nonexistent-config.json"),
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, ...environment, UCI_ARENA_FIXTURE_TASK_STATE: state } });
  const snapshot = () => {
    const store = new LichessStore(path.join(runtimeDir, "matches.sqlite"));
    try { return store.providerLifecycleSnapshot(); } finally { store.close(); }
  };
  return { runtimeDir, previousRoot, replacementRoot, run, snapshot };
}

test("absent startup replacement preserves inactivity, closes admission, and resumes idempotently", (t) => {
  if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
  const { runtimeDir, run, snapshot } = fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = run("prepare_replace");
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = JSON.parse(prepared.stdout);
    assert.equal(result.schema, "arena_provider_lifecycle_result_v1");
    assert.equal(result.operation, "pre_replace");
    assert.deepEqual(result.observed, {
      installation: "installed", activity: "inactive", configuration: "matches", replacement: "safe",
    });
    assert.equal(snapshot().admissionBlocked, true);
    const captured = JSON.parse(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json')));
    assert.equal(captured.schema_version, 2);
    assert.equal(captured.interlock_before.admission_blocked, 0);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const priorControl = snapshot();
    const priorBytes = readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json'), 'utf8');
    const completed = run("complete_replace");
    assert.equal(completed.status, 0, completed.stderr);
    const result = JSON.parse(completed.stdout);
    assert.equal(result.operation, "post_replace");
    assert.equal(result.disposition, "safe_inactive");
    assert.equal(result.reason.id, "startup.explicitly_inactive");
    assert.equal(result.observed.activity, "inactive");
    assert.equal(snapshot().admissionBlocked, false);
    if (attempt > 0) {
      assert.deepEqual(snapshot(), priorControl, 'A completed repeat must not cycle its gate or reset ownership');
      assert.equal(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json'), 'utf8'), priorBytes,
        'A completed read-only convergence must retain its existing authority record');
    }
  }
  const intent = JSON.parse(readFileSync(path.join(runtimeDir, "startup-replacement-intent.json")));
  assert.equal(intent.phase, "completed");
  assert.equal(intent.registration_present, false);
});

for (const state of ["active", "disabled"]) {
  test(`absent replacement intent rejects a new ${state} registration before admission resumes`, (t) => {
    if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
    const { replacementRoot, run, snapshot } = fixture(t);
    const prepared = run("prepare_replace");
    assert.equal(prepared.status, 0, prepared.stderr);
    const completed = run("complete_replace", replacementRoot, state);
    assert.equal(completed.status, 1);
    assert.equal(snapshot().admissionBlocked, true);
  });
}

for (const corrupt of ["preparing", "unknown_field"]) {
  test(`completion rejects ${corrupt} intent before admission resumes`, (t) => {
    if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
    const { runtimeDir, run, snapshot } = fixture(t);
    assert.equal(run("prepare_replace").status, 0);
    const filename = path.join(runtimeDir, "startup-replacement-intent.json");
    const intent = JSON.parse(readFileSync(filename));
    if (corrupt === "preparing") intent.phase = "preparing";
    else intent.unrecognized_authority = true;
    writeFileSync(filename, JSON.stringify(intent));
    assert.equal(run("complete_replace").status, 1);
    assert.equal(snapshot().admissionBlocked, true);
  });
}

test("absent startup does not let replacement bypass unresolved provider work", (t) => {
  if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
  const { runtimeDir, run, snapshot } = fixture(t);
  const store = new LichessStore(path.join(runtimeDir, "matches.sqlite"));
  const now = Date.now();
  store.acquireApiLease("https://lichess.org|fixture", "fixture-owner", 101, now, 60_000,
    null, { schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: 101,
      start_token: "504911232000000101", executable_path: "C:\\UCI Arena\\node.exe", boot_id: "" });
  store.claimProviderLifecycle("fixture-owner", now);
  store.beginProviderWork("fixture-owner", Date.now());
  store.close();
  const prepared = run("prepare_replace");
  assert.equal(prepared.status, 1);
  assert.equal(prepared.stderr, "");
  const failure = JSON.parse(prepared.stdout);
  assert.equal(failure.disposition, "failed");
  assert.equal(failure.reason.id, "startup.interlock_failed");
  assert.equal(JSON.parse(failure.reason.message).code, "provider_owned_work_active");
  assert.equal(snapshot().activeWork, 1);
  assert.equal(snapshot().admissionBlocked, false);
});

test("inactive completion cannot consume intent for a different replacement root", (t) => {
  if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
  const { runtimeDir, run, snapshot } = fixture(t);
  const prepared = run("prepare_replace");
  assert.equal(prepared.status, 0, prepared.stderr);
  const completed = run("complete_replace", path.join(runtimeDir, "unrelated"));
  assert.equal(completed.status, 1);
  assert.equal(snapshot().admissionBlocked, true);
});

test('real Node24 staged pre accepts absent future payload and real Node26 post owns the committed target', (t) => {
  if (process.platform !== 'win32' || process.versions.node !== '26.11.1') {
    return t.skip('Exact Windows Node26.11.1 post interpreter fixture');
  }
  const nodeRoot = path.join(process.env.LOCALAPPDATA ?? '', 'UCI Arena Manager', 'installed',
    'components', 'node_runtime.private', '24.15.0');
  const node24 = process.env.UCI_ARENA_REPLACEMENT_TEST_NODE24 ?? path.join(nodeRoot, 'bin', 'node.exe');
  if (!existsSync(node24)) return t.skip('Exact public Node24.15.0 interpreter not available');
  const inventory = JSON.parse(readFileSync(path.join(path.dirname(path.dirname(node24)), 'arena-component.json')));
  const row = inventory.files.find((record) => record.path === 'bin/node.exe');
  assert.equal(inventory.component_id, 'node_runtime.private'); assert.equal(inventory.component_version, '24.15.0');
  assert.equal(row.sha256, '3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5');
  assert.equal(createHash('sha256').update(readFileSync(node24)).digest('hex'), row.sha256);
  const { runtimeDir, replacementRoot, run, snapshot } = fixture(t);
  assert.equal(existsSync(replacementRoot), false, 'Future final-root admission is lexical before commit');
  const pre = run('prepare_replace', replacementRoot, '', {}, node24);
  assert.equal(pre.status, 0, pre.stdout + pre.stderr);
  const before = JSON.parse(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json')));
  assert.equal(before.phase, 'prepared'); assert.equal(before.request_authority.command, node24);
  assert.equal(existsSync(replacementRoot), false);
  // An absent registration executes no target code. The post controller owns
  // its actual Node26 identity without requiring equality to the old interpreter.
  const post = run('complete_replace');
  assert.equal(post.status, 0, post.stdout + post.stderr);
  const after = JSON.parse(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json')));
  assert.equal(after.phase, 'completed'); assert.equal(after.controller.executable_path, process.execPath);
  assert.equal(after.request_authority.command, node24, 'Original before invocation remains immutable');
  assert.equal(snapshot().admissionBlocked, false);
});

for (const mode of ['present', 'unverifiable', 'absent', 'reused']) {
  test(`absent Task cannot substitute for ${mode} exact provider-process observation`, (t) => {
    if (process.platform !== 'win32') return t.skip('Windows guarded provider process fixture');
    const { runtimeDir, run, snapshot } = fixture(t);
    const presenceFile = path.join(runtimeDir, 'fixture-controller-presence.json');
    const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
      start_token: '504911232000000001', executable_path: process.execPath, boot_id: '' };
    const store = new LichessStore(path.join(runtimeDir, 'matches.sqlite'));
    try { store.acquireApiLease('https://example.invalid|fixture', 'fixture-owner', 101, Date.now(), 60000, null, identity);
      store.claimProviderLifecycle('fixture-owner'); } finally { store.close(); }
    writeFileSync(presenceFile, JSON.stringify({ 101: mode }));
    const prepared = run('prepare_replace', undefined, '', { UCI_ARENA_FIXTURE_PRESENCE_FILE: presenceFile });
    assert.equal(prepared.status, ['absent', 'reused'].includes(mode) ? 0 : 1, prepared.stdout);
    assert.equal(snapshot().admissionBlocked, true);
    assert.equal(snapshot().owned, true);
    assert.equal(snapshot().activeWork, 0);
    assert.equal(JSON.parse(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json'))).phase,
      ['absent', 'reused'].includes(mode) ? 'prepared' : 'preparing');
  });
}

for (const retained of [false, true]) {
  test(`missing old lease row ${retained ? 'uses exact retained runtime process' : 'never invents process absence'}`, (t) => {
    if (process.platform !== 'win32') return t.skip('Windows guarded provider process fixture');
    const { runtimeDir, run, snapshot } = fixture(t);
    const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
      start_token: '504911232000000001', executable_path: process.execPath, boot_id: '' };
    const store = new LichessStore(path.join(runtimeDir, 'matches.sqlite'));
    try { store.acquireApiLease('https://example.invalid|fixture', 'fixture-owner', 101, Date.now(), 60000, null, identity);
      store.claimProviderLifecycle('fixture-owner'); store.releaseApiLease('https://example.invalid|fixture', 'fixture-owner');
    } finally { store.close(); }
    if (retained) writeFileSync(path.join(runtimeDir, 'runtime.json'), JSON.stringify({
      schema: 'uci_arena_lichess_runtime_v3', adapter_id: 'lichess_node_adapter_v2', pid: 101, process_instance: identity }));
    const before = snapshot(); const pre = run('prepare_replace');
    assert.equal(pre.status, retained ? 0 : 1, pre.stdout);
    assert.equal(snapshot().owned, true); assert.equal(snapshot().activeWork, 0);
    if (!retained) assert.deepEqual(snapshot(), before);
  });
}

test('guarded concurrent pre/post cannot reopen admission while the exact pre controller remains live', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows guarded controller fixture');
  const { runtimeDir, previousRoot, replacementRoot, snapshot } = fixture(t);
  const holdFile = path.join(runtimeDir, 'fixture-controller-held.json');
  const presenceFile = path.join(runtimeDir, 'fixture-controller-presence.json');
  const args = (action, target) => ['--import', pathToFileURL(path.join(root, 'test-fixtures', 'absent-startup-platform.mjs')).href,
    path.join(root, 'lichess-adapter.mjs'), 'startup', action, '--lifecycle-result', 'typed_v1',
    '--runtime-dir', runtimeDir, '--previous-root', previousRoot, '--replacement-root', target,
    '--config', path.join(runtimeDir, 'nonexistent-config.json')];
  const child = spawn(process.execPath, args('prepare_replace', replacementRoot), { windowsHide: true,
    env: { ...process.env, UCI_ARENA_FIXTURE_HOLD_FILE: holdFile, UCI_ARENA_FIXTURE_PRESENCE_FILE: presenceFile } });
  let output = ''; let stderr = ''; child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code)); });
  let childCode;
  try {
    for (let attempt = 0; attempt < 250 && !existsSync(holdFile); attempt += 1) await wait(10);
    assert.equal(existsSync(holdFile), true);
    const { pid } = JSON.parse(readFileSync(holdFile, 'utf8'));
    writeFileSync(presenceFile, JSON.stringify({ [pid]: 'present' }));
    const beforeBytes = readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json'), 'utf8');
    const beforeControl = snapshot();
    const post = spawnSync(process.execPath, args('complete_replace', previousRoot), { encoding: 'utf8', windowsHide: true,
      timeout: 10000, env: { ...process.env, UCI_ARENA_FIXTURE_PRESENCE_FILE: presenceFile } });
    assert.equal(post.status, 1); assert.equal(JSON.parse(post.stdout).disposition, 'failed');
    assert.deepEqual(snapshot(), beforeControl); assert.equal(snapshot().admissionBlocked, true);
    assert.equal(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json'), 'utf8'), beforeBytes);
  } finally {
    writeFileSync(`${holdFile}.release`, 'released');
    childCode = await closed;
  }
  assert.equal(childCode, 0, stderr);
  assert.equal(JSON.parse(output).operation, 'pre_replace');
});

test('paired compensation restores captured absence after forward preparation may not have finished', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows guarded compensation fixture');
  const { captureReplacementState } = await import('./provider-replacement-state.mjs');
  const { runtimeDir, previousRoot, replacementRoot, run, snapshot } = fixture(t);
  const store = new LichessStore(path.join(runtimeDir, 'matches.sqlite'));
  try {
    store.requestProviderReplacement(Date.now(), { allowUnowned: true, beforeEffect(control, closedControl) {
      captureReplacementState({ runtimeDir, previousRoot, replacementRoot, control, closedControl,
        observation: { platform: 'win32', registered: false, active: false, enabled: false,
          definition_text: null, definition_sha256: null, action: null, instances: [] },
        authority: { command: process.execPath, arguments: 'fixture forward invocation', working_directory: root } });
    } });
  } finally { store.close(); }
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const result = run('complete_replace', previousRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).disposition, 'safe_inactive');
    assert.equal(snapshot().admissionBlocked, false);
    const state = JSON.parse(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json')));
    assert.equal(state.phase, 'completed'); assert.equal(state.terminal_root, previousRoot);
    assert.equal(state.before.registered, false);
  }
});

test('historical inactive baseline compensation preserves positive work and every original control field', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows guarded compensation fixture');
  const { runtimeDir, previousRoot, run } = fixture(t);
  const store = new LichessStore(path.join(runtimeDir, 'matches.sqlite'));
  try {
    store.acquireApiLease('https://lichess.org|fixture', 'fixture-owner', 101, Date.now(), 60000, null,
      { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 101,
        start_token: '504911232000000101', executable_path: 'C:\\fixture\\node.exe', boot_id: '' });
    store.claimProviderLifecycle('fixture-owner'); store.beginProviderWork('fixture-owner');
    const before = store.db.prepare('SELECT * FROM provider_lifecycle_control').all();
    const historical = { schema: 'uci_arena_lichess_startup_replacement_intent_v1', schema_version: 1,
      previous_root: path.join(runtimeDir, 'removed-137'), replacement_root: previousRoot,
      preserve_inactive: true, registration_present: false, phase: 'completed' };
    writeFileSync(path.join(runtimeDir, 'startup-replacement-intent.json'), JSON.stringify(historical));
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const restored = run('complete_replace', previousRoot);
      assert.equal(restored.status, 0, restored.stderr);
      assert.equal(JSON.parse(restored.stdout).disposition, 'safe_inactive');
      assert.deepEqual(store.db.prepare('SELECT * FROM provider_lifecycle_control').all(), before);
      assert.deepEqual(JSON.parse(readFileSync(path.join(runtimeDir, 'startup-replacement-intent.json'))), historical);
    }
    assert.equal(run('prepare_replace').status, 1); // This is no new forward-ready grant.
    assert.deepEqual(store.db.prepare('SELECT * FROM provider_lifecycle_control').all(), before);
  } finally { store.close(); }
});
