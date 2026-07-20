import assert from "node:assert/strict";
import test from "node:test";

import {
  AsyncSemaphore,
  PriorityRequestQueue,
  SlotPool,
  candidateWeight,
  reservationBlocksPublicHuman,
  selectWeightedCandidate,
} from "./lichess-scheduler.mjs";

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
  await pool.release(bot);
  assert.ok(pool.acquire("bot", { opponent: "bot-two" }));
});

test("configured borrowing is explicit and one-way into idle human capacity", () => {
  const pool = new SlotPool(capacity({ humans: 1, bots: 1, borrowing: true }));
  assert.ok(pool.acquire("bot", { opponent: "first" }));
  const borrowed = pool.acquire("bot", { opponent: "second" });
  assert.equal(borrowed.configuredAudience, "human");
  assert.equal(pool.acquire("human", { opponent: "human" }), null);
});

test("pending lookup is deterministic by challenge id then opponent", () => {
  const pool = new SlotPool(capacity({ humans: 0, bots: 2 }));
  const first = pool.acquire("bot", { opponent: "one", createdAt: 1 });
  const second = pool.acquire("bot", { opponent: "two", createdAt: 2 });
  pool.pending(first, "challenge-one");
  pool.pending(second, "challenge-two");
  assert.equal(pool.findPending({ gameId: "challenge-two" }), second);
  assert.equal(pool.findPending({ gameId: "new-id", opponent: { username: "one" } }), first);
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
