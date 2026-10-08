import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
  runSpawnedAttempt,
  terminateChild,
  validateAcceptanceOptions,
} from "./live-acceptance.mjs";
import { ExactFileError, exactFiles } from "./exact-file.mjs";

function logAttemptFixture(t) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "arena-live-log-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const logPath = path.join(runtimeDir, "adapter.ndjson");
  writeFileSync(logPath, "");
  let clock = 0;
  let spawns = 0;
  let shutdowns = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = { writable: true, end(value) {
    assert.equal(value, "shutdown\n");
    shutdowns += 1;
    child.exitCode = 0;
  } };
  child.kill = () => assert.fail("Fixture should shut down gracefully");
  return {
    runtimeDir, logPath, child,
    get spawns() { return spawns; },
    get shutdowns() { return shutdowns; },
    append(event) { appendFileSync(logPath, `${JSON.stringify(event)}\n`); },
    run(overrides = {}) {
      return runSpawnedAttempt({ options: options(), configPath: "synthetic-config.json", runtimeDir,
        deadline: 1000, now: () => clock,
        waitImpl: async (milliseconds) => { clock += milliseconds; },
        spawnImpl: () => { spawns += 1; return child; }, ...overrides });
    },
  };
}

const finishedEvent = { event: "game_finished", game_id: "new-game", opponent: "publicbot", status: "mate" };

test("live log concurrent admission append defers and later delivers completed event", async (t) => {
  const fixture = logAttemptFixture(t);
  let reads = 0;
  const result = await fixture.run({
    spawnImpl: () => { fixture.append({ event: "game_started", game_id: "new-game", opponent: "publicbot" }); return fixture.child; },
    fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
      reads += 1;
      return exactFiles.readExactFileSync(filename, { ...readOptions, hooks: {
        afterPathAdmission: () => { if (reads === 2) fixture.append(finishedEvent); },
      } });
    } },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.gameId, "new-game");
  assert.equal(reads, 3);
  assert.equal(fixture.shutdowns, 1);
});

test("live log append after fstat discards unadmitted bytes and preserves partial record", async (t) => {
  const fixture = logAttemptFixture(t);
  let reads = 0;
  const line = `${JSON.stringify(finishedEvent)}\n`;
  const result = await fixture.run({
    spawnImpl: () => { appendFileSync(fixture.logPath, line.slice(0, 20)); return fixture.child; },
    fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
      reads += 1;
      return exactFiles.readExactFileSync(filename, { ...readOptions, hooks: {
        afterOpen: () => { if (reads === 3) appendFileSync(filename, line.slice(20)); },
      } });
    } },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.gameId, "new-game");
  assert.equal(reads, 4);
  assert.equal(fixture.shutdowns, 1);
});

test("initial log admission append is retried before spawn and old completion is excluded", async (t) => {
  const fixture = logAttemptFixture(t);
  let reads = 0;
  const result = await fixture.run({ fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
    reads += 1;
    return exactFiles.readExactFileSync(filename, { ...readOptions, hooks: {
      afterPathAdmission: () => { if (reads === 1) fixture.append(finishedEvent); },
    } });
  } } });
  assert.equal(result.status, "inconclusive");
  assert.match(result.reason, /wall-clock limit/);
  assert.equal(fixture.spawns, 1);
  assert.equal(fixture.shutdowns, 1);
});

for (const initial of [false, true]) {
  test(`repeated log mutation reaches deadline without invented completion (initial=${initial})`, async (t) => {
    const fixture = logAttemptFixture(t);
    let reads = 0;
    const result = await fixture.run({ fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
      reads += 1;
      return exactFiles.readExactFileSync(filename, { ...readOptions, hooks: {
        afterPathAdmission: () => { if (initial || reads > 1) fixture.append(finishedEvent); },
      } });
    } } });
    assert.equal(result.status, "inconclusive");
    assert.match(result.reason, /wall-clock limit/);
    assert.equal(fixture.spawns, initial ? 0 : 1);
    assert.equal(fixture.shutdowns, initial ? 0 : 1);
    assert.equal(reads, initial ? 4 : 5);
  });
}

for (const code of ["EXACT_FILE_TOO_LARGE", "EXACT_FILE_TYPE_INVALID", "EXACT_FILE_READ_FAILED", "EXACT_FILE_OPERATION_AND_CLOSE_FAILED"]) {
  test(`live log rejects non-mutation ${code}`, async (t) => {
    const fixture = logAttemptFixture(t);
    const failure = new ExactFileError(code, "Synthetic log", "rejected");
    let reads = 0;
    await assert.rejects(fixture.run({ fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
      if (++reads === 2) throw failure;
      return exactFiles.readExactFileSync(filename, readOptions);
    } } }), (error) => error === failure);
    assert.equal(reads, 2);
    assert.equal(fixture.shutdowns, 1);
  });
}

test("live log observed object substitution remains rejected", async (t) => {
  const fixture = logAttemptFixture(t);
  let reads = 0;
  await assert.rejects(fixture.run({ fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
    reads += 1;
    return exactFiles.readExactFileSync(filename, { ...readOptions, hooks: {
      afterPathAdmission: () => {
        if (reads === 2) { renameSync(filename, `${filename}.old`); writeFileSync(filename, `${JSON.stringify(finishedEvent)}\n`); }
      },
    } });
  } } }), (error) => error instanceof ExactFileError && error.code === "EXACT_FILE_IDENTITY_CHANGED");
  assert.equal(reads, 2);
  assert.equal(fixture.shutdowns, 1);
});

test("live log growth beyond quota is rejected rather than deferred", async (t) => {
  const fixture = logAttemptFixture(t);
  let reads = 0;
  await assert.rejects(fixture.run({ fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
    reads += 1;
    return exactFiles.readExactFileSync(filename, { ...readOptions, hooks: {
      afterPathAdmission: () => {
        if (reads === 2) appendFileSync(filename, Buffer.alloc(readOptions.maximumBytes + 1));
      },
    } });
  } } }), (error) => error instanceof ExactFileError && error.code === "EXACT_FILE_TOO_LARGE");
  assert.equal(reads, 2);
  assert.equal(fixture.shutdowns, 1);
});

test("live log unknown error with a mutation-shaped code remains rejected", async (t) => {
  const fixture = logAttemptFixture(t);
  const failure = Object.assign(new Error("Synthetic unexpected failure"), { code: "EXACT_FILE_IDENTITY_CHANGED" });
  let reads = 0;
  await assert.rejects(fixture.run({ fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
    if (++reads === 2) throw failure;
    return exactFiles.readExactFileSync(filename, readOptions);
  } } }), (error) => error === failure);
  assert.equal(fixture.shutdowns, 1);
});

test("live log missing poll preserves the admitted partial record", async (t) => {
  const fixture = logAttemptFixture(t);
  const line = `${JSON.stringify(finishedEvent)}\n`;
  let classifications = 0;
  const result = await fixture.run({
    spawnImpl: () => { appendFileSync(fixture.logPath, line.slice(0, 20)); return fixture.child; },
    fileAuthority: { ...exactFiles, classifyExactPathSync(filename, readOptions) {
      if (++classifications === 3) {
        appendFileSync(filename, line.slice(20));
        return { kind: "missing" };
      }
      return exactFiles.classifyExactPathSync(filename, readOptions);
    } },
  });
  assert.equal(result.status, "completed");
  assert.equal(classifications, 4);
  assert.equal(fixture.shutdowns, 1);
});

test("live log mutation on child exit is observed at the next bounded poll", async (t) => {
  const fixture = logAttemptFixture(t);
  let reads = 0;
  const result = await fixture.run({ fileAuthority: { ...exactFiles, readExactFileSync(filename, readOptions) {
    reads += 1;
    return exactFiles.readExactFileSync(filename, { ...readOptions, hooks: {
      afterPathAdmission: () => {
        if (reads === 2) {
          fixture.append(finishedEvent);
          fixture.child.exitCode = 0;
          fixture.child.emit("exit", 0);
        }
      },
    } });
  } } });
  assert.equal(result.status, "completed");
  assert.equal(reads, 3);
  assert.equal(fixture.shutdowns, 0);
});

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

test("acceptance requests graceful child shutdown before forced termination", async () => {
  const actions = [];
  const child = {
    exitCode: null,
    signalCode: null,
    stdin: {
      writable: true,
      end(value) {
        actions.push(["stdin", value]);
        child.exitCode = 0;
      },
    },
    kill(signal) {
      actions.push(["kill", signal]);
    },
  };
  await terminateChild(child);
  assert.deepEqual(actions, [["stdin", "shutdown\n"]]);
});

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
    schema: "uci_arena_lichess_adapter_v8",
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
      engine: "installed/bin/uci_arena_engine.exe",
    working_directory: "installed",
    model_root: "installed/models/default",
  }, "acceptance.json", "runtime");
  const engineIndex = args.indexOf("--engine");
    assert.equal(args[engineIndex + 1], path.resolve("installed/bin/uci_arena_engine.exe"));
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
