import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';

// This fixture never invokes the OS or opens provider configuration/storage.
const fail = () => Object.assign(new Error('DO_NOT_EXPOSE_SENTINEL'), { code: 'EPERM' });
childProcess.execFile = (file, args, options, callback) => callback(fail(), '', '');
childProcess.execFile[Symbol.for('nodejs.util.promisify.custom')] = async () => { throw fail(); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw fail(); };
}
syncBuiltinESMExports();
// The child must prove interception before production main is imported.
const published = await import('node:child_process');
assert.equal(published.execFile, childProcess.execFile);
await assert.rejects(childProcess.execFile[Symbol.for('nodejs.util.promisify.custom')](),
  /DO_NOT_EXPOSE_SENTINEL/);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) {
  assert.equal(published[name], childProcess[name]);
  assert.throws(() => published[name]('FORBIDDEN_FIXTURE_PROOF', []), /DO_NOT_EXPOSE_SENTINEL/);
}
