import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  LIVE_ACCEPTANCE_CONFIRMATION,
  validateLiveAcceptanceParticipants,
} from "./lichess-adapter.mjs";
import {
  acceptanceChildEnvironment,
  adapterArguments,
  buildAcceptanceConfig,
  executeAcceptancePlan,
  observeAcceptanceEvent,
  validateAcceptanceOptions,
} from "./live-acceptance.mjs";

function options(overrides = {}) {
  return validateAcceptanceOptions({
    confirm: LIVE_ACCEPTANCE_CONFIRMATION,
    expected_account: "OperatorBot",
    opponent: "PublicBot",
    token_file: "opaque-token-path",
    attempts: "3",
    minutes: "20",
    ...overrides,
  });
}

function mockApi(routes) {
  const requests = [];
  return {
    requests,
    async json(endpoint) {
      requests.push(endpoint);
      if (!(endpoint in routes)) throw new Error(`unexpected mock API endpoint: ${endpoint}`);
      return structuredClone(routes[endpoint]);
    },
    async collectNdjson(endpoint) {
      requests.push(endpoint);
      if (!(endpoint in routes)) throw new Error(`unexpected mock API endpoint: ${endpoint}`);
      return structuredClone(routes[endpoint]);
    },
  };
}

test("mock API accepts only the named online public BOT and no unrelated game", async () => {
  const client = mockApi({
    "api/user/publicbot": {
      id: "publicbot",
      title: "BOT",
    },
    "api/bot/online?nb=512": [{ id: "publicbot", title: "BOT" }],
    "api/account/playing?nb=50": { nowPlaying: [] },
  });
  const result = await validateLiveAcceptanceParticipants({
    client,
    account: "operatorbot",
    target: "publicbot",
  });
  assert.deepEqual(result, {
    account: "operatorbot",
    target: "publicbot",
    target_title: "BOT",
    target_online: true,
    recovered_game_id: null,
  });
  assert.deepEqual(client.requests, [
    "api/user/publicbot",
    "api/bot/online?nb=512",
    "api/account/playing?nb=50",
  ]);
});

test("mock API fails closed for non-BOT, offline, and unrelated active games", async () => {
  for (const profile of [
    { id: "publicbot", title: null },
    { id: "publicbot", title: "BOT" },
    { id: "publicbot", title: "BOT", disabled: true },
  ]) {
    const client = mockApi({
      "api/user/publicbot": profile,
      "api/bot/online?nb=512": [],
      "api/account/playing?nb=50": { nowPlaying: [] },
    });
    await assert.rejects(
      validateLiveAcceptanceParticipants({
        client,
        account: "operatorbot",
        target: "publicbot",
      }),
      /not BOT-titled|not online|not a public usable account/,
    );
  }
  const client = mockApi({
    "api/user/publicbot": { id: "publicbot", title: "BOT" },
    "api/bot/online?nb=512": [{ id: "publicbot", title: "BOT" }],
    "api/account/playing?nb=50": {
      nowPlaying: [{ gameId: "other-game", opponent: { id: "otherbot" } }],
    },
  });
  await assert.rejects(
    validateLiveAcceptanceParticipants({
      client,
      account: "operatorbot",
      target: "publicbot",
    }),
    /unrelated active game/,
  );
});

test("acceptance activation is explicit and hard-capped", () => {
  assert.throws(
    () => options({ confirm: "yes" }),
    /exact explicit confirmation/,
  );
  assert.throws(
    () => options({ attempts: "4" }),
    /1\.\.3/,
  );
  assert.throws(
    () => options({ minutes: "21" }),
    /1\.\.20/,
  );
});

test("acceptance config permits only the explicit casual outbound target", () => {
  const config = buildAcceptanceConfig({
    schema: "uci_arena_lichess_adapter_v5",
    scheduler: { enabled: true },
    capacity: {
      human: { slots: 1, accept_public: true },
      bot: { slots: 1, target_active: 1 },
    },
    challenges: { accept_bots: true, modes: ["casual", "rated"] },
    outbound_challenge: { rated: true, color: "white" },
  });
  assert.equal(config.scheduler.enabled, false);
  assert.equal(config.capacity.total_slots, 1);
  assert.equal(config.capacity.startup_parallelism, 1);
  assert.equal(config.capacity.human.slots, 0);
  assert.equal(config.capacity.bot.slots, 1);
  assert.equal(config.capacity.bot.target_active, 0);
  assert.equal(config.capacity.human.accept_public, false);
  assert.equal(config.challenges.accept_bots, false);
  assert.deepEqual(config.challenges.modes, ["casual"]);
  assert.equal(config.outbound_challenge.rated, false);
});

test("acceptance passes exact installed runtime bindings and shared knowledge root", () => {
  const args = adapterArguments({
    token_file: "token.txt",
    expected_account: "operatorbot",
    opponent: "publicbot",
    engine: "installed/bin/flashfork_uci.exe",
    working_directory: "installed",
    model_root: "installed/models/default",
  }, "acceptance.json", "runtime");
  const engineIndex = args.indexOf("--engine");
  assert.equal(args[engineIndex + 1], path.resolve("installed/bin/flashfork_uci.exe"));
  assert.equal(args[engineIndex + 2], "--working-directory");
  assert.equal(args[engineIndex + 3], path.resolve("installed"));
  const environment = acceptanceChildEnvironment(
    { knowledge_root: "shared/knowledge" },
    { SENTINEL: "retained" },
  );
  assert.equal(environment.SENTINEL, "retained");
  assert.equal(environment.UCI_ARENA_KNOWLEDGE_ROOT, path.resolve("shared/knowledge"));
});

test("event evidence requires a completed game against the named opponent", () => {
  const initial = {
    challengeCreated: false,
    gameStarted: false,
    gameId: null,
    terminal: null,
  };
  const started = observeAcceptanceEvent(initial, {
    event: "game_started",
    game_id: "g1",
    opponent: "publicbot",
  }, "publicbot");
  assert.equal(started.terminal, null);
  const completed = observeAcceptanceEvent(started, {
    event: "game_finished",
    game_id: "g1",
    opponent: "publicbot",
    status: "mate",
    result: "win",
  }, "publicbot");
  assert.equal(completed.terminal.status, "completed");
  const unrelated = observeAcceptanceEvent(initial, {
    event: "game_finished",
    game_id: "g2",
    opponent: "otherbot",
    status: "draw",
  }, "publicbot");
  assert.equal(unrelated.terminal.status, "inconclusive");
  const aborted = observeAcceptanceEvent(started, {
    event: "game_finished",
    game_id: "g1",
    opponent: "publicbot",
    status: "aborted",
  }, "publicbot");
  assert.equal(aborted.terminal.status, "inconclusive");
});

test("fatal evidence without an opponent preserves the provider diagnostic", () => {
  const observed = observeAcceptanceEvent({
    challengeCreated: false,
    gameStarted: false,
    gameId: null,
    terminal: null,
  }, {
    event: "adapter_fatal",
    message: "profile evidence is missing",
  }, "publicbot");
  assert.deepEqual(observed.terminal, {
    status: "inconclusive",
    reason: "profile evidence is missing",
  });
});

test("attempt plan retries bounded challenge failures and requires completion", async () => {
  const outcomes = [
    { status: "retryable", reason: "declined", challengeAttempted: true },
    {
      status: "completed",
      gameId: "game-1",
      opponent: "publicbot",
      gameStatus: "mate",
      result: "win",
      challengeAttempted: true,
    },
  ];
  const result = await executeAcceptancePlan({
    options: options(),
    now: () => 1_000,
    runAttempt: async () => outcomes.shift(),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.game_id, "game-1");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.challenge_attempts, 2);
});

test("inconclusive and exhausted attempts fail closed but can be rerun", async () => {
  await assert.rejects(
    executeAcceptancePlan({
      options: options(),
      now: () => 1_000,
      runAttempt: async () => ({ status: "inconclusive", reason: "API ambiguity" }),
    }),
    /inconclusive/,
  );
  await assert.rejects(
    executeAcceptancePlan({
      options: options(),
      now: () => 1_000,
      runAttempt: async () => ({ status: "retryable", reason: "declined" }),
    }),
    /exhausted 3/,
  );
});
