#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

const PROFILE_OWNED_UCI_OPTIONS = Object.freeze({
  search_core: "SearchCore",
  threads: "Threads",
  root_workers: "RootWorkers",
  split_depth: "V2SplitDepth",
  provider: "OnnxProvider",
  batch_size: "NNBatchSize",
  batch_wait_us: "NNBatchWaitUs",
  speculation: "NNSpeculation",
  background_search: "BackgroundSearch",
});
const REQUIRED_PROFILE_EVIDENCE = Object.freeze([
  "cursor_correctness",
  "provider_parity",
  "deadline",
  "topology",
  "complete_game",
]);

function sha256File(filePath) {
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new Error(`Single-game profile ${label} is invalid`);
  }
  return value;
}

function requireInteger(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Single-game profile ${label} must be in ${minimum}..${maximum}`);
  }
  return value;
}

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
  profilePath,
  environment = process.env,
} = {}) {
  const parsed = JSON.parse(readFileSync(templatePath, "utf8"));
  if (parsed.schema !== "uci_arena_lichess_adapter_v2") {
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
  const selectedModelRoot = modelRoot || environment.UCI_ARENA_MODEL_ROOT?.trim();
  if (selectedModelRoot) config.engine.uci_options.ModelRoot = selectedModelRoot;
  const selectedProfile = profilePath || environment.UCI_ARENA_SINGLE_GAME_PROFILE?.trim();
  if (selectedProfile) config.engine.single_game_profile = selectedProfile;
  if (!config.engine.single_game_profile) {
    throw new Error("Lichess adapter config is missing engine.single_game_profile");
  }
  if (Number(config.challenges?.concurrency) !== 1) {
    throw new Error("The single-game Lichess profile requires challenge concurrency 1");
  }
  return config;
}

export function loadSingleGameProfile(profilePath) {
  const resolvedPath = path.resolve(profilePath);
  const profile = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (profile.schema !== "uci_arena_single_game_profile_v1") {
    throw new Error(`Unsupported single-game profile schema: ${profile.schema ?? "missing"}`);
  }
  if (profile.qualified !== true) throw new Error("Single-game profile is not qualified");
  requireString(profile.published_at, "published_at");
  if (!Number.isFinite(Date.parse(profile.published_at))) {
    throw new Error("Single-game profile published_at is not an RFC3339 timestamp");
  }
  requireString(profile.model_id, "model_id", /^[A-Za-z0-9_.-]+$/);
  requireString(profile.model_fingerprint, "model_fingerprint", /^\d+$/);
  requireString(profile.checkpoint_hash, "checkpoint_hash", /^[0-9a-f]{64}$/);
  requireString(profile.adapter_id, "adapter_id", /^[A-Za-z0-9_.-]+$/);
  requireString(profile.engine_build_fingerprint, "engine_build_fingerprint", /^sha256:[0-9a-f]{64}$/);
  requireString(profile.hardware_driver_fingerprint, "hardware_driver_fingerprint", /^\d+$/);
  requireString(profile.onnx_runtime_version, "onnx_runtime_version");
  requireString(profile.provider_numeric_fingerprint, "provider_numeric_fingerprint", /^\d+$/);
  if (profile.search_core !== "v2") throw new Error("Single-game profile must select SearchCore v2");
  if (!new Set(["directml", "cuda"]).has(profile.provider)) {
    throw new Error("Single-game profile provider must be directml or cuda");
  }
  requireInteger(profile.threads, "threads", 1, 64);
  requireInteger(profile.root_workers, "root_workers", 1, 16);
  requireInteger(profile.split_depth, "split_depth", 2, 64);
  requireInteger(profile.batch_size, "batch_size", 2, 256);
  requireInteger(profile.batch_wait_us, "batch_wait_us", 0, 2_000);
  if (typeof profile.speculation !== "boolean") {
    throw new Error("Single-game profile speculation must be boolean");
  }
  if (!profile.qualification_probe || typeof profile.qualification_probe !== "object") {
    throw new Error("Single-game profile qualification_probe is missing");
  }
  requireInteger(profile.qualification_probe.depth, "qualification_probe.depth", profile.split_depth, 64);
  requireInteger(profile.qualification_probe.timeout_ms, "qualification_probe.timeout_ms", 1_000, 600_000);
  if (!profile.evidence || typeof profile.evidence !== "object") {
    throw new Error("Single-game profile evidence is missing");
  }
  for (const name of REQUIRED_PROFILE_EVIDENCE) {
    const evidence = profile.evidence[name];
    if (!evidence || evidence.passed !== true) {
      throw new Error(`Single-game profile evidence ${name} is not passed`);
    }
    requireString(evidence.artifact, `evidence.${name}.artifact`);
    requireString(evidence.artifact_sha256, `evidence.${name}.artifact_sha256`, /^sha256:[0-9a-f]{64}$/);
    const artifactCandidates = path.isAbsolute(evidence.artifact)
      ? [evidence.artifact]
      : [
        path.resolve(ROOT, evidence.artifact),
        path.resolve(path.dirname(resolvedPath), evidence.artifact),
      ];
    const artifactPath = artifactCandidates.find((candidate) => existsSync(candidate));
    if (!artifactPath) {
      throw new Error(`Single-game profile evidence ${name} artifact is missing`);
    }
    if (sha256File(artifactPath) !== evidence.artifact_sha256) {
      throw new Error(`Single-game profile evidence ${name} hash mismatch`);
    }
  }
  return { ...profile, profile_path: resolvedPath };
}

export function applySingleGameProfile(config) {
  const profile = loadSingleGameProfile(config.engine.single_game_profile);
  const engineFingerprint = sha256File(config.engine.executable);
  if (engineFingerprint !== profile.engine_build_fingerprint) {
    throw new Error("Single-game profile engine build fingerprint mismatch");
  }
  const modelRoot = path.resolve(
    config.engine.working_directory,
    config.engine.uci_options.ModelRoot,
  );
  const checkpointManifestPath = path.join(modelRoot, "checkpoint_manifest.json");
  if (!existsSync(checkpointManifestPath)) {
    throw new Error("Single-game profile model checkpoint manifest is missing");
  }
  const checkpointManifest = JSON.parse(readFileSync(checkpointManifestPath, "utf8"));
  if (checkpointManifest.model_id !== profile.model_id
      || checkpointManifest.checkpoint_hash !== profile.checkpoint_hash) {
    throw new Error("Single-game profile model/checkpoint identity mismatch");
  }
  const profileValues = {
    SearchCore: profile.search_core,
    Threads: profile.threads,
    RootWorkers: profile.root_workers,
    V2SplitDepth: profile.split_depth,
    OnnxProvider: profile.provider,
    NNBatchSize: profile.batch_size,
    NNBatchWaitUs: profile.batch_wait_us,
    NNSpeculation: profile.speculation,
    BackgroundSearch: false,
  };
  for (const optionName of Object.values(PROFILE_OWNED_UCI_OPTIONS)) {
    if (Object.hasOwn(config.engine.uci_options, optionName)
        && String(config.engine.uci_options[optionName]) !== String(profileValues[optionName])) {
      throw new Error(`Tracked config conflicts with profile-owned UCI option ${optionName}`);
    }
  }
  config.engine.uci_options = { ...config.engine.uci_options, ...profileValues };
  config.engine.qualification_profile = profile;
  return profile;
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
  for (const key of [
    "depth",
    "seldepth",
    "nodes",
    "nps",
    "time",
    "hashfull",
    "actual_active_workers",
    "v2_cursor_admissions",
    "v2_cursor_async_pending",
    "v2_cursor_ready_resumes",
    "v2_cursor_capacity_deferrals",
    "v2_cursor_readiness_waits",
    "v2_cursor_peak_waiting",
  ]) {
    const match = line.match(new RegExp(`(?:^| )${key} (\\d+)`));
    if (match) telemetry[key] = Number(match[1]);
  }
  const score = line.match(/(?:^| )score (cp|mate) (-?\d+)/);
  if (score) telemetry.score = { unit: score[1], value: Number(score[2]) };
  return telemetry;
}

export function parseRuntimeStatus(line) {
  const prefix = "info string runtime_status_v1 ";
  if (!line.startsWith(prefix)) throw new Error("UCI runtime status response is malformed");
  const status = JSON.parse(line.slice(prefix.length));
  if (status.schema !== "uci_runtime_status_v1") {
    throw new Error(`Unsupported UCI runtime status schema: ${status.schema ?? "missing"}`);
  }
  return status;
}

function requireRuntimeStatus(condition, message) {
  if (!condition) throw new Error(`Single-game runtime qualification failed: ${message}`);
}

export function validateRuntimeStatus(profile, status) {
  requireRuntimeStatus(status.model_loaded === true, "model is not loaded");
  requireRuntimeStatus(status.model_id === profile.model_id, "model_id mismatch");
  requireRuntimeStatus(status.model_fingerprint === profile.model_fingerprint, "model fingerprint mismatch");
  requireRuntimeStatus(status.adapter_id === profile.adapter_id, "adapter mismatch");
  requireRuntimeStatus(status.provider_requested === profile.provider, "requested provider mismatch");
  requireRuntimeStatus(status.provider_effective === profile.provider, "GPU provider fallback");
  requireRuntimeStatus(
    status.provider_numeric_fingerprint === profile.provider_numeric_fingerprint,
    "provider numeric fingerprint mismatch",
  );
  requireRuntimeStatus(
    status.hardware_driver_fingerprint === profile.hardware_driver_fingerprint,
    "hardware/driver fingerprint mismatch",
  );
  requireRuntimeStatus(
    status.onnx_runtime_version === profile.onnx_runtime_version,
    "ONNX Runtime version mismatch",
  );
  requireRuntimeStatus(status.search_core_configured === "v2", "SearchCore v2 is not configured");
  requireRuntimeStatus(status.threads_configured === profile.threads, "thread topology mismatch");
  requireRuntimeStatus(
    status.root_workers_configured === profile.root_workers,
    "root-worker topology mismatch",
  );
  requireRuntimeStatus(status.split_depth_configured === profile.split_depth, "split depth mismatch");
  requireRuntimeStatus(status.batch_size_configured === profile.batch_size, "configured batch mismatch");
  requireRuntimeStatus(status.batch_size_effective === profile.batch_size, "effective batch mismatch");
  requireRuntimeStatus(
    status.batch_wait_us_configured === profile.batch_wait_us
      && status.batch_wait_us_effective === profile.batch_wait_us,
    "batch wait mismatch",
  );
  requireRuntimeStatus(status.background_search === false, "background search must be disabled");
  requireRuntimeStatus(status.last_search_available === true, "qualification search is missing");
  requireRuntimeStatus(status.last_search_core === "v2", "qualification search used legacy core");
  requireRuntimeStatus(status.last_search_threads === profile.threads, "active thread topology mismatch");
  requireRuntimeStatus(
    status.last_search_root_workers === profile.root_workers,
    "active root-worker topology mismatch",
  );
  requireRuntimeStatus(status.actual_active_workers > 0, "no V2 worker became active");
  requireRuntimeStatus(status.root_workers_active === true, "root workers were inactive");
  requireRuntimeStatus(status.worker_gate_active === true, "V2 worker gate was inactive");
  requireRuntimeStatus(status.persistent_workers === true, "persistent workers were inactive");
  requireRuntimeStatus(status.search_batch_coupling === true, "search/batch coupling was inactive");
  requireRuntimeStatus(status.v2_cursor_admissions > 0, "no root cursor was admitted");
  requireRuntimeStatus(status.v2_cursor_async_pending > 0, "no root cursor suspended on inference");
  requireRuntimeStatus(status.v2_cursor_ready_resumes > 0, "no ready root cursor resumed");
  requireRuntimeStatus(status.v2_cursor_peak_waiting > 0, "no concurrent cursor wait was observed");
  requireRuntimeStatus(
    status.evaluation_service_async_lease_completions > 0,
    "no asynchronous inference lease completed",
  );
  requireRuntimeStatus(
    status.evaluation_service_stale_publications_discarded === 0,
    "stale evaluation publication",
  );
  requireRuntimeStatus(
    status.evaluation_service_active_async_leases === 0,
    "terminal async leases remain active",
  );
  requireRuntimeStatus(status.evaluation_service_active_tickets === 0, "terminal tickets remain active");
  requireRuntimeStatus(status.model_cache_eviction_deferrals === 0, "model cache pin deferral");
  requireRuntimeStatus(status.repetition_unbalanced_workers === 0, "repetition state imbalance");
  return status;
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
    if (this.config.qualification_profile) await this.qualifyRuntime();
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

  async runtimeStatus() {
    const line = await this.exchange(
      "runtime_status",
      (candidate) => candidate.startsWith("info string runtime_status_v1 "),
      30_000,
    );
    return parseRuntimeStatus(line);
  }

  async qualifyRuntime() {
    const profile = this.config.qualification_profile;
    if (!this.advertisedOptions.has("OwnBook")) {
      throw new Error("Qualification requires the OwnBook UCI option");
    }
    const restoredOwnBook = Object.hasOwn(this.config.uci_options, "OwnBook")
      ? String(this.config.uci_options.OwnBook)
      : "true";
    this.send("setoption name OwnBook value false");
    await this.exchange("isready", (line) => line === "readyok", 30_000);
    try {
      await this.newGame();
      this.send("position startpos");
      const line = await this.exchange(
        `go depth ${profile.qualification_probe.depth}`,
        (candidate) => candidate.startsWith("bestmove "),
        profile.qualification_probe.timeout_ms,
      );
      const bestmove = line.split(/\s+/)[1];
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(bestmove)) {
        throw new Error(`Qualification search returned unusable bestmove: ${bestmove ?? "missing"}`);
      }
      this.qualificationStatus = validateRuntimeStatus(profile, await this.runtimeStatus());
      return this.qualificationStatus;
    } finally {
      this.send(`setoption name OwnBook value ${restoredOwnBook}`);
      await this.exchange("isready", (line) => line === "readyok", 30_000);
    }
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

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    let exited = child.exitCode !== null;
    const exitPromise = exited
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", () => {
        exited = true;
        resolve();
      }));
    if (child.stdin.writable) {
      child.stdin.write("quit\n");
      child.stdin.end();
    }
    let timer;
    await Promise.race([
      exitPromise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Number(this.config.shutdown_grace_ms ?? 5_000));
      }),
    ]).finally(() => clearTimeout(timer));
    if (!exited) child.kill();
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
          await engine?.close();
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
      await engine?.close();
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
    if (this.activeGames.size >= 1) {
      log("concurrent_game_blocked", { game_id: gameId, active_games: this.activeGames.size });
      return;
    }
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
  if (!command) throw new Error("Expected config, qualify, probe, or run command");
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key}`);
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

async function preflightQualifiedEngine(config) {
  const engine = new UciEngine(config.engine);
  try {
    await engine.start();
    return engine.qualificationStatus;
  } finally {
    await engine.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const config = loadRuntimeConfig({
    templatePath: path.resolve(options.config ?? DEFAULT_TEMPLATE),
    repoRoot: path.resolve(options.repo_root ?? ROOT),
    modelRoot: options.model_root,
    profilePath: options.profile,
  });
  if (options.command === "config") {
    console.log(JSON.stringify({ status: "ready", schema: config.schema, engine: config.engine.executable }));
    return 0;
  }
  if (!new Set(["qualify", "probe", "run"]).has(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  let qualificationStatus;
  if (options.command === "qualify" || options.command === "run") {
    const qualificationProfile = applySingleGameProfile(config);
    qualificationStatus = await preflightQualifiedEngine(config);
    if (options.command === "qualify") {
      console.log(JSON.stringify({
        status: "qualified",
        schema: qualificationProfile.schema,
        model_id: qualificationProfile.model_id,
        provider: qualificationStatus.provider_effective,
        cursor_ready_resumes: qualificationStatus.v2_cursor_ready_resumes,
      }));
      return 0;
    }
  }
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
    qualification_profile: config.engine.qualification_profile.profile_path,
    model_id: config.engine.qualification_profile.model_id,
    provider: qualificationStatus.provider_effective,
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
