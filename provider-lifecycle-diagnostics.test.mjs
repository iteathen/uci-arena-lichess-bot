import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { providerLifecycleResult } from './lichess-adapter.mjs';

for (const [action, operation] of [['install', 'install'], ['uninstall', 'uninstall'],
  ['prepare_replace', 'pre_replace'], ['complete_replace', 'post_replace']]) {
  test(`typed startup ${action} fatal emits one safe failed frame`, () => {
    // Preloaded platform boundary refuses all real platform/process operations.
    const child = spawnSync(process.execPath, ['--import', './test-fixtures/failed-startup-platform.mjs',
      'lichess-adapter.mjs', 'startup', action,
      '--lifecycle-result', 'typed_v1', '--invalid-secret-marker', 'DO_NOT_EXPOSE_SENTINEL'],
    { cwd: import.meta.dirname, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    const result = JSON.parse(child.stdout);
    assert.equal(result.operation, operation);
    assert.equal(result.disposition, 'failed');
    assert.deepEqual(Object.values(result.observed), ['unknown', 'unknown', 'unknown', 'unknown']);
    assert.ok(result.reason.id.startsWith('startup.'));
    assert.ok(['STARTUP_OPERATION_FAILED', 'EPERM'].includes(JSON.parse(result.reason.message).code));
    assert.ok(Buffer.byteLength(result.reason.message) <= 512);
    assert.ok(!child.stdout.includes('DO_NOT_EXPOSE_SENTINEL'));
  });
}

test('startup diagnostics retain only allowlisted code and hash-verified inventoried source', async (t) => {
  const { startupFailureDiagnostic } = await import('./provider-lifecycle-diagnostics.mjs');
  const temporaryRoot = realpathSync(os.tmpdir());
  const root = mkdtempSync(path.join(temporaryRoot, 'bot-lifecycle-diagnostic-'));
  const initial = lstatSync(root, { bigint: true });
  t.after(() => {
    const current = lstatSync(root, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.ino, initial.ino);
    assert.equal(current.dev, initial.dev);
    assert.equal(current.birthtimeNs, initial.birthtimeNs);
    assert.equal(realpathSync(root), root);
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith('bot-lifecycle-diagnostic-'));
    rmSync(root, { recursive: true });
  });
  const source = 'export const fixture = true;\n';
  writeFileSync(path.join(root, 'owner.mjs'), source);
  const sha256 = createHash('sha256').update(source).digest('hex');
  writeFileSync(path.join(root, 'arena-component.json'), JSON.stringify({ files: [
    { path: 'owner.mjs', size_bytes: Buffer.byteLength(source), sha256 },
  ] }));
  const error = new Error('DO_NOT_EXPOSE_PRIVATE_MESSAGE');
  error.code = 'LICHESS_STORAGE_PRAGMA_REFUSED';
  error.stack = `Error: DO_NOT_EXPOSE_PRIVATE_MESSAGE\n    at owner (${pathToFileURL(path.join(root, 'owner.mjs'))}:1:2)`;
  assert.deepEqual(startupFailureDiagnostic(error, root), {
    id: 'startup.storage_failed', message: JSON.stringify({ code: error.code,
      source: { path: 'owner.mjs', line: 1, column: 2, sha256 } }),
  });
  const capturedStack = error.stack;
  let stackReads = 0;
  Object.defineProperty(error, 'stack', { configurable: true, get() {
    stackReads++;
    return stackReads === 1 ? capturedStack : 'DO_NOT_EXPOSE_CHANGED_STACK';
  } });
  assert.equal(JSON.parse(startupFailureDiagnostic(error, root).message).source.sha256, sha256);
  assert.equal(stackReads, 1);
  Object.defineProperty(error, 'stack', { configurable: true, writable: true, value: capturedStack });
  error.code = 'DO_NOT_EXPOSE_PRIVATE_CODE';
  writeFileSync(path.join(root, 'owner.mjs'), source + '// drift\n');
  assert.deepEqual(startupFailureDiagnostic(error, root), {
    id: 'startup.operation_failed', message: '{"code":"STARTUP_OPERATION_FAILED"}',
  });
  error.stack = 'Error: secret\n    at owner (file:///outside/private.mjs:1:2)';
  assert.ok(!startupFailureDiagnostic(error, root).message.includes('private'));
});

test('only the four exact typed startup operations select failed-frame transport', async () => {
  const { typedStartupOperation } = await import('./provider-lifecycle-diagnostics.mjs');
  for (const argv of [['startup', '__proto__', '--lifecycle-result', 'typed_v1'],
    ['startup', 'status', '--lifecycle-result', 'typed_v1'],
    ['run', 'install', '--lifecycle-result', 'typed_v1'], ['startup', 'install'],
    ['startup', 'install', '--lifecycle-result', 'typed_v1', '--lifecycle-result', 'typed_v1']]) {
    assert.equal(typedStartupOperation(argv), null);
  }
});

test('failed lifecycle frame enforces the public bounded reason contract', () => {
  for (const reason of [null, { id: 'x'.repeat(65), message: '' },
    { id: 'failed', message: '\nprivate' }, { id: 'failed', message: 'é'.repeat(257) }]) {
    assert.throws(() => providerLifecycleResult('pre_replace', 'failed', reason), /reason is invalid/);
  }
  const result = providerLifecycleResult('pre_replace', 'failed',
    { id: 'startup.operation_failed', message: '{"code":"STARTUP_OPERATION_FAILED"}' });
  assert.equal(result.disposition, 'failed');
});

test('changing or throwing exception getters cannot bypass the code allowlist', async () => {
  const { startupFailureDiagnostic } = await import('./provider-lifecycle-diagnostics.mjs');
  let reads = 0;
  const error = Object.defineProperty(new Error('private message'), 'code', { configurable: true,
    get() { return ++reads < 3 ? 'ENOENT' : 'CANARY_GETTER_PRIVATE_TOKEN'; } });
  const result = startupFailureDiagnostic(error, import.meta.dirname);
  assert.deepEqual(result, { id: 'startup.platform_failed', message: '{"code":"ENOENT"}' });
  assert.equal(reads, 1);
  Object.defineProperty(error, 'code', { get() { throw new Error('CANARY_THROWING_PRIVATE_TOKEN'); } });
  assert.deepEqual(startupFailureDiagnostic(error, import.meta.dirname), {
    id: 'startup.operation_failed', message: '{"code":"STARTUP_OPERATION_FAILED"}',
  });
});
