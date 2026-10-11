import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UciEngine, GameSession, BotController } from './lichess-adapter.mjs';
import { LichessStore } from './lichess-store.mjs';

function clockEngine(t, initial = 0, advertised = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-clock-input-'));
  const program = path.join(root, 'uci.mjs'), transcript = path.join(root, 'transcript.txt');
  writeFileSync(program, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
let initial = 0, gameActive = false;
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(${JSON.stringify(transcript)}, line + '\\n');
  if (line === 'uci') {
    console.log('id name Clock Contract Fixture');
    ${advertised ? "console.log('option name TimingInitialTimeMs type spin default 0 min 0 max 86400000');" : ''}
    console.log('uciok');
  } else if (line.startsWith('setoption name TimingInitialTimeMs value ')) {
    if (gameActive) process.exit(4);
    initial = Number(line.split(' ').at(-1));
  } else if (line === 'ucinewgame') gameActive = false;
  else if (line.startsWith('position ')) gameActive = true;
  else if (line === 'isready') {
    ${advertised ? "if (![180000,300000].includes(initial)) process.exit(3);" : ''}
    console.log('readyok');
  } else if (line.startsWith('go ')) console.log('bestmove e2e4');
  else if (line === 'quit') process.exit(0);
}
`);
  const config = { adapter: 'standard_uci_v1', executable: process.execPath,
    arguments: [program], working_directory: root, shutdown_grace_ms: 1000,
    uci_options: advertised ? { TimingInitialTimeMs: initial } : {},
    timing: { opponent_turn_search: false } };
  const engine = new UciEngine(config);
  const cleanups = [() => engine.close()];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); rmSync(root, { recursive: true, force: true }); });
  return { engine, config, root, cleanups, commands: () => readFileSync(transcript, 'utf8').trim().split('\n') };
}

test('provider known initial control replaces the opaque zero placeholder before first readiness', async t => {
  const { engine, config, commands } = clockEngine(t);
  await engine.start({ initialTimeMs: 180000, incrementMs: 0 });
  assert.equal(engine.qualificationStatus.qualified, true);
  const sent = commands();
  assert.ok(sent.indexOf('setoption name TimingInitialTimeMs value 180000') < sent.indexOf('isready'));
  assert.equal(config.uci_options.TimingInitialTimeMs, 0);
});

test('reused child binds the next game initial control before its new game readiness without shared option mutation', async t => {
  const { engine, config, commands } = clockEngine(t, 180000);
  await engine.start({ initialTimeMs: 180000, incrementMs: 0 });
  const before = commands().length;
  await engine.newGame({ initialTimeMs: 300000, incrementMs: 2000 });
  const sent = commands().slice(before);
  assert.deepEqual(sent.slice(0, 3), ['ucinewgame', 'setoption name TimingInitialTimeMs value 300000', 'isready']);
  assert.equal(config.uci_options.TimingInitialTimeMs, 180000);
});

test('missing actual game initial clock rejects the new game rather than inferring from remaining clock', async t => {
  const { engine, commands } = clockEngine(t, 180000);
  await engine.start({ initialTimeMs: 180000, incrementMs: 0 });
  const before = commands().length;
  await assert.rejects(() => engine.newGame({ initialTimeMs: undefined, incrementMs: 0 }), /initial.*clock/i);
  assert.equal(commands().slice(before).includes('ucinewgame'), false);
});

test('ordinary standard engine receives no unadvertised clock option', async t => {
  const { engine, commands } = clockEngine(t, 0, false);
  await engine.start({ initialTimeMs: 180000, incrementMs: 0 });
  await engine.newGame({ initialTimeMs: 300000, incrementMs: 2000 });
  assert.equal(commands().some(line => line.includes('TimingInitialTimeMs')), false);
});

test('gameFull binds original millisecond control while residual clocks differ and reconnect retains it', async t => {
  const { engine, config, commands } = clockEngine(t, 180000);
  await engine.start({ initialTimeMs: 180000, incrementMs: 0 });
  const session = new GameSession({ client: {}, config: { engine: config, timing: { opponent_turn_search: false } },
    account: 'fixture', gameId: 'fixture-game', signal: new AbortController().signal,
    slot: { id: 'human-1', audience: 'human', engine }, store: { beginGame() {} } });
  const event = { id: 'fixture-game', variant: { key: 'standard' }, initialFen: 'startpos',
    white: { id: 'fixture' }, black: { id: 'opponent' }, clock: { initial: 300000, increment: 2000 },
    state: { moves: 'e2e4 e7e5', wtime: 173000, btime: 169000 } };
  const before = commands().length;
  await session.initialize(event, engine);
  assert.ok(commands().slice(before).includes('setoption name TimingInitialTimeMs value 300000'));
  const reconnect = commands().length;
  await session.initialize(event, engine);
  assert.equal(commands().length, reconnect);
});

test('public qualify binds configured outbound seconds before the placeholder engine readiness', t => {
  const { config, root, commands } = clockEngine(t);
  const raw = JSON.parse(readFileSync(new URL('./config.uci_arena.template.yml', import.meta.url), 'utf8'));
  raw.engine = config;
  raw.outbound_challenge = { rated: false, color: 'random', clock_limit: 180, clock_increment: 0 };
  raw.capacity = { total_slots: 1, startup_parallelism: 1,
    human: { slots: 1, allow_borrowing: false, accept_public: true }, bot: { slots: 0, target_active: 0 } };
  raw.scheduler.enabled = false;
  const filename = path.join(root, 'config.json');
  writeFileSync(filename, JSON.stringify(raw));
  const child = spawnSync(process.execPath, ['lichess-adapter.mjs', 'qualify', '--config', filename],
    { cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).status, 'qualified');
  assert.ok(commands().includes('setoption name TimingInitialTimeMs value 180000'));
  const smoke = spawnSync(process.execPath, ['smoke-uci-startup.mjs', '--config', filename],
    { cwd: path.dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.equal(JSON.parse(smoke.stdout).bestmove, 'e2e4');
});

test('inbound preparation binds admitted challenge seconds rather than configured outbound control', async t => {
  const { config, root, commands, cleanups } = clockEngine(t);
  const store = new LichessStore(path.join(root, 'matches.sqlite'));
  cleanups.push(() => store.close());
  const controller = new BotController({ client: { post: async () => ({}) },
    config: { engine: config, timing: { opponent_turn_search: false },
      outbound_challenge: { clock_limit: 180, clock_increment: 0 },
      capacity: { total_slots: 1, startup_parallelism: 1,
        human: { slots: 1, allow_borrowing: false, accept_public: true }, bot: { slots: 0, target_active: 0 } },
      challenges: { accept_bots: true, min_base: 180, max_base: 300, min_increment: 0, max_increment: 2,
        speeds: ['blitz'], modes: ['casual'] }, scheduler: { decline_cooldown_minutes: 1 } },
    account: 'fixture', runtimeDir: root, signal: new AbortController().signal, store });
  cleanups.unshift(async () => { for (const slot of controller.slots.slots) await slot.engine?.close(); });
  await controller.onChallenge({ id: 'incoming', rated: false, speed: 'blitz', variant: { key: 'standard' },
    timeControl: { type: 'clock', limit: 300, increment: 2 }, challenger: { id: 'opponent' } });
  assert.ok(commands().includes('setoption name TimingInitialTimeMs value 300000'));
  assert.equal(commands().includes('setoption name TimingInitialTimeMs value 180000'), false);
});
