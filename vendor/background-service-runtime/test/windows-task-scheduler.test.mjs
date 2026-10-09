import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
import { NativeResourceHelper } from '@uci-arena/background-service-runtime/native-resource-helper';

const sha = text => createHash('sha256').update(text).digest('hex');
const absent = { registered: false, enabled: null, definition_xml: null,
  definition_sha256: null, instance_guids: [], principal: null, action: null };
const action = { command: 'C:\\Owned Fixture\\launcher.exe',
  arguments: '--restart "C:\\Owned Fixture\\node.exe" "C:\\Owned Fixture\\cli.mjs"',
  working_directory: 'C:\\Owned Fixture' };
const frame = (request, observation = structuredClone(absent)) => ({
  schema: 'uci_arena_windows_task_result_v1', schema_version: 1,
  operation: request.operation, task_path: request.task_path,
  outcome: 'completed', observation, failure: null,
});
const source = (request, value = frame(request)) => ({
  stdout: Buffer.from(JSON.stringify(value)), exitCode: 0, signal: null,
});

test('exact-task port owns a closed copied request before asynchronous invocation', async () => {
  let observed;
  const sdk = new WindowsTaskScheduler({ platform: 'win32', invoke: async request => {
    observed = request;
    return source(request);
  } });
  const request = { operation: 'inspect', task_path: '\\UCI Arena SDK Fixture' };
  const pending = sdk.perform(request);
  request.task_path = '\\different task';
  const result = await pending;
  assert.equal(observed.task_path, '\\UCI Arena SDK Fixture');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.observation, absent);
});

test('unknown action, accessors and unbound before-image fail before child invocation', async () => {
  let calls = 0;
  const sdk = new WindowsTaskScheduler({ platform: 'win32', invoke: async request => {
    calls++; return source(request);
  } });
  for (const request of [
    { operation: 'shell', task_path: '\\x' },
    { operation: 'inspect', task_path: '\\x', arbitrary: true },
    { operation: 'inspect', task_path: '\\folder\\x' },
    { operation: 'set_enabled', task_path: '\\x', enabled: false,
      expected_definition_xml: '<Task/>', expected_xml_sha256: '0'.repeat(64) },
    { operation: 'inspect', get task_path() { throw Error('CANARY'); } },
  ]) await assert.rejects(sdk.perform(request), TypeError);
  assert.equal(calls, 0);
});

test('response must bind the request and cannot turn privilege-hidden instances into absence', async () => {
  const request = { operation: 'inspect', task_path: '\\UCI Arena SDK Fixture' };
  for (const mutate of [
    value => { value.task_path = '\\foreign'; },
    value => { value.extra = true; },
    value => { value.observation.registered = true; },
    value => { value.observation = { registered: true, enabled: false,
      definition_xml: '<Task/>', definition_sha256: sha('<Task/>'), instance_guids: [],
      action,
      principal: { current_user_sid: 'S-1-5-21-1', user_sid: 'S-1-5-21-2', logon_type: 3, run_level: 0 } }; },
  ]) {
    const value = frame(request); mutate(value);
    const sdk = new WindowsTaskScheduler({ platform: 'win32', invoke: async () => source(request, value) });
    const result = await sdk.perform(request);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.failure.category, 'invalid_response');
    assert.equal(result.observation, null);
  }
});

test('invalid output and invocation errors never copy arbitrary child/exception bytes', async () => {
  const request = { operation: 'inspect', task_path: '\\UCI Arena SDK Fixture' };
  const invocations = [
    async () => ({ stdout: Buffer.from('CANARY_PRIVATE_TOKEN=secret'), exitCode: 0, signal: null }),
    async () => { throw Error('CANARY_PRIVATE_TOKEN=secret'); },
    async () => ({ stdout: Buffer.alloc(8388609, 120), exitCode: 0, signal: null }),
  ];
  for (const invoke of invocations) {
    const result = await new WindowsTaskScheduler({ platform: 'win32', invoke }).perform(request);
    assert.equal(result.outcome, 'failed');
    assert.equal(JSON.stringify(result).includes('CANARY'), false);
  }
});

test('selected request budget remains bounded and unsupported platform performs no invocation', async () => {
  let called = false;
  const sdk = new WindowsTaskScheduler({ platform: 'linux', invoke: async () => { called = true; } });
  const request = { operation: 'inspect', task_path: '\\UCI Arena SDK Fixture' };
  const result = await sdk.perform(request, { timeoutMs: 12 });
  assert.equal(result.failure.category, 'unsupported_platform');
  assert.equal(called, false);
  await assert.rejects(sdk.perform(request, { timeoutMs: 30001 }), TypeError);
});

test('completed response must satisfy the requested enabled state', async () => {
  const xml = '<Task/>';
  const request = { operation: 'set_enabled', task_path: '\\SDK Fixture',
    expected_definition_xml: xml, expected_xml_sha256: sha(xml), enabled: true };
  const observation = { registered: true, enabled: false, definition_xml: xml,
    definition_sha256: sha(xml), instance_guids: [], action, principal: {
      current_user_sid: 'S-1-5-21-1', user_sid: 'S-1-5-21-1', logon_type: 3, run_level: 0,
    } };
  const sdk = new WindowsTaskScheduler({ platform: 'win32', invoke: async value => source(value, frame(value, observation)) });
  const result = await sdk.perform(request);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure.category, 'invalid_response');
});

test('invalid cancellation options are rejected before invoking any child transport', async () => {
  let calls = 0;
  const scheduler = new WindowsTaskScheduler({ platform: 'win32', invoke: async request => {
    calls++; return source(request);
  } });
  const request = { operation: 'inspect', task_path: '\\SDK cancellation fixture' };
  for (const signal of [true, null, {}, { get aborted() { throw Error('CANARY'); } },
    new Proxy(new AbortController().signal, {})]) {
    await assert.rejects(scheduler.perform(request, { signal }), TypeError);
  }
  assert.equal(calls, 0);
});

test('completed run must retain the exact admitted definition after platform invocation', async () => {
  const xml = '<Task/>';
  const changed = '<Task changed="true"/>';
  const request = { operation: 'run', task_path: '\\SDK run fixture',
    expected_definition_xml: xml, expected_xml_sha256: sha(xml) };
  const observation = { registered: true, enabled: true, definition_xml: changed,
    definition_sha256: sha(changed), instance_guids: [], action, principal: {
      current_user_sid: 'S-1-5-21-1', user_sid: 'S-1-5-21-1', logon_type: 3, run_level: 0,
    } };
  const scheduler = new WindowsTaskScheduler({ platform: 'win32',
    invoke: async value => source(value, frame(value, observation)) });
  assert.equal((await scheduler.perform(request)).outcome, 'failed');
});

test('typed Exec action is retained exactly and malformed action facts reject', async () => {
  const request = { operation: 'inspect', task_path: '\\SDK action fixture' };
  const xml = '<Task/>';
  const observation = { registered: true, enabled: true, definition_xml: xml,
    definition_sha256: sha(xml), instance_guids: [], action, principal: {
      current_user_sid: 'S-1-5-21-1', user_sid: 'S-1-5-21-1', logon_type: 3, run_level: 0,
    } };
  const scheduler = value => new WindowsTaskScheduler({ platform: 'win32',
    invoke: async original => source(original, frame(original, value)) });
  const accepted = await scheduler(observation).perform(request);
  assert.equal(accepted.outcome, 'completed');
  assert.deepEqual(accepted.observation.action, action);
  for (const invalid of [null, { ...action, command: '' }, { ...action, arguments: '\uD800' },
    { ...action, working_directory: 'x'.repeat(32768) }, { ...action, extra: true }]) {
    assert.equal((await scheduler({ ...observation, action: invalid }).perform(request)).outcome, 'failed');
  }
});

test('actual Windows SDK bridge observes only its nonexistent UUID fixture task', {
  skip: process.platform !== 'win32' || process.env.UCI_ARENA_TASK_SCHEDULER_FIXTURE !== '1',
}, async () => {
  const task_path = `\\UCI Arena SDK Fixture ${randomUUID()}`;
  const result = await new WindowsTaskScheduler().perform({ operation: 'inspect', task_path });
  assert.equal(result.outcome, 'completed', JSON.stringify(result));
  assert.deepEqual(result.observation, absent);
});

test('actual owned UUID task register and enabled changes converge on repeated requests', {
  skip: process.platform !== 'win32' || process.env.UCI_ARENA_TASK_SCHEDULER_FIXTURE !== '1' ||
    !process.env.UCI_ARENA_NATIVE_HELPER,
  timeout: 60000,
}, async () => {
  const scheduler = new WindowsTaskScheduler();
  const task_path = `\\UCI Arena SDK Fixture ${randomUUID()}`;
  const parent = realpathSync(os.tmpdir());
  const root = realpathSync(mkdtempSync(path.join(parent, 'arena-task-sdk-')));
  const script = path.join(root, 'owned-child.mjs');
  const marker = path.join(root, 'child-pid.json');
  writeFileSync(script, "import { writeFileSync } from 'node:fs';\n" +
    "writeFileSync(new URL('./child-pid.json', import.meta.url), JSON.stringify({pid:process.pid}));\n" +
    'setInterval(() => {}, 1000);\n', { flag: 'wx' });
  const native = new NativeResourceHelper({ nativeHelperAvailable: true,
    nativeHelper: process.env.UCI_ARENA_NATIVE_HELPER });
  let childIdentity;
  const sid = /"[^"]+","(S-\d(?:-\d+)+)"/u.exec(execFileSync(
    path.join(process.env.SystemRoot, 'System32/whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true }).trim())?.[1];
  assert.ok(sid);
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const definition_xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>SDK owned UUID fixture</Description><URI>${escape(task_path)}</URI></RegistrationInfo>
<Triggers><RegistrationTrigger><Enabled>true</Enabled></RegistrationTrigger><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Owner"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><Enabled>true</Enabled><UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="Owner"><Exec><Command>${escape(process.execPath)}</Command><Arguments>${escape('"' + script + '"')}</Arguments><WorkingDirectory>${escape(root)}</WorkingDirectory></Exec></Actions></Task>`;
  let owns = false;
  const inspect = () => scheduler.perform({ operation: 'inspect', task_path });
  const before = observation => ({ expected_definition_xml: observation.definition_xml,
    expected_xml_sha256: observation.definition_sha256 });
  try {
    assert.equal((await inspect()).observation.registered, false);
    owns = true; // The admitted UUID was absent; cleanup still verifies its exact fixture action.
    const register = { operation: 'register', task_path, expected_definition_xml: null,
      expected_xml_sha256: null, definition_xml };
    let result = await scheduler.perform(register);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.deepEqual(result.observation.action, { command: process.execPath,
      arguments: '"' + script + '"', working_directory: root });
    await new Promise(resolve => setTimeout(resolve, 500));
    const registeredOnly = await inspect();
    assert.equal(registeredOnly.outcome, 'completed', JSON.stringify(registeredOnly));
    assert.deepEqual(registeredOnly.observation.instance_guids, [],
      'registration must not execute a registration trigger before explicit run');
    result = await scheduler.perform(register);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    const logonUser = /<LogonTrigger(?:\s[^>]*)?>[\s\S]*?<UserId>([^<]+)<\/UserId>/u.exec(result.observation.definition_xml)?.[1];
    assert.ok(logonUser, 'registered explicit logon trigger remains present');
    console.log(JSON.stringify({schema:'sdk_owned_logon_identity_observation_v1',
      representationChanged:logonUser!==sid, semanticRetry:'completed'}));
    const logon = '<LogonTrigger><Enabled>true</Enabled><UserId>' + sid + '</UserId></LogonTrigger>';
    for (const replacement of [
      '<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-18</UserId></LogonTrigger>',
      '<LogonTrigger><Enabled>true</Enabled></LogonTrigger>',
      '<LogonTrigger><Enabled>false</Enabled><UserId>' + sid + '</UserId></LogonTrigger>',
      '<LogonTrigger><Enabled>true</Enabled><UserId>' + sid + '</UserId><Delay>PT1S</Delay></LogonTrigger>',
    ]) {
      const differing = await scheduler.perform({...register,
        definition_xml:definition_xml.replace(logon,replacement)});
      assert.equal(differing.outcome,'failed');assert.equal(differing.failure.category,'identity_mismatch');
      assert.equal((await inspect()).observation.definition_sha256,result.observation.definition_sha256);
    }
    const unknown = await scheduler.perform({...register,definition_xml:definition_xml.replace(logon,
      '<LogonTrigger><Enabled>true</Enabled><UserId>' + escape(process.env.COMPUTERNAME+'\\UCI_ARENA_SDK_UNKNOWN_'+randomUUID()) + '</UserId></LogonTrigger>')});
    assert.equal(unknown.outcome,'failed');assert.equal(unknown.failure.category,'unsupported_principal');
    const admittedDigest = result.observation.definition_sha256;
    const substituted = await scheduler.perform({ ...register,
      definition_xml: definition_xml.replace('SDK owned UUID fixture', 'changed fixture definition') });
    assert.equal(substituted.outcome, 'failed');
    assert.equal(substituted.failure.category, 'identity_mismatch');
    assert.equal((await inspect()).observation.definition_sha256, admittedDigest);
    const disable = { operation: 'set_enabled', task_path, ...before(result.observation), enabled: false };
    result = await scheduler.perform(disable);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(result.observation.enabled, false);
    result = await scheduler.perform(disable);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    const prior = result.observation;
    const changed = await scheduler.perform({ operation: 'register', task_path, ...before(prior),
      definition_xml: prior.definition_xml.replace('SDK owned UUID fixture', 'replacement fixture definition') });
    assert.equal(changed.outcome, 'completed', JSON.stringify(changed));
    const restore = { operation: 'register', task_path, ...before(changed.observation),
      definition_xml: prior.definition_xml };
    result = await scheduler.perform(restore);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(result.observation.definition_sha256, prior.definition_sha256);
    result = await scheduler.perform(restore);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(result.observation.enabled, false);
    const enable = { operation: 'set_enabled', task_path, ...before(result.observation), enabled: true };
    result = await scheduler.perform(enable);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    const run = { operation: 'run', task_path, ...before(result.observation) };
    result = await scheduler.perform(run);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.ok(result.observation.instance_guids.length > 0);
    const startedBy = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < startedBy) await new Promise(resolve => setTimeout(resolve, 25));
    const pid = JSON.parse(readFileSync(marker)).pid;
    const nativeDeadline = performance.now() + 5000;
    let child;
    do {
      const remaining = Math.ceil(nativeDeadline - performance.now());
      if (remaining <= 0) break;
      child = native.queryProcessInstanceSync(pid, { timeoutMs: Math.min(2000, remaining) });
      if (child.state !== 'unverifiable') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (performance.now() < nativeDeadline);
    assert.equal(child.state, 'present');
    assert.equal(child.identity.executable_path.toLowerCase(), realpathSync(process.execPath).toLowerCase());
    childIdentity = child.identity;
    // Gate the same owned task before draining; no global task is touched.
    result = await scheduler.perform({ operation: 'set_enabled', task_path, ...before(result.observation), enabled: false });
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    const stop = { operation: 'stop_instances', task_path, ...before(result.observation),
      instance_guids: result.observation.instance_guids };
    result = await scheduler.perform(stop);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.deepEqual(result.observation.instance_guids, []);
    result = await scheduler.perform(stop);
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
  } finally {
    if (owns) {
      let current = await inspect();
      assert.equal(current.outcome, 'completed');
      if (current.observation.registered) {
        assert.ok(current.observation.definition_xml.includes(escape(script)), 'cleanup refuses a foreign action');
        if (!childIdentity && existsSync(marker)) {
          const candidate = native.queryProcessInstanceSync(JSON.parse(readFileSync(marker)).pid);
          if (candidate.state === 'present') childIdentity = candidate.identity;
          else assert.equal(candidate.state, 'absent');
        }
        if (current.observation.instance_guids.length) {
          // Existing public OS end operation is restricted to this verified UUID,
          // so even a deliberately failing SDK stop test cannot leak its fixture.
          execFileSync(path.join(process.env.SystemRoot, 'System32/schtasks.exe'),
            ['/End', '/TN', task_path], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
          current = await inspect();
        }
        const deleted = await scheduler.perform({ operation: 'delete', task_path, ...before(current.observation) });
        assert.equal(deleted.outcome, 'completed', JSON.stringify(deleted));
        assert.equal(deleted.observation.registered, false);
      }
    }
    if (childIdentity) {
      const closedBy = Date.now() + 5000;
      let observation;
      do {
        observation = native.queryProcessInstanceSync(childIdentity.pid);
        if (observation.state === 'absent' || (observation.state === 'present' &&
            observation.identity.start_token !== childIdentity.start_token)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < closedBy);
      assert.ok(observation.state === 'absent' || (observation.state === 'present' &&
        observation.identity.start_token !== childIdentity.start_token), 'owned child incarnation must be gone');
    }
    const resolved = realpathSync(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('arena-task-sdk-'));
    assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
    rmSync(resolved, { recursive: true, maxRetries: 20, retryDelay: 50 });
  }
});

test('actual owned platform invocation is joined on a selected timeout and cancellation', {
  skip: process.platform !== 'win32' || process.env.UCI_ARENA_TASK_SCHEDULER_FIXTURE !== '1',
}, async () => {
  const scheduler = new WindowsTaskScheduler();
  const request = { operation: 'inspect', task_path: `\\UCI Arena SDK Fixture ${randomUUID()}` };
  const timed = await scheduler.perform(request, { timeoutMs: 1 });
  assert.equal(timed.failure.category, 'transport_timeout');
  const controller = new AbortController();
  Object.defineProperty(controller.signal, 'addEventListener', {
    get() { throw Error('CANARY overridden subscription'); },
  });
  const pending = scheduler.perform(request, { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).failure.category, 'cancelled');
});
