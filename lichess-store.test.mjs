import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LichessStore } from "./lichess-store.mjs";

function storeFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-store-"));
  return new LichessStore(path.join(directory, "matches.sqlite"));
}

test("store migrates to schema two and uses WAL", () => {
  const store = storeFixture();
  try {
    assert.equal(store.status().schemaVersion, 2);
    assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  } finally {
    store.close();
  }
});

test("rate-limit circuit breaker persists stepped backoff and admits one half-open request", () => {
  const store = storeFixture();
  const filePath = store.filePath;
  try {
    const first = store.recordApiRateLimit429({ random: () => 0 }, 1_000);
    assert.equal(first.consecutive429, 1);
    assert.equal(first.blockedUntil, 61_000);
  } finally {
    store.close();
  }

  const reopened = new LichessStore(filePath);
  try {
    assert.equal(reopened.apiRateLimitState(2_000).blocked, true);
    assert.equal(reopened.beginApiRateLimitRequest(60_999), false);
    assert.equal(reopened.beginApiRateLimitRequest(61_000), true);
    assert.equal(reopened.beginApiRateLimitRequest(61_000), false);
    const second = reopened.recordApiRateLimit429({ random: () => 0 }, 61_000);
    assert.equal(second.consecutive429, 2);
    assert.equal(second.blockedUntil, 181_000);
    const retryAfter = reopened.recordApiRateLimit429({ retryAfterMs: 1_000_000, random: () => 0 }, 181_000);
    assert.equal(retryAfter.blockedUntil, 1_181_000);
    reopened.clearApiRateLimit();
    assert.deepEqual(reopened.apiRateLimitState(1_181_000), {
      consecutive429: 0,
      blockedUntil: 0,
      last429At: 0,
      halfOpen: false,
      blocked: false,
    });
  } finally {
    reopened.close();
  }
});

test("owners and expiring reservations are durable control state", () => {
  const store = storeFixture();
  try {
    store.addOwner("Owner_Name", 100);
    assert.equal(store.isOwner("owner_name"), true);
    assert.equal(store.reserve("OWNER_NAME", 2, 15, 1_000).games_remaining, 2);
    assert.equal(store.consumeReservation("owner_name", 2_000), true);
    assert.equal(store.getReservation(2_000).games_remaining, 1);
    assert.equal(store.consumeReservation("owner_name", 2_000), true);
    assert.equal(store.getReservation(2_000), null);
    store.reserve("owner_name", 1, 1, 5_000);
    assert.equal(store.getReservation(65_001), null);
  } finally {
    store.close();
  }
});

test("online discovery, cooldown, and daily game caps filter candidates", () => {
  const store = storeFixture();
  const now = 1_000_000_000;
  try {
    store.replaceOnlineBots([
      { username: "BotOne", title: "BOT", perfs: { blitz: { rating: 2200 } } },
      { username: "BotTwo", title: "BOT", perfs: { rapid: { rating: 2100 } } },
    ], now);
    assert.deepEqual(store.eligibleBots({ self: "self", now }).map((row) => row.username), ["botone", "bottwo"]);
    store.setOpponentCooldown("botone", 30, now);
    assert.deepEqual(store.eligibleBots({ self: "self", now }).map((row) => row.username), ["bottwo"]);
    for (const id of ["game-one", "game-two"]) {
      store.beginGame({ id, opponent: "bottwo", audience: "bot", color: "white", startedAt: now });
    }
    assert.deepEqual(store.eligibleBots({ self: "self", now, maximumGamesPerDay: 2 }), []);
  } finally {
    store.close();
  }
});

test("challenge and game completion writes are idempotent", () => {
  const store = storeFixture();
  try {
    store.replaceOnlineBots([{ username: "Opponent", title: "BOT" }], 100);
    store.recordChallenge({
      id: "challenge", opponent: "opponent", audience: "bot", direction: "outbound", status: "pending",
    }, 200);
    store.updateChallenge("challenge", "accepted", {}, 300);
    store.updateChallenge("challenge", "accepted", {}, 400);
    assert.equal(store.db.prepare("SELECT accepts FROM opponents WHERE username='opponent'").get().accepts, 1);
    store.beginGame({
      id: "game", opponent: "opponent", audience: "bot", color: "black", startedAt: 500,
      engineBuildFingerprint: "engine-a", modelFingerprint: "model-a", providerFingerprint: "provider-a",
    });
    store.finishGame({ id: "game", status: "mate", result: "win", winner: "black", plies: 42, finishedAt: 600 });
    store.finishGame({ id: "game", status: "resign", result: "loss", winner: "white", plies: 43, finishedAt: 700 });
    assert.deepEqual(store.opponentStats().map((entry) => ({ ...entry })), [
      {
        opponent: "opponent", rating: 0, games: 1, wins: 1, draws: 0, losses: 0,
        accepts: 1, declines: 0, timeouts: 0, last_game_at: 600,
      },
    ]);
    const row = store.db.prepare("SELECT result, engine_build_fingerprint FROM games WHERE game_id='game'").get();
    assert.deepEqual({ ...row }, { result: "win", engine_build_fingerprint: "engine-a" });
  } finally {
    store.close();
  }
});
