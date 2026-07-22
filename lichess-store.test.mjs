import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    assert.equal(store.db.prepare("SELECT version FROM schema_meta").get().version, 2);
  } finally {
    store.close();
  }
});

test("schema-one stores migrate without losing existing control state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-store-v1-"));
  const file = path.join(directory, "matches.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) VALUES(1);
    CREATE TABLE scheduler_control(
      id INTEGER PRIMARY KEY CHECK(id=1),
      paused INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO scheduler_control(id, paused, updated_at) VALUES(1, 1, 123);
  `);
  legacy.close();
  const store = new LichessStore(file);
  try {
    assert.equal(store.status().schemaVersion, 2);
    assert.equal(store.control().paused, true);
    assert.deepEqual(store.apiSafetyState("https://lichess.org|arena-bot"), {
      cooldownUntil: 0,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
    });
  } finally {
    store.close();
  }
});

test("API cooldown state is durable and never shortened", () => {
  const store = storeFixture();
  const key = "https://lichess.org|arena-bot";
  try {
    store.saveApiSafetyState(key, {
      cooldownUntil: 100_000,
      strikeCount: 1,
      last429At: 40_000,
      lastRetryAfterMs: 60_000,
    }, 40_000);
    store.saveApiSafetyState(key, {
      cooldownUntil: 90_000,
      strikeCount: 2,
      last429At: 50_000,
      lastRetryAfterMs: 1_000,
    }, 50_000);
    assert.deepEqual(store.apiSafetyState(key), {
      cooldownUntil: 100_000,
      strikeCount: 2,
      last429At: 50_000,
      lastRetryAfterMs: 1_000,
    });
  } finally {
    store.close();
  }
});

test("API client lease excludes a second process and permits stale takeover", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-lease-"));
  const file = path.join(directory, "matches.sqlite");
  const first = new LichessStore(file);
  const second = new LichessStore(file);
  const key = "https://lichess.org|arena-bot";
  try {
    first.acquireApiLease(key, "owner-one", 101, 1_000, 60_000);
    assert.throws(
      () => second.acquireApiLease(key, "owner-two", 202, 2_000, 60_000),
      (error) => error.code === "LICHESS_API_LEASE_HELD",
    );
    first.heartbeatApiLease(key, "owner-one", 101, 10_000, 60_000);
    assert.equal(first.apiLease(key).expires_at, 70_000);
    second.acquireApiLease(key, "owner-two", 202, 70_001, 60_000);
    assert.equal(second.apiLease(key).owner_id, "owner-two");
    assert.equal(first.releaseApiLease(key, "owner-one"), false);
    assert.equal(second.releaseApiLease(key, "owner-two"), true);
  } finally {
    first.close();
    second.close();
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
