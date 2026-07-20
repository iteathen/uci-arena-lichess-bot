#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  AsyncSemaphore,
  LichessHttpError,
  PriorityRequestQueue,
  SlotPool,
  reservationBlocksPublicHuman,
  selectWeightedCandidate,
} from "./lichess-scheduler.mjs";
import { LichessStore, normalizedUsername } from "./lichess-store.mjs";
import {
  installWindowsStartup,
  queryWindowsStartup,
  uninstallWindowsStartup,
} from "./windows-startup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const REPO_PLACEHOLDER = "<UCI_ARENA_REPO>";
export const DEFAULT_TEMPLATE = path.join(HERE, "config.uci_arena.template.yml");
export const DEFAULT_TOKEN_FILE = path.join(ROOT, "secrets", "lichess_bot_token.txt");
export const DEFAULT_RUNTIME_DIR = path.join(ROOT, "runtime_state", "lichess");
export const DEFAULT_STORE_FILE = path.join(DEFAULT_RUNTIME_DIR, "matches.sqlite");

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

export function assertSupportedNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(`Lichess adapter requires Node.js >=24.15.0; found ${process.versions.node}`);
  }
}

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
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
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

function validateCapacityConfig(config) {
  const capacity = config.capacity;
  if (!capacity || typeof capacity !== "object") throw new Error("Lichess adapter config is missing capacity");
  requireInteger(capacity.total_slots, "capacity.total_slots", 1, 64);
  requireInteger(capacity.startup_parallelism, "capacity.startup_parallelism", 1, 64);
  for (const audience of ["human", "bot"]) {
    if (!capacity[audience] || typeof capacity[audience] !== "object") {
      throw new Error(`Lichess adapter config is missing capacity.${audience}`);
    }
    requireInteger(capacity[audience].slots, `capacity.${audience}.slots`, 0, 64);
  }
  requireInteger(capacity.bot.target_active, "capacity.bot.target_active", 0, capacity.bot.slots);
  if (capacity.human.slots + capacity.bot.slots !== capacity.total_slots) {
    throw new Error("Lichess adapter capacity human and bot slots must sum to total_slots");
  }
  if (typeof capacity.human.allow_borrowing !== "boolean"
      || typeof capacity.human.accept_public !== "boolean") {
    throw new Error("Lichess adapter human capacity flags must be boolean");
  }
  if (!capacity.legacy_shared && !capacity.capacity_profile) {
    throw new Error("Lichess adapter config is missing capacity.capacity_profile");
  }
  const scheduler = config.scheduler;
  if (!scheduler || typeof scheduler.enabled !== "boolean") {
    throw new Error("Lichess adapter config is missing scheduler policy");
  }
  for (const [name, minimum, maximum] of [
    ["discovery_interval_seconds", 15, 3600],
    ["challenge_interval_seconds", 1, 300],
    ["reservation_retry_seconds", 5, 600],
    ["challenge_timeout_seconds", 10, 300],
    ["max_games_per_opponent_per_day", 1, 100],
    ["timeout_cooldown_minutes", 1, 1440],
    ["decline_cooldown_minutes", 1, 10080],
    ["rating_target", 400, 4000],
    ["rating_spread", 50, 2000],
  ]) requireInteger(scheduler[name], `scheduler.${name}`, minimum, maximum);
  return config;
}

function migrateV2Config(config) {
  config.capacity = {
    total_slots: 1,
    capacity_profile: null,
    startup_parallelism: 1,
    legacy_shared: true,
    human: { slots: 1, allow_borrowing: false, accept_public: true },
    bot: { slots: 0, target_active: 0 },
  };
  config.scheduler = {
    enabled: false,
    discovery_interval_seconds: 60,
    challenge_interval_seconds: 5,
    reservation_retry_seconds: 30,
    challenge_timeout_seconds: 25,
    max_games_per_opponent_per_day: 2,
    timeout_cooldown_minutes: 30,
    decline_cooldown_minutes: 360,
    rating_target: 2200,
    rating_spread: 600,
  };
  return config;
}

export function loadRuntimeConfig({
  templatePath = DEFAULT_TEMPLATE,
  repoRoot = ROOT,
  modelRoot,
  profilePath,
  environment = process.env,
} = {}) {
  const parsed = JSON.parse(readFileSync(templatePath, "utf8"));
  if (!new Set(["uci_arena_lichess_adapter_v2", "uci_arena_lichess_adapter_v3"]).has(parsed.schema)) {
    throw new Error(`Unsupported Lichess adapter config schema: ${parsed.schema ?? "missing"}`);
  }
  const serialized = JSON.stringify(parsed).toLowerCase();
  if (serialized.includes("oauth_token") || serialized.includes("bearer ")) {
    throw new Error("Tracked Lichess config must not contain credentials");
  }
  const config = replaceRepoPlaceholder(parsed, path.resolve(repoRoot));
  if (config.schema === "uci_arena_lichess_adapter_v2") migrateV2Config(config);
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
  return validateCapacityConfig(config);
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

export function loadCapacityProfile(profilePath, config, singleGameProfile) {
  if (config.capacity.legacy_shared) return null;
  const resolvedPath = path.resolve(profilePath);
  const capacity = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (capacity.schema !== "uci_arena_lichess_capacity_profile_v1") {
    throw new Error(`Unsupported Lichess capacity profile schema: ${capacity.schema ?? "missing"}`);
  }
  if (capacity.qualified !== true) throw new Error("Lichess capacity profile is not qualified");
  if (!Number.isFinite(Date.parse(capacity.published_at))) {
    throw new Error("Lichess capacity profile published_at is invalid");
  }
  requireInteger(capacity.maximum_concurrency, "capacity.maximum_concurrency", 1, 64);
  if (config.capacity.total_slots > capacity.maximum_concurrency) {
    throw new Error(`Configured Lichess capacity ${config.capacity.total_slots} exceeds qualified maximum ${capacity.maximum_concurrency}`);
  }
  const bindings = {
    engine_build_fingerprint: sha256File(config.engine.executable),
    single_game_profile_sha256: sha256File(singleGameProfile.profile_path),
    model_fingerprint: singleGameProfile.model_fingerprint,
    provider_numeric_fingerprint: singleGameProfile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: singleGameProfile.hardware_driver_fingerprint,
  };
  for (const [name, expected] of Object.entries(bindings)) {
    if (capacity[name] !== expected) {
      throw new Error(`Lichess capacity profile ${name} mismatch`);
    }
  }
  if (!Array.isArray(capacity.evidence) || capacity.evidence.length !== capacity.maximum_concurrency
      || capacity.evidence.some((entry) => entry?.qualified !== true)) {
    throw new Error("Lichess capacity profile concurrent evidence is incomplete");
  }
  return { ...capacity, profile_path: resolvedPath };
}

function publishCapacityProfile(targetPath, maximumConcurrency, config, singleGameProfile, statuses) {
  const target = path.resolve(targetPath);
  mkdirSync(path.dirname(target), { recursive: true });
  const profile = {
    schema: "uci_arena_lichess_capacity_profile_v1",
    qualified: true,
    published_at: new Date().toISOString(),
    maximum_concurrency: maximumConcurrency,
    engine_build_fingerprint: sha256File(config.engine.executable),
    single_game_profile_sha256: sha256File(singleGameProfile.profile_path),
    model_fingerprint: singleGameProfile.model_fingerprint,
    provider_numeric_fingerprint: singleGameProfile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: singleGameProfile.hardware_driver_fingerprint,
    provider: singleGameProfile.provider,
    model_id: singleGameProfile.model_id,
    evidence: statuses.map((status, index) => ({
      child: index + 1,
      qualified: true,
      provider: status.provider_effective,
      actual_active_workers: status.actual_active_workers,
      v2_cursor_admissions: status.v2_cursor_admissions,
      v2_cursor_async_pending: status.v2_cursor_async_pending,
      v2_cursor_ready_resumes: status.v2_cursor_ready_resumes,
      v2_cursor_peak_waiting: status.v2_cursor_peak_waiting,
    })),
  };
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  return { ...profile, profile_path: target };
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
  constructor({ token, baseUrl = "https://lichess.org/", fetchImpl = globalThis.fetch, requestQueue }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.requestQueue = requestQueue ?? new PriorityRequestQueue();
  }

  async requestDirect(endpoint, { method = "GET", form, stream = false, signal } = {}) {
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
      let retryAfterMs = 0;
      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        retryAfterMs = Math.max(60_000, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 0);
        this.requestQueue.blockNonMove(retryAfterMs);
      }
      throw new LichessHttpError(method, endpoint, response.status, retryAfterMs);
    }
    return response;
  }

  request(endpoint, options = {}) {
    if (options.stream) return this.requestDirect(endpoint, options);
    const priority = options.priority ?? 20;
    return this.requestQueue.enqueue(() => this.requestDirect(endpoint, options), priority);
  }

  async json(endpoint, options) {
    return (await this.request(endpoint, options)).json();
  }

  async post(endpoint, form, signal, priority) {
    const requestPriority = priority ?? (endpoint.includes("/move/") ? 0 : 10);
    return this.request(endpoint, { method: "POST", form, signal, priority: requestPriority });
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
  const challenger = String(challenge.challenger?.id ?? challenge.challenger?.name ?? "");
  return challenger.toLocaleLowerCase() === account.toLocaleLowerCase();
}

let runtimeLogFile = null;

function configureRuntimeLog(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true });
  runtimeLogFile = path.join(runtimeDir, "adapter.ndjson");
}

function log(event, details = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), event, ...details });
  console.log(line);
  if (runtimeLogFile) {
    try {
      appendFileSync(runtimeLogFile, `${line}\n`, "utf8");
    } catch {
      // Runtime logging must not interrupt move submission or game handling.
    }
  }
}

function bookConfigurationIdentity(config) {
  const options = config.engine.uci_options;
  const value = JSON.stringify({
    OwnBook: options.OwnBook ?? true,
    BookFile: options.BookFile ?? "",
    BookSelectionPolicy: options.BookSelectionPolicy ?? "",
  });
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

class GameSession {
  constructor({ client, config, account, gameId, signal, slot, store }) {
    this.client = client;
    this.config = config;
    this.account = account.toLocaleLowerCase();
    this.gameId = String(gameId);
    this.signal = signal;
    this.slot = slot;
    this.store = store;
    this.lastSearchPly = -1;
  }

  async run() {
    const engine = this.slot.engine;
    if (!engine) throw new Error(`Game ${this.gameId} has no prepared engine`);
    let reconnectDelay = 1_000;
    let consecutiveFailures = 0;
    while (!this.finished && !this.signal.aborted) {
      try {
        for await (const event of this.client.stream(
          `api/bot/game/stream/${encodeURIComponent(this.gameId)}`,
          this.signal,
        )) {
          if (event.type === "gameFull") {
            await this.initialize(event, engine);
            await this.onState(event.state, engine);
          } else if (event.type === "gameState") {
            if (!this.initialized) throw new Error(`Game state arrived before metadata for ${this.gameId}`);
            await this.onState(event, engine);
          }
          consecutiveFailures = 0;
          reconnectDelay = 1_000;
        }
        if (!this.finished) throw new Error("Lichess game stream closed before the game finished");
      } catch (error) {
        if (this.signal.aborted) break;
        consecutiveFailures += 1;
        const retryMs = error instanceof LichessHttpError && error.status === 429
          ? Math.max(60_000, error.retryAfterMs)
          : reconnectDelay;
        log("game_stream_error", {
          game_id: this.gameId,
          message: error.message,
          retry_ms: retryMs,
        });
        if (consecutiveFailures >= 5) {
          throw new Error(`Game session failed ${consecutiveFailures} consecutive times: ${error.message}`);
        }
        await delay(retryMs, this.signal);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      }
    }
  }

  async initialize(event, engine) {
    if (event.variant?.key !== "standard" || event.initialFen !== "startpos") {
      throw new Error(`Unsupported live game shape for ${this.gameId}`);
    }
    const white = String(event.white?.id ?? event.white?.name ?? "").toLocaleLowerCase();
    const black = String(event.black?.id ?? event.black?.name ?? "").toLocaleLowerCase();
    this.color = white === this.account ? "white" : black === this.account ? "black" : null;
    if (!this.color) throw new Error(`Account is not a player in game ${this.gameId}`);
    if (this.initialized) return;
    this.opponent = this.color === "white" ? black : white;
    this.slot.opponent = this.opponent;
    await engine.newGame();
    const profile = this.config.engine.qualification_profile;
    this.store.beginGame({
      id: this.gameId,
      opponent: this.opponent,
      audience: this.slot.audience,
      color: this.color,
      rated: event.rated,
      speed: event.speed,
      clockLimit: event.clock?.initial,
      clockIncrement: event.clock?.increment,
      engineBuildFingerprint: profile.engine_build_fingerprint,
      modelFingerprint: profile.model_fingerprint,
      providerFingerprint: profile.provider_numeric_fingerprint,
      bookIdentity: bookConfigurationIdentity(this.config),
    });
    this.initialized = true;
    log("game_ready", {
      game_id: this.gameId,
      audience: this.slot.audience,
      opponent: this.opponent,
      color: this.color,
    });
  }

  async onState(state, engine) {
    const moves = String(state.moves ?? "").trim().split(/\s+/).filter(Boolean);
    if (state.status !== "started") {
      this.finished = true;
      const winner = String(state.winner ?? "");
      const result = winner
        ? winner === this.color ? "win" : "loss"
        : new Set(["draw", "stalemate"]).has(state.status) ? "draw" : "";
      this.store.finishGame({
        id: this.gameId,
        status: state.status,
        result,
        winner,
        plies: moves.length,
      });
      log("game_finished", {
        game_id: this.gameId,
        opponent: this.opponent,
        status: state.status,
        result,
        winner: winner || null,
        plies: moves.length,
      });
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

export class BotController {
  constructor({ client, config, account, runtimeDir, signal, store, random = Math.random }) {
    this.client = client;
    this.config = config;
    this.account = normalizedUsername(account);
    this.runtimeDir = runtimeDir;
    this.signal = signal;
    this.store = store;
    this.random = random;
    this.slots = new SlotPool(config.capacity);
    this.engineStarts = new AsyncSemaphore(config.capacity.startup_parallelism);
    this.activeGames = new Map();
    this.lastDiscoveryAt = 0;
    this.lastBotChallengeAt = 0;
    this.lastOwnerChallengeAt = 0;
    this.lastReconciliationAt = 0;
    this.needsReconciliation = false;
    this.streamConnected = false;
    this.tickRunning = false;
  }

  async run(opponent) {
    this.manualOpponent = opponent ? normalizedUsername(opponent) : null;
    await this.recoverPlayingGames();
    const schedulerTask = this.schedulerLoop();
    let reconnectDelay = 1_000;
    try {
      while (!this.signal.aborted) {
        try {
          const events = await this.client.openStream("api/stream/event", this.signal);
          const connectedAt = Date.now();
          this.streamConnected = true;
          await this.writeStatus();
          for await (const event of events) {
            reconnectDelay = 1_000;
            await this.onEvent(event);
          }
          this.streamConnected = false;
          this.needsReconciliation = true;
          if (Date.now() - connectedAt >= 30_000) reconnectDelay = 1_000;
          if (!this.signal.aborted) throw new Error("Lichess event stream closed");
        } catch (error) {
          this.streamConnected = false;
          this.needsReconciliation = true;
          if (this.signal.aborted) break;
          const retryMs = error instanceof LichessHttpError && error.status === 429
            ? Math.max(60_000, error.retryAfterMs)
            : reconnectDelay;
          log("event_stream_error", { message: error.message, retry_ms: retryMs });
          await this.writeStatus();
          await delay(retryMs, this.signal);
          reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        }
      }
    } finally {
      await Promise.allSettled(this.activeGames.values());
      await this.slots.drainAll();
      await schedulerTask;
      await this.writeStatus();
    }
  }

  async prepareSlot(slot) {
    try {
      const engine = await this.engineStarts.run(async () => {
        const prepared = new UciEngine(this.config.engine, (details) => log(details.event, {
          slot_id: slot.id,
          ...details,
        }));
        try {
          await prepared.start();
          return prepared;
        } catch (error) {
          await prepared.close();
          throw error;
        }
      });
      this.slots.attachEngine(slot, engine);
      return slot;
    } catch (error) {
      await this.slots.release(slot);
      throw error;
    }
  }

  async recoverPlayingGames() {
    const playing = await this.client.json("api/account/playing?nb=50", { signal: this.signal });
    const games = playing.nowPlaying ?? [];
    let recovered = 0;
    await Promise.all(games.map(async (game) => {
      const gameId = String(game.gameId ?? game.id ?? "");
      if (!gameId || this.activeGames.has(gameId) || this.slots.findGame(gameId)) return;
      const pending = this.slots.findPending(game);
      if (pending) {
        await this.startGame(game, pending);
        recovered += 1;
        return;
      }
      const opponent = normalizedUsername(game.opponent?.id ?? game.opponent?.username ?? game.opponent?.name);
      const audience = await this.resolveAudience(opponent, game.opponent?.title);
      const slot = this.slots.acquire(audience, { opponent, direction: "recovered" });
      if (!slot) throw new Error(`Configured ${audience} capacity cannot recover active game ${game.gameId ?? game.id}`);
      await this.prepareSlot(slot);
      await this.startGame(game, slot);
      recovered += 1;
    }));
    this.lastReconciliationAt = Date.now();
    this.needsReconciliation = false;
    if (recovered) log("games_recovered", { count: recovered });
    return recovered;
  }

  async resolveAudience(opponent, knownTitle) {
    if (String(knownTitle ?? "").toUpperCase() === "BOT") return "bot";
    const stored = this.store.opponentAudience(opponent);
    if (stored) return stored;
    try {
      const profile = await this.client.json(`api/user/${encodeURIComponent(opponent)}`, { signal: this.signal });
      return String(profile.title ?? "").toUpperCase() === "BOT" ? "bot" : "human";
    } catch {
      return "human";
    }
  }

  async onEvent(event) {
    if (event.type === "challenge") {
      await this.onChallenge(event.challenge);
    } else if (event.type === "gameStart") {
      await this.startGame(event.game);
    } else if (event.type === "challengeCanceled" || event.type === "challengeDeclined") {
      await this.finishPendingChallenge(event);
    } else if (event.type === "gameFinish") {
      log("game_finish_event", { game_id: event.game?.gameId ?? event.game?.id ?? null });
    }
    await this.writeStatus();
  }

  async onChallenge(challenge) {
    if (challengeFromSelf(challenge, this.account)) {
      log("outbound_challenge_observed", { challenge_id: challenge.id });
      return;
    }
    const opponent = normalizedUsername(
      challenge.challenger?.id ?? challenge.challenger?.name,
    );
    const audience = String(challenge.challenger?.title ?? "").toUpperCase() === "BOT" ? "bot" : "human";
    let reason = challengeDeclineReason(challenge, this.config.challenges, 0);
    const owner = audience === "human" && this.store.isOwner(opponent);
    if (!reason && audience === "human" && !owner && !this.config.capacity.human.accept_public) reason = "later";
    const reservation = this.store.getReservation();
    if (!reason && audience === "human" && reservationBlocksPublicHuman({
      reservation,
      opponent,
      reservationOccupied: this.slots.hasOpponent(reservation?.opponent, "human"),
      availableHuman: this.slots.available("human"),
    })) reason = "later";
    let slot = null;
    if (!reason) {
      slot = this.slots.acquire(audience, {
        opponent,
        direction: "inbound",
        challengeId: challenge.id,
      });
      if (!slot) reason = "later";
    }
    const endpoint = `api/challenge/${encodeURIComponent(challenge.id)}`;
    if (reason) {
      await this.client.post(`${endpoint}/decline`, { reason }, this.signal);
      log("challenge_declined", { challenge_id: challenge.id, opponent, audience, reason });
      return;
    }
    try {
      await this.prepareSlot(slot);
      await this.client.post(`${endpoint}/accept`, undefined, this.signal);
      this.slots.pending(slot, challenge.id);
      this.store.recordChallenge({
        id: challenge.id,
        opponent,
        audience,
        direction: "inbound",
        status: "accepted",
        color: challenge.color,
        clockLimit: challenge.timeControl?.limit,
        clockIncrement: challenge.timeControl?.increment,
      });
      log("challenge_accepted", { challenge_id: challenge.id, opponent, audience, slot_id: slot.id });
    } catch (error) {
      await this.slots.release(slot);
      throw error;
    }
  }

  async finishPendingChallenge(event) {
    const challengeId = event.challenge?.id;
    if (!challengeId) return;
    const slot = this.slots.findChallenge(challengeId);
    const declined = event.type === "challengeDeclined";
    this.store.updateChallenge(challengeId, declined ? "declined" : "canceled", {
      cooldownMinutes: declined && slot?.audience === "bot"
        ? this.config.scheduler.decline_cooldown_minutes
        : 0,
    });
    if (slot?.state === "pending" || slot?.state === "preparing") await this.slots.release(slot);
    log("challenge_terminal", { challenge_id: challengeId, status: declined ? "declined" : "canceled" });
  }

  async startGame(game, suppliedSlot = null) {
    const gameId = String(game?.gameId ?? game?.id ?? "");
    if (!gameId || this.activeGames.has(gameId)) return;
    let slot = suppliedSlot ?? this.slots.findPending(game);
    if (!slot) {
      const opponent = normalizedUsername(game?.opponent?.id ?? game?.opponent?.username ?? game?.opponent?.name);
      const audience = await this.resolveAudience(opponent, game?.opponent?.title);
      slot = this.slots.acquire(audience, { opponent, direction: "event-recovery" });
      if (!slot) throw new Error(`No ${audience} slot is available for started game ${gameId}`);
      await this.prepareSlot(slot);
    }
    this.slots.active(slot, gameId);
    if (slot.challengeId) this.store.updateChallenge(slot.challengeId, "accepted");
    if (slot.audience === "human" && slot.opponent) this.store.consumeReservation(slot.opponent);
    const session = new GameSession({
      client: this.client,
      config: this.config,
      account: this.account,
      gameId,
      signal: this.signal,
      slot,
      store: this.store,
    });
    const task = session.run().catch((error) => {
      log("game_error", { game_id: gameId, message: error.message });
    }).finally(async () => {
      this.activeGames.delete(gameId);
      await this.slots.release(slot);
      await this.writeStatus();
    });
    this.activeGames.set(gameId, task);
    log("game_started", { game_id: gameId, audience: slot.audience, opponent: slot.opponent, slot_id: slot.id });
  }

  async createChallenge(opponent, audience) {
    const normalized = normalizedUsername(opponent);
    if (normalized === this.account || this.slots.hasOpponent(normalized)) return false;
    const slot = this.slots.acquire(audience, { opponent: normalized, direction: "outbound" });
    if (!slot) return false;
    try {
      await this.prepareSlot(slot);
      const outbound = this.config.outbound_challenge;
      if (audience === "bot") this.lastBotChallengeAt = Date.now();
      else this.lastOwnerChallengeAt = Date.now();
      const response = await this.client.post(`api/challenge/${encodeURIComponent(normalized)}`, {
        rated: outbound.rated,
        color: outbound.color,
        variant: "standard",
        "clock.limit": outbound.clock_limit,
        "clock.increment": outbound.clock_increment,
        keepAliveStream: false,
      }, this.signal);
      const challenge = await response.json();
      const challengeId = challenge.id ?? challenge.challenge?.id;
      if (!challengeId) throw new Error(`Lichess challenge response for ${normalized} has no id`);
      this.slots.pending(slot, challengeId);
      this.store.recordChallenge({
        id: challengeId,
        opponent: normalized,
        audience,
        direction: "outbound",
        status: "pending",
        color: outbound.color,
        clockLimit: outbound.clock_limit,
        clockIncrement: outbound.clock_increment,
      });
      log("challenge_created", {
        challenge_id: challengeId,
        opponent: normalized,
        audience,
        rated: outbound.rated,
        clock: `${outbound.clock_limit}+${outbound.clock_increment}`,
        slot_id: slot.id,
      });
      return true;
    } catch (error) {
      await this.slots.release(slot);
      if (!(error instanceof LichessHttpError && error.status === 429) && audience === "bot") {
        this.store.setOpponentCooldown(normalized, this.config.scheduler.timeout_cooldown_minutes);
      }
      throw error;
    }
  }

  async schedulerLoop() {
    while (!this.signal.aborted) {
      try {
        await this.schedulerTick();
      } catch (error) {
        if (!this.signal.aborted) log("scheduler_error", { message: error.message });
      }
      try {
        await delay(1_000, this.signal);
      } catch {
        break;
      }
    }
  }

  async schedulerTick(now = Date.now()) {
    if (this.tickRunning || !this.streamConnected) return;
    this.tickRunning = true;
    try {
      if (this.needsReconciliation) {
        if (now - this.lastReconciliationAt < 15_000) return;
        await this.recoverPlayingGames();
      }
      await this.expirePending(now);
      const control = this.store.control(now);
      if (control.paused) return;
      if (this.manualOpponent) {
        const opponent = this.manualOpponent;
        this.manualOpponent = null;
        const audience = this.store.isOwner(opponent) ? "human" : "bot";
        await this.createChallenge(opponent, audience);
      }
      const reservation = control.reservation;
      if (reservation && !this.slots.hasOpponent(reservation.opponent, "human")
          && this.slots.available("human") > 0
          && now - this.lastOwnerChallengeAt >= this.config.scheduler.reservation_retry_seconds * 1_000) {
        await this.createChallenge(reservation.opponent, "human");
      }
      if (!this.config.scheduler.enabled || this.config.capacity.bot.target_active === 0) return;
      if (now - this.lastDiscoveryAt >= this.config.scheduler.discovery_interval_seconds * 1_000) {
        await this.discoverBots(now);
      }
      if (now - this.lastBotChallengeAt < this.config.scheduler.challenge_interval_seconds * 1_000) return;
      while (this.slots.occupied("bot") < this.config.capacity.bot.target_active
          && this.slots.available("bot") > 0) {
        const eligible = this.store.eligibleBots({
          self: this.account,
          now,
          maximumGamesPerDay: this.config.scheduler.max_games_per_opponent_per_day,
        }).filter((candidate) => !this.slots.hasOpponent(candidate.username));
        const candidate = selectWeightedCandidate(eligible, this.config.scheduler, this.random, now);
        if (!candidate) break;
        await this.createChallenge(candidate.username, "bot");
        break;
      }
    } finally {
      this.tickRunning = false;
      await this.writeStatus();
    }
  }

  async discoverBots(now = Date.now()) {
    const bots = [];
    for await (const bot of this.client.stream("api/bot/online?nb=512", this.signal)) bots.push(bot);
    this.store.replaceOnlineBots(bots, now);
    this.lastDiscoveryAt = now;
    log("bot_discovery_complete", { online_bots: bots.length });
  }

  async expirePending(now = Date.now()) {
    const timeout = this.config.scheduler.challenge_timeout_seconds * 1_000;
    for (const slot of this.slots.slots.filter((candidate) => candidate.state === "pending"
      && candidate.direction === "outbound"
      && now - candidate.createdAt >= timeout)) {
      if (slot.challengeId) {
        this.store.updateChallenge(slot.challengeId, "timeout", {
          cooldownMinutes: slot.audience === "bot" ? this.config.scheduler.timeout_cooldown_minutes : 0,
        }, now);
      }
      log("challenge_timeout", { challenge_id: slot.challengeId, opponent: slot.opponent, audience: slot.audience });
      await this.slots.release(slot);
    }
  }

  async writeStatus() {
    writeRuntimeMetadata(this.runtimeDir, {
      schema: "uci_arena_lichess_runtime_v2",
      adapter_id: "lichess_node_adapter_v2",
      pid: process.pid,
      account: this.account,
      stream_connected: this.streamConnected,
      configured_capacity: this.config.capacity.total_slots,
      qualified_capacity: this.config.capacity_profile?.maximum_concurrency ?? 1,
      slots: this.slots.snapshot(),
      scheduler: {
        enabled: this.config.scheduler.enabled,
        target_active_bots: this.config.capacity.bot.target_active,
        last_discovery_at: this.lastDiscoveryAt || null,
        last_bot_challenge_at: this.lastBotChallengeAt || null,
        last_owner_challenge_at: this.lastOwnerChallengeAt || null,
        last_reconciliation_at: this.lastReconciliationAt || null,
        reconciliation_pending: this.needsReconciliation,
        ...this.store.control(),
      },
      opponents: this.store.opponentStats(),
      engine: this.config.engine.executable,
      model_root: this.config.engine.uci_options.ModelRoot,
      qualification_profile: this.config.engine.qualification_profile.profile_path,
      capacity_profile: this.config.capacity_profile?.profile_path ?? null,
      model_id: this.config.engine.qualification_profile.model_id,
      provider: this.config.engine.qualification_profile.provider,
      updated_at: new Date().toISOString(),
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

export function parseArguments(argv) {
  const [command, ...argumentsList] = argv;
  if (!command) throw new Error("Expected a Lichess adapter command");
  const rest = [...argumentsList];
  const options = { command };
  if (new Set(["owner", "reservation", "scheduler", "startup"]).has(command)
      && rest[0] && !rest[0].startsWith("--")) {
    options.action = rest.shift();
  }
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

async function preflightQualifiedEngines(config, count) {
  const engines = Array.from({ length: count }, () => new UciEngine(config.engine));
  try {
    const outcomes = await Promise.allSettled(engines.map((engine) => engine.start()));
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) throw failure.reason;
    return engines.map((engine) => engine.qualificationStatus);
  } finally {
    await Promise.allSettled(engines.map((engine) => engine.close()));
  }
}

function integerOption(value, label, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function runStoreCommand(options) {
  const runtimeDir = path.resolve(options.runtime_dir ?? DEFAULT_RUNTIME_DIR);
  const store = new LichessStore(path.resolve(options.store ?? path.join(runtimeDir, "matches.sqlite")));
  try {
    let result;
    if (options.command === "owner" && options.action === "add") {
      if (!options.username) throw new Error("owner add requires --username");
      result = { username: store.addOwner(options.username), added: true };
    } else if (options.command === "owner" && options.action === "remove") {
      if (!options.username) throw new Error("owner remove requires --username");
      result = { username: normalizedUsername(options.username), removed: store.removeOwner(options.username) };
    } else if (options.command === "owner" && options.action === "list") {
      result = { owners: store.listOwners() };
    } else if (options.command === "reserve") {
      if (!options.opponent) throw new Error("reserve requires --opponent");
      result = { reservation: store.reserve(
        options.opponent,
        integerOption(options.games, "--games", 1),
        integerOption(options.minutes, "--minutes", 15),
      ) };
    } else if (options.command === "reservation" && options.action === "status") {
      result = { reservation: store.getReservation() };
    } else if (options.command === "reservation" && options.action === "cancel") {
      result = { canceled: store.cancelReservation() };
    } else if (options.command === "scheduler" && options.action === "status") {
      result = store.status();
    } else if (options.command === "scheduler" && options.action === "pause") {
      store.setPaused(true);
      result = store.status();
    } else if (options.command === "scheduler" && options.action === "resume") {
      store.setPaused(false);
      result = store.status();
    } else {
      throw new Error(`Unknown local control command: ${options.command}${options.action ? ` ${options.action}` : ""}`);
    }
    console.log(JSON.stringify({ status: "ready", ...result }));
    return 0;
  } finally {
    store.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  assertSupportedNode();
  const options = parseArguments(argv);
  if (options.command === "reserve"
      || new Set(["owner", "reservation", "scheduler"]).has(options.command)) {
    return runStoreCommand(options);
  }
  const runtimeDir = path.resolve(options.runtime_dir ?? DEFAULT_RUNTIME_DIR);
  if (options.command === "run") configureRuntimeLog(runtimeDir);
  if (options.command === "startup" && options.action === "status") {
    console.log(JSON.stringify({ status: "ready", startup: await queryWindowsStartup() }));
    return 0;
  }
  if (options.command === "startup" && options.action === "uninstall") {
    console.log(JSON.stringify({ status: "ready", startup: await uninstallWindowsStartup(runtimeDir) }));
    return 0;
  }
  const config = loadRuntimeConfig({
    templatePath: path.resolve(options.config ?? DEFAULT_TEMPLATE),
    repoRoot: path.resolve(options.repo_root ?? ROOT),
    modelRoot: options.model_root,
    profilePath: options.profile,
  });
  if (options.command === "config") {
    console.log(JSON.stringify({
      status: "ready",
      schema: config.schema,
      engine: config.engine.executable,
      capacity: config.capacity,
      scheduler: config.scheduler,
    }));
    return 0;
  }
  if (options.command === "startup" && options.action === "install") {
    const qualificationProfile = applySingleGameProfile(config);
    loadCapacityProfile(
      options.capacity_profile ?? config.capacity.capacity_profile,
      config,
      qualificationProfile,
    );
    const startup = await installWindowsStartup({
      config: path.resolve(options.config ?? DEFAULT_TEMPLATE),
      tokenFile: path.resolve(options.token_file ?? DEFAULT_TOKEN_FILE),
      expectedAccount: options.expected_account,
      runtimeDir,
      profile: config.engine.single_game_profile,
      capacityProfile: options.capacity_profile ?? config.capacity.capacity_profile,
      modelRoot: config.engine.uci_options.ModelRoot,
    });
    console.log(JSON.stringify({ status: "ready", startup }));
    return 0;
  }
  if (!new Set(["qualify", "capacity-qualify", "probe", "run"]).has(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  let qualificationStatus;
  if (new Set(["qualify", "capacity-qualify", "run"]).has(options.command)) {
    const qualificationProfile = applySingleGameProfile(config);
    if (options.command === "capacity-qualify") {
      const maximumConcurrency = integerOption(
        options.max_concurrency,
        "--max-concurrency",
        config.capacity.total_slots,
      );
      requireInteger(maximumConcurrency, "capacity.maximum_concurrency", 1, 64);
      const statuses = await preflightQualifiedEngines(config, maximumConcurrency);
      const configuredCapacityPath = options.capacity_profile ?? config.capacity.capacity_profile;
      if (!configuredCapacityPath) throw new Error("capacity-qualify requires --capacity-profile");
      const capacityPath = path.resolve(configuredCapacityPath);
      const capacityProfile = publishCapacityProfile(
        capacityPath,
        maximumConcurrency,
        config,
        qualificationProfile,
        statuses,
      );
      console.log(JSON.stringify({
        status: "qualified",
        schema: capacityProfile.schema,
        maximum_concurrency: capacityProfile.maximum_concurrency,
        profile: capacityProfile.profile_path,
      }));
      return 0;
    }
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
    config.capacity_profile = loadCapacityProfile(
      options.capacity_profile ?? config.capacity.capacity_profile,
      config,
      qualificationProfile,
    );
  }
  const expectedAccount = options.expected_account;
  if (!expectedAccount) throw new Error("--expected-account is required");
  const tokenFile = path.resolve(options.token_file ?? DEFAULT_TOKEN_FILE);
  const profile = await probeAccount({ tokenFile, expectedAccount, url: config.url });
  if (options.command === "probe") {
    console.log(JSON.stringify({ status: "ready", account: profile.username, is_bot: true, games: profile.games }));
    return 0;
  }

  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => controller.abort(new Error(`Received ${signal}`)));
  }
  log("adapter_started", {
    account: profile.username,
    opponent: options.opponent ?? null,
    configured_capacity: config.capacity.total_slots,
    qualified_capacity: config.capacity_profile?.maximum_concurrency ?? 1,
    provider: qualificationStatus.provider_effective,
  });
  const client = new LichessClient({ token: readTokenForRuntime(tokenFile), baseUrl: config.url });
  const store = new LichessStore(path.resolve(options.store ?? path.join(runtimeDir, "matches.sqlite")));
  try {
    await new BotController({
      client,
      config,
      account: profile.username,
      runtimeDir,
      signal: controller.signal,
      store,
    }).run(options.opponent);
  } finally {
    store.close();
  }
  return 0;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    log("adapter_fatal", { message: error.message });
    console.error(`lichess-adapter: ${error.message}`);
    process.exitCode = 1;
  });
}
