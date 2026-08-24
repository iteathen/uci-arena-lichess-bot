import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BotController,
  prepareProviderReplacementInterlock,
} from "./lichess-adapter.mjs";
import { LichessStore } from "./lichess-store.mjs";

function config() {
  return {
    engine: { adapter: "standard_uci_v1", uci_options: {} },
    timing: { opponent_turn_search: false },
    scheduler: { enabled: false },
    capacity: {
      total_slots: 1,
      startup_parallelism: 1,
      human: { slots: 0, allow_borrowing: false, accept_public: false },
      bot: { slots: 1, target_active: 0 },
    },
  };
}

function statusPublisher() {
  let generation = 0;
  return {
    schedule: () => ++generation,
    flush: async () => {},
    close: async () => {},
    health: () => ({ state: "ready", last_success_generation: generation || null }),
  };
}

function processIdentity(pid) {
  return {
    schema: "uci_arena_process_instance_identity_v1",
    platform: "win32",
    pid,
    start_token: String(pid),
    executable_path: "C:\\UCI Arena\\node.exe",
    boot_id: "",
  };
}

function initializeGameArchive(store, gameId) {
  store.beginGame({
    id: gameId,
    opponent: "fixture-bot",
    audience: "bot",
    color: "white",
    initialFen: "startpos",
    variant: "standard",
    providerComponent: {
      componentId: "lichess.adapter",
      version: "1.0.24",
      manifestSha256: `sha256:${"a".repeat(64)}`,
    },
  });
}

test("pre-replacement leaves an active game and startup control untouched", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-game-interlock-"));
  const storeFile = path.join(directory, "matches.sqlite");
  const store = new LichessStore(storeFile);
  const owner = "live-provider-owner";
  const authority = "https://lichess.org|arena-bot";
  const now = Date.now();
  let finishSession;
  let sessionStarted;
  const sessionStartedPromise = new Promise((resolve) => { sessionStarted = resolve; });
  const sessionFinishPromise = new Promise((resolve) => { finishSession = resolve; });
  let closes = 0;
  let prepareCalls = 0;
  store.acquireApiLease(
    authority,
    owner,
    101,
    now,
    60_000,
    null,
    processIdentity(101),
  );
  store.claimProviderLifecycle(owner, now);
  const controller = new BotController({
    client: {},
    config: config(),
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
    lifecycleOwner: owner,
    statusPublisher: statusPublisher(),
    sessionFactory: ({ gameId }) => ({
      finished: true,
      run: async () => {
        sessionStarted();
        await sessionFinishPromise;
        initializeGameArchive(store, gameId);
        store.finishGame({
          id: gameId,
          status: "mate",
          result: "win",
          winner: "white",
          plies: 0,
        });
      },
    }),
  });
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
    return slot;
  };
  let activeTask = null;
  try {
    await controller.startGame({
      gameId: "interlock-game",
      opponent: { id: "fixture-bot", title: "BOT" },
    });
    await sessionStartedPromise;
    activeTask = controller.activeGames.get("interlock-game");
    await assert.rejects(prepareProviderReplacementInterlock({
      runtimeDir: directory,
      storeFile,
      prepare: async () => { prepareCalls += 1; },
    }), (error) => (
      error.code === "provider_owned_work_active"
      && error.observed.activeWork === 1
    ));
    assert.equal(prepareCalls, 0);
    assert.equal(controller.activeGames.get("interlock-game"), activeTask);
    assert.equal(controller.slots.findGame("interlock-game").state, "active");
    assert.equal(store.providerLifecycleSnapshot().admissionBlocked, false);
    assert.equal(closes, 0);

    finishSession();
    await activeTask;
    activeTask = null;
    assert.equal(controller.activeGames.size, 0);
    assert.equal(store.providerLifecycleSnapshot().activeWork, 0);
    assert.equal(closes, 1);
  } finally {
    finishSession();
    await activeTask;
    await controller.drainProviderSlots();
    store.releaseProviderLifecycle(owner);
    store.releaseApiLease(authority, owner);
    store.close();
  }
});

test("failed platform preparation compensates an idle replacement gate", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-interlock-compensation-"));
  const storeFile = path.join(directory, "matches.sqlite");
  const seed = new LichessStore(storeFile);
  seed.close();
  await assert.rejects(prepareProviderReplacementInterlock({
    runtimeDir: directory,
    storeFile,
    allowUnowned: true,
    prepare: async () => { throw new Error("platform preparation failed"); },
  }), /platform preparation failed/u);
  const observed = new LichessStore(storeFile);
  try {
    assert.equal(observed.providerLifecycleSnapshot().admissionBlocked, false);
  } finally {
    observed.close();
  }
});

test("activation publishes maps and active slot before immediate session execution", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-game-activation-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let controller;
  let observedPublishedAuthority = false;
  let closes = 0;
  controller = new BotController({
    client: {},
    config: config(),
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
    statusPublisher: statusPublisher(),
    sessionFactory: ({ gameId }) => ({
      finished: true,
      run: async () => {
        observedPublishedAuthority = controller.gameSessions.has(gameId)
          && controller.activeGames.has(gameId)
          && controller.slots.findGame(gameId)?.state === "active";
        initializeGameArchive(store, gameId);
        store.finishGame({ id: gameId, status: "aborted", result: "", winner: "", plies: 0 });
      },
    }),
  });
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
    return slot;
  };
  try {
    await controller.startGame({
      gameId: "game-1",
      opponent: { id: "fixture-bot", title: "BOT" },
    });
    await Promise.all(controller.activeGames.values());
    assert.equal(observedPublishedAuthority, true);
    assert.equal(controller.activeGames.size, 0);
    assert.equal(controller.gameSessions.size, 0);
    assert.equal(controller.slots.snapshot().byAudience.bot.empty, 1);
    assert.equal(closes, 1);
    assert.equal(store.db.prepare("SELECT status FROM games WHERE game_id='game-1'").get().status, "aborted");
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("session failure persists provider_error and generation-owned cleanup closes once", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-game-error-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let closes = 0;
  const controller = new BotController({
    client: {},
    config: config(),
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
    statusPublisher: statusPublisher(),
    sessionFactory: () => ({
      finished: false,
      run: async () => { throw new Error("primary game failure"); },
    }),
  });
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
    return slot;
  };
  try {
    await controller.startGame({
      gameId: "game-2",
      opponent: { id: "fixture-bot", title: "BOT" },
    });
    await Promise.all(controller.activeGames.values());
    assert.equal(store.db.prepare("SELECT status FROM games WHERE game_id='game-2'").get().status, "provider_error");
    assert.equal(controller.slots.snapshot().byAudience.bot.empty, 1);
    assert.equal(closes, 1);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("session construction failure releases only its prepared generation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-game-construction-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let closes = 0;
  const controller = new BotController({
    client: {},
    config: config(),
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
    statusPublisher: statusPublisher(),
    sessionFactory: () => { throw new Error("session construction failed"); },
  });
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
    return slot;
  };
  try {
    await assert.rejects(controller.startGame({
      gameId: "game-construction",
      opponent: { id: "fixture-bot", title: "BOT" },
    }), /session construction failed/u);
    assert.equal(controller.activeGames.size, 0);
    assert.equal(controller.gameSessions.size, 0);
    assert.equal(controller.slots.snapshot().byAudience.bot.empty, 1);
    assert.equal(closes, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM games").get().count, 0);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("map publication failure compensates durable activation and closes once", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-game-publication-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let closes = 0;
  let runs = 0;
  const controller = new BotController({
    client: {},
    config: config(),
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
    statusPublisher: statusPublisher(),
    sessionFactory: () => ({
      finished: false,
      run: async () => { runs += 1; },
    }),
  });
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
    return slot;
  };
  controller.slots.active = () => { throw new Error("active publication failed"); };
  try {
    await assert.rejects(controller.startGame({
      gameId: "game-publication",
      opponent: { id: "fixture-bot", title: "BOT" },
    }), /active publication failed/u);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 0);
    assert.equal(controller.activeGames.size, 0);
    assert.equal(controller.gameSessions.size, 0);
    assert.equal(controller.slots.snapshot().byAudience.bot.empty, 1);
    assert.equal(closes, 1);
    assert.equal(
      store.db.prepare("SELECT status FROM games WHERE game_id='game-publication'").get().status,
      "activation_failed",
    );
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("durable activation consumes one reservation and challenge transition once", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-game-store-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  try {
    store.addOwner("fixture-human");
    store.reserve("fixture-human", 2, 30, 1_000);
    store.recordChallenge({
      id: "challenge-1",
      opponent: "fixture-human",
      audience: "human",
      direction: "inbound",
      status: "accepted",
    }, 1_000);
    const first = store.beginGameActivation({
      id: "game-3",
      opponent: "fixture-human",
      audience: "human",
      challengeId: "challenge-1",
    }, 2_000);
    const duplicate = store.beginGameActivation({
      id: "game-3",
      opponent: "fixture-human",
      audience: "human",
      challengeId: "challenge-1",
    }, 3_000);
    assert.equal(first.inserted, true);
    assert.equal(first.reservationConsumed, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.reservationConsumed, false);
    assert.equal(store.getReservation(3_000).games_remaining, 1);
  } finally {
    store.close();
  }
});

test("durable activation rolls back every owner transition on storage failure", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-game-rollback-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  try {
    store.addOwner("fixture-human");
    store.reserve("fixture-human", 2, 30, 1_000);
    store.recordChallenge({
      id: "challenge-rollback",
      opponent: "fixture-human",
      audience: "human",
      direction: "inbound",
      status: "pending",
    }, 1_000);
    store.db.exec(`
      CREATE TRIGGER fail_reservation_update BEFORE UPDATE ON reservations
      BEGIN SELECT RAISE(ABORT, 'fixture reservation failure'); END;
    `);
    assert.throws(() => store.beginGameActivation({
      id: "game-rollback",
      opponent: "fixture-human",
      audience: "human",
      challengeId: "challenge-rollback",
    }, 2_000), /fixture reservation failure/u);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM games WHERE game_id='game-rollback'").get().count,
      0,
    );
    assert.equal(
      store.db.prepare("SELECT status FROM challenge_attempts WHERE challenge_id='challenge-rollback'")
        .get().status,
      "pending",
    );
    assert.equal(store.getReservation(2_000).games_remaining, 2);
  } finally {
    store.close();
  }
});
