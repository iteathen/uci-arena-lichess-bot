import assert from 'node:assert/strict';
import {lstatSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {UciEngine,loadCapacityProfile} from './lichess-adapter.mjs';

function fixture(t,{move='e2e4',silent=false,exitCode=0}={}){
 const directory=mkdtempSync(path.join(os.tmpdir(),'bot-standard-movetime-'));
 const temporaryRoot=realpathSync(os.tmpdir()),created=lstatSync(directory,{bigint:true});
 t.after(()=>{
  const actualRoot=realpathSync(os.tmpdir()),actualDirectory=realpathSync(directory),current=lstatSync(directory,{bigint:true});
  assert(path.isAbsolute(actualRoot)&&path.isAbsolute(actualDirectory));assert.equal(actualRoot,temporaryRoot);assert.equal(path.dirname(actualDirectory),actualRoot);
  const relative=path.relative(actualRoot,actualDirectory);assert(relative.startsWith('bot-standard-movetime-')&&!relative.includes(path.sep));
  assert(current.isDirectory()&&!current.isSymbolicLink());assert.equal(current.dev,created.dev);assert.equal(current.ino,created.ino);assert.equal(current.birthtimeNs,created.birthtimeNs);
  rmSync(actualDirectory,{recursive:true,force:true});
 });
 const script=path.join(directory,'engine.mjs'),journal=path.join(directory,'commands.jsonl');
 writeFileSync(script,`
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 appendFileSync(${JSON.stringify(journal)},JSON.stringify(line)+'\\n');
 if(line==='uci'){console.log('id name Movetime Contract Fixture');console.log('option name Hash type spin default 16 min 1 max 128');console.log('uciok');}
 else if(line==='isready')console.log('readyok');
 else if(line.startsWith('go depth')||line.startsWith('go nodes')){console.log('info string unsupported search budget');console.log('bestmove 0000');}
 else if(line==='go movetime 500'&&!${silent})console.log('bestmove ${move}');
 else if(line==='quit')process.exit(${exitCode});
}
`);
 const engine=new UciEngine({adapter:'standard_uci_v1',executable:process.execPath,arguments:[script],working_directory:directory,uci_options:{Hash:32},qualification_timeout_ms:100,shutdown_grace_ms:1000,timing:{opponent_turn_search:false}});
 return {engine,commands:()=>readFileSync(journal,'utf8').trim().split('\n').map(JSON.parse)};
}

test('standard startup qualifies a depth-unsupported process through bounded movetime and retains one-slot identity',async t=>{
 const f=fixture(t);try{
  await f.engine.start();const q=f.engine.qualificationStatus;
  assert.equal(q.qualified,true);assert.equal(q.bestmove,'e2e4');assert.equal(q.engine_adapter,'standard_uci_v1');
  assert.match(q.engine_launch_identity_sha256,/^sha256:[a-f0-9]{64}$/);assert.match(q.applied_options_sha256,/^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(q.probe,{kind:'bounded_movetime_legal_move',command:'go movetime 500',position:'startpos',movetime_ms:500,timeout_ms:100});assert.equal(Object.hasOwn(q,'depth'),false);
  const config={engine:f.engine.config,capacity:{total_slots:1}};assert.equal(loadCapacityProfile(null,config,null,q).maximum_concurrency,1);
  const commands=f.commands();assert(commands.indexOf('setoption name Hash value 32')<commands.indexOf('go movetime 500'));assert(commands.indexOf('isready')<commands.indexOf('go movetime 500'));assert(commands.includes('position startpos'));assert.equal(commands.some(c=>c.startsWith('go depth')||c.startsWith('go nodes')),false);
 }finally{const outcome=await f.engine.close({requireCleanExit:true});assert.equal(outcome.clean_exit,true);assert.equal(outcome.exit_code,0);}
});

test('bounded standard startup retains illegal-move and no-response failure gates with actual normal closure',async t=>{
 for(const options of [{move:'e2e5'},{silent:true}]){const f=fixture(t,options);try{await assert.rejects(f.engine.start(),options.silent?/timed out after 100 ms/:/illegal bestmove/);assert.equal(f.engine.qualificationStatus,undefined);}finally{assert.equal((await f.engine.close({requireCleanExit:true})).clean_exit,true);}}
});

test('explicit fixed-depth smoke remains unsupported after successful standard movetime onboarding',async t=>{
 const f=fixture(t);try{await f.engine.start();await assert.rejects(f.engine.fixedDepthProbe(1,1000),/unusable bestmove/);assert(f.commands().includes('go depth 1'));assert.equal(f.engine.qualificationStatus.probe.kind,'bounded_movetime_legal_move');}finally{await f.engine.close({requireCleanExit:true});}
});

test('movetime onboarding cannot turn an abnormal owned process close into clean qualification evidence',async t=>{
 const f=fixture(t,{exitCode:7});try{await f.engine.start();await assert.rejects(f.engine.close({requireCleanExit:true}),error=>error.code==='UCI_CHILD_CLOSE_FAILED'&&error.closeOutcome.exit_code===7&&error.closeOutcome.clean_exit===false);}finally{await f.engine.close();}
});
