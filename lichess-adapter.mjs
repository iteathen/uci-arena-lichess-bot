#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const REPO_PLACEHOLDER = "<UCI_ARENA_REPO>";
export const DEFAULT_TEMPLATE = path.join(HERE, "config.uci_arena.template.yml");
export const DEFAULT_TOKEN_FILE = path.join(ROOT, "secrets", "lichess_bot_token.txt");
export const DEFAULT_RUNTIME_DIR = path.join(HERE, "runtime");

function replaceRepoPlaceholder(value, repoRoot) {
  if (typeof value === "string") {
    return value.split(REPO_PLACEHOLDER).join(repoRoot.replaceAll("\\", "/"));
  }
  if (Array.isArray(value)) return value.map((item) => replaceRepoPlaceholder(item, repoRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceRepoPlaceholder(item, repoRoot)]),
    );
  }
  return value;
}

export function loadRuntimeConfig({
  templatePath = DEFAULT_TEMPLATE,
  repoRoot = ROOT,
  modelRoot,
} = {}) {
  const parsed = JSON.parse(readFileSync(templatePath, "utf8"));
  if (parsed.schema !== "uci_arena_lichess_adapter_v1") {
    throw new Error(`Unsupported Lichess adapter config schema: ${parsed.schema ?? "missing"}`);
  }
  const serialized = JSON.stringify(parsed).toLowerCase();
  if (serialized.includes("oauth_token") || serialized.includes("bearer ")) {
    throw new Error("Tracked Lichess config must not contain credentials");
  }
  const config = replaceRepoPlaceholder(parsed, path.resolve(repoRoot));
  if (!config.engine?.executable || !config.engine?.working_directory) {
    throw new Error("Lichess adapter config is missing engine paths");
  }
  if (!config.engine.uci_options || typeof config.engine.uci_options !== "object") {
    throw new Error("Lichess adapter config is missing engine UCI options");
  }
  if (modelRoot) config.engine.uci_options.ModelRoot = modelRoot;
  return config;
}

export function parseNdjsonStream(stream) {
  return (async function* parse() {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield JSON.parse(line);
      }
    }
    const finalLine = `${buffered}${decoder.decode()}`.trim();
    if (finalLine) yield JSON.parse(finalLine);
  })();
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Operation aborted"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Operation aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function readTokenForRuntime(tokenFile) {
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error("Lichess token file is empty");
  return token;
}

export class LichessClient {
  constructor({ token, baseUrl = "https://lichess.org/", fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async request(endpoint, { method = "GET", form, stream = false, signal } = {}) {
    const headers = {
      Accept: stream ? "application/x-ndjson" : "application/json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "UCI-Arena-Lichess-Adapter/1",
    };
    let body;
    if (form) {
      body = new URLSearchParams(Object.entries(form).map(([key, value]) => [key, String(value)]));
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const response = await this.fetchImpl(new URL(endpoint, this.baseUrl), {
      method,
      headers,
      body,
      signal,
    });
    if (!response.ok) {
      throw new Error(`Lichess ${method} ${endpoint} failed with HTTP ${response.status}`);
    }
    return response;
  }

  async json(endpoint, options) {
    return (await this.request(endpoint, options)).json();
  }

  async post(endpoint, form, signal) {
    return this.request(endpoint, { method: "POST", form, signal });
  }

  async openStream(endpoint, signal) {
    const response = await this.request(endpoint, { stream: true, signal });
    return parseNdjsonStream(response.body);
  }

  async *stream(endpoint, signal) {
    yield* await this.openStream(endpoint, signal);
  }
}

export async function probeAccount({
  tokenFile,
  expectedAccount,
  url = "https://lichess.org/",
  fetchImpl = globalThis.fetch,
}) {
  const client = new LichessClient({
    token: readTokenForRuntime(tokenFile),
    baseUrl: url,
    fetchImpl,
  });
  const profile = await client.json("api/account");
  const username = String(profile.username ?? profile.id ?? "");
  if (username.toLocaleLowerCase() !== expectedAccount.toLocaleLowerCase()) {
    throw new Error(`Authenticated Lichess account mismatch: ${username}`);
  }
  const games = Number(profile.count?.all ?? 0);
  if (String(profile.title ?? "").toUpperCase() !== "BOT") {
    const eligibility = games > 0 ? `; prior games=${games}, so Lichess BOT conversion is unavailable` : "";
    throw new Error(`Authenticated Lichess account is not a BOT account: ${username}${eligibility}`);
  }
  return { username, title: "BOT", is_bot: true, games };
}

function parseInfo(line) {
  const telemetry = {};
  for (const key of ["depth", "seldepth", "nodes", "nps", "time", "hashfull"]) {
    const match = line.match(new RegExp(`(?:^| )${key} (\\d+)`));
    if (match) telemetry[key] = Number(match[1]);
  }
  const score = line.match(/(?:^| )score (cp|mate) (-?\d+)/);
  if (score) telemetry.score = { unit: score[1], value: Number(score[2]) };
  return telemetry;
}

export class UciEngine {
  constructor(config, telemetry = () => {}) {
    this.config = config;
    this.telemetry = telemetry;
    this.waiters = [];
    this.advertisedOptions = new Set();
    this.latestInfo = {};
  }

  async start() {
    if (!existsSync(this.config.executable)) {
      throw new Error(`UCI executable not found: ${this.config.executable}`);
    }
    this.child = spawn(this.config.executable, [], {
      cwd: this.config.working_directory,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) this.telemetry({ event: "engine_stderr", message: text });
    });
    this.child.once("error", (error) => this.rejectWaiters(error));
    this.child.once("exit", (code) => this.rejectWaiters(new Error(`UCI engine exited with ${code}`)));

    await this.exchange("uci", (line) => line === "uciok", 30_000);
    const unknown = Object.keys(this.config.uci_options)
      .filter((name) => !this.advertisedOptions.has(name));
    if (unknown.length) throw new Error(`Configured UCI options are not advertised: ${unknown.join(", ")}`);
    for (const [name, value] of Object.entries(this.config.uci_options)) {
      this.send(`setoption name ${name} value ${String(value)}`);
    }
    await this.exchange("isready", (line) => line === "readyok", 30_000);
  }

  onLine(line) {
    if (line.startsWith("option name ") && line.includes(" type ")) {
      this.advertisedOptions.add(line.slice("option name ".length).split(" type ", 1)[0]);
    }
    if (line.startsWith("info ")) this.latestInfo = parseInfo(line);
    const match = this.waiters.findIndex((waiter) => waiter.predicate(line));
    if (match >= 0) {
      const [waiter] = this.waiters.splice(match, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  send(command) {
    if (!this.child?.stdin.writable) throw new Error("UCI engine stdin is not writable");
    this.child.stdin.write(`${command}\n`);
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`UCI response timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  exchange(command, predicate, timeoutMs) {
    const response = this.waitFor(predicate, timeoutMs);
    this.send(command);
    return response;
  }

  async newGame() {
    this.send("ucinewgame");
    await this.exchange("isready", (line) => line === "readyok", 30_000);
  }

  async search({ moves, wtime, btime, winc, binc, color }) {
    this.latestInfo = {};
    this.send(moves.length ? `position startpos moves ${moves.join(" ")}` : "position startpos");
    const ownTime = color === "white" ? wtime : btime;
    const timeoutMs = Math.max(10_000, ownTime + Number(this.config.search_timeout_grace_ms ?? 10_000));
    const command = `go wtime ${wtime} btime ${btime} winc ${winc} binc ${binc}`;
    const line = await this.exchange(command, (candidate) => candidate.startsWith("bestmove "), timeoutMs);
    const bestmove = line.split(/\s+/)[1];
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestmove)) {
      throw new Error(`UCI engine returned unusable bestmove: ${bestmove ?? "missing"}`);
    }
    return { bestmove, telemetry: this.latestInfo };
  }

  close() {
    if (!this.child) return;
    if (this.child.stdin.writable) this.send("quit");
    this.child.kill();
    this.lines?.close();
  }
}

export function challengeDeclineReason(challenge, policy, activeGames = 0) {
  if (activeGames >= Number(policy.concurrency ?? 1)) return "later";
  if (challenge.variant?.key !== "standard") return "variant";
  if (challenge.initialFen && challenge.initialFen !== "startpos") return "variant";
  if (!policy.modes.includes(challenge.rated ? "rated" : "casual")) {
    return challenge.rated ? "rated" : "casual";
  }
  if (!policy.speeds.includes(challenge.speed)) return "timeControl";
  const clock = challenge.timeControl;
  if (clock?.type !== "clock") return "timeControl";
  if (clock.limit < policy.min_base || clock.limit > policy.max_base) return "timeControl";
  if (clock.increment < policy.min_increment || clock.increment > policy.max_increment) return "timeControl";
  if (!policy.accept_bots && String(challenge.challenger?.title ?? "").toUpperCase() === "BOT") return "noBot";
  return null;
}

export function challengeFromSelf(challenge, account) {
  const challenger = String(challenge.challenger?.name ?? challenge.challenger?.id ?? "");
  return challenger.toLocaleLowerCase() === account.toLocaleLowerCase();
}

function log(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}

class GameSession {
  constructor({ client, config, account, gameId, signal }) {
    this.client = client;
    this.config = config;
    this.account = account.toLocaleLowerCase();
    this.gameId = gameId;
    this.signal = signal;
    this.lastSearchPly = -1;
  }

  async run() {
    let engine;
    let reconnectDelay = 1_000;
    let consecutiveFailures = 0;
    try {
      while (!this.finished && !this.signal.aborted) {
        try {
          for await (const event of this.client.stream(`api/bot/game/stream/${encodeURIComponent(this.gameId)}`, this.signal)) {
            if (event.type === "gameFull") {
              if (event.variant?.key !== "standard" || event.initialFen !== "startpos") {
                throw new Error(`Unsupported live game shape for ${this.gameId}`);
              }
              const white = String(event.white?.id ?? event.white?.name ?? "").toLocaleLowerCase();
              const black = String(event.black?.id ?? event.black?.name ?? "").toLocaleLowerCase();
              this.color = white === this.account ? "white" : black === this.account ? "black" : null;
              if (!this.color) throw new Error(`Account is not a player in game ${this.gameId}`);
              if (!engine) {
                engine = new UciEngine(this.config.engine, (details) => log(details.event, { game_id: this.gameId, ...details }));
                await engine.start();
                await engine.newGame();
                log("game_ready", { game_id: this.gameId, color: this.color });
              }
              await this.onState(event.state, engine);
              consecutiveFailures = 0;
              reconnectDelay = 1_000;
            } else if (event.type === "gameState") {
              if (!engine) throw new Error(`Game state arrived before game metadata for ${this.gameId}`);
              await this.onState(event, engine);
              consecutiveFailures = 0;
              reconnectDelay = 1_000;
            }
          }
          if (!this.finished) throw new Error("Lichess game stream closed before the game finished");
        } catch (error) {
          if (this.signal.aborted) break;
          engine?.close();
          engine = undefined;
          consecutiveFailures += 1;
          log("game_stream_error", { game_id: this.gameId, message: error.message, retry_ms: reconnectDelay });
          if (consecutiveFailures >= 5) {
            throw new Error(`Game session failed ${consecutiveFailures} consecutive times: ${error.message}`);
          }
          await delay(reconnectDelay, this.signal);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        }
      }
    } finally {
      engine?.close();
    }
  }

  async onState(state, engine) {
    const moves = String(state.moves ?? "").trim().split(/\s+/).filter(Boolean);
    if (state.status !== "started") {
      this.finished = true;
      log("game_finished", { game_id: this.gameId, status: state.status, winner: state.winner ?? null, plies: moves.length });
      return;
    }
    const sideToMove = moves.length % 2 === 0 ? "white" : "black";
    if (sideToMove !== this.color || this.lastSearchPly === moves.length) return;
    const started = Date.now();
    const result = await engine.search({
      moves,
      wtime: Number(state.wtime),
      btime: Number(state.btime),
      winc: Number(state.winc),
      binc: Number(state.binc),
      color: this.color,
    });
    await this.client.post(
      `api/bot/game/${encodeURIComponent(this.gameId)}/move/${result.bestmove}`,
      undefined,
      this.signal,
    );
    this.lastSearchPly = moves.length;
    log("move_played", {
      game_id: this.gameId,
      ply: moves.length + 1,
      move: result.bestmove,
      elapsed_ms: Date.now() - started,
      ...result.telemetry,
    });
  }
}

class BotController {
  constructor({ client, config, account, runtimeDir, signal }) {
    this.client = client;
    this.config = config;
    this.account = account;
    this.runtimeDir = runtimeDir;
    this.signal = signal;
    this.activeGames = new Map();
    this.pendingChallenges = new Set();
  }

  async run(opponent) {
    let outboundSent = false;
    let reconnectDelay = 1_000;
    while (!this.signal.aborted) {
      try {
        const events = await this.client.openStream("api/stream/event", this.signal);
        if (opponent && !outboundSent) {
          await this.createChallenge(opponent);
          outboundSent = true;
        }
        for await (const event of events) await this.onEvent(event);
        reconnectDelay = 1_000;
      } catch (error) {
        if (this.signal.aborted) break;
        log("event_stream_error", { message: error.message, retry_ms: reconnectDelay });
        await delay(reconnectDelay, this.signal);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      }
    }
    await Promise.allSettled(this.activeGames.values());
  }

  async onEvent(event) {
    if (event.type === "challenge") {
      const challenge = event.challenge;
      if (challengeFromSelf(challenge, this.account)) {
        log("outbound_challenge_observed", { challenge_id: challenge.id });
        return;
      }
      const occupiedSlots = this.activeGames.size + this.pendingChallenges.size;
      const reason = challengeDeclineReason(challenge, this.config.challenges, occupiedSlots);
      const endpoint = `api/challenge/${encodeURIComponent(challenge.id)}`;
      if (reason) {
        await this.client.post(`${endpoint}/decline`, { reason }, this.signal);
        log("challenge_declined", { challenge_id: challenge.id, reason });
      } else {
        await this.client.post(`${endpoint}/accept`, undefined, this.signal);
        this.pendingChallenges.add(challenge.id);
        log("challenge_accepted", { challenge_id: challenge.id });
      }
      return;
    }
    if (event.type === "gameStart") this.startGame(event.game?.gameId ?? event.game?.id);
    if (event.type === "challengeCanceled" || event.type === "challengeDeclined") {
      const challengeId = event.challenge?.id;
      if (challengeId) this.pendingChallenges.delete(challengeId);
    }
    if (event.type === "gameFinish") {
      log("game_finish_event", { game_id: event.game?.gameId ?? event.game?.id ?? null });
    }
  }

  startGame(gameId) {
    if (!gameId || this.activeGames.has(gameId)) return;
    this.pendingChallenges.delete(gameId);
    const task = new GameSession({
      client: this.client,
      config: this.config,
      account: this.account,
      gameId,
      signal: this.signal,
    }).run().catch((error) => {
      log("game_error", { game_id: gameId, message: error.message });
    }).finally(() => this.activeGames.delete(gameId));
    this.activeGames.set(gameId, task);
  }

  async createChallenge(opponent) {
    const playing = await this.client.json("api/account/playing", { signal: this.signal });
    if ((playing.nowPlaying?.length ?? 0) > 0 || this.activeGames.size > 0) {
      throw new Error("Cannot create an outbound challenge while a game is active");
    }
    const outbound = this.config.outbound_challenge;
    const response = await this.client.post(`api/challenge/${encodeURIComponent(opponent)}`, {
      rated: outbound.rated,
      color: outbound.color,
      variant: "standard",
      "clock.limit": outbound.clock_limit,
      "clock.increment": outbound.clock_increment,
      keepAliveStream: false,
    }, this.signal);
    const challenge = await response.json();
    if (challenge.id) this.pendingChallenges.add(challenge.id);
    log("challenge_created", {
      opponent,
      rated: outbound.rated,
      clock: `${outbound.clock_limit}+${outbound.clock_increment}`,
    });
  }
}

function writeRuntimeMetadata(runtimeDir, metadata) {
  mkdirSync(runtimeDir, { recursive: true });
  const target = path.join(runtimeDir, "runtime.json");
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error("Expected config, probe, or run command");
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key}`);
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const config = loadRuntimeConfig({
    templatePath: path.resolve(options.config ?? DEFAULT_TEMPLATE),
    repoRoot: path.resolve(options.repo_root ?? ROOT),
    modelRoot: options.model_root,
  });
  if (options.command === "config") {
    console.log(JSON.stringify({ status: "ready", schema: config.schema, engine: config.engine.executable }));
    return 0;
  }
  if (!new Set(["probe", "run"]).has(options.command)) throw new Error(`Unknown command: ${options.command}`);
  const expectedAccount = options.expected_account;
  if (!expectedAccount) throw new Error("--expected-account is required");
  const tokenFile = path.resolve(options.token_file ?? DEFAULT_TOKEN_FILE);
  const profile = await probeAccount({ tokenFile, expectedAccount, url: config.url });
  if (options.command === "probe") {
    console.log(JSON.stringify({ status: "ready", account: profile.username, is_bot: true, games: profile.games }));
    return 0;
  }

  const runtimeDir = path.resolve(options.runtime_dir ?? DEFAULT_RUNTIME_DIR);
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => controller.abort(new Error(`Received ${signal}`)));
  }
  writeRuntimeMetadata(runtimeDir, {
    schema: "uci_arena_lichess_runtime_v1",
    adapter_id: "lichess_node_adapter_v1",
    pid: process.pid,
    account: profile.username,
    engine: config.engine.executable,
    model_root: config.engine.uci_options.ModelRoot,
    outbound_opponent: options.opponent ?? null,
  });
  log("adapter_started", { account: profile.username, opponent: options.opponent ?? null });
  const client = new LichessClient({ token: readTokenForRuntime(tokenFile), baseUrl: config.url });
  await new BotController({
    client,
    config,
    account: profile.username,
    runtimeDir,
    signal: controller.signal,
  }).run(options.opponent);
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`lichess-adapter: ${error.message}`);
    process.exitCode = 1;
  });
}
