import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, lstatSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { WindowsTaskScheduler } from '@uci-arena/background-service-runtime/windows-task-scheduler';
import { NativeResourceHelper } from '@uci-arena/background-service-runtime/native-resource-helper';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const parent = realpathSync(os.tmpdir());
  const prefix = `arena-hidden-sdk-${randomUUID()}-`;
  const root = realpathSync(mkdtempSync(path.join(parent, prefix)));
  const initial = lstatSync(root);
  return { root, close() {
    const current = lstatSync(root);
    const resolved = realpathSync(root);
    assert.ok(path.isAbsolute(resolved));
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith(prefix));
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, initial.dev); assert.equal(current.ino, initial.ino);
    rmSync(resolved, { recursive: true, maxRetries: 20, retryDelay: 50 });
  } };
}

// Exercise the actual static helper function with a fake COM collection; no
// thousands of real tasks are created merely to test the enumeration bound.
test('actual enumeration function bounds before reads, filters foreign metadata and validates selected GUIDs', {
  skip: process.platform !== 'win32',
}, () => {
  const owned = fixture();
  try {
    const helper = readFileSync(new URL('../src/windows-task-scheduler.ps1', import.meta.url), 'utf8');
    const functionSource = helper.slice(helper.indexOf('function Instances($task)'), helper.indexOf('function Observe($task)'));
    const contractPath = fileURLToPath(new URL('../src/windows-task-scheduler-contract.json', import.meta.url));
    const script = path.join(owned.root, 'bound.ps1');
    writeFileSync(script, `$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$contract=Get-Content -LiteralPath $args[0] -Raw|ConvertFrom-Json
function Fail([string]$category){throw $category}
${functionSource}
$collection=[pscustomobject]@{Count=4097}
$collection|Add-Member ScriptMethod Item {param($index) throw 'CANARY_ITEM_READ'}
$service=[pscustomobject]@{}
$service|Add-Member ScriptMethod GetRunningTasks {param($flags) if($flags-ne 1){throw 'wrong_flags'};return $collection}
$task=[pscustomobject]@{Path='\\Owned';Definition=$null}
$task|Add-Member ScriptMethod GetInstances {param($flags) return [pscustomobject]@{Count=0}}
$request=[pscustomobject]@{task_path='\\Owned'}
$results=@()
try {$null=Instances $task;$results+='absence'}catch{$results+=$_.Exception.Message}
$foreign=[pscustomobject]@{Path='\\FOREIGN_CANARY'}
$foreign|Add-Member ScriptProperty InstanceGuid {throw 'CANARY_FOREIGN_GUID_READ'}
$selected=[pscustomobject]@{Path='\\oWnEd';InstanceGuid='{00112233-4455-6677-8899-AABBCCDDEEFF}'}
$items=@($foreign,$selected)
$collection=[pscustomobject]@{Count=2}
$collection|Add-Member ScriptMethod Item {param($index) return $items[$index-1]}
$found=Instances $task
$results+=@($found|ForEach-Object{$_.id})
$items=@($selected,$selected)
try {$null=Instances $task;$results+='duplicate_accepted'}catch{$results+=$_.Exception.Message}
$items=@([pscustomobject]@{Path='\\Owned';InstanceGuid=[guid]::Empty})
$collection.Count=1
try {$null=Instances $task;$results+='empty_accepted'}catch{$results+=$_.Exception.Message}
$items=@(1..17|ForEach-Object{[pscustomobject]@{Path='\\Owned';InstanceGuid=([guid]::NewGuid()).ToString('B')}})
$collection.Count=17
try {$null=Instances $task;$results+='over_capacity_accepted'}catch{$results+=$_.Exception.Message}
[Console]::Out.Write(($results|ConvertTo-Json -Compress))
`);
    const output = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, contractPath],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.deepEqual(JSON.parse(output), ['output_limit', '{00112233-4455-6677-8899-AABBCCDDEEFF}',
      'instance_mismatch', 'instance_mismatch', 'output_limit']);
  } finally { owned.close(); }
});

test('two owned Hidden tasks expose only their own GUIDs and reject the other task stop set', {
  skip: process.platform !== 'win32' || process.env.UCI_ARENA_TASK_SCHEDULER_FIXTURE !== '1' ||
    !process.env.UCI_ARENA_NATIVE_HELPER,
  timeout: 90000,
}, async () => {
  const owned = fixture();
  const scheduler = new WindowsTaskScheduler();
  const native = new NativeResourceHelper({ nativeHelperAvailable: true,
    nativeHelper: process.env.UCI_ARENA_NATIVE_HELPER });
  const sid = /"[^"]+","(S-\d(?:-\d+)+)"/u.exec(execFileSync(
    path.join(process.env.SystemRoot, 'System32/whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true }))?.[1];
  assert.ok(sid);
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const expected = observation => ({ expected_definition_xml: observation.definition_xml,
    expected_xml_sha256: observation.definition_sha256 });
  const entries = [0, 1].map(index => {
    const task_path = `\\UCI Arena SDK Hidden Fixture ${randomUUID()}`;
    const script = path.join(owned.root, `child-${index}.mjs`);
    const marker = path.join(owned.root, `pid-${index}.json`);
    writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),25000);`);
    const action = { command: process.execPath, arguments: '"' + script + '"', working_directory: owned.root };
    const xml = `<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><URI>${escape(task_path)}</URI></RegistrationInfo><Principals><Principal id="Owner"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Enabled>true</Enabled><Hidden>true</Hidden><UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Owner"><Exec><Command>${escape(action.command)}</Command><Arguments>${escape(action.arguments)}</Arguments><WorkingDirectory>${escape(action.working_directory)}</WorkingDirectory></Exec></Actions></Task>`;
    return { task_path, marker, action, xml, owns: false, identity: null };
  });
  const call = async (entry, operation, observation, extra = {}) => scheduler.perform({
    operation, task_path: entry.task_path, ...(operation === 'inspect' ? {} : expected(observation)), ...extra });
  const successful = result => { assert.equal(result.outcome, 'completed', JSON.stringify(result)); return result.observation; };
  const sameLive = entry => {
    const result = native.queryProcessInstanceSync(entry.identity.pid);
    assert.equal(result.state, 'present'); assert.equal(result.identity.start_token, entry.identity.start_token);
  };
  try {
    for (const entry of entries) {
      assert.equal(successful(await call(entry, 'inspect')).registered, false);
      entry.owns = true;
      let observation = successful(await scheduler.perform({ operation: 'register', task_path: entry.task_path,
        expected_definition_xml: null, expected_xml_sha256: null, definition_xml: entry.xml }));
      assert.deepEqual(observation.action, entry.action);
      observation = successful(await call(entry, 'run', observation));
      const due = Date.now() + 5000;
      while (!existsSync(entry.marker) && Date.now() < due) await pause(25);
      entry.identity = native.queryProcessInstanceSync(JSON.parse(readFileSync(entry.marker)).pid).identity;
      assert.ok(entry.identity);
      assert.equal(observation.instance_guids.length, 1, 'Hidden run must expose its exact running instance');
    }
    const first = successful(await call(entries[0], 'inspect'));
    const second = successful(await call(entries[1], 'inspect'));
    assert.equal(first.instance_guids.length, 1); assert.equal(second.instance_guids.length, 1);
    assert.notEqual(first.instance_guids[0], second.instance_guids[0]);
    const rejected = await call(entries[0], 'stop_instances', first, { instance_guids: second.instance_guids });
    assert.equal(rejected.outcome, 'failed'); assert.equal(rejected.failure.category, 'instance_mismatch');
    entries.forEach(sameLive);
    const stopped = successful(await call(entries[0], 'stop_instances', first, { instance_guids: first.instance_guids }));
    assert.deepEqual(stopped.instance_guids, []);
    sameLive(entries[1]);
    assert.deepEqual(successful(await call(entries[1], 'inspect')).instance_guids, second.instance_guids);
    console.log(JSON.stringify({ schema: 'sdk_owned_hidden_task_isolation_v1', hiddenTasks: 2,
      exactGuidCounts: [1, 1], foreignGuidStop: 'rejected', otherChildAfterStop: 'same-incarnation-present' }));
  } finally {
    // Self-expiry provides independent cleanup even against the deliberately
    // failing historical helper; no PID-based termination is inferred.
    for (const entry of entries) {
      if (!entry.owns) continue;
      let current = successful(await call(entry, 'inspect'));
      if (!current.registered) continue;
      assert.deepEqual(current.action, entry.action, 'cleanup refuses a substituted action');
      current = successful(await call(entry, 'set_enabled', current, { enabled: false }));
      if (!entry.identity && existsSync(entry.marker)) {
        const result = native.queryProcessInstanceSync(JSON.parse(readFileSync(entry.marker)).pid);
        if (result.state === 'present') entry.identity = result.identity;
        else assert.equal(result.state, 'absent');
      }
      if (current.instance_guids.length) current = successful(await call(entry, 'stop_instances', current,
        { instance_guids: current.instance_guids }));
      if (entry.identity) {
        const due = Date.now() + 30000;
        let result;
        do {
          result = native.queryProcessInstanceSync(entry.identity.pid);
          if (result.state === 'absent' || result.state === 'present' && result.identity.start_token !== entry.identity.start_token) break;
          await pause(50);
        } while (Date.now() < due);
        assert.ok(result.state === 'absent' || result.state === 'present' && result.identity.start_token !== entry.identity.start_token,
          'exact owned child must be joined before deleting fixture files');
      }
      current = successful(await call(entry, 'inspect'));
      assert.deepEqual(current.instance_guids, []);
      assert.equal(successful(await call(entry, 'delete', current)).registered, false);
    }
    owned.close();
  }
});
