import assert from "node:assert/strict";
import test from "node:test";

import {
  API_REQUEST_PRIORITY,
  API_RATE_LIMIT_BACKOFF_MS,
  API_RATE_LIMIT_STRIKE_RESET_MS,
  CHALLENGE_RATE_LIMIT_BACKOFF_MS,
  ApiSafetyCoordinator,
  AsyncSemaphore,
  ChallengeRequestQuarantinedError,
  PriorityRequestQueue,
  SlotPool,
  candidateWeight,
  reservationBlocksPublicHuman,
  retryAfterMilliseconds,
  selectWeightedCandidate,
} from "./lichess-scheduler.mjs";

test("historical archive work is the lowest API request priority", () => {
  assert.ok(API_REQUEST_PRIORITY.archive_backfill > API_REQUEST_PRIORITY.ordinary);
  assert.ok(API_REQUEST_PRIORITY.archive_backfill > API_REQUEST_PRIORITY.discovery);
});

function capacity({ humans = 1, bots = 1, borrowing = false } = {}) {
  return {
    human: { slots: humans, allow_borrowing: borrowing },
    bot: { slots: bots },
  };
}

test("hard audience pools reserve one human slot while bot capacity is occupied", async () => {
  const pool = new SlotPool(capacity());
  const bot = pool.acquire("bot", { opponent: "bot-one" });
  assert.ok(bot);
  assert.equal(pool.acquire("bot", { opponent: "bot-two" }), null);
  const human = pool.acquire("human", { opponent: "owner" });
  assert.ok(human);
  assert.equal(pool.acquire("human", { opponent: "public" }), null);
  assert.equal(pool.snapshot().byAudience.bot.preparing, 1);
  assert.equal(pool.snapshot().byAudience.human.preparing, 1);
  await pool.release(bot, bot.generation);
  assert.ok(pool.acquire("bot", { opponent: "bot-two" }));
});

test("configured borrowing is explicit and one-way into idle human capacity", () => {
  const pool = new SlotPool(capacity({ humans: 1, bots: 1, borrowing: true }));
  assert.ok(pool.acquire("bot", { opponent: "first" }));
  const borrowed = pool.acquire("bot", { opponent: "second" });
  assert.equal(borrowed.configuredAudience, "human");
  assert.equal(pool.acquire("human", { opponent: "human" }), null);
});

test("already-started recovery uses idle qualified capacity without weakening admission pools", () => {
  const pool = new SlotPool(capacity({ humans: 1, bots: 1, borrowing: false }));
  assert.ok(pool.acquire("bot", { opponent: "scheduled" }));
  assert.equal(pool.acquire("bot", { opponent: "new-challenge" }), null);
  const recovered = pool.acquireStarted("bot", { opponent: "late-accept", direction: "recovered" });
  assert.ok(recovered);
  assert.equal(recovered.configuredAudience, "human");
  assert.equal(recovered.audience, "bot");
  assert.equal(pool.acquireStarted("bot", { opponent: "over-capacity" }), null);
});

test("concurrent releases keep a slot draining until its engine closes", async () => {
  const pool = new SlotPool(capacity({ humans: 0, bots: 1 }));
  const slot = pool.acquire("bot", { opponent: "timed-out" });
  let finishClose;
  const closeGate = new Promise((resolve) => { finishClose = resolve; });
  let closes = 0;
  pool.attachEngine(slot, {
    close: async () => {
      closes += 1;
      await closeGate;
    },
  }, slot.generation);
  const firstRelease = pool.release(slot, slot.generation);
  assert.equal(slot.state, "draining");
  assert.equal(await pool.release(slot, slot.generation), false);
  assert.equal(slot.state, "draining");
  assert.equal(pool.acquireStarted("bot", { opponent: "next" }), null);
  finishClose();
  assert.equal(await firstRelease, true);
  assert.equal(closes, 1);
  assert.equal(slot.state, "empty");
  assert.ok(pool.acquire("bot", { opponent: "next" }));
});

test("slot transitions require captured generations and stale releases cannot affect reuse", async () => {
  const pool = new SlotPool(capacity({ humans: 0, bots: 1 }));
  const first = pool.acquire("bot", { opponent: "first" });
  const firstGeneration = first.generation;
  assert.throws(
    () => pool.attachEngine(first, { close: async () => {} }),
    /captured generation/,
  );
  pool.attachEngine(first, { close: async () => {} }, firstGeneration);
  await pool.release(first, firstGeneration);
  const second = pool.acquire("bot", { opponent: "second" });
  assert.equal(second, first);
  assert.notEqual(second.generation, firstGeneration);
  assert.equal(await pool.release(second, firstGeneration), false);
  assert.equal(second.state, "preparing");
  await pool.release(second, second.generation);
});

test("pending lookup requires an exact challenge id or one unique outbound correlation", () => {
  const pool = new SlotPool(capacity({ humans: 0, bots: 2 }));
  const first = pool.acquire("bot", { opponent: "one", createdAt: 1 });
  const second = pool.acquire("bot", { opponent: "two", createdAt: 2 });
  pool.pending(first, "challenge-one", first.generation);
  pool.pending(second, "challenge-two", second.generation);
  assert.equal(pool.findPending({ gameId: "challenge-two" }), second);
  assert.equal(pool.findPending({ gameId: "new-id", opponent: { username: "one" } }), null);

  const outbound = new SlotPool(capacity({ humans: 0, bots: 1 }));
  const correlated = outbound.acquire("bot", {
    opponent: "one",
    direction: "outbound",
    correlationToken: "attempt-one",
  });
  assert.equal(outbound.findPending({ gameId: "new-id", opponent: { username: "one" } }), correlated);
  assert.equal(outbound.correlatesGame(correlated, {
    gameId: "new-id",
    opponent: { username: "one" },
  }), true);
});

test("same-opponent outbound attempts cannot be adopted by opponent alone", () => {
  const pool = new SlotPool(capacity({ humans: 0, bots: 2 }));
  const first = pool.acquire("bot", {
    opponent: "same",
    direction: "outbound",
    correlationToken: "attempt-one",
  });
  const second = pool.acquire("bot", {
    opponent: "same",
    direction: "outbound",
    correlationToken: "attempt-two",
  });

  const game = { gameId: "unrelated", opponent: { username: "same" } };
  assert.equal(pool.findPending(game), null);
  assert.equal(pool.correlatesGame(first, game), false);
  assert.equal(pool.correlatesGame(second, game), false);
});

test("owner reservation protects only the next human slot", () => {
  const reservation = { opponent: "owner" };
  assert.equal(reservationBlocksPublicHuman({
    reservation, opponent: "public", reservationOccupied: false, availableHuman: 1,
  }), true);
  assert.equal(reservationBlocksPublicHuman({
    reservation, opponent: "public", reservationOccupied: false, availableHuman: 2,
  }), false);
  assert.equal(reservationBlocksPublicHuman({
    reservation, opponent: "owner", reservationOccupied: false, availableHuman: 1,
  }), false);
  assert.equal(reservationBlocksPublicHuman({
    reservation, opponent: "public", reservationOccupied: true, availableHuman: 1,
  }), false);
});

test("weighted selection favors close, accepting, under-sampled opponents without becoming deterministic", () => {
  const scheduler = { rating_target: 2200, rating_spread: 600 };
  const strongCandidate = {
    username: "strong", rating: 2200, accepts: 8, declines: 0, timeouts: 0,
    total_games: 0, last_game_at: 0, white_games: 0, black_games: 0,
  };
  const weakCandidate = {
    username: "weak", rating: 1000, accepts: 0, declines: 8, timeouts: 4,
    total_games: 20, last_game_at: Date.now(), white_games: 20, black_games: 0,
  };
  assert.ok(candidateWeight(strongCandidate, scheduler) > candidateWeight(weakCandidate, scheduler));
  assert.equal(selectWeightedCandidate([strongCandidate, weakCandidate], scheduler, () => 0).username, "strong");
  assert.equal(selectWeightedCandidate([strongCandidate, weakCandidate], scheduler, () => 0.999999).username, "weak");
});

test("serialized request queue admits a waiting move before ordinary API work", async () => {
  const queue = new PriorityRequestQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.enqueue(async () => { order.push("running"); await gate; }, 20);
  const ordinary = queue.enqueue(async () => { order.push("ordinary"); }, 20);
  const move = queue.enqueue(async () => { order.push("move"); }, 0);
  release();
  await Promise.all([first, ordinary, move]);
  assert.deepEqual(order, ["running", "move", "ordinary"]);
});

test("HTTP 429 cooldown blocks moves and every other request class", async () => {
  let now = 1_000;
  let scheduled = null;
  const queue = new ApiSafetyCoordinator({
    now: () => now,
    setTimer: (callback, milliseconds) => {
      scheduled = { callback, milliseconds };
      return 1;
    },
    clearTimer: () => { scheduled = null; },
  });
  assert.equal(await queue.registerRateLimit("1", "discovery"), 60_000);
  const order = [];
  const move = queue.enqueue(() => order.push("move"), { requestClass: "move", priority: 0 });
  const stream = queue.enqueue(() => order.push("stream"), { requestClass: "game_stream", priority: 5 });
  await Promise.resolve();
  assert.deepEqual(order, []);
  assert.equal(scheduled.milliseconds, 60_000);
  now += 59_999;
  scheduled.callback();
  await Promise.resolve();
  assert.deepEqual(order, []);
  now += 1;
  queue.pump();
  await Promise.all([move, stream]);
  assert.deepEqual(order, ["move", "stream"]);
});

test("rate-limit cooldown escalates and resets after six quiet hours", async () => {
  let now = 10_000;
  const queue = new ApiSafetyCoordinator({
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  for (const expected of API_RATE_LIMIT_BACKOFF_MS) {
    assert.equal(await queue.registerRateLimit(null), expected);
    now = queue.cooldownUntil;
  }
  now += API_RATE_LIMIT_STRIKE_RESET_MS;
  assert.equal(await queue.registerRateLimit(null), API_RATE_LIMIT_BACKOFF_MS[0]);
  assert.equal(queue.snapshot().strike_count, 1);
});

test("challenge 429s use a class quarantine without extending the global cooldown", async () => {
  let now = 10_000;
  const persisted = [];
  const queue = new ApiSafetyCoordinator({
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {},
    persistSafetyState: async (state) => persisted.push({ ...state }),
  });

  for (let index = 0; index < CHALLENGE_RATE_LIMIT_BACKOFF_MS.length; index += 1) {
    const expected = CHALLENGE_RATE_LIMIT_BACKOFF_MS[index];
    assert.equal(await queue.registerRateLimit(null, "challenge_create"), 60_000);
    assert.equal(queue.challengeRemainingMs(), expected);
    assert.equal(queue.snapshot().challenge_strike_count, index + 1);
    now = queue.challengeBlockedUntil;
  }

  assert.equal(queue.snapshot().state, "challenge_half_open");
  const halfOpen = queue.enqueue(() => "recovered", { requestClass: "challenge_create" });
  assert.equal(await halfOpen, "recovered");
  assert.equal(queue.snapshot().state, "ready");
  assert.equal(queue.snapshot().challenge_strike_count, 0);
  assert.ok(persisted.some((state) => state.challengeHalfOpen));
  assert.ok(persisted.some((state) => state.challengeRecoveredAt === now));
});

test("challenge quarantine rejects writes locally while identity resumes after one minute", async () => {
  let now = 1_000;
  const queue = new ApiSafetyCoordinator({
    now: () => now,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await queue.registerRateLimit(null, "challenge_create");
  now = queue.cooldownUntil;
  await queue.registerRateLimit(null, "challenge_create");
  now = queue.cooldownUntil;

  await assert.rejects(
    queue.enqueue(() => assert.fail("quarantined challenge dispatched"), {
      requestClass: "challenge_create",
    }),
    (error) => error instanceof ChallengeRequestQuarantinedError
      && error.code === "LICHESS_CHALLENGE_QUARANTINED",
  );
  assert.equal(
    await queue.enqueue(() => "identity-ready", { requestClass: "identity" }),
    "identity-ready",
  );
  assert.equal(queue.snapshot().challenge_remaining_ms, 60_000);
});

test("Retry-After accepts delta seconds and HTTP dates without weakening the minimum", () => {
  const now = Date.parse("2026-07-21T20:00:00Z");
  assert.equal(retryAfterMilliseconds("90", now), 90_000);
  assert.equal(
    retryAfterMilliseconds("Tue, 21 Jul 2026 20:03:00 GMT", now),
    180_000,
  );
  assert.equal(retryAfterMilliseconds("invalid", now), 0);
});

test("long Retry-After deadlines use bounded timer slices without shortening cooldown", async () => {
  let now = 1_000;
  let scheduled = null;
  const queue = new ApiSafetyCoordinator({
    now: () => now,
    setTimer: (callback, milliseconds) => {
      scheduled = { callback, milliseconds };
      return 1;
    },
    clearTimer: () => { scheduled = null; },
  });
  const delay = 3_000_000_000;
  await queue.registerRateLimit(delay);
  const pending = queue.enqueue(() => "ready");
  assert.equal(queue.cooldownRemainingMs(), delay);
  assert.equal(scheduled.milliseconds, 2_147_483_647);
  now += 2_147_483_647;
  scheduled.callback();
  assert.equal(scheduled.milliseconds, delay - 2_147_483_647);
  now = queue.cooldownUntil;
  scheduled.callback();
  assert.equal(await pending, "ready");
});

test("engine-start semaphore never exceeds its configured parallelism", async () => {
  const semaphore = new AsyncSemaphore(2);
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tasks = Array.from({ length: 8 }, () => semaphore.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  release();
  await Promise.all(tasks);
  assert.equal(peak, 2);
  assert.equal(semaphore.active, 0);
});
