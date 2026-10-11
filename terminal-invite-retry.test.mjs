import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BotController} from './lichess-adapter.mjs';
import {LichessStore} from './lichess-store.mjs';

function fixture(t,slots=1) {
  let clock=1_000_000, sequence=0, cooling=false, blocked=false;
  t.mock.method(Date,'now',()=>clock);
  const directory=mkdtempSync(path.join(os.tmpdir(),'bot-terminal-retry-'));
  const store=new LichessStore(path.join(directory,'matches.sqlite'));
  t.after(()=>store.close());
  store.setPaused(false);
  const requests=[];
  const client={isCoolingDown:()=>cooling,isRequestClassBlocked:()=>blocked,
    collectNdjson:async()=>[{id:'first-bot',title:'BOT',perfs:{blitz:{rating:2200}}},{id:'next-bot',title:'BOT',perfs:{blitz:{rating:2200}}}],
    postJson:async(endpoint,_body,_signal,_priority,revalidate)=>{revalidate?.();requests.push(endpoint);return {id:`challenge-${++sequence}`};}};
  const controller=new BotController({client,account:'self',runtimeDir:directory,store,
    signal:new AbortController().signal,now:()=>clock,random:()=>0,
    config:{engine:{adapter:'standard_uci_v1',uci_options:{}},timing:{opponent_turn_search:false},
      outbound_challenge:{rated:false,color:'random',clock_limit:180,clock_increment:0},
      scheduler:{enabled:true,discovery_interval_seconds:60,challenge_interval_seconds:300,
        reservation_retry_seconds:30,challenge_timeout_seconds:25,decline_cooldown_minutes:360,
        max_games_per_opponent_per_day:1,rating_target:2200,rating_spread:600},
      capacity:{total_slots:slots,startup_parallelism:1,human:{slots:0,allow_borrowing:false,accept_public:false},bot:{slots,target_active:slots}}}});
  controller.streamConnected=true;
  controller.writeStatus=async()=>{};
  controller.prepareSlot=async slot=>{controller.slots.attachEngine(slot,{close:async()=>{}},slot.generation);return slot;};
  return {controller,requests,store,setClock:value=>{clock=value;},setCooling:value=>{cooling=value;},setBlocked:value=>{blocked=value;}};
}

for(const type of ['challengeDeclined','challengeCanceled']) {
  test(`${type} allows the next invitation exactly ten seconds after termination`,async t=>{
    const f=fixture(t);
    await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
    f.setClock(1_080_000);
    await f.controller.finishPendingChallenge({type,challenge:{id:'challenge-1'}});
    f.setClock(1_089_999);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
    f.setClock(1_090_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
    if(type==='challengeDeclined')assert.equal(f.requests[1],'api/challenge/next-bot');
  });
}

test('duplicate or unrelated terminal events do not postpone an admitted retry',async t=>{
  const f=fixture(t);await f.controller.schedulerTick(Date.now());
  await f.controller.finishPendingChallenge({type:'challengeDeclined',challenge:{id:'challenge-1'}});
  f.setClock(1_005_000);
  await f.controller.finishPendingChallenge({type:'challengeDeclined',challenge:{id:'challenge-1'}});
  await f.controller.finishPendingChallenge({type:'challengeCanceled',challenge:{id:'unknown'}});
  f.setClock(1_010_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
});

test('terminal retry preserves global and challenge-create cooldown and scheduler pause',async t=>{
  const f=fixture(t);await f.controller.schedulerTick(Date.now());
  await f.controller.finishPendingChallenge({type:'challengeDeclined',challenge:{id:'challenge-1'}});
  f.setClock(1_010_000);f.setCooling(true);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
  f.setCooling(false);f.setBlocked(true);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
  f.setBlocked(false);f.store.setPaused(true);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
  f.store.setPaused(false);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
});

test('a terminal event for an active game does not release capacity or accelerate invitations',async t=>{
  const f=fixture(t);await f.controller.schedulerTick(Date.now());
  const slot=f.controller.slots.findChallenge('challenge-1');
  f.controller.slots.active(slot,'game-1',slot.generation);
  await f.controller.finishPendingChallenge({type:'challengeCanceled',challenge:{id:'challenge-1'}});
  f.setClock(1_010_000);await f.controller.schedulerTick(Date.now());
  assert.equal(slot.state,'active');assert.equal(f.requests.length,1);
});

test('without an owned decline or cancellation the ordinary interval still applies',async t=>{
  const f=fixture(t);await f.controller.schedulerTick(Date.now());
  const slot=f.controller.slots.findChallenge('challenge-1');
  await f.controller.releaseProviderSlot(slot,slot.generation);
  await f.controller.finishPendingChallenge({type:'challengeCanceled',challenge:{id:'unknown'}});
  f.setClock(1_010_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
  f.setClock(1_300_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
});

test('late termination still waits a full ten seconds even after ordinary spacing elapsed',async t=>{
  const f=fixture(t);await f.controller.schedulerTick(Date.now());
  f.setClock(1_350_000);
  await f.controller.finishPendingChallenge({type:'challengeDeclined',challenge:{id:'challenge-1'}});
  f.setClock(1_359_999);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
  f.setClock(1_360_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
});

test('timeout-driven cancellation keeps ordinary spacing',async t=>{
  const f=fixture(t);await f.controller.schedulerTick(Date.now());
  const slot=f.controller.slots.findChallenge('challenge-1');
  f.controller.slots.cancelling(slot,slot.generation);
  await f.controller.finishPendingChallenge({type:'challengeCanceled',challenge:{id:'challenge-1'}});
  f.setClock(1_010_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
  f.setClock(1_300_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
});

test('a used terminal retry does not shorten another ordinary invitation',async t=>{
  const f=fixture(t);await f.controller.schedulerTick(Date.now());
  await f.controller.finishPendingChallenge({type:'challengeDeclined',challenge:{id:'challenge-1'}});
  f.setClock(1_010_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
  const slot=f.controller.slots.findChallenge('challenge-2');
  await f.controller.releaseProviderSlot(slot,slot.generation);
  f.setClock(1_020_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
  f.setClock(1_310_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,3);
});

test('terminal observation gates other slots immediately and until cleanup completes',async t=>{
  const f=fixture(t,2);await f.controller.schedulerTick(Date.now());
  const slot=f.controller.slots.findChallenge('challenge-1');
  let completeCleanup;slot.engine.close=()=>new Promise(resolve=>{completeCleanup=resolve;});
  f.setClock(1_350_000);
  const finishing=f.controller.finishPendingChallenge({type:'challengeDeclined',challenge:{id:'challenge-1'}});
  try {
    await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
    f.setClock(1_360_000);await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,1);
  } finally {completeCleanup();await finishing;}
  await f.controller.schedulerTick(Date.now());assert.equal(f.requests.length,2);
});
test('ordinary spacing starts at actual dispatch after a consumed terminal retry',async t=>{
 const f=fixture(t);await f.controller.schedulerTick(Date.now());
 await f.controller.finishPendingChallenge({type:'challengeDeclined',challenge:{id:'challenge-1'}});
 let enteredQueue,dispatch;const queued=new Promise(resolve=>{enteredQueue=resolve;});
 const post=f.controller.client.postJson;
 f.controller.client.postJson=async(endpoint,body,signal,priority,revalidate)=>{
  enteredQueue();await new Promise(resolve=>{dispatch=resolve;});return post(endpoint,body,signal,priority,revalidate);
 };
 f.setClock(1_010_000);const scheduling=f.controller.schedulerTick(Date.now());await queued;
 f.setClock(1_050_000);dispatch();await scheduling;assert.equal(f.requests.length,2);
 f.controller.client.postJson=post;
 const slot=f.controller.slots.findChallenge('challenge-2');await f.controller.releaseProviderSlot(slot,slot.generation);
 f.setClock(1_310_000);await f.controller.schedulerTick(Date.now());
 assert.equal(f.requests.length,2,'ordinary 300-second spacing must begin at actual dispatch, not queue admission');
});
