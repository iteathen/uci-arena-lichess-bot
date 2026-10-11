import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { LichessStore } from './lichess-store.mjs';
import { parseProviderHistoricalGame } from './provider-games.mjs';
import { restoreOfflineWorkspace } from './offline-workspace-restore.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const authority = 'https://127.0.0.1|fixture';
// The CLI fixture models Windows Task Scheduler and the packaged Windows probe.
// The producer storage/race tests below run on every supported platform.
const cliTest = process.platform === 'win32' ? test : test.skip;
const identity = { schema: 'uci_arena_process_instance_identity_v1', platform: 'win32', pid: 4242,
  start_token: '504911232000000001', executable_path: process.execPath, boot_id: '' };
function fixture(t) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'bot-offline-restore-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = path.join(folder, 'source'), target = path.join(folder, 'target');
  mkdirSync(source); mkdirSync(target);
  const file = path.join(source, 'matches.sqlite'), store = new LichessStore(file), now = Date.now();
  store.acquireApiLease(authority, 'old-owner', identity.pid, now, 60000, () => ({ state: 'absent' }), identity);
  store.claimProviderLifecycle('old-owner', now);
  store.beginGame({ id: 'preserved-game', opponent: 'fixture', audience: 'bot', color: 'white', initialFen: 'startpos',
    providerComponent: { componentId: 'lichess.adapter', version: '1.0.44', manifestSha256: `sha256:${'b'.repeat(64)}` },
    variant: 'standard', startedAt: now - 10000, runtimeProvenance: { schema: 'uci_arena_game_runtime_provenance_v1',
      engine: { adapter: 'standard_uci_v1', executable_path: 'C:/historical/unchanged.exe' } },
    runtimeProvenanceSha256: `sha256:${'a'.repeat(64)}` });
  store.reconcileGameLine(parseProviderHistoricalGame({ id: 'preserved-game', moves: 'e4 e5', status: 'resign',
    winner: 'black', lastMoveAt: now - 1000 }));
  store.finishGame({ id: 'preserved-game', status: 'resign', result: 'loss', winner: 'black', plies: 2, finishedAt: now - 1000 });
  store.saveApiSafetyState(authority, { cooldownUntil: now + 60000, strikeCount: 2, last429At: now,
    lastRetryAfterMs: 60000, challengeBlockedUntil: now + 120000, challengeStrikeCount: 1,
    challengeLast429At: now, challengeRecoveredAt: 0, challengeHalfOpen: true }, now);
  store.recordChallenge({ id: 'pending-remote', opponent: 'fixture', audience: 'bot', direction: 'outbound', status: 'pending' }, now);
  store.replaceOnlineBots([{ username: 'fixture', title: 'BOT', perfs: { blitz: { rating: 2000 } } }], now);
  store.setOpponentCooldown('fixture', 30, now);
  store.addOwner('do-not-restore-owner', now); store.reserve('do-not-restore-owner', 1, 30, now);
  return { folder, source, target, file, store, now };
}
function invoke(source, target, extra = [], env = {}) {
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'test-fixtures/absent-startup-platform.mjs')).href,
    path.join(root, 'lichess-adapter.mjs'), 'workspace', 'restore', '--source-workspace', source, '--runtime-dir', target, ...extra],
  { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env } });
  return { exit: child.status, result: JSON.parse(child.stdout), stderr: child.stderr };
}
cliTest('offline restore preserves archive and durable safety while excluding old runtime authority', t => {
  const { source, target, file, store, now } = fixture(t);
  const game = store.getProviderGame('preserved-game'), safety = store.apiSafetyState(authority);
  // This owned fixture-only oracle checks opaque JSON bytes, including original path spelling.
  const raw = store.db.prepare('SELECT runtime_provenance_json FROM games WHERE game_id=?').get('preserved-game');
  store.close(); const before = hash(readFileSync(file));
  for (const filename of ['startup-task.json','startup-replacement-intent.json','launcher-exit.json','runtime.json']) writeFileSync(path.join(source,filename),'{}');
  const called = invoke(source, target);
  assert.equal(called.result.schema, 'uci_arena_lichess_workspace_restore_v1');
  assert.equal(called.exit, 0, JSON.stringify(called)); assert.equal(called.result.status, 'restored');
  assert.equal(hash(readFileSync(file)), before);
  for (const filename of ['startup-task.json','startup-replacement-intent.json','launcher-exit.json','runtime.json']) assert.equal(existsSync(path.join(target,filename)),false);
  const restored = new LichessStore(path.join(target, 'matches.sqlite'));
  try {
    assert.deepEqual(restored.getProviderGame('preserved-game'), game);
    assert.deepEqual(restored.db.prepare('SELECT runtime_provenance_json FROM games WHERE game_id=?').get('preserved-game'), raw);
    assert.deepEqual(restored.apiSafetyState(authority), safety);
    assert.equal(restored.maintenanceWorkAmbiguous(authority), true);
    assert.equal(restored.listApiLeaseRows().length, 0); assert.equal(restored.providerLifecycleSnapshot().owned, false);
    assert.equal(restored.providerLifecycleSnapshot().activeWork, 0); assert.equal(restored.control().paused, true);
    assert.deepEqual(restored.listOwners(), []); assert.equal(restored.getReservation(now), null);
    assert.equal(restored.eligibleBots({ self: 'self', now }).length, 0);
  } finally { restored.close(); }
});
cliTest('existing destination is never overwritten', t => {
  const { source, target, store } = fixture(t); store.close();
  const sentinel = path.join(target, 'matches.sqlite'); writeFileSync(sentinel, 'untouched');
  const called = invoke(source, target); assert.equal(called.result.status, 'deferred');
  assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
});
cliTest('active source work cannot be reset by offline restoration', t => {
  const { source, target, store } = fixture(t); store.beginProviderWork('old-owner'); store.close();
  const called = invoke(source, target); assert.equal(called.result.status, 'deferred');
  assert.equal(called.result.reason, 'source_not_quiescent'); assert.equal(existsSync(path.join(target, 'matches.sqlite')), false);
});
cliTest('a live or unverifiable old process defers rather than transferring authority', t => {
  const { source, target, store } = fixture(t); store.close();
  const presence = path.join(target, 'fixture-controller-presence.json'); writeFileSync(presence, JSON.stringify({ 4242: 'present' }));
  const called = invoke(source, target, [], { UCI_ARENA_FIXTURE_PRESENCE_FILE: presence });
  assert.equal(called.result.status, 'deferred'); assert.equal(called.result.reason, 'source_process_unverifiable');
  assert.equal(existsSync(path.join(target, 'matches.sqlite')), false);
});
cliTest('absent source creates no storage or success-shaped result', t => {
  const { folder, target, store } = fixture(t); store.close();
  const source = path.join(folder, 'missing'); const called = invoke(source, target);
  assert.equal(called.result.status, 'deferred'); assert.equal(existsSync(source), false);
  assert.equal(existsSync(path.join(target, 'matches.sqlite')), false);
});
cliTest('PID reuse admits exact abandoned ownership while an unverifiable observation defers', t => {
  for (const mode of ['reused', 'unverifiable']) {
    const { source, target, store } = fixture(t); store.close();
    const presence = path.join(target,'fixture-controller-presence.json'); writeFileSync(presence, JSON.stringify({ 4242: mode }));
    const called = invoke(source,target,[],{UCI_ARENA_FIXTURE_PRESENCE_FILE:presence});
    assert.equal(called.result.status,mode === 'reused' ? 'restored' : 'deferred');
    assert.equal(existsSync(path.join(target,'matches.sqlite')),mode === 'reused');
  }
});
cliTest('missing prior lease needs retained exact provider identity rather than lease expiry assumptions', t => {
  for (const retained of [false,true]) {
    const { source,target,store } = fixture(t); store.releaseApiLease(authority,'old-owner'); store.close();
    if (retained) writeFileSync(path.join(source,'runtime.json'),JSON.stringify({schema:'uci_arena_lichess_runtime_v3',adapter_id:'lichess_node_adapter_v2',pid:identity.pid,process_instance:identity}));
    const called=invoke(source,target); assert.equal(called.result.status,retained ? 'restored' : 'deferred');
    assert.equal(existsSync(path.join(target,'runtime.json')),false);
  }
});
test('durable safety change after snapshot rejects publication and removes private staging', async t => {
  const { source,target,store,now }=fixture(t); store.close(); let calls=0;
  const result=await restoreOfflineWorkspace({sourceWorkspace:source,destinationWorkspace:target,
    ownerProcessProbe:()=>({state:'absent'}),observeStartup:async()=>{
      if (++calls===2) {const changed=new LichessStore(path.join(source,'matches.sqlite'));try{
        changed.saveApiSafetyState(authority,{...changed.apiSafetyState(authority),cooldownUntil:now+999999},now+1);
      }finally{changed.close();}}
      return {installed:false};
    }});
  assert.equal(result.status,'deferred');assert.equal(result.reason,'source_changed');
  assert.equal(existsSync(path.join(target,'matches.sqlite')),false);
});
test('destination publication race preserves the newly observed foreign file', async t=>{
  const {source,target,store}=fixture(t);store.close();let calls=0;
  const result=await restoreOfflineWorkspace({sourceWorkspace:source,destinationWorkspace:target,
    ownerProcessProbe:()=>({state:'absent'}),observeStartup:async()=>{
      if(++calls===2)writeFileSync(path.join(target,'matches.sqlite'),'foreign file');return {installed:false};
    }});
  assert.equal(result.status,'deferred');assert.equal(result.reason,'destination_exists');
  assert.equal(readFileSync(path.join(target,'matches.sqlite'),'utf8'),'foreign file');
});
test('startup becoming active after snapshot cannot publish a restored workspace',async t=>{
  const {source,target,store}=fixture(t);store.close();let calls=0;
  const result=await restoreOfflineWorkspace({sourceWorkspace:source,destinationWorkspace:target,
    ownerProcessProbe:()=>({state:'absent'}),observeStartup:async()=>++calls===1?{installed:false}:{installed:true,active:true,enabled:true}});
  assert.equal(result.reason,'startup_not_quiescent');assert.equal(existsSync(path.join(target,'matches.sqlite')),false);
});
cliTest('closed restore grammar rejects unsupported and duplicate inputs without raw diagnostics',t=>{
  const {source,target,store}=fixture(t);store.close();
  for(const flags of [['--source-workspace',source],['--token-file','PRIVATE_VALUE'],['--maximum-milliseconds','0']]) {
    const called=invoke(source,target,flags);assert.notEqual(called.exit,0);assert.equal(called.stderr,'');
    assert.equal(existsSync(path.join(target,'matches.sqlite')),false);assert.equal(JSON.stringify(called.result).includes('PRIVATE_VALUE'),false);
  }
});
test('a nested workspace destination cannot acquire a parallel persistence authority',async t=>{
  const {source,store}=fixture(t);store.close();const target=path.join(source,'nested');mkdirSync(target);
  const result=await restoreOfflineWorkspace({sourceWorkspace:source,destinationWorkspace:target,
    observeStartup:async()=>({installed:false}),ownerProcessProbe:()=>({state:'absent'})});
  assert.equal(result.reason,'invalid_request');assert.equal(existsSync(path.join(target,'matches.sqlite')),false);
});
