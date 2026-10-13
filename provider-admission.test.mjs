import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotController } from './lichess-adapter.mjs';
import { LichessStore } from './lichess-store.mjs';

function fixture(t, client = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'bot-admission-'));
  const store = new LichessStore(path.join(directory, 'matches.sqlite'));
  const config = {
    engine: { adapter: 'standard_uci_v1', uci_options: {} },
    timing: { opponent_turn_search: false, initial_transport_reserve_ms: 250 },
    scheduler: { enabled: false, decline_cooldown_minutes: 360 },
    capacity: { total_slots: 1, startup_parallelism: 1,
      human: { slots: 0, allow_borrowing: false, accept_public: false },
      bot: { slots: 1, target_active: 0 } },
    challenges: { accept_bots: true, min_base: 180, max_base: 180,
      min_increment: 0, max_increment: 0, speeds: ['blitz'], modes: ['casual'] },
  };
  const controller = new BotController({ client, config, account: 'self', runtimeDir: directory,
    signal: new AbortController().signal, store });
  t.after(async () => { await controller.slots.drainAll(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { controller, store };
}

const challenge = { id: 'NewGame1', rated: false, speed: 'blitz', variant: { key: 'standard' },
  timeControl: { type: 'clock', limit: 180, increment: 0 }, challenger: { id: 'otherbot', title: 'BOT' } };

test('paused provider rejects inbound admission before preparing an engine', async t => {
  const posts = [];
  const { controller, store } = fixture(t, { post: async (endpoint, form, _signal, _priority, beforeDispatch) => {
    beforeDispatch?.(); posts.push({ endpoint, form });
  }});
  store.setPaused(true);
  let preparations = 0;
  controller.prepareSlot = async () => { preparations += 1; throw new Error('No engine may be prepared while paused'); };
  await controller.onChallenge(challenge);
  assert.equal(preparations, 0);
  assert.deepEqual(posts, [{ endpoint: 'api/challenge/NewGame1/decline', form: { reason: 'later' } }]);
});

test('pause while an inbound accept is queued prevents its mutation and closes its prepared child', async t => {
  let accepted = 0, closed = 0, store;
  const fixtureResult = fixture(t, { post: async (endpoint, _form, _signal, _priority, beforeDispatch) => {
    if (endpoint.endsWith('/accept')) store.setPaused(true);
    beforeDispatch?.();
    if (endpoint.endsWith('/accept')) accepted += 1;
  }});
  store = fixtureResult.store;
  const { controller } = fixtureResult;
  controller.prepareSlot = async slot => {
    controller.slots.attachEngine(slot, { close: async () => { closed += 1; } }, slot.generation);
    return slot;
  };
  await controller.onChallenge(challenge);
  assert.equal(accepted, 0);
  assert.equal(closed, 1);
  assert.equal(controller.slots.snapshot().byAudience.bot.preparing, 0);
  assert.equal(controller.slots.snapshot().byAudience.bot.pending, 0);
});

for (const [name, response] of [
  ['missing list', {}], ['null response', null], ['non-array list', { nowPlaying: {}, nbMyTurn: 0 }],
  ['missing count', { nowPlaying: [] }], ['string count', { nowPlaying: [], nbMyTurn: '0' }],
  ['contradictory empty count', { nowPlaying: [], nbMyTurn: 1 }],
  ['missing game identity', { nowPlaying: [{}], nbMyTurn: 0 }],
  ['duplicate game identity', { nowPlaying: [{ gameId: 'SameGame' }, { gameId: 'SameGame' }], nbMyTurn: 0 }],
]) test(`reconciliation rejects ${name} without clearing pending authority`, async t => {
  const { controller } = fixture(t, { json: async () => response });
  controller.needsReconciliation = true;
  let starts = 0;
  controller.startGame = async () => { starts += 1; };
  await assert.rejects(controller.recoverPlayingGames(), /ongoing.game response/i);
  assert.equal(controller.needsReconciliation, true);
  assert.equal(starts, 0);
  assert.equal(controller.lastReconciliationAt, 0);
});

test('paused provider still reconciles an existing remote game from a complete response', async t => {
  const { controller, store } = fixture(t, { json: async () => ({ nowPlaying: [{ gameId: 'Existing1' }], nbMyTurn: 0 }) });
  store.setPaused(true);
  const games = [];
  controller.startGame = async game => { games.push(game.gameId); };
  assert.equal(await controller.recoverPlayingGames(), 1);
  assert.deepEqual(games, ['Existing1']);
  assert.equal(controller.needsReconciliation, false);
});

test('complete empty reconciliation releases startup pending authority', async t => {
  const { controller } = fixture(t, { json: async () => ({ nowPlaying: [], nbMyTurn: 0 }) });
  assert.equal(await controller.recoverPlayingGames(), 0);
  assert.equal(controller.needsReconciliation, false);
});
