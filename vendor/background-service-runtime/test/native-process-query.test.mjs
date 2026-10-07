import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NativeResourceHelper } from '../src/native-resource-helper.mjs';
import { processIdentityTestOraclePath } from './process-identity-test-oracle.mjs';

const configuredHelper = process.env.UCI_ARENA_NATIVE_HELPER;
const native = process.platform === 'win32' && Boolean(configuredHelper);
const options = { skip: native ? false : 'requires Windows and explicit UCI_ARENA_NATIVE_HELPER', timeout: 30000 };
const helper = () => new NativeResourceHelper({ nativeHelperAvailable: true, nativeHelper: configuredHelper });
const schema = 'uci_arena_process_instance_query_v1';

test('cold native query returns the exact current instance inside the unchanged 2 s query deadline', options, () => {
  assert.equal(path.isAbsolute(configuredHelper), true);
  const observation = helper().queryProcessInstanceSync(process.pid);
  assert.equal(observation.state, 'present');
  assert.equal(observation.identity.pid, process.pid);
  assert.equal(observation.identity.executable_path.toLowerCase(), fs.realpathSync(process.execPath).toLowerCase());
  assert.equal(typeof observation.identity.start_token, 'string');
  assert.equal(helper().queryProcessInstanceSync(process.pid).identity.start_token, observation.identity.start_token);

  // This slower independent .NET oracle is qualification only, never a runtime fallback.
  const oraclePath = processIdentityTestOraclePath(process.env.UCI_ARENA_PROCESS_IDENTITY_TEST_ORACLE, process.env.SystemRoot);
  const oracle = JSON.parse(execFileSync(oraclePath, ['-NoProfile', '-NonInteractive', '-Command',
    `$p = [System.Diagnostics.Process]::GetProcessById(${process.pid}); try { @{ ticks = $p.StartTime.ToUniversalTime().Ticks.ToString(); executable = $p.MainModule.FileName } | ConvertTo-Json -Compress } finally { $p.Dispose() }`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 262144 }));
  assert.equal(observation.identity.start_token, oracle.ticks);
  assert.equal(observation.identity.executable_path.toLowerCase(), oracle.executable.toLowerCase());
});

test('native capability and strict request admission do not invoke resource policy', options, () => {
  const probe = JSON.parse(execFileSync(configuredHelper, ['--probe'], { encoding: 'utf8', windowsHide: true, timeout: 2000 }));
  assert.ok(probe.capabilities.includes('process_instance_query_v1'));
  for (const pid of ['0', '-1', '1x', '4294967296']) {
    assert.throws(() => execFileSync(configuredHelper, ['--query-process-instance', pid],
      { encoding: 'utf8', windowsHide: true, timeout: 2000 }), (error) => error.status === 2 && error.stdout === '');
  }
});

test('native query observes an owned child and then its absence with bounded cleanup', options, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  exited.catch(() => {}); // Keep a failed spawn owned until the cleanup hook runs.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let timeout;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('owned native-query fixture did not exit within 5 s')), 5000);
        timeout.unref();
      })]);
    } finally { clearTimeout(timeout); }
  });
  await once(child, 'spawn');
  const identity = helper().queryProcessInstanceSync(child.pid);
  assert.equal(identity.state, 'present');
  assert.equal(identity.identity.pid, child.pid);
  child.kill();
  await exited;
  assert.deepEqual(helper().queryProcessInstanceSync(child.pid), { schema, state: 'absent' });
});
