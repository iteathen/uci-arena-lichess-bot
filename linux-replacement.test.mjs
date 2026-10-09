import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSystemdUnit, SYSTEMD_UNIT_NAME } from './linux-startup.mjs';

function fixture(enabled = false, active = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-linux-replacement-'));
  const componentRoot = path.join(root, 'old'); const runtimeDir = path.join(root, 'runtime');
  const configPath = path.join(root, 'configuration.json'); const unitPath = path.join(root, 'fixture.service');
  const original = buildSystemdUnit({ componentRoot, config: configPath, runtimeDir,
    tokenFile: path.join(root, 'blind-token-locator'), expectedAccount: 'fixture' });
  writeFileSync(unitPath, original);
  const calls = [];
  const execute = async (_file, args) => {
    calls.push(args.slice(1));
    const op = args[1];
    if (op === 'is-enabled') return { stdout: enabled ? 'enabled\n' : 'disabled\n' };
    if (op === 'is-active') return { stdout: active ? 'active\n' : 'inactive\n' };
    if (op === 'disable') { enabled = false; active = false; return { stdout: '' }; }
    if (op === 'daemon-reload') return { stdout: '' };
    assert.fail('Unadmitted fixture platform operation');
  };
  return { root, componentRoot, runtimeDir, configPath, unitPath, original, calls, execute, platform: 'linux' };
}

test('Linux replacement captures the exact unit and typed root action without platform mutation', async () => {
  const { inspectLinuxReplacement } = await import('./linux-startup.mjs');
  const input = fixture(); const observed = await inspectLinuxReplacement(input);
  assert.equal(observed.definition_text, input.original);
  assert.equal(observed.definition_sha256, createHash('sha256').update(input.original).digest('hex'));
  assert.equal(observed.action.working_directory, input.componentRoot);
  assert.ok(input.calls.every((args) => ['is-active', 'is-enabled'].includes(args[0])));
});

test('missing Linux unit file cannot conceal a cached registered systemd unit', async () => {
  const { inspectLinuxReplacement } = await import('./linux-startup.mjs');
  const input = fixture(); const unitPath = path.join(input.root, 'missing.service');
  for (const state of ['loaded', 'unknown']) {
    await assert.rejects(inspectLinuxReplacement({ ...input, unitPath, execute: async (_file, args) => {
      assert.deepEqual(args, ['--user', 'show', '--property=LoadState', '--value', SYSTEMD_UNIT_NAME]);
      return { stdout: `${state}\n` };
    } }), /absence.*confirmed/i);
  }
  const absent = await inspectLinuxReplacement({ ...input, unitPath, execute: async () => ({ stdout: 'not-found\n' }) });
  assert.equal(absent.registered, false); assert.equal(absent.active, false);
});

test('Linux before-target convergence restores a partially retargeted exact unit', async () => {
  const { inspectLinuxReplacement, retargetSystemdUnit, deriveLinuxReplacementAction, convergeLinuxReplacement } = await import('./linux-startup.mjs');
  const input = fixture(); const before = await inspectLinuxReplacement(input);
  const replacementRoot = path.join(input.root, 'new');
  writeFileSync(input.unitPath, retargetSystemdUnit(input.original, input.componentRoot, replacementRoot));
  const state = { previous_root: input.componentRoot, replacement_root: replacementRoot, before };
  const requestedAction = deriveLinuxReplacementAction({ state, targetRoot: input.componentRoot,
    runtimeDir: input.runtimeDir, configPath: input.configPath });
  const result = await convergeLinuxReplacement({ ...input, state, target: 'before', requestedAction });
  assert.equal(readFileSync(input.unitPath, 'utf8'), input.original);
  assert.deepEqual(result.observation.action, before.action);
  assert.equal(result.observation.enabled, false);
  assert.ok(input.calls.some((args) => args[0] === 'disable'));
});

test('Linux foreign unit changes fail before gate/platform effects or unit overwrite', async () => {
  const { inspectLinuxReplacement, deriveLinuxReplacementAction, convergeLinuxReplacement } = await import('./linux-startup.mjs');
  const input = fixture(); const before = await inspectLinuxReplacement(input);
  const state = { previous_root: input.componentRoot, replacement_root: path.join(input.root, 'new'), before };
  const changed = input.original.replace('RestartSec=60', 'RestartSec=2');
  writeFileSync(input.unitPath, changed); input.calls.length = 0;
  const requestedAction = deriveLinuxReplacementAction({ state, targetRoot: input.componentRoot,
    runtimeDir: input.runtimeDir, configPath: input.configPath });
  await assert.rejects(convergeLinuxReplacement({ ...input, state, target: 'before', requestedAction }));
  assert.equal(readFileSync(input.unitPath, 'utf8'), changed);
  assert.ok(input.calls.every((args) => ['is-active', 'is-enabled'].includes(args[0])));
});

test('real systemctl inactive/disabled exit codes retain exact read authority', async () => {
  const { inspectLinuxReplacement } = await import('./linux-startup.mjs');
  const input = fixture();
  const observed = await inspectLinuxReplacement({ ...input, execute: async (_file, args) => {
    throw Object.assign(new Error('private stderr omitted'), { code: args[1] === 'is-active' ? 3 : 1,
      stdout: args[1] === 'is-active' ? 'inactive\n' : 'disabled\n' });
  } });
  assert.equal(observed.active, false); assert.equal(observed.enabled, false);
});
