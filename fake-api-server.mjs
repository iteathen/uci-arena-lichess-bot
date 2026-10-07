import http from "node:http";
import { once } from "node:events";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOURNAL_ROWS = 256;

function jsonResponse(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function emptyResponse(response, status = 200) {
  response.writeHead(status, { "Content-Length": "0" });
  response.end();
}

function ndjsonResponse(response, values) {
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  const terminated = body ? `${body}\n` : "";
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Length": Buffer.byteLength(terminated),
  });
  response.end(terminated);
}

async function timedNdjsonResponse(response, records) {
  response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
  for await (const value of records()) {
    if (response.destroyed) break;
    response.write(`${JSON.stringify(value)}\n`);
  }
  if (!response.destroyed) response.end();
}

async function boundedBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body exceeds fixture limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizedUser(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function defaultState() {
  const account = {
    id: "fixturearenabot",
    username: "FixtureArenaBot",
    title: "BOT",
    count: { all: 0 },
  };
  const opponent = {
    id: "fixtureopponent",
    username: "FixtureOpponent",
    title: "BOT",
    disabled: false,
    perfs: { blitz: { rating: 1800 } },
  };
  return {
    account,
    users: {
      [normalizedUser(account.username)]: account,
      [normalizedUser(opponent.username)]: opponent,
    },
    playing: [],
    onlineBots: [opponent],
    eventStream: [],
    gameStreams: {},
    challengeSequence: 0,
    challenges: [],
    moves: [],
    aborts: [],
  };
}

function journalRequest(journal, request, pathname, form) {
  if (journal.length >= MAX_JOURNAL_ROWS) journal.shift();
  journal.push({
    method: request.method,
    path: pathname,
    form,
  });
}

export async function startFakeLichessApi({
  host = "127.0.0.1",
  fixtureToken,
  state: suppliedState = {},
} = {}) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("fake Lichess API may bind only to loopback");
  }
  if (typeof fixtureToken !== "string" || fixtureToken.length < 8) {
    throw new Error("fake Lichess API requires an explicit non-secret fixture token");
  }
  const state = { ...defaultState(), ...suppliedState };
  state.users = { ...defaultState().users, ...(suppliedState.users ?? {}) };
  state.gameStreams = { ...(suppliedState.gameStreams ?? {}) };
  state.challenges = [...(suppliedState.challenges ?? [])];
  state.moves = [...(suppliedState.moves ?? [])];
  const requests = [];

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await boundedBody(request);
      const form = body
        ? Object.fromEntries(new URLSearchParams(body).entries())
        : {};
      journalRequest(requests, request, url.pathname, form);

      if (request.headers.authorization !== `Bearer ${fixtureToken}`) {
        jsonResponse(response, 401, {
          error: "fixture authentication rejected",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/account") {
        jsonResponse(response, 200, state.account);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/account/playing") {
        jsonResponse(response, 200, { nowPlaying: state.playing });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bot/online") {
        ndjsonResponse(response, state.onlineBots);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/stream/event") {
        ndjsonResponse(response, state.eventStream);
        return;
      }

      const userMatch = /^\/api\/user\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && userMatch) {
        const user = state.users[normalizedUser(decodeURIComponent(userMatch[1]))];
        if (!user) {
          jsonResponse(response, 404, { error: "fixture user not found" });
          return;
        }
        jsonResponse(response, 200, user);
        return;
      }

      const gameStreamMatch =
        /^\/api\/bot\/game\/stream\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && gameStreamMatch) {
        const records = state.gameStreams[decodeURIComponent(gameStreamMatch[1])] ?? [];
        if (typeof records === "function") {
          await timedNdjsonResponse(response, records);
          return;
        }
        ndjsonResponse(
          response,
          records,
        );
        return;
      }

      const challengeActionMatch =
        /^\/api\/challenge\/([^/]+)\/(accept|decline|cancel)$/.exec(url.pathname);
      if (request.method === "POST" && challengeActionMatch) {
        state.challenges.push({
          id: decodeURIComponent(challengeActionMatch[1]),
          action: challengeActionMatch[2],
          form,
        });
        emptyResponse(response);
        return;
      }

      const challengeMatch = /^\/api\/challenge\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && challengeMatch) {
        state.challengeSequence += 1;
        const challenge = {
          id: `fixture-challenge-${state.challengeSequence}`,
          opponent: decodeURIComponent(challengeMatch[1]),
          form,
        };
        state.challenges.push({ ...challenge, action: "create" });
        jsonResponse(response, 200, { challenge });
        return;
      }

      const moveMatch =
        /^\/api\/bot\/game\/([^/]+)\/move\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && moveMatch) {
        state.moves.push({
          gameId: decodeURIComponent(moveMatch[1]),
          move: decodeURIComponent(moveMatch[2]),
          form,
        });
        emptyResponse(response);
        return;
      }

      const abortMatch = /^\/api\/bot\/game\/([^/]+)\/abort$/.exec(url.pathname);
      if (request.method === "POST" && abortMatch) {
        state.aborts.push({
          gameId: decodeURIComponent(abortMatch[1]),
          form,
        });
        jsonResponse(response, 200, { ok: true });
        return;
      }

      jsonResponse(response, 404, { error: "fixture route not found" });
    } catch (error) {
      jsonResponse(response, 400, {
        error: error instanceof Error ? error.message : "invalid fixture request",
      });
    }
  });
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("fake Lichess API did not expose a TCP address");
  }
  return {
    origin: `http://${host === "::1" ? "[::1]" : host}:${address.port}/`,
    requests,
    state,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}
