import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LichessStore } from "./lichess-store.mjs";
import { parseProviderHistoricalGame } from "./provider-games.mjs";

const PROVIDER_COMPONENT = Object.freeze({
  componentId: "lichess.adapter",
  version: "1.0.24",
  manifestSha256: `sha256:${"a".repeat(64)}`,
});

function gameFixture(overrides = {}) {
  return {
    id: "game",
    opponent: "opponent",
    audience: "bot",
    color: "white",
    initialFen: "startpos",
    variant: "standard",
    providerComponent: PROVIDER_COMPONENT,
    ...overrides,
  };
}

function storeFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-store-"));
  return new LichessStore(path.join(directory, "matches.sqlite"));
}

function processIdentity(pid, startToken = String(pid)) {
  return {
    schema: "uci_arena_process_instance_identity_v1",
    platform: "win32",
    pid,
    start_token: startToken,
    executable_path: "C:\\UCI Arena\\node.exe",
    boot_id: "",
  };
}

const PROVENANCE_COLUMNS = Object.freeze([
  "runtime_provenance_json",
  "runtime_provenance_sha256",
  "time_profile_identity",
  "batch_wait_us",
  "batch_size",
  "split_depth",
  "root_workers",
  "threads",
  "search_core",
  "onnx_runtime_version",
  "hardware_driver_fingerprint",
  "provider",
  "adapter_id",
  "checkpoint_hash",
  "model_id",
]);

const ARCHIVE_COLUMNS = Object.freeze([
  "backfill_last_attempted_at", "backfill_attempts",
  "engine_component_manifest_sha256", "engine_component_version", "engine_component_id",
  "provider_component_manifest_sha256", "provider_component_version", "provider_component_id",
  "archive_sha256", "archive_reason", "archive_completeness", "variant", "initial_fen",
  "completion_cursor", "archive_cursor",
]);

function removeArchiveSchema(database) {
  database.exec(`
    DROP INDEX games_live_cursor;
    DROP INDEX games_completion_cursor;
    DROP INDEX games_archive_cursor;
    DROP TABLE game_plies;
    DROP TABLE game_archive_control;
  `);
  for (const column of ARCHIVE_COLUMNS) {
    database.exec(`ALTER TABLE games DROP COLUMN ${column}`);
  }
}

function downgradeToLegacyV1(file, { version = 1, legacyRateLimit = false } = {}) {
  const database = new DatabaseSync(file);
  removeArchiveSchema(database);
  database.exec(`
    DROP TABLE provider_incidents;
    DROP TABLE provider_incident_control;
    DROP TABLE api_safety_state;
    DROP TABLE api_client_leases;
    DROP TABLE provider_lifecycle_control;
  `);
  for (const column of PROVENANCE_COLUMNS) {
    database.exec(`ALTER TABLE games DROP COLUMN ${column}`);
  }
  database.exec(`
    DROP TABLE schema_meta;
    CREATE TABLE schema_meta(version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) VALUES(${version});
  `);
  if (legacyRateLimit) {
    database.exec(`
      CREATE TABLE api_rate_limit(
        id INTEGER PRIMARY KEY CHECK(id=1),
        consecutive_429 INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        last_429_at INTEGER NOT NULL DEFAULT 0,
        half_open INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO api_rate_limit(id, consecutive_429, blocked_until, last_429_at, half_open)
      VALUES(1, 3, 100000, 40000, 0);
    `);
  }
  database.close();
}

const EMPTY_CHALLENGE_SAFETY = Object.freeze({
  challengeBlockedUntil: 0,
  challengeStrikeCount: 0,
  challengeLast429At: 0,
  challengeRecoveredAt: 0,
  challengeHalfOpen: false,
});

test("store keeps schema six and adds exact lifecycle, incident, and archive extensions", () => {
  const store = storeFixture();
  try {
    assert.equal(store.status().schemaVersion, 6);
    assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(store.db.prepare("SELECT version FROM schema_meta").get().version, 6);
    assert.deepEqual(store.providerLifecycleSnapshot(), {
      admissionBlocked: false,
      owned: false,
      activeWork: 0,
      updatedAt: 0,
    });
    assert.deepEqual(store.providerIncidentSummary(), {
      available: true,
      active_count: 0,
      highest_severity: null,
      latest_cursor: 0,
      truncated: false,
      truncated_rows: 0,
    });
  } finally {
    store.close();
  }
});

test("schema-one stores migrate without losing existing control state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-store-v1-"));
  const file = path.join(directory, "matches.sqlite");
  const initialized = new LichessStore(file);
  initialized.setPaused(true, 123);
  initialized.close();
  downgradeToLegacyV1(file);
  const store = new LichessStore(file);
  try {
    assert.equal(store.status().schemaVersion, 6);
    assert.equal(store.control().paused, true);
    assert.deepEqual(store.apiSafetyState("https://lichess.org|arena-bot"), {
      cooldownUntil: 0,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
      ...EMPTY_CHALLENGE_SAFETY,
    });
  } finally {
    store.close();
  }
});

test("legacy schema-two rate-limit state migrates without shortening cooldown", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-store-v2-"));
  const file = path.join(directory, "matches.sqlite");
  const seed = new LichessStore(file);
  seed.close();
  downgradeToLegacyV1(file, { version: 2, legacyRateLimit: true });

  const store = new LichessStore(file);
  const key = "https://lichess.org|arena-bot";
  try {
    assert.deepEqual(store.apiSafetyState(key), {
      cooldownUntil: 100_000,
      strikeCount: 3,
      last429At: 40_000,
      lastRetryAfterMs: 0,
      ...EMPTY_CHALLENGE_SAFETY,
    });
    store.saveApiSafetyState(key, {
      cooldownUntil: 90_000,
      strikeCount: 1,
      last429At: 50_000,
      lastRetryAfterMs: 60_000,
      ...EMPTY_CHALLENGE_SAFETY,
    }, 50_000);
    assert.deepEqual(store.apiSafetyState(key), {
      cooldownUntil: 100_000,
      strikeCount: 1,
      last429At: 50_000,
      lastRetryAfterMs: 60_000,
      ...EMPTY_CHALLENGE_SAFETY,
    });
    assert.equal(store.acquireApiLease(
      key,
      "repair-owner",
      101,
      50_000,
      60_000,
      null,
      processIdentity(101),
    ).owner_id, "repair-owner");
    assert.equal(store.releaseApiLease(key, "repair-owner"), true);
    assert.equal(store.status().schemaVersion, 6);
  } finally {
    store.close();
  }
});

test("partial schema is rejected instead of being repaired", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-store-partial-"));
  const file = path.join(directory, "matches.sqlite");
  const seed = new LichessStore(file);
  seed.db.exec("DROP TABLE api_client_leases; UPDATE schema_meta SET version=3");
  seed.close();
  assert.throws(
    () => new LichessStore(file),
    (error) => error.code === "LICHESS_STORAGE_SCHEMA_MALFORMED",
  );
  const reopened = new DatabaseSync(file);
  try {
    assert.equal(reopened.prepare("SELECT version FROM schema_meta").get().version, 3);
  } finally {
    reopened.close();
  }
});

test("replacement admission and provider work serialize without a status race", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lifecycle-interlock-"));
  const file = path.join(directory, "matches.sqlite");
  const runtime = new LichessStore(file);
  const lifecycle = new LichessStore(file);
  const authority = "https://lichess.org|arena-bot";
  const owner = "provider-owner";
  try {
    runtime.acquireApiLease(
      authority,
      owner,
      101,
      1_000,
      60_000,
      null,
      processIdentity(101),
    );
    runtime.claimProviderLifecycle(owner, 1_000);
    runtime.beginProviderWork(owner, 1_001);

    assert.deepEqual(lifecycle.requestProviderReplacement(1_002), {
      safe: false,
      reason: "provider_owned_work_active",
      activeWork: 1,
      unfinishedGames: 0,
      admissionBlocked: false,
    });
    assert.equal(runtime.providerLifecycleSnapshot().admissionBlocked, false);

    runtime.finishProviderWork(owner, 1_003);
    assert.deepEqual(lifecycle.requestProviderReplacement(1_004), {
      safe: true,
      reason: null,
      activeWork: 0,
      unfinishedGames: 0,
      admissionBlocked: true,
    });
    assert.throws(
      () => runtime.beginProviderWork(owner, 1_005),
      (error) => error.code === "LICHESS_PROVIDER_REPLACEMENT_BLOCKED",
    );
    assert.equal(lifecycle.requestProviderReplacement(1_006).safe, true);
    lifecycle.resumeProviderAdmissions(1_007);
    runtime.claimProviderLifecycle(owner, 1_008);
    assert.equal(runtime.beginProviderWork(owner, 1_009).activeWork, 1);
    runtime.finishProviderWork(owner, 1_010);
  } finally {
    runtime.releaseProviderLifecycle(owner, 1_011);
    runtime.releaseApiLease(authority, owner);
    runtime.close();
    lifecycle.close();
  }
});

test("replacement fails closed for legacy live authority and unfinished games", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lifecycle-legacy-"));
  const file = path.join(directory, "matches.sqlite");
  const runtime = new LichessStore(file);
  const lifecycle = new LichessStore(file);
  const authority = "https://lichess.org|arena-bot";
  try {
    runtime.acquireApiLease(
      authority,
      "legacy-owner",
      101,
      1_000,
      60_000,
      null,
      processIdentity(101),
    );
    assert.deepEqual(lifecycle.requestProviderReplacement(1_001), {
      safe: false,
      reason: "provider_lifecycle_interlock_unavailable",
      activeWork: 0,
      unfinishedGames: 0,
      admissionBlocked: false,
    });
    runtime.releaseApiLease(authority, "legacy-owner");
    assert.equal(
      lifecycle.requestProviderReplacement(1_002).reason,
      "provider_lifecycle_interlock_unavailable",
    );
    assert.equal(
      lifecycle.requestProviderReplacement(1_003, { allowUnowned: true }).safe,
      true,
    );
    lifecycle.resumeProviderAdmissions(1_004);
    runtime.beginGameActivation({
      id: "unfinished-game",
      opponent: "fixture-bot",
      audience: "bot",
    }, 1_005);
    const unfinished = lifecycle.requestProviderReplacement(1_006, { allowUnowned: true });
    assert.equal(unfinished.safe, false);
    assert.equal(unfinished.reason, "provider_owned_work_active");
    assert.equal(unfinished.unfinishedGames, 1);
    assert.equal(unfinished.admissionBlocked, false);
  } finally {
    runtime.close();
    lifecycle.close();
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
      ...EMPTY_CHALLENGE_SAFETY,
    }, 50_000);
    assert.deepEqual(store.apiSafetyState(key), {
      cooldownUntil: 100_000,
      strikeCount: 2,
      last429At: 50_000,
      lastRetryAfterMs: 1_000,
      ...EMPTY_CHALLENGE_SAFETY,
    });
    store.saveApiSafetyState(key, {
      cooldownUntil: 80_000,
      strikeCount: 1,
      last429At: 45_000,
      lastRetryAfterMs: 500,
    }, 60_000);
    assert.deepEqual(store.apiSafetyState(key), {
      cooldownUntil: 100_000,
      strikeCount: 2,
      last429At: 50_000,
      lastRetryAfterMs: 1_000,
      ...EMPTY_CHALLENGE_SAFETY,
    });
  } finally {
    store.close();
  }
});

test("challenge quarantine is durable and only a newer recovery clears it", () => {
  const store = storeFixture();
  const key = "https://lichess.org|arena-bot";
  try {
    store.saveApiSafetyState(key, {
      cooldownUntil: 100_000,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
      challengeBlockedUntil: 500_000,
      challengeStrikeCount: 6,
      challengeLast429At: 100_000,
      challengeRecoveredAt: 0,
      challengeHalfOpen: false,
    }, 100_000);
    store.saveApiSafetyState(key, {
      cooldownUntil: 90_000,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
      challengeBlockedUntil: 200_000,
      challengeStrikeCount: 1,
      challengeLast429At: 90_000,
      challengeRecoveredAt: 0,
      challengeHalfOpen: false,
    }, 110_000);
    assert.equal(store.apiSafetyState(key).challengeBlockedUntil, 500_000);
    assert.equal(store.apiSafetyState(key).challengeStrikeCount, 6);

    store.saveApiSafetyState(key, {
      cooldownUntil: 100_000,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
      challengeBlockedUntil: 0,
      challengeStrikeCount: 0,
      challengeLast429At: 0,
      challengeRecoveredAt: 600_000,
      challengeHalfOpen: false,
    }, 600_000);
    assert.deepEqual(store.apiSafetyState(key), {
      cooldownUntil: 100_000,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
      challengeBlockedUntil: 0,
      challengeStrikeCount: 0,
      challengeLast429At: 0,
      challengeRecoveredAt: 600_000,
      challengeHalfOpen: false,
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
    const firstIdentity = processIdentity(101);
    const secondIdentity = processIdentity(202);
    first.acquireApiLease(key, "owner-one", 101, 1_000, 60_000, null, firstIdentity);
    assert.throws(
      () => second.acquireApiLease(
        key, "owner-two", 202, 2_000, 60_000, null, secondIdentity,
      ),
      (error) => error.code === "LICHESS_API_LEASE_HELD",
    );
    first.heartbeatApiLease(key, "owner-one", 101, 10_000, 60_000, firstIdentity);
    assert.equal(first.apiLease(key).expires_at, 70_000);
    second.acquireApiLease(
      key, "owner-two", 202, 70_001, 60_000, null, secondIdentity,
    );
    assert.equal(second.apiLease(key).owner_id, "owner-two");
    assert.equal(first.releaseApiLease(key, "owner-one"), false);
    assert.equal(second.releaseApiLease(key, "owner-two"), true);
  } finally {
    first.close();
    second.close();
  }
});

test("API client lease permits fresh takeover only when the exact owner is absent or replaced", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-dead-lease-"));
  const file = path.join(directory, "matches.sqlite");
  const first = new LichessStore(file);
  const second = new LichessStore(file);
  const key = "https://lichess.org|arena-bot";
  try {
    const firstIdentity = processIdentity(101, "100");
    const reusedIdentity = processIdentity(101, "200");
    const secondIdentity = processIdentity(202, "300");
    first.acquireApiLease(key, "owner-one", 101, 1_000, 60_000, null, firstIdentity);
    assert.throws(
      () => second.acquireApiLease(
        key,
        "owner-two",
        202,
        2_000,
        60_000,
        () => ({ state: "present", identity: firstIdentity }),
        secondIdentity,
      ),
      (error) => error.code === "LICHESS_API_LEASE_HELD",
    );
    assert.throws(
      () => second.acquireApiLease(
        key,
        "owner-two",
        202,
        2_000,
        60_000,
        () => ({ state: "unverifiable" }),
        secondIdentity,
      ),
      (error) => error.code === "LICHESS_API_LEASE_HELD",
    );

    const replacement = second.acquireApiLease(
      key,
      "owner-two",
      202,
      2_000,
      60_000,
      () => ({ state: "present", identity: reusedIdentity }),
      secondIdentity,
    );

    assert.equal(replacement.owner_id, "owner-two");
    assert.equal(replacement.pid, 202);
    assert.equal(first.releaseApiLease(key, "owner-one"), false);

    second.releaseApiLease(key, "owner-two");
    first.acquireApiLease(key, "owner-three", 101, 3_000, 60_000, null, firstIdentity);
    const absent = second.acquireApiLease(
      key,
      "owner-four",
      202,
      4_000,
      60_000,
      () => ({ state: "absent" }),
      secondIdentity,
    );
    assert.equal(absent.owner_id, "owner-four");
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
      store.beginGame(gameFixture({
        id, opponent: "bottwo", audience: "bot", color: "white", startedAt: now,
      }));
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
    store.beginGame(gameFixture({
      id: "game", opponent: "opponent", audience: "bot", color: "black", startedAt: 500,
      engineBuildFingerprint: "engine-a", modelFingerprint: "model-a", providerFingerprint: "provider-a",
      modelId: "model-id-a", checkpointHash: "checkpoint-a", adapterId: "adapter-a",
      provider: "directml", hardwareDriverFingerprint: "hardware-a",
      onnxRuntimeVersion: "1.2.3", searchCore: "v2", threads: 6, rootWorkers: 6,
      splitDepth: 2, batchSize: 64, batchWaitUs: 0, timeProfileIdentity: "time-a",
      runtimeProvenanceSha256: "sha256:provenance-a",
      runtimeProvenance: { schema: "uci_arena_game_runtime_provenance_v1", version: "a" },
    }));
    store.beginGame(gameFixture({
      id: "game", opponent: "opponent", audience: "bot", color: "black", startedAt: 501,
      engineBuildFingerprint: "engine-b", modelFingerprint: "model-b",
      runtimeProvenanceSha256: "sha256:provenance-b",
      runtimeProvenance: { schema: "uci_arena_game_runtime_provenance_v1", version: "b" },
    }));
    store.finishGame({ id: "game", status: "mate", result: "win", winner: "black", plies: 0, finishedAt: 600 });
    assert.throws(
      () => store.finishGame({
        id: "game", status: "resign", result: "loss", winner: "white", plies: 0,
        finishedAt: 700,
      }),
      /immutable/,
    );
    assert.deepEqual(store.opponentStats().map((entry) => ({ ...entry })), [
      {
        opponent: "opponent", rating: 0, games: 1, wins: 1, draws: 0, losses: 0,
        accepts: 1, declines: 0, timeouts: 0, last_game_at: 600,
      },
    ]);
    const row = store.db.prepare(`
      SELECT result, engine_build_fingerprint, model_id, model_fingerprint,
        checkpoint_hash, adapter_id, provider, provider_fingerprint,
        hardware_driver_fingerprint, onnx_runtime_version, search_core, threads,
        root_workers, split_depth, batch_size, batch_wait_us, time_profile_identity,
        runtime_provenance_sha256, runtime_provenance_json
      FROM games WHERE game_id='game'
    `).get();
    assert.deepEqual({ ...row }, {
      result: "win",
      engine_build_fingerprint: "engine-a",
      model_id: "model-id-a",
      model_fingerprint: "model-a",
      checkpoint_hash: "checkpoint-a",
      adapter_id: "adapter-a",
      provider: "directml",
      provider_fingerprint: "provider-a",
      hardware_driver_fingerprint: "hardware-a",
      onnx_runtime_version: "1.2.3",
      search_core: "v2",
      threads: 6,
      root_workers: 6,
      split_depth: 2,
      batch_size: 64,
      batch_wait_us: 0,
      time_profile_identity: "time-a",
      runtime_provenance_sha256: "sha256:provenance-a",
      runtime_provenance_json:
        '{"schema":"uci_arena_game_runtime_provenance_v1","version":"a"}',
    });
  } finally {
    store.close();
  }
});

test("provider game archive reconciles takebacks, closes immutably, and paginates by cursor", () => {
  const store = storeFixture();
  try {
    const first = parseProviderHistoricalGame({
      id: "archive-one",
      moves: "e4 c5 Nf3",
      clocks: [18_000, 17_900, 17_800],
      status: "resign",
      winner: "black",
      lastMoveAt: 900,
    });
    store.beginGame(gameFixture({ id: first.id, color: "white", startedAt: 100 }));
    assert.equal(store.reconcileGameLine(first), true);

    const corrected = parseProviderHistoricalGame({
      id: "archive-one",
      moves: "e4 e5",
      clocks: [18_000, 17_950],
      status: "resign",
      winner: "black",
      lastMoveAt: 900,
    });
    assert.equal(store.reconcileGameLine(corrected), true);
    assert.deepEqual(store.gamePlyRows(first.id).map((ply) => ply.uci_move), ["e2e4", "e7e5"]);
    assert.equal(store.finishGame({
      id: first.id,
      status: "resign",
      result: "loss",
      winner: "black",
      plies: 2,
      finishedAt: 900,
    }), true);
    assert.equal(store.finishGame({
      id: first.id,
      status: "resign",
      result: "loss",
      winner: "black",
      plies: 2,
      finishedAt: 900,
    }), false);
    assert.throws(() => store.reconcileGameLine(first), /immutable/);

    store.beginGame(gameFixture({ id: "archive-two", startedAt: 200 }));
    store.beginGame(gameFixture({ id: "archive-three", startedAt: 300 }));
    const liveFirst = store.listProviderGames({ scope: "live", limit: 1 });
    assert.equal(liveFirst.games[0].game_id, "archive-three");
    assert.equal(liveFirst.has_more, true);
    const liveSecond = store.listProviderGames({
      scope: "live",
      beforeCursor: liveFirst.next_cursor,
      limit: 2,
    });
    assert.deepEqual(liveSecond.games.map((game) => game.game_id), ["archive-two"]);

    const history = store.listProviderGames({ scope: "history", limit: 2 });
    assert.deepEqual(history.games.map((game) => game.game_id), [first.id]);
    const detail = store.getProviderGame(first.id);
    assert.equal(detail.archive_completeness, "complete");
    assert.deepEqual(detail.replay.map((ply) => ply.uci_move), ["e2e4", "e7e5"]);
    assert.match(detail.archive_sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(store.gameArchiveSummary(), {
      available: true,
      total_games: 3,
      complete_games: 1,
      incomplete_games: 0,
      live_games: 2,
      logical_storage_bytes: store.gameArchiveSummary().logical_storage_bytes,
    });
  } finally {
    store.close();
  }
});

test("historical archive reconciliation is evidence-only and component identity is immutable", () => {
  const store = storeFixture();
  try {
    const game = gameFixture({ id: "historical-one", startedAt: 100, color: "black" });
    store.beginGame(game);
    assert.throws(
      () => store.beginGame({
        ...game,
        providerComponent: { ...PROVIDER_COMPONENT, version: "invented" },
      }),
      /component identity conflicts/,
    );
    store.db.prepare(`
      UPDATE games SET archive_completeness='summary_only',
        archive_reason='historical_moves_unavailable' WHERE game_id=?
    `).run(game.id);
    const parsed = parseProviderHistoricalGame({
      id: game.id,
      moves: "e4 e5",
      clocks: [6_000, 5_950],
      status: "mate",
      winner: "white",
      lastMoveAt: 1_000,
    });
    assert.equal(store.reconcileHistoricalGame(parsed, 1_100), true);
    const detail = store.getProviderGame(game.id);
    assert.equal(detail.archive_completeness, "reconciled");
    assert.equal(detail.result, "loss");
    assert.equal(detail.engine_component, null);
    assert.equal(detail.replay.length, 2);
    assert.deepEqual(store.listProviderGameBackfillIds(), []);
    assert.equal(store.reconcileHistoricalGame(parsed, 1_200), false);
    assert.throws(
      () => store.reconcileHistoricalGame({ ...parsed, status: "resign" }, 1_300),
      /status conflicts|archive conflicts/,
    );
  } finally {
    store.close();
  }
});

test("history keyset pagination reaches all 646 records exactly once", () => {
  const store = storeFixture();
  try {
    const insert = store.db.prepare(`
      INSERT INTO games(
        game_id, opponent, audience, color, status, plies, started_at, finished_at,
        archive_cursor, completion_cursor, initial_fen, variant,
        archive_completeness, archive_reason
      ) VALUES(?, 'fixture-bot', 'bot', 'white', 'mate', 0, ?, ?, ?, ?, ?,
        'standard', 'summary_only', 'historical_moves_unavailable')
    `);
    const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    store.db.exec("BEGIN IMMEDIATE");
    for (let cursor = 1; cursor <= 646; cursor += 1) {
      insert.run(
        `game-${String(cursor).padStart(4, "0")}`,
        cursor,
        cursor + 1_000,
        cursor,
        cursor,
        initialFen,
      );
    }
    store.db.prepare(`
      UPDATE game_archive_control
      SET next_archive_cursor=647, next_completion_cursor=647, updated_at=1646
      WHERE id=1
    `).run();
    store.db.exec("COMMIT");

    const visited = [];
    let beforeCursor = 0;
    let pages = 0;
    do {
      const page = store.listProviderGames({ scope: "history", beforeCursor, limit: 100 });
      assert.ok(page.games.length > 0 && page.games.length <= 100);
      visited.push(...page.games.map((game) => game.game_id));
      beforeCursor = page.next_cursor;
      pages += 1;
      if (!page.has_more) break;
    } while (pages < 10);
    assert.equal(pages, 7);
    assert.equal(visited.length, 646);
    assert.equal(new Set(visited).size, 646);
    assert.equal(visited[0], "game-0646");
    assert.equal(visited.at(-1), "game-0001");
    assert.throws(
      () => store.listProviderGames({ scope: "history", limit: 101 }),
      /page limit must be an exact safe integer/,
    );
  } finally {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
    store.close();
  }
});

test("historical provenance backfill is dry-run-first, idempotent, and never overwrites identity", () => {
  const store = storeFixture();
  const startedAt = Date.parse("2026-07-20T12:00:00Z");
  const baseGame = gameFixture({
    id: "historical-game",
    opponent: "opponent",
    audience: "bot",
    color: "white",
    startedAt,
    engineBuildFingerprint: "sha256:historical-engine",
    modelFingerprint: "historical-model-fingerprint",
    providerFingerprint: "historical-provider-fingerprint",
    bookIdentity: "sha256:historical-book",
  });
  const entry = {
    deployment_id: "historical-deployment",
    started_at_or_after: "2026-07-20T11:59:00Z",
    started_before: "2026-07-20T12:01:00Z",
    expected_game_count: 1,
    match: {
      engine_build_fingerprint: baseGame.engineBuildFingerprint,
      model_fingerprint: baseGame.modelFingerprint,
      provider_fingerprint: baseGame.providerFingerprint,
      book_identity: baseGame.bookIdentity,
    },
    values: {
      model_id: "historical-model",
      checkpoint_hash: "historical-checkpoint",
      adapter_id: "historical-adapter",
      provider: "directml",
      hardware_driver_fingerprint: "historical-hardware",
      onnx_runtime_version: "1.2.3",
      search_core: "v2",
      threads: 6,
      root_workers: 6,
      split_depth: 2,
      batch_size: 64,
      batch_wait_us: 0,
      time_profile_identity: "sha256:historical-time-profile",
    },
    provenance: {
      schema: "uci_arena_game_runtime_provenance_v1",
      engine: { build_fingerprint: baseGame.engineBuildFingerprint },
      model: { id: "historical-model", fingerprint: baseGame.modelFingerprint },
      provider: { name: "directml", numeric_fingerprint: baseGame.providerFingerprint },
      search: { threads: 6, root_workers: 6 },
      timing: { profile_identity_sha256: "sha256:historical-time-profile" },
      book: { configuration_identity: baseGame.bookIdentity, observed_active: null },
    },
    evidence_sources: [{ path: "runtime.log", sha256: "sha256:evidence" }],
    unknown_fields: ["book.observed_active"],
  };
  try {
    store.beginGame(baseGame);
    const dryRun = store.backfillGameProvenance([entry]);
    assert.equal(dryRun[0].would_update, 1);
    assert.equal(store.db.prepare("SELECT model_id FROM games WHERE game_id=?").get(baseGame.id).model_id, "");

    const applied = store.backfillGameProvenance([entry], { apply: true });
    assert.equal(applied[0].updated, 1);
    const row = store.db.prepare(`SELECT model_id, checkpoint_hash, threads, root_workers,
      runtime_provenance_sha256, runtime_provenance_json FROM games WHERE game_id=?`).get(baseGame.id);
    assert.equal(row.model_id, "historical-model");
    assert.equal(row.checkpoint_hash, "historical-checkpoint");
    assert.equal(row.threads, 6);
    assert.equal(row.root_workers, 6);
    assert.match(row.runtime_provenance_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(row.runtime_provenance_json).historical_backfill.unknown_fields,
      ["book.observed_active"]);

    const replay = store.backfillGameProvenance([entry], { apply: true });
    assert.equal(replay[0].skipped_existing, 1);
    const conflicting = structuredClone(entry);
    conflicting.values.model_id = "invented-model";
    assert.throws(
      () => store.backfillGameProvenance([conflicting], { apply: true }),
      /conflicting rows/,
    );
    assert.equal(store.db.prepare("SELECT model_id FROM games WHERE game_id=?").get(baseGame.id).model_id,
      "historical-model");
  } finally {
    store.close();
  }
});
