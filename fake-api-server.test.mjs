import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LichessClient,
  probeAccount,
} from "./lichess-adapter.mjs";
import { startFakeLichessApi } from "./fake-api-server.mjs";

const FIXTURE_TOKEN = "uci-arena-non-secret-test-token";

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

test("fake Lichess API refuses non-loopback binding", async () => {
  await assert.rejects(
    startFakeLichessApi({ host: "0.0.0.0", fixtureToken: FIXTURE_TOKEN }),
    /only to loopback/,
  );
});
