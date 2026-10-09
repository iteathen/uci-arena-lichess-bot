import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
import { NativeResourceHelper } from '@uci-arena/background-service-runtime/native-resource-helper';

// This subprocess fixture forbids platform mutations and models only an absent task.
childProcess.execFile = (file, args, options, callback) => {
  if (file !== "schtasks.exe" || args[0] !== "/Query") {
    throw new Error(`Forbidden platform operation in absent-startup fixture: ${file}`);
  }
  if (process.env.UCI_ARENA_FIXTURE_TASK_STATE) {
    const active = process.env.UCI_ARENA_FIXTURE_TASK_STATE === "active";
    callback(null, `Status: ${active ? "Running" : "Ready"}\nScheduled Task State: ${active ? "Enabled" : "Disabled"}\nLast Result: 0\n`, "");
    return;
  }
  const error = Object.assign(new Error("The system cannot find the file specified"), {
    code: 1, stderr: "ERROR: The system cannot find the file specified.",
  });
  callback(error, "", error.stderr);
};
childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] = (file, args, options) =>
  new Promise((resolve, reject) => childProcess.execFile(file, args, options,
    (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
syncBuiltinESMExports();
const blocked = () => { throw new Error('FORBIDDEN_PLATFORM_EFFECT'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) childProcess[name] = blocked;
syncBuiltinESMExports();
const published = await import('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) {
  assert.equal(published[name], blocked); assert.throws(() => published[name]('fixture-proof'), /FORBIDDEN_PLATFORM_EFFECT/);
}
const runtimeFlag = process.argv.indexOf('--runtime-dir');
const fixtureRuntime = runtimeFlag >= 0 ? path.resolve(process.argv[runtimeFlag + 1]) : null;
const holdFile = process.env.UCI_ARENA_FIXTURE_HOLD_FILE;
const presenceFile = process.env.UCI_ARENA_FIXTURE_PRESENCE_FILE;
if (holdFile) assert.equal(path.resolve(holdFile), path.join(fixtureRuntime, 'fixture-controller-held.json'));
if (presenceFile) assert.equal(path.resolve(presenceFile), path.join(fixtureRuntime, 'fixture-controller-presence.json'));
let inspections = 0;
WindowsTaskScheduler.prototype.perform = async (request) => {
  assert.equal(request.operation, 'inspect'); assert.equal(request.task_path, '\\UCI Arena Lichess Adapter');
  if (process.env.UCI_ARENA_FIXTURE_TASK_STATE) throw new Error('FOREIGN_FIXTURE_REGISTRATION');
  if (holdFile && process.argv[3] === 'prepare_replace' && ++inspections === 2) {
    writeFileSync(holdFile, JSON.stringify({ pid: process.pid, held: true }));
    for (let attempt = 0; attempt < 500 && !existsSync(`${holdFile}.release`); attempt += 1) await wait(10);
    assert.equal(existsSync(`${holdFile}.release`), true, 'Owned controller fixture must be released');
  }
  return { outcome: 'completed', observation: { registered: false, enabled: null, definition_xml: null,
    definition_sha256: null, instance_guids: [], principal: null, action: null } };
};
NativeResourceHelper.prototype.queryProcessInstanceSync = (pid) => {
  const mode = pid === process.pid ? 'present' : presenceFile && existsSync(presenceFile)
    ? JSON.parse(readFileSync(presenceFile, 'utf8'))[pid] : 'absent';
  if (mode === 'unverifiable') return { schema: 'uci_arena_process_instance_query_v1', state: 'unverifiable' };
  return mode === 'present' || mode === 'reused'
  ? { schema: 'uci_arena_process_instance_query_v1', state: 'present', identity: {
    schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid,
    start_token: mode === 'reused' ? '504911232000000002' : '504911232000000001', executable_path: process.execPath, boot_id: '',
  } } : { schema: 'uci_arena_process_instance_query_v1', state: 'absent' };
};
