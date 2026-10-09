import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { NativeResourceHelper } from '@uci-arena/background-service-runtime/native-resource-helper';
import { LichessStore } from '../lichess-store.mjs';

// Protocol fixture only: no platform mutation, native program or external API.
Object.defineProperty(process, 'platform', { value: 'win32' });
const blocked = () => { throw new Error('FORBIDDEN_PROCESS_OR_ENGINE'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) childProcess[name] = blocked;
childProcess.execFile = (file, args, options, callback) => {
  assert.equal(file, 'schtasks.exe'); assert.equal(args[0], '/Query');
  callback(Object.assign(new Error('The system cannot find the file specified'), { code: 1,
    stderr: 'ERROR: The system cannot find the file specified.' }), '', '');
};
childProcess.execFile[Symbol.for('nodejs.util.promisify.custom')] = (file, args, options) =>
  new Promise((resolve, reject) => childProcess.execFile(file, args, options,
    (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
syncBuiltinESMExports();
const published = await import('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) {
  assert.equal(published[name], blocked);
  assert.throws(() => published[name]('proof-only'), /FORBIDDEN_PROCESS_OR_ENGINE/);
}
NativeResourceHelper.prototype.queryProcessInstanceSync = (pid) => pid === process.pid
  ? { schema: 'uci_arena_process_instance_query_v1', state: 'present', identity: {
    schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid,
    start_token: String(504911232000000000n + BigInt(pid)),
    executable_path: 'C:\\fixture\\node.exe', boot_id: '',
  } } : { schema: 'uci_arena_process_instance_query_v1', state: 'absent' };
if (process.env.BOT_MAINTENANCE_FIXTURE_CLOSE_FAILURE === '1') {
  const close = LichessStore.prototype.close;
  LichessStore.prototype.close = function () { close.call(this); throw new Error('PRIVATE_CLOSE_FAILURE'); };
}
if (process.env.BOT_MAINTENANCE_FIXTURE_RELEASE_FAILURE === '1') {
  LichessStore.prototype.releaseApiLease = () => { throw new Error('PRIVATE_LEASE_FAILURE'); };
}
globalThis.fetch = async (url, options) => {
  assert.equal(url.origin, 'http://127.0.0.1:1');
  assert.equal(options.method, 'GET');
  const body = url.pathname === '/api/account' ? { username: 'fixture', title: 'BOT' }
    : url.pathname === '/api/challenge' ? { in: [], out: process.env.BOT_MAINTENANCE_FIXTURE_RELEASE_FAILURE === '1' ? [{}] : [] }
      : url.pathname === '/api/account/playing' ? { nowPlaying: [], nbMyTurn: 0 } : null;
  assert.ok(body, 'undeclared API endpoint');
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};
