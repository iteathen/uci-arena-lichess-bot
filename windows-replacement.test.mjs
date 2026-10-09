import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';

const componentRoot = path.resolve('fixture-old-component');
const runtimeDir = path.resolve('fixture-runtime');
const configPath = path.join(runtimeDir, 'configuration.json');
const action = { command: path.join(componentRoot, 'native', 'lichess_adapter_launcher.exe'),
  arguments: [process.execPath, path.join(componentRoot, 'lichess-adapter.mjs'), 'run',
    '--config', configPath, '--token-file', path.resolve('fixture-external', 'token-locator'),
    '--expected-account', 'fixture', '--runtime-dir', runtimeDir].map((value) => `"${value}"`).join(' '),
  working_directory: componentRoot };
const definition = '<Task>opaque fixture SDK definition</Task>';
const registered = { registered: true, enabled: false, definition_xml: definition,
  definition_sha256: createHash('sha256').update(definition).digest('hex'), instance_guids: [],
  principal: { current_user_sid: 'S-1-5-21-1', user_sid: 'S-1-5-21-1', logon_type: 3, run_level: 0 }, action };

const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const unescape = (text) => text.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const taskDefinition = (enabled) => `<Task><Settings><Enabled>${enabled}</Enabled><Priority>4</Priority></Settings><Actions><Exec><Command>${escape(action.command)}</Command><Arguments>${escape(action.arguments)}</Arguments><WorkingDirectory>${escape(action.working_directory)}</WorkingDirectory></Exec></Actions></Task>`;

function taskFixture(xml, active = false) {
  const calls = [];
  let current = xml;
  let instances = active ? ['11111111-1111-4111-8111-111111111111'] : [];
  const snapshot = () => ({ ...registered, enabled: /<Enabled>true<\/Enabled>/.test(current),
    definition_xml: current, definition_sha256: createHash('sha256').update(current).digest('hex'),
    instance_guids: [...instances], action: Object.fromEntries(['Command', 'Arguments', 'WorkingDirectory'].map((key, index) =>
      [['command', 'arguments', 'working_directory'][index], unescape(current.match(new RegExp(`<${key}>([\\s\\S]*?)<\\/${key}>`))[1])])) });
  return { calls, snapshot, scheduler: { async perform(request) {
    calls.push(request.operation);
    if (request.operation === 'inspect') return { outcome: 'completed', observation: snapshot() };
    if (request.operation === 'register' && current === request.definition_xml) return { outcome: 'completed', observation: snapshot() };
    assert.equal(request.expected_xml_sha256, snapshot().definition_sha256, 'public exact-definition admission');
    if (request.operation === 'set_enabled') current = current.replace(/<Enabled>(true|false)<\/Enabled>/,
      `<Enabled>${request.enabled}</Enabled>`);
    else if (request.operation === 'stop_instances') {
      assert.deepEqual(request.instance_guids, instances); instances = [];
    } else if (request.operation === 'register') current = request.definition_xml;
    else if (request.operation === 'run') instances = ['11111111-1111-4111-8111-111111111111'];
    else assert.fail('unadmitted SDK operation');
    return { outcome: 'completed', observation: snapshot() };
  } } };
}

test('canonical public SDK null absence normalizes to a provider inactive before-image', async () => {
  const { inspectWindowsReplacement } = await import('./windows-startup.mjs');
  const scheduler = new WindowsTaskScheduler({ platform: 'win32', invoke: async (request) => ({
    stdout: Buffer.from(JSON.stringify({ schema: 'uci_arena_windows_task_result_v1', schema_version: 1,
      operation: request.operation, task_path: request.task_path, outcome: 'completed', failure: null,
      observation: { registered: false, enabled: null, definition_xml: null, definition_sha256: null,
        instance_guids: [], principal: null, action: null } })), exitCode: 0, signal: null,
  }) });
  const result = await inspectWindowsReplacement({ componentRoot, runtimeDir, configPath, platform: 'win32', scheduler });
  assert.equal(result.registered, false); assert.equal(result.enabled, false); assert.equal(result.active, false);
  assert.equal(result.action, null);
});

test('same-root inverse convergence restores the captured Node tuple rather than the current desired tuple', async () => {
  const { deriveWindowsReplacementAction, convergeWindowsReplacement } = await import('./windows-startup.mjs');
  const beforeXml = taskDefinition(false);
  const laterNode = path.resolve('fixture-node27.exe');
  const currentXml = beforeXml.replace(escape(process.execPath), escape(laterNode));
  const fixture = taskFixture(currentXml);
  const state = { previous_root: componentRoot, replacement_root: componentRoot,
    before: { platform: 'win32', registered: true, enabled: false, active: false,
      definition_text: beforeXml, definition_sha256: createHash('sha256').update(beforeXml).digest('hex'), action, instances: [] },
    completed_observation: { platform: 'win32', registered: true, enabled: false, active: false,
      definition_text: currentXml, definition_sha256: createHash('sha256').update(currentXml).digest('hex'),
      action: fixture.snapshot().action, instances: [] } };
  const requested = deriveWindowsReplacementAction({ state, targetRoot: componentRoot,
    configPath, runtimeDir, nodePath: process.execPath });
  assert.deepEqual(requested, action);
  const result = await convergeWindowsReplacement({ state, target: 'before', requestedAction: requested,
    runtimeDir, configPath, platform: 'win32', scheduler: fixture.scheduler,
    execute: async () => fixture.calls.push('native_join') });
  assert.equal(result.observation.enabled, false);
  assert.deepEqual(result.observation.action, action);
  assert.equal(fixture.snapshot().definition_xml, beforeXml);
});

test('activation uses the exact public task definition and requires sustained provider readiness', async () => {
  const { inspectWindowsReplacement, activateWindowsReplacement } = await import('./windows-startup.mjs');
  const fixture = taskFixture(taskDefinition(false));
  const observation = await inspectWindowsReplacement({ componentRoot, runtimeDir, configPath,
    platform: 'win32', scheduler: fixture.scheduler });
  let readiness = 0;
  const result = await activateWindowsReplacement({ observation, componentRoot, runtimeDir, configPath,
    scheduler: fixture.scheduler, ready: async () => { readiness += 1; return readiness >= 2; },
    delay: async () => {}, pollMilliseconds: 10, stabilityMilliseconds: 20, timeoutMilliseconds: 100,
    launchGraceMilliseconds: 20 });
  assert.equal(result.active, true); assert.ok(readiness >= 3);
  assert.ok(fixture.calls.includes('set_enabled')); assert.ok(fixture.calls.includes('run'));
});

test('inverse restoration rejects a foreign definition before any platform mutation', async () => {
  const { convergeWindowsReplacement } = await import('./windows-startup.mjs');
  const beforeXml = taskDefinition(false);
  const fixture = taskFixture(beforeXml.replace('<Priority>4</Priority>', '<Priority>5</Priority>'));
  const state = { previous_root: componentRoot, replacement_root: path.resolve('fixture-new-component'),
    before: { platform: 'win32', registered: true, enabled: false, active: false,
      definition_text: beforeXml, definition_sha256: createHash('sha256').update(beforeXml).digest('hex'), action, instances: [] } };
  await assert.rejects(convergeWindowsReplacement({ state, target: 'before', requestedAction: action,
    runtimeDir, configPath, platform: 'win32', scheduler: fixture.scheduler,
    execute: async () => fixture.calls.push('native_join') }));
  assert.ok(fixture.calls.every((op) => op === 'inspect' || op === 'register'));
  assert.equal(fixture.snapshot().definition_xml.includes('<Priority>5</Priority>'), true);
});

test('Windows replacement admission uses public typed action and exact SDK before-image', async () => {
  const { inspectWindowsReplacement } = await import('./windows-startup.mjs');
  const calls = [];
  const snapshot = await inspectWindowsReplacement({ componentRoot, runtimeDir, configPath, platform: 'win32',
    scheduler: { async perform(request) { calls.push(request); return { outcome: 'completed', observation: registered }; } } });
  assert.deepEqual(calls, [{ operation: 'inspect', task_path: '\\UCI Arena Lichess Adapter' }]);
  assert.equal(snapshot.platform, 'win32'); assert.equal(snapshot.registered, true);
  assert.equal(snapshot.definition_text, definition); assert.equal(snapshot.definition_sha256, registered.definition_sha256);
  assert.deepEqual(snapshot.action, action); assert.equal(snapshot.active, false);
});

for (const wrong of [
  { ...action, command: path.resolve('foreign.exe') },
  { ...action, working_directory: path.resolve('foreign') },
  { ...action, arguments: action.arguments.replace(runtimeDir, path.resolve('foreign-runtime')) },
  { ...action, arguments: `${action.arguments} --runtime-dir "${runtimeDir}"` },
]) {
  test(`typed owned action rejects drift ${JSON.stringify(wrong)}`, async () => {
    const { inspectWindowsReplacement } = await import('./windows-startup.mjs');
    await assert.rejects(inspectWindowsReplacement({ componentRoot, runtimeDir, configPath, platform: 'win32',
      scheduler: { async perform() { return { outcome: 'completed', observation: { ...registered, action: wrong } }; } } }));
  });
}

test('absent task replacement is read-only and never invokes native tree mutation', async () => {
  const { quiesceWindowsReplacement } = await import('./windows-startup.mjs');
  const calls = [];
  const replacementRoot = path.resolve('fixture-new-component');
  const before = { platform: 'win32', registered: false, enabled: false, active: false,
    definition_text: null, definition_sha256: null, action: null, instances: [] };
  const state = { previous_root: componentRoot, replacement_root: replacementRoot, before };
  await quiesceWindowsReplacement({ state, runtimeDir, configPath, platform: 'win32',
    scheduler: { async perform(request) { calls.push(request.operation); return { outcome: 'completed',
      observation: { registered: false, enabled: null, action: null, definition_xml: null,
        definition_sha256: null, instance_guids: [], principal: null } }; } },
    execute: async () => { assert.fail('Absent task cannot trigger native tree mutation'); },
  });
  assert.deepEqual(calls, ['inspect']);
});

test('registered task is stopped and native-joined before the desired root is registered', async () => {
  const { quiesceWindowsReplacement } = await import('./windows-startup.mjs');
  const fixture = taskFixture(taskDefinition(true), true);
  const snapshot = fixture.snapshot();
  const replacementRoot = path.resolve('fixture-new-component');
  const state = { previous_root: componentRoot, replacement_root: replacementRoot,
    before: { platform: 'win32', registered: true, enabled: true, active: true,
      definition_text: snapshot.definition_xml, definition_sha256: snapshot.definition_sha256,
      action: snapshot.action, instances: snapshot.instance_guids } };
  const result = await quiesceWindowsReplacement({ state, runtimeDir, configPath, platform: 'win32',
    scheduler: fixture.scheduler, async execute(file, args) {
      fixture.calls.push('native_join');
      assert.equal(args[0], '--terminate-owned-tree');
      assert.equal(args[1], path.join(componentRoot, 'native', 'lichess_adapter_launcher.exe'));
      assert.equal(fixture.snapshot().instance_guids.length, 0);
      assert.equal(fixture.snapshot().action.working_directory, componentRoot);
    } });
  assert.equal(result.replacementReady, true);
  assert.equal(fixture.snapshot().action.working_directory, replacementRoot);
  assert.deepEqual(fixture.calls, ['inspect', 'register', 'set_enabled', 'stop_instances', 'native_join', 'inspect', 'register', 'inspect']);
});

test('unexpected enablement after an inactive before-capture fails before any task effect', async () => {
  const { quiesceWindowsReplacement } = await import('./windows-startup.mjs');
  const fixture = taskFixture(taskDefinition(true));
  const beforeXml = taskDefinition(false);
  const state = { previous_root: componentRoot, replacement_root: path.resolve('fixture-new-component'),
    before: { platform: 'win32', registered: true, enabled: false, active: false,
      definition_text: beforeXml, definition_sha256: createHash('sha256').update(beforeXml).digest('hex'),
      action, instances: [] } };
  await assert.rejects(quiesceWindowsReplacement({ state, runtimeDir, configPath, platform: 'win32',
    scheduler: fixture.scheduler, execute: async () => fixture.calls.push('native_join') }));
  assert.deepEqual(fixture.calls, ['inspect']);
});
