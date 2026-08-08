import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TEMPLATE,
  LichessClient,
  main,
  probeAccount,
} from "./lichess-adapter.mjs";
import { startFakeLichessApi } from "./fake-api-server.mjs";

const FIXTURE_TOKEN = "uci-arena-non-secret-test-token";
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function waitFor(predicate, {
  timeoutMs = 15_000,
  intervalMs = 25,
  message = "fixture condition was not observed",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

async function temporaryToken(value = FIXTURE_TOKEN) {
  const root = await mkdtemp(path.join(os.tmpdir(), "uci-arena-fake-lichess-"));
  const tokenFile = path.join(root, "operator-token.txt");
  await writeFile(tokenFile, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    tokenFile,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("loopback API server exercises the real account probe without a Lichess credential", async () => {
  const api = await startFakeLichessApi({ fixtureToken: FIXTURE_TOKEN });
  const token = await temporaryToken();
  try {
    assert.deepEqual(
      await probeAccount({
        tokenFile: token.tokenFile,
        expectedAccount: "fixturearenabot",
        url: api.origin,
      }),
      {
        username: "FixtureArenaBot",
        title: "BOT",
        is_bot: true,
        games: 0,
      },
    );
    assert.deepEqual(api.requests, [
      { method: "GET", path: "/api/account", form: {} },
    ]);
    assert.equal(JSON.stringify(api.requests).includes("Bearer"), false);
    assert.equal(JSON.stringify(api.requests).includes(FIXTURE_TOKEN), false);
  } finally {
    await token.close();
    await api.close();
  }
});

test("provider probe reaches the account API without a configured engine", async () => {
  const api = await startFakeLichessApi({ fixtureToken: FIXTURE_TOKEN });
  const token = await temporaryToken();
  const root = await mkdtemp(path.join(os.tmpdir(), "uci-arena-provider-probe-"));
  const configPath = path.join(root, "config.json");
  const runtimeDir = path.join(root, "runtime");
  const config = JSON.parse(await readFile(DEFAULT_TEMPLATE, "utf8"));
  config.url = api.origin;
  config.engine.executable = "";
  config.engine.working_directory = "";
  await writeFile(configPath, JSON.stringify(config), "utf8");
  const output = [];
  const originalLog = console.log;
  console.log = (line) => output.push(String(line));
  try {
    assert.equal(await main([
      "probe",
      "--config", configPath,
      "--token-file", token.tokenFile,
      "--runtime-dir", runtimeDir,
    ]), 0);
    assert.deepEqual(JSON.parse(output.at(-1)), {
      status: "ready",
      account: "FixtureArenaBot",
      is_bot: true,
      games: 0,
    });
    assert.deepEqual(api.requests, [
      { method: "GET", path: "/api/account", form: {} },
    ]);
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
    await token.close();
    await api.close();
  }
});

test("loopback API server rejects bad bearer values and non-BOT account fixtures", async () => {
  const rejectedApi = await startFakeLichessApi({ fixtureToken: FIXTURE_TOKEN });
  const rejectedToken = await temporaryToken("different-non-secret-test-token");
  try {
    await assert.rejects(
      probeAccount({
        tokenFile: rejectedToken.tokenFile,
        url: rejectedApi.origin,
      }),
      /HTTP 401/,
    );
    assert.equal(JSON.stringify(rejectedApi.requests).includes(FIXTURE_TOKEN), false);
  } finally {
    await rejectedToken.close();
    await rejectedApi.close();
  }

  const humanApi = await startFakeLichessApi({
    fixtureToken: FIXTURE_TOKEN,
    state: {
      account: {
        id: "fixturehuman",
        username: "FixtureHuman",
        count: { all: 3 },
      },
    },
  });
  const humanToken = await temporaryToken();
  try {
    await assert.rejects(
      probeAccount({
        tokenFile: humanToken.tokenFile,
        url: humanApi.origin,
      }),
      /not a BOT account/,
    );
  } finally {
    await humanToken.close();
    await humanApi.close();
  }
});

test("loopback API server simulates NDJSON, challenges, and move submission", async () => {
  const api = await startFakeLichessApi({
    fixtureToken: FIXTURE_TOKEN,
    state: {
      eventStream: [{ type: "gameStart", game: { id: "fixture-game" } }],
      gameStreams: {
        "fixture-game": [
          {
            type: "gameFull",
            id: "fixture-game",
            state: { moves: "", status: "started" },
          },
        ],
      },
    },
  });
  const client = new LichessClient({
    token: FIXTURE_TOKEN,
    baseUrl: api.origin,
  });
  try {
    assert.deepEqual(await client.json("api/account/playing"), {
      nowPlaying: [],
    });
    assert.equal(
      (await client.json("api/user/FixtureOpponent")).username,
      "FixtureOpponent",
    );

    const online = [];
    for await (const row of client.stream("api/bot/online?nb=512")) {
      online.push(row);
    }
    assert.equal(online[0].username, "FixtureOpponent");

    const events = [];
    for await (const row of client.stream("api/stream/event")) {
      events.push(row);
    }
    assert.equal(events[0].game.id, "fixture-game");

    const games = [];
    for await (const row of client.stream("api/bot/game/stream/fixture-game")) {
      games.push(row);
    }
    assert.equal(games[0].type, "gameFull");

    const created = await client.postJson(
      "api/challenge/FixtureOpponent",
      { rated: false, clockLimit: 180, clockIncrement: 2 },
    );
    assert.equal(created.challenge.opponent, "FixtureOpponent");
    await client.post("api/challenge/inbound/accept", {});
    await client.post("api/challenge/inbound/decline", { reason: "later" });
    await client.post("api/challenge/outbound/cancel", {});
    await client.post(
      "api/bot/game/fixture-game/move/e2e4",
      { offeringDraw: false },
    );
    assert.deepEqual(api.state.moves, [
      {
        gameId: "fixture-game",
        move: "e2e4",
        form: { offeringDraw: "false" },
      },
    ]);
    assert.deepEqual(
      api.state.challenges.map(({ action }) => action),
      ["create", "accept", "decline", "cancel"],
    );
    assert.equal(JSON.stringify(api.requests).includes("authorization"), false);
    assert.equal(JSON.stringify(api.requests).includes(FIXTURE_TOKEN), false);
  } finally {
    await api.close();
  }
});

test("loopback API drives the complete adapter through a spawned UCI child and legal move POST", {
  timeout: 30_000,
}, async () => {
  const gameId = "fixture-complete-game";
  const api = await startFakeLichessApi({
    fixtureToken: FIXTURE_TOKEN,
    state: {
      playing: [{
        gameId,
        opponent: {
          id: "fixtureopponent",
          username: "FixtureOpponent",
          title: "BOT",
        },
      }],
      gameStreams: {
        [gameId]: [{
          type: "gameFull",
          id: gameId,
          variant: { key: "standard" },
          initialFen: "startpos",
          white: { id: "fixturearenabot", username: "FixtureArenaBot" },
          black: { id: "fixtureopponent", username: "FixtureOpponent" },
          rated: false,
          speed: "blitz",
          clock: { initial: 180_000, increment: 2_000 },
          state: {
            type: "gameState",
            moves: "",
            status: "started",
            wtime: 180_000,
            btime: 180_000,
            winc: 2_000,
            binc: 2_000,
          },
        }],
      },
    },
  });
  const token = await temporaryToken();
  const root = await mkdtemp(path.join(os.tmpdir(), "uci-arena-complete-lichess-"));
  const configPath = path.join(root, "config.json");
  const runtimeDir = path.join(root, "runtime");
  const storePath = path.join(root, "matches.sqlite");
  const config = JSON.parse(await readFile(DEFAULT_TEMPLATE, "utf8"));
  config.url = api.origin;
  config.engine = {
    adapter: "standard_uci_v1",
    executable: process.execPath,
    arguments: [path.join(HERE, "test-fixtures", "fake-standard-uci-engine.mjs")],
    working_directory: HERE,
    search_timeout_grace_ms: 1_000,
    shutdown_grace_ms: 1_000,
    uci_options: {},
  };
  config.timing.opponent_turn_search = false;
  config.capacity = {
    total_slots: 1,
    capacity_profile: null,
    startup_parallelism: 1,
    human: { slots: 0, allow_borrowing: false, accept_public: false },
    bot: { slots: 1, target_active: 0 },
  };
  config.scheduler.enabled = false;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const child = spawn(process.execPath, [
    path.join(HERE, "lichess-adapter.mjs"),
    "run",
    "--config", configPath,
    "--token-file", token.tokenFile,
    "--expected-account", "fixturearenabot",
    "--runtime-dir", runtimeDir,
    "--store", storePath,
  ], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_768); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-32_768); });
  const exited = once(child, "exit");
  try {
    await Promise.race([
      waitFor(() => api.state.moves.length === 1, {
        message: `complete adapter did not submit a move; output=${output}`,
      }),
      exited.then(([code, signal]) => {
        throw new Error(`complete adapter exited before move submission: ${code}/${signal}; ${output}`);
      }),
    ]);
    assert.deepEqual(api.state.moves, [{
      gameId,
      move: "e2e4",
      form: {},
    }]);
    assert.ok(api.requests.some((request) => (
      request.method === "GET" && request.path === "/api/account/playing"
    )));
    assert.ok(api.requests.some((request) => (
      request.method === "GET" && request.path === `/api/bot/game/stream/${gameId}`
    )));
    assert.ok(api.requests.some((request) => (
      request.method === "POST" && request.path === `/api/bot/game/${gameId}/move/e2e4`
    )));
    assert.equal(JSON.stringify(api.requests).includes(FIXTURE_TOKEN), false);
    child.stdin.end("shutdown\n");
    const [code, signal] = await exited;
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled([exited]);
    await rm(root, { recursive: true, force: true });
    await token.close();
    await api.close();
  }
});

test("fake Lichess API refuses non-loopback binding", async () => {
  await assert.rejects(
    startFakeLichessApi({ host: "0.0.0.0", fixtureToken: FIXTURE_TOKEN }),
    /only to loopback/,
  );
});
