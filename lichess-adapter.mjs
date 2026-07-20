#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
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
import {
  AuthoritativeChessState,
} from "./chess-legality.mjs";
import {
  loadTimeProfile,
  timeProfileFallbackStatus,
  validateAppliedTimeProfileReserve,
  validateProfileRuntimeSnapshot,
} from "../../engine/tools/qualify_uci_time_profile.mjs";

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
const CURRENT_CONFIG_SCHEMA = "uci_arena_lichess_adapter_v4";
const LEGACY_CONFIG_SCHEMAS = new Set([
  "uci_arena_lichess_adapter_v2",
  "uci_arena_lichess_adapter_v3",
]);
const DEFAULT_TIMING_CONFIG = Object.freeze({
  opponent_turn_search: true,
  foreground_preempts_ponder: true,
  initial_transport_reserve_ms: 250,
});
const UCI_MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const TIME_PROFILE_RESERVED_OPTIONS = new Set([
  "SearchCore", "Threads", "RootWorkers", "V2SplitDepth", "BackgroundSearch",
  "NNSpeculation", "ModelRoot", "NNBatchSize", "NNBatchWaitUs", "OnnxProvider",
  "IterativeTimeController", "TimeProfileProviderReserveUs", "Move Overhead", "Ponder",
  "OwnBook",
]);

class StaleAuthoritativeSearchError extends Error {
  constructor(gameId, reason) {
    super(`Authoritative Lichess state changed during search for ${gameId}: ${reason}`);
    this.name = "StaleAuthoritativeSearchError";
    this.reason = reason;
  }
}

function searchCancellationError(signal, fallback = "UCI search cancelled") {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

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

function normalizeTimingConfig(config) {
  const timing = config.timing ?? {};
  config.timing = {
    ...DEFAULT_TIMING_CONFIG,
    ...timing,
  };
  if (typeof config.timing.opponent_turn_search !== "boolean"
      || typeof config.timing.foreground_preempts_ponder !== "boolean") {
    throw new Error("Lichess adapter timing search/preemption flags must be boolean");
  }
  if (config.timing.opponent_turn_search && !config.timing.foreground_preempts_ponder) {
    throw new Error("Simultaneous foreground and ponder load has no qualified capacity profile");
  }
  requireInteger(
    config.timing.initial_transport_reserve_ms,
    "timing.initial_transport_reserve_ms",
    0,
    5_000,
  );
  const configuredPonder = config.engine?.uci_options?.Ponder;
  if (config.timing.opponent_turn_search && configuredPonder !== undefined
      && String(configuredPonder).toLocaleLowerCase() !== "true") {
    throw new Error("timing.opponent_turn_search requires UCI Ponder=true");
  }
  const configuredOverhead = config.engine?.uci_options?.["Move Overhead"];
  if (configuredOverhead !== undefined
      && Number(configuredOverhead) !== config.timing.initial_transport_reserve_ms) {
    throw new Error("UCI Move Overhead conflicts with timing.initial_transport_reserve_ms");
  }
  const configuredController = config.engine?.uci_options?.IterativeTimeController;
  if (configuredController !== undefined
      && String(configuredController).toLocaleLowerCase() !== "false") {
    throw new Error("Lichess timing-profile consumption requires IterativeTimeController=false");
  }
  const configuredProviderReserve = config.engine?.uci_options?.TimeProfileProviderReserveUs;
  if (configuredProviderReserve !== undefined && Number(configuredProviderReserve) !== 0) {
    throw new Error("TimeProfileProviderReserveUs is timing-profile-owned and must start at zero");
  }
  config.engine.uci_options.IterativeTimeController = false;
  config.engine.uci_options.TimeProfileProviderReserveUs = 0;
  config.schema = CURRENT_CONFIG_SCHEMA;
  config.engine.timing = config.timing;
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
  timeProfilePath,
  environment = process.env,
} = {}) {
  const parsed = JSON.parse(readFileSync(templatePath, "utf8"));
  if (parsed.schema !== CURRENT_CONFIG_SCHEMA && !LEGACY_CONFIG_SCHEMAS.has(parsed.schema)) {
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
  const selectedTimeProfile = timeProfilePath || environment.UCI_ARENA_TIME_PROFILE?.trim();
  if (selectedTimeProfile) config.engine.time_profile = selectedTimeProfile;
  normalizeTimingConfig(config);
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
    return this.requestQueue.enqueue(() => {
      options.beforeDispatch?.();
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Lichess request was cancelled before dispatch");
      }
      return this.requestDirect(endpoint, options);
    }, priority);
  }

  async json(endpoint, options) {
    return (await this.request(endpoint, options)).json();
  }

  async post(endpoint, form, signal, priority, beforeDispatch) {
    const requestPriority = priority ?? (endpoint.includes("/move/") ? 0 : 10);
    return this.request(endpoint, {
      method: "POST",
      form,
      signal,
      priority: requestPriority,
      beforeDispatch,
    });
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
  for (const key of [
    "model_fingerprint",
    "model_provider",
    "model_provider_numeric_fingerprint",
    "model_hardware_driver_fingerprint",
    "model_id",
  ]) {
    const match = line.match(new RegExp(`(?:^| )${key} ([^ ]+)`));
    if (match) telemetry[key] = match[1];
  }
  return telemetry;
}

function requireQualifiedSearchIdentity(profile, telemetry) {
  const identityFields = [
    ["model_fingerprint", "model_fingerprint"],
    ["model_provider", "provider"],
    ["model_provider_numeric_fingerprint", "provider_numeric_fingerprint"],
    ["model_hardware_driver_fingerprint", "hardware_driver_fingerprint"],
    ["model_id", "model_id"],
  ];
  for (const [telemetryField, profileField] of identityFields) {
    if (telemetry[telemetryField] === undefined || profile[profileField] === undefined) continue;
    if (String(telemetry[telemetryField]) !== String(profile[profileField])) {
      throw new Error(
        `UCI search ${telemetryField} mismatch: expected ${profile[profileField]}, got ${telemetry[telemetryField]}`,
      );
    }
  }
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
    this.uciIdLines = [];
    this.uciOptionLines = [];
    this.latestInfo = {};
    this.timing = { ...DEFAULT_TIMING_CONFIG, ...(config.timing ?? {}) };
    this.searchSequence = 0;
    this.runtimeGeneration = 0;
    this.mode = "idle";
    this.activeSearch = null;
    this.timeProfileStatus = timeProfileFallbackStatus(
      "missing",
      "no timing profile was configured",
    );
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
    this.configureUciOptions();
    await this.exchange("isready", (line) => line === "readyok", 30_000);
    this.runtimeGeneration += 1;
    await this.configureTimeProfile();
    if (this.config.qualification_profile) await this.qualifyRuntime();
    if (this.qualificationStatus) this.qualificationStatus.time_profile = this.timeProfileStatus;
  }

  configureUciOptions() {
    const unknown = Object.keys(this.config.uci_options)
      .filter((name) => !this.advertisedOptions.has(name));
    if (unknown.length) throw new Error(`Configured UCI options are not advertised: ${unknown.join(", ")}`);
    const requiredTimingOptions = [
      "Move Overhead",
      "IterativeTimeController",
      "TimeProfileProviderReserveUs",
    ];
    if (this.timing.opponent_turn_search) requiredTimingOptions.push("Ponder");
    const missingTimingOptions = requiredTimingOptions
      .filter((name) => !this.advertisedOptions.has(name));
    if (missingTimingOptions.length) {
      throw new Error(`Required time-management UCI options are not advertised: ${missingTimingOptions.join(", ")}`);
    }
    for (const [name, value] of Object.entries(this.config.uci_options)) {
      if (name === "Move Overhead" || name === "Ponder"
          || name === "IterativeTimeController"
          || name === "TimeProfileProviderReserveUs") continue;
      this.send(`setoption name ${name} value ${String(value)}`);
    }
    this.send(`setoption name Move Overhead value ${this.timing.initial_transport_reserve_ms}`);
    this.send("setoption name IterativeTimeController value false");
    this.send("setoption name TimeProfileProviderReserveUs value 0");
    if (this.timing.opponent_turn_search) this.send("setoption name Ponder value true");
  }

  onLine(line) {
    if (line.startsWith("id ")) this.uciIdLines.push(line);
    if (line.startsWith("option name ") && line.includes(" type ")) {
      this.uciOptionLines.push(line);
      this.advertisedOptions.add(line.slice("option name ".length).split(" type ", 1)[0]);
    }
    if (line.startsWith("info ")) this.latestInfo = { ...this.latestInfo, ...parseInfo(line) };
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
      if (Number.isFinite(timeoutMs)) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`UCI response timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }

  exchange(command, predicate, timeoutMs) {
    const response = this.waitFor(predicate, timeoutMs);
    this.send(command);
    return response;
  }

  async newGame() {
    await this.stopAndDrain("new_game");
    this.send("ucinewgame");
    await this.exchange("isready", (line) => line === "readyok", 30_000);
    this.runtimeGeneration += 1;
  }

  async runtimeStatus() {
    const line = await this.exchange(
      "runtime_status",
      (candidate) => candidate.startsWith("info string runtime_status_v1 "),
      30_000,
    );
    return parseRuntimeStatus(line);
  }

  timeProfileConfiguration(appliedTimeProfileReserveUs = 0) {
    const options = this.config.uci_options;
    const extraEngineOptions = Object.fromEntries(
      Object.entries(options)
        .filter(([name]) => !TIME_PROFILE_RESERVED_OPTIONS.has(name))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    const booleanOption = (name, fallback = false) => (
      options[name] === undefined
        ? fallback
        : String(options[name]).toLocaleLowerCase() === "true"
    );
    return {
      searchCore: String(options.SearchCore),
      threads: Number(options.Threads),
      rootWorkers: Number(options.RootWorkers),
      splitDepth: Number(options.V2SplitDepth),
      batchSize: Number(options.NNBatchSize),
      batchWaitUs: Number(options.NNBatchWaitUs),
      provider: String(options.OnnxProvider),
      backgroundSearch: booleanOption("BackgroundSearch"),
      nnSpeculation: booleanOption("NNSpeculation"),
      moveOverheadMs: this.timing.initial_transport_reserve_ms,
      iterativeTimeController: false,
      appliedTimeProfileReserveUs,
      modelRoot: options.ModelRoot,
      extraEngineOptions,
    };
  }

  async configureTimeProfile() {
    const initialStatus = await this.runtimeStatus();
    if (initialStatus.time_profile_provider_reserve_us !== 0) {
      throw new Error("UCI timing-profile provider reserve did not initialize to zero");
    }
    const configuredPath = String(this.config.time_profile ?? "").trim();
    if (!configuredPath) {
      this.timeProfileStatus = timeProfileFallbackStatus(
        "missing",
        "no timing profile was configured",
      );
      this.telemetry({ event: "time_profile_status", ...this.timeProfileStatus });
      return this.timeProfileStatus;
    }
    const resolvedPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(this.config.working_directory, configuredPath);
    if (!existsSync(resolvedPath)) {
      this.timeProfileStatus = timeProfileFallbackStatus(
        "missing",
        `timing profile is unavailable: ${resolvedPath}`,
      );
      this.telemetry({ event: "time_profile_status", ...this.timeProfileStatus });
      return this.timeProfileStatus;
    }

    let profile;
    let reserveWasSet = false;
    try {
      profile = loadTimeProfile(resolvedPath, this.config.working_directory);
      const configuration = this.timeProfileConfiguration(0);
      const accepted = validateProfileRuntimeSnapshot({
        profile,
        status: initialStatus,
        executable: this.config.executable,
        engineArgs: [],
        cwd: this.config.working_directory,
        uciIdLines: this.uciIdLines,
        uciOptionLines: this.uciOptionLines,
        configuration,
      });
      this.send(`setoption name ${accepted.uci_option.name} value ${accepted.uci_option.value}`);
      reserveWasSet = true;
      await this.exchange("isready", (line) => line === "readyok", 30_000);
      const appliedStatus = await this.runtimeStatus();
      validateProfileRuntimeSnapshot({
        profile,
        status: appliedStatus,
        executable: this.config.executable,
        engineArgs: [],
        cwd: this.config.working_directory,
        uciIdLines: this.uciIdLines,
        uciOptionLines: this.uciOptionLines,
        configuration: this.timeProfileConfiguration(accepted.provider_service_reserve_us),
      });
      this.timeProfileStatus = validateAppliedTimeProfileReserve(profile, appliedStatus);
    } catch (error) {
      if (reserveWasSet) {
        this.send("setoption name TimeProfileProviderReserveUs value 0");
        await this.exchange("isready", (line) => line === "readyok", 30_000);
        const resetStatus = await this.runtimeStatus();
        if (resetStatus.time_profile_provider_reserve_us !== 0) {
          throw new Error(`Timing-profile rejection could not restore reserve zero: ${error.message}`);
        }
      }
      this.timeProfileStatus = timeProfileFallbackStatus("rejected", error.message);
    }
    this.telemetry({ event: "time_profile_status", ...this.timeProfileStatus });
    return this.timeProfileStatus;
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

  parseBestmove(line) {
    const parts = String(line).trim().split(/\s+/);
    const bestmove = parts[0] === "bestmove" ? parts[1] : null;
    if (!UCI_MOVE_PATTERN.test(bestmove ?? "")) {
      throw new Error(`UCI engine returned unusable bestmove: ${bestmove ?? "missing"}`);
    }
    const ponderIndex = parts.indexOf("ponder");
    const ponder = ponderIndex >= 0 && UCI_MOVE_PATTERN.test(parts[ponderIndex + 1] ?? "")
      ? parts[ponderIndex + 1]
      : null;
    return { bestmove, ponder };
  }

  formatPosition(moves) {
    return moves.length ? `position startpos moves ${moves.join(" ")}` : "position startpos";
  }

  formatClockGo(prefix, { wtime, btime, winc, binc }) {
    const clock = (value) => Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
    return `${prefix} wtime ${clock(wtime)} btime ${clock(btime)} winc ${clock(winc)} binc ${clock(binc)}`;
  }

  beginSearch(kind, command, { rootMoves, predictedMove = null } = {}) {
    if (this.activeSearch) {
      throw new Error(`Cannot start ${kind} UCI search while ${this.activeSearch.kind} is active`);
    }
    const generation = ++this.searchSequence;
    const goSentAt = performance.now();
    const active = {
      kind,
      generation,
      runtimeGeneration: this.runtimeGeneration,
      rootMoves: [...(rootMoves ?? [])],
      rootKey: (rootMoves ?? []).join(" "),
      predictedMove,
      goSentAt,
      settled: false,
    };
    const response = this.waitFor((candidate) => candidate.startsWith("bestmove "));
    active.completion = response.then((line) => ({
      ok: true,
      line,
      completedAt: performance.now(),
      telemetry: { ...this.latestInfo },
    }), (error) => ({ ok: false, error }));
    active.completion.then(() => { active.settled = true; });
    this.activeSearch = active;
    this.mode = kind;
    this.send(command);
    return active;
  }

  async awaitSearch(active, timeoutMs) {
    let timer;
    const timeout = Number.isFinite(timeoutMs)
      ? new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          ok: false,
          error: new Error(`UCI ${active.kind} search timed out after ${timeoutMs} ms`),
        }), timeoutMs);
      })
      : null;
    const outcome = timeout
      ? await Promise.race([active.completion, timeout]).finally(() => clearTimeout(timer))
      : await active.completion;
    if (!outcome.ok) throw outcome.error;
    if (this.activeSearch === active) {
      this.activeSearch = null;
      this.mode = "idle";
    }
    const move = this.parseBestmove(outcome.line);
    return {
      ...move,
      telemetry: outcome.telemetry,
      rootMoves: [...active.rootMoves],
      rootKey: active.rootKey,
      runtimeGeneration: active.runtimeGeneration,
      searchGeneration: active.generation,
      goSentAt: active.goSentAt,
      bestmoveAt: outcome.completedAt,
      go_to_bestmove_ms: outcome.completedAt - active.goSentAt,
      ponderMode: active.kind,
    };
  }

  async awaitCancellableSearch(active, timeoutMs, signal, reason) {
    if (!signal) return this.awaitSearch(active, timeoutMs);
    let cancellationDrain = null;
    const onAbort = () => {
      cancellationDrain ??= this.stopAndDrain(reason).catch((error) => {
        this.telemetry({
          event: "authoritative_search_cancel_drain_error",
          search_generation: active.generation,
          message: error.message,
        });
      });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.awaitSearch(active, timeoutMs);
      if (signal.aborted) {
        await cancellationDrain;
        throw searchCancellationError(signal);
      }
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async stopAndDrain(reason = "state_change") {
    const active = this.activeSearch;
    if (!active) return { drained: false, reason };
    if (!active.settled) this.send("stop");
    const timeoutMs = Number(this.config.ponder_stop_timeout_ms ?? 5_000);
    const result = await this.awaitSearch(active, timeoutMs);
    this.telemetry({
      event: "stale_bestmove_drained",
      search_kind: active.kind,
      search_generation: active.generation,
      reason,
      move: result.bestmove,
    });
    return {
      drained: true,
      reason,
      searchKind: active.kind,
      searchGeneration: active.generation,
      staleBestmove: result.bestmove,
    };
  }

  isOpponentTurnSearchActive() {
    return this.activeSearch?.kind === "ponder" || this.activeSearch?.kind === "opponent_root";
  }

  opponentTurnSearchSnapshot() {
    const active = this.activeSearch;
    if (!active || !this.isOpponentTurnSearchActive()) return null;
    return {
      kind: active.kind,
      runtimeGeneration: active.runtimeGeneration,
      searchGeneration: active.generation,
      rootKey: active.rootKey,
      predictedMove: active.predictedMove,
    };
  }

  async startOpponentTurnSearch({ moves, predictedMove, wtime, btime, winc, binc }) {
    if (!this.timing.opponent_turn_search) return null;
    await this.stopAndDrain("opponent_turn_restart");
    this.latestInfo = {};
    if (predictedMove && !UCI_MOVE_PATTERN.test(predictedMove)) {
      throw new Error(`Cannot ponder unusable predicted move: ${predictedMove}`);
    }
    if (predictedMove) {
      const ponderRoot = [...moves, predictedMove];
      this.send(this.formatPosition(ponderRoot));
      return this.beginSearch(
        "ponder",
        this.formatClockGo("go ponder", { wtime, btime, winc, binc }),
        { rootMoves: ponderRoot, predictedMove },
      );
    }
    this.send(this.formatPosition(moves));
    return this.beginSearch("opponent_root", "go infinite", { rootMoves: moves });
  }

  async ponderHit({ timeoutMs, signal }) {
    const active = this.activeSearch;
    if (!active || active.kind !== "ponder") {
      throw new Error("Cannot send ponderhit without an active ponder search");
    }
    if (signal?.aborted) {
      await this.stopAndDrain("authoritative_state_changed");
      throw searchCancellationError(signal);
    }
    this.send("ponderhit");
    active.kind = "foreground";
    this.mode = "foreground";
    try {
      return await this.awaitCancellableSearch(
        active,
        timeoutMs,
        signal,
        "authoritative_state_changed",
      );
    } catch (error) {
      await this.stopAndDrain("ponderhit_failure").catch(() => {});
      throw error;
    }
  }

  async search({ moves, wtime, btime, winc, binc, color, signal }) {
    if (signal?.aborted) throw searchCancellationError(signal);
    const drained = await this.stopAndDrain("foreground_search");
    if (signal?.aborted) throw searchCancellationError(signal);
    this.latestInfo = {};
    this.send(this.formatPosition(moves));
    const ownTime = color === "white" ? wtime : btime;
    const timeoutMs = Math.max(10_000, ownTime + Number(this.config.search_timeout_grace_ms ?? 10_000));
    const active = this.beginSearch(
      "foreground",
      this.formatClockGo("go", { wtime, btime, winc, binc }),
      { rootMoves: moves },
    );
    try {
      return {
        ...await this.awaitCancellableSearch(
          active,
          timeoutMs,
          signal,
          "authoritative_state_changed",
        ),
        staleBestmoveDrained: drained.drained,
      };
    } catch (error) {
      await this.stopAndDrain("foreground_search_failure").catch(() => {});
      throw error;
    }
  }

  async close() {
    const child = this.child;
    if (!child) return;
    await this.stopAndDrain("engine_close").catch((error) => {
      this.telemetry({ event: "engine_close_drain_error", message: error.message });
    });
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

function normalizedMoves(value) {
  const moves = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const invalid = moves.find((move) => !UCI_MOVE_PATTERN.test(move));
  if (invalid) throw new Error(`Authoritative Lichess move list contains invalid move: ${invalid}`);
  return moves;
}

function movesKey(moves) {
  return moves.join(" ");
}

function sameMoves(left, right) {
  return left.length === right.length && left.every((move, index) => move === right[index]);
}

function startsWithMoves(moves, prefix) {
  return moves.length >= prefix.length && prefix.every((move, index) => moves[index] === move);
}

function colorToMove(moves) {
  return moves.length % 2 === 0 ? "white" : "black";
}

function clockMilliseconds(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : Math.max(0, Math.trunc(fallback));
}

function stateClock(state, defaultIncrementMs = 0) {
  return {
    wtime: clockMilliseconds(state.wtime),
    btime: clockMilliseconds(state.btime),
    winc: clockMilliseconds(state.winc, defaultIncrementMs),
    binc: clockMilliseconds(state.binc, defaultIncrementMs),
  };
}

function subtractLocalClockDelay(clocks, color, elapsedMs) {
  const adjusted = { ...clocks };
  const key = color === "white" ? "wtime" : "btime";
  adjusted[key] = Math.max(0, adjusted[key] - Math.max(0, Math.ceil(elapsedMs)));
  return adjusted;
}

export class ForegroundSearchCoordinator {
  constructor({ enabled = true, sessions = () => [] } = {}) {
    this.enabled = enabled;
    this.sessions = sessions;
    this.activeGames = new Set();
  }

  canStartOpponentTurnSearch() {
    return !this.enabled || this.activeGames.size === 0;
  }

  async begin(gameId) {
    const id = String(gameId);
    this.activeGames.add(id);
    try {
      if (this.enabled) {
        await Promise.all(Array.from(this.sessions(), (session) => (
          session.gameId === id
            ? Promise.resolve()
            : session.pauseOpponentSearch("foreground_preempted")
        )));
      }
    } catch (error) {
      this.activeGames.delete(id);
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.activeGames.delete(id);
        if (!this.enabled || this.activeGames.size !== 0) return;
        const sessions = Array.from(this.sessions());
        const outcomes = await Promise.allSettled(
          sessions.map((session) => session.resumeOpponentSearch()),
        );
        outcomes.forEach((outcome, index) => {
          if (outcome.status === "rejected") {
            log("opponent_turn_search_resume_error", {
              game_id: sessions[index].gameId,
              message: outcome.reason?.message ?? String(outcome.reason),
            });
          }
        });
      },
    };
  }
}

export class GameSession {
  constructor({ client, config, account, gameId, signal, slot, store, foregroundCoordinator }) {
    this.client = client;
    this.config = { ...config, timing: { ...DEFAULT_TIMING_CONFIG, ...(config.timing ?? {}) } };
    this.account = account.toLocaleLowerCase();
    this.gameId = String(gameId);
    this.signal = signal;
    this.slot = slot;
    this.store = store;
    this.foregroundCoordinator = foregroundCoordinator ?? new ForegroundSearchCoordinator();
    this.authoritativeMoves = null;
    this.authoritativeGeneration = 0;
    this.observedGeneration = 0;
    this.latestObservedState = null;
    this.foregroundSearch = null;
    this.initialFen = null;
    this.legalityState = null;
    this.lastSubmittedRootKey = null;
    this.pendingOwnMove = null;
    this.defaultIncrementMs = 0;
    this.lastClock = { wtime: 0, btime: 0, winc: 0, binc: 0 };
    this.lastPonderMissReason = null;
    this.staleBestmoveDrained = false;
    this.reconnecting = false;
    this.opponentOperation = Promise.resolve();
  }

  async run() {
    const engine = this.slot.engine;
    if (!engine) throw new Error(`Game ${this.gameId} has no prepared engine`);
    let reconnectDelay = 1_000;
    let consecutiveFailures = 0;
    while (!this.finished && !this.signal.aborted) {
      const generationBeforeConnection = this.observedGeneration;
      try {
        await this.consumeGameStream(engine);
        if (!this.finished) throw new Error("Lichess game stream closed before the game finished");
      } catch (error) {
        if (this.signal.aborted) break;
        await this.invalidateOpponentSearch("reconnect");
        this.reconnecting = true;
        if (this.observedGeneration > generationBeforeConnection) {
          consecutiveFailures = 0;
          reconnectDelay = 1_000;
        }
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

  async consumeGameStream(engine) {
    const connectionAbort = new AbortController();
    const streamSignal = this.signal && typeof this.signal.addEventListener === "function"
      ? AbortSignal.any([this.signal, connectionAbort.signal])
      : connectionAbort.signal;
    const queue = [];
    let wakeConsumer = null;
    let producerDone = false;
    let producerError = null;
    const wake = () => {
      const resolve = wakeConsumer;
      wakeConsumer = null;
      resolve?.();
    };
    const producer = (async () => {
      try {
        for await (const event of this.client.stream(
          `api/bot/game/stream/${encodeURIComponent(this.gameId)}`,
          streamSignal,
        )) {
          const receivedAt = performance.now();
          if (event.type === "gameFull") {
            queue.push({
              event,
              observation: this.observeState(event.state, {
                receivedAt,
                reconciled: this.reconnecting,
                defaultIncrementMs: clockMilliseconds(event.clock?.increment),
              }),
            });
          } else if (event.type === "gameState") {
            queue.push({
              event,
              observation: this.observeState(event, { receivedAt }),
            });
          } else {
            continue;
          }
          wake();
        }
      } catch (error) {
        producerError = error;
      } finally {
        producerDone = true;
        wake();
      }
    })();

    try {
      while (!producerDone || queue.length) {
        if (!queue.length) {
          await new Promise((resolve) => { wakeConsumer = resolve; });
          continue;
        }
        const { event, observation } = queue.shift();
        if (event.type === "gameFull") {
          await this.initialize(event, engine);
          await this.onState(event.state, engine, { observation });
          this.reconnecting = false;
        } else {
          if (!this.initialized) {
            throw new Error(`Game state arrived before metadata for ${this.gameId}`);
          }
          await this.onState(event, engine, { observation });
        }
        if (this.finished) {
          connectionAbort.abort();
          break;
        }
      }
    } catch (error) {
      connectionAbort.abort(error);
      await producer;
      throw error;
    }
    connectionAbort.abort();
    await producer;
    if (producerError && !this.finished && !this.signal.aborted) throw producerError;
  }

  async initialize(event, engine) {
    const streamedGameId = event.id ?? event.gameId;
    if (streamedGameId !== undefined && String(streamedGameId) !== this.gameId) {
      throw new Error(`Lichess game stream identity mismatch: ${streamedGameId}`);
    }
    if (event.variant?.key !== "standard" || event.initialFen !== "startpos") {
      throw new Error(`Unsupported live game shape for ${this.gameId}`);
    }
    this.initialFen = event.initialFen;
    this.legalityState = new AuthoritativeChessState(this.initialFen);
    const white = String(event.white?.id ?? event.white?.name ?? "").toLocaleLowerCase();
    const black = String(event.black?.id ?? event.black?.name ?? "").toLocaleLowerCase();
    this.color = white === this.account ? "white" : black === this.account ? "black" : null;
    if (!this.color) throw new Error(`Account is not a player in game ${this.gameId}`);
    if (this.initialized) return;
    this.opponent = this.color === "white" ? black : white;
    this.slot.opponent = this.opponent;
    this.defaultIncrementMs = clockMilliseconds(event.clock?.increment);
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

  serializeOpponentOperation(operation) {
    const current = this.opponentOperation.then(operation, operation);
    this.opponentOperation = current.catch(() => {});
    return current;
  }

  pauseOpponentSearch(reason = "foreground_preempted") {
    return this.serializeOpponentOperation(async () => {
      const engine = this.slot.engine;
      if (!engine || engine.mode === "idle") return { drained: false, reason };
      if (reason === "foreground_preempted" && !engine.isOpponentTurnSearchActive()) {
        return { drained: false, reason };
      }
      const drained = await engine.stopAndDrain(reason);
      this.staleBestmoveDrained ||= drained.drained;
      if (reason === "foreground_preempted") this.lastPonderMissReason = reason;
      return drained;
    });
  }

  async invalidateOpponentSearch(reason) {
    const drained = await this.pauseOpponentSearch(reason);
    if (this.pendingOwnMove) this.pendingOwnMove.predictedMove = null;
    this.lastPonderMissReason = reason;
    return drained;
  }

  resumeOpponentSearch() {
    return this.serializeOpponentOperation(async () => {
      const engine = this.slot.engine;
      if (!engine || this.finished || !this.initialized
          || !this.config.timing.opponent_turn_search
          || engine.mode !== "idle"
          || this.authoritativeGeneration !== this.observedGeneration
          || !this.foregroundCoordinator.canStartOpponentTurnSearch()) return null;

      let moves;
      let predictedMove = null;
      let clocks = this.lastClock;
      if (this.pendingOwnMove) {
        moves = this.pendingOwnMove.projectedMoves;
        predictedMove = this.pendingOwnMove.predictedMove;
        clocks = this.pendingOwnMove.estimatedClock;
      } else if (this.authoritativeMoves && colorToMove(this.authoritativeMoves) !== this.color) {
        moves = this.authoritativeMoves;
      } else {
        return null;
      }
      const active = await engine.startOpponentTurnSearch({ moves, predictedMove, ...clocks });
      if (!active) return null;
      if (this.pendingOwnMove) {
        this.pendingOwnMove.ponderSearchGeneration = active.generation;
        this.pendingOwnMove.runtimeGeneration = active.runtimeGeneration;
      }
      log("opponent_turn_search_started", {
        game_id: this.gameId,
        ponder_mode: active.kind,
        predicted_move: predictedMove,
        search_generation: active.generation,
        transport_reserve_ms: this.config.timing.initial_transport_reserve_ms,
      });
      return active;
    });
  }

  classifyTransition(moves, reconciled, previousMoves = this.authoritativeMoves) {
    if (!previousMoves) return { kind: "initial", appended: moves };
    if (sameMoves(moves, previousMoves)) return { kind: "duplicate", appended: [] };
    if (startsWithMoves(moves, previousMoves)) {
      const appended = moves.slice(previousMoves.length);
      return {
        kind: reconciled || appended.length > 2 ? "stream_gap" : "advance",
        appended,
      };
    }
    if (startsWithMoves(previousMoves, moves)) return { kind: "takeback", appended: [] };
    return { kind: "divergence", appended: [] };
  }

  observeState(state, {
    receivedAt = performance.now(),
    reconciled = false,
    defaultIncrementMs = this.defaultIncrementMs,
  } = {}) {
    const moves = normalizedMoves(state.moves);
    const status = String(state.status ?? "");
    const clock = stateClock(state, defaultIncrementMs);
    const previous = this.latestObservedState;
    const transition = this.classifyTransition(
      moves,
      reconciled,
      previous?.moves ?? this.authoritativeMoves,
    );
    const clockChanged = Boolean(previous && ["wtime", "btime", "winc", "binc"]
      .some((field) => previous.clock[field] !== clock[field]));
    const movesChanged = Boolean(previous && !sameMoves(previous.moves, moves));
    const statusChanged = Boolean(previous && previous.status !== status);
    const materiallyChanged = !previous || movesChanged || statusChanged || clockChanged || reconciled;
    if (materiallyChanged) this.observedGeneration += 1;
    const changeReason = status !== "started"
      ? "terminal_state"
      : movesChanged
        ? transition.kind
        : clockChanged
          ? "clock_correction"
          : reconciled
            ? "reconciled_state"
            : transition.kind;
    const observation = {
      state,
      moves,
      rootKey: movesKey(moves),
      status,
      clock,
      clockChanged,
      changeReason,
      transition,
      generation: this.observedGeneration,
      receivedAt,
      reconciled,
    };
    this.latestObservedState = observation;

    const foreground = this.foregroundSearch;
    if (foreground && !foreground.controller.signal.aborted) {
      const invalidatesRoot = status !== "started"
        || observation.rootKey !== foreground.rootKey
        || observation.generation !== foreground.stateGeneration
        || (this.color && colorToMove(moves) !== this.color);
      if (invalidatesRoot) {
        const reason = observation.changeReason;
        foreground.controller.abort(new StaleAuthoritativeSearchError(this.gameId, reason));
        log("foreground_search_preempted", {
          game_id: this.gameId,
          reason,
          search_root: foreground.rootKey,
          authoritative_root: observation.rootKey,
          authoritative_generation: observation.generation,
        });
      }
    }
    return observation;
  }

  observationIsLatest(observation) {
    const latest = this.latestObservedState;
    return Boolean(
      latest
      && latest.generation === observation.generation
      && latest.rootKey === observation.rootKey
      && latest.status === observation.status
    );
  }

  observationIsCurrent(observation) {
    return this.observationIsLatest(observation)
      && observation.status === "started"
      && colorToMove(observation.moves) === this.color;
  }

  preparedPonderHit(moves, engine) {
    const pending = this.pendingOwnMove;
    const active = engine.opponentTurnSearchSnapshot();
    if (!pending?.predictedMove) return { hit: false, reason: "no_predicted_move" };
    if (!startsWithMoves(moves, pending.projectedMoves)
        || moves.length !== pending.projectedMoves.length + 1
        || moves.at(-1) !== pending.predictedMove) {
      return { hit: false, reason: "predicted_move_miss" };
    }
    if (!active || active.kind !== "ponder") return { hit: false, reason: "ponder_not_active" };
    if (active.rootKey !== movesKey(moves)) return { hit: false, reason: "ponder_root_mismatch" };
    if (active.predictedMove !== pending.predictedMove) {
      return { hit: false, reason: "ponder_prediction_mismatch" };
    }
    if (active.runtimeGeneration !== pending.runtimeGeneration
        || engine.runtimeGeneration !== pending.runtimeGeneration) {
      return { hit: false, reason: "runtime_generation_changed" };
    }
    return { hit: true, reason: null };
  }

  async onState(state, engine, {
    receivedAt = performance.now(),
    reconciled = false,
    observation: suppliedObservation = null,
  } = {}) {
    const observation = suppliedObservation
      ?? this.observeState(state, { receivedAt, reconciled });
    receivedAt = observation.receivedAt;
    await this.opponentOperation;
    if (this.finished) return;
    const moves = observation.moves;
    const transition = observation.transition;
    const status = observation.status;
    if (!this.legalityState) {
      throw new Error(`Game ${this.gameId} has no authoritative legality state`);
    }
    observation.legalitySynchronization = this.legalityState.synchronize(moves, {
      forceRebuild: observation.reconciled,
    });
    this.lastClock = observation.clock;

    if (transition.kind === "duplicate" && status === "started") {
      if (!this.observationIsLatest(observation)) return;
      this.authoritativeMoves = moves;
      this.authoritativeGeneration = observation.generation;
      if (observation.clockChanged && engine.isOpponentTurnSearchActive()) {
        const stopped = await this.invalidateOpponentSearch("clock_correction");
        this.staleBestmoveDrained ||= stopped.drained;
      }
      if (colorToMove(moves) === this.color && this.lastSubmittedRootKey !== movesKey(moves)) {
        await this.playMove(state, engine, {
          moves,
          receivedAt,
          observation,
          ponderHit: false,
          ponderMissReason: this.lastPonderMissReason,
          staleBestmoveDrained: this.staleBestmoveDrained,
        });
      } else {
        await this.resumeOpponentSearch();
      }
      return;
    }

    let ponder = { hit: false, reason: null };
    let drained = false;
    if (this.pendingOwnMove) {
      const ownMoveAcknowledged = sameMoves(moves, this.pendingOwnMove.projectedMoves);
      ponder = this.preparedPonderHit(moves, engine);
      const stillWaitingForOwnAck = this.authoritativeMoves
        && sameMoves(moves, this.authoritativeMoves);
      if (!ownMoveAcknowledged && !ponder.hit && !stillWaitingForOwnAck) {
        const reason = transition.kind === "takeback" || transition.kind === "divergence"
          ? transition.kind
          : ponder.reason;
        const stopped = await this.invalidateOpponentSearch(reason ?? "authoritative_state_miss");
        drained ||= stopped.drained;
        this.pendingOwnMove = null;
      }
    } else if (engine.isOpponentTurnSearchActive()
        && transition.kind !== "initial" && transition.kind !== "duplicate") {
      const stopped = await this.invalidateOpponentSearch(transition.kind);
      drained ||= stopped.drained;
    }

    this.authoritativeMoves = moves;
    this.authoritativeGeneration = observation.generation;
    if (this.lastSubmittedRootKey && this.lastSubmittedRootKey !== movesKey(moves)) {
      this.lastSubmittedRootKey = null;
    }

    if (state.status !== "started") {
      if (this.latestObservedState?.generation !== observation.generation) return;
      const stopped = await this.invalidateOpponentSearch("terminal_state");
      drained ||= stopped.drained;
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
    if (this.latestObservedState?.generation !== observation.generation) return;
    if (colorToMove(moves) !== this.color) {
      await this.resumeOpponentSearch();
      return;
    }
    if (this.lastSubmittedRootKey === movesKey(moves)) return;
    await this.playMove(state, engine, {
      moves,
      receivedAt,
      observation,
      ponderHit: ponder.hit,
      ponderMissReason: ponder.hit ? null : ponder.reason ?? this.lastPonderMissReason,
      staleBestmoveDrained: drained || this.staleBestmoveDrained,
    });
  }

  async playMove(state, engine, {
    moves,
    receivedAt,
    observation,
    ponderHit,
    ponderMissReason,
    staleBestmoveDrained,
  }) {
    const rootKey = movesKey(moves);
    const stateGeneration = observation.generation;
    const stateValidatedAt = performance.now();
    const controller = new AbortController();
    const foreground = { controller, rootKey, stateGeneration };
    this.foregroundSearch = foreground;
    let lease = null;
    let result;
    let legality = null;
    try {
      if (!this.observationIsCurrent(observation)) {
        throw new StaleAuthoritativeSearchError(this.gameId, "superseded_before_search");
      }
      lease = await this.foregroundCoordinator.begin(this.gameId);
      if (controller.signal.aborted) throw searchCancellationError(controller.signal);
      if (ponderHit) {
        const ownTime = this.color === "white" ? this.lastClock.wtime : this.lastClock.btime;
        result = await engine.ponderHit({
          timeoutMs: Math.max(
            10_000,
            ownTime + Number(this.config.engine.search_timeout_grace_ms ?? 10_000),
          ),
          signal: controller.signal,
        });
      } else {
        const clocks = subtractLocalClockDelay(
          this.lastClock,
          this.color,
          performance.now() - receivedAt,
        );
        result = await engine.search({
          moves,
          ...clocks,
          color: this.color,
          signal: controller.signal,
        });
      }

      if (!this.observationIsCurrent(observation)
          || this.authoritativeGeneration !== stateGeneration) {
        throw new StaleAuthoritativeSearchError(this.gameId, "superseded_before_submission");
      }
      if (result.rootKey !== rootKey || result.runtimeGeneration !== engine.runtimeGeneration) {
        throw new Error(`UCI bestmove belongs to a stale root or runtime generation for ${this.gameId}`);
      }
      requireQualifiedSearchIdentity(this.config.engine.qualification_profile, result.telemetry ?? {});
      if (!UCI_MOVE_PATTERN.test(result.bestmove)) {
        throw new Error(`UCI bestmove failed legal-root syntax validation: ${result.bestmove ?? "missing"}`);
      }
      legality = this.legalityState.validateCandidate(moves, result.bestmove);
      if (!legality.legal) {
        throw new Error(
          `UCI bestmove is illegal at the exact authoritative root: ${result.bestmove}`,
        );
      }
      if (!this.observationIsCurrent(observation)) {
        throw new StaleAuthoritativeSearchError(this.gameId, "superseded_during_legality_replay");
      }

      let postDispatchedAt = performance.now();
      const postSignal = this.signal && typeof this.signal.addEventListener === "function"
        ? AbortSignal.any([this.signal, controller.signal])
        : controller.signal;
      await this.client.post(
        `api/bot/game/${encodeURIComponent(this.gameId)}/move/${result.bestmove}`,
        undefined,
        postSignal,
        undefined,
        () => {
          if (!this.observationIsCurrent(observation)
              || this.authoritativeGeneration !== stateGeneration) {
            throw new StaleAuthoritativeSearchError(this.gameId, "superseded_in_move_queue");
          }
          postDispatchedAt = performance.now();
        },
      );
      const postAcknowledgedAt = performance.now();
      this.lastSubmittedRootKey = rootKey;
      const elapsedClockMs = Math.max(0, Math.ceil(postAcknowledgedAt - receivedAt));
      const estimatedClock = subtractLocalClockDelay(this.lastClock, this.color, elapsedClockMs);
      const ownTimeKey = this.color === "white" ? "wtime" : "btime";
      const ownIncrementKey = this.color === "white" ? "winc" : "binc";
      estimatedClock[ownTimeKey] += estimatedClock[ownIncrementKey];
      this.pendingOwnMove = {
        baseRootKey: rootKey,
        projectedMoves: [...moves, result.bestmove],
        predictedMove: result.ponder,
        runtimeGeneration: result.runtimeGeneration,
        ponderSearchGeneration: null,
        estimatedClock,
      };
      this.lastPonderMissReason = null;
      this.staleBestmoveDrained = false;
      log("move_played", {
        game_id: this.gameId,
        ply: moves.length + 1,
        move: result.bestmove,
        ponder: result.ponder,
        elapsed_ms: postAcknowledgedAt - receivedAt,
        state_received_to_go_ms: Math.max(0, result.goSentAt - receivedAt),
        go_to_bestmove_ms: result.go_to_bestmove_ms,
        state_validated_to_post_ms: postDispatchedAt - stateValidatedAt,
        post_to_ack_ms: postAcknowledgedAt - postDispatchedAt,
        ponder_mode: ponderHit ? "ponder" : "foreground",
        ponder_hit: Boolean(ponderHit),
        ponder_miss_reason: ponderMissReason,
        stale_bestmove_drained: Boolean(staleBestmoveDrained),
        transport_reserve_ms: this.config.timing.initial_transport_reserve_ms,
        root_legality_validation_ms: legality.elapsedMs,
        root_legality_sync_ms: observation.legalitySynchronization?.elapsedMs ?? null,
        root_legality_applied_plies: observation.legalitySynchronization?.appliedPlies ?? null,
        root_legality_rebuilt: observation.legalitySynchronization?.rebuilt ?? null,
        ...result.telemetry,
      });
    } catch (error) {
      this.lastSubmittedRootKey = null;
      this.pendingOwnMove = null;
      const staleError = error instanceof StaleAuthoritativeSearchError
        ? error
        : controller.signal.aborted
            && controller.signal.reason instanceof StaleAuthoritativeSearchError
          ? controller.signal.reason
          : null;
      if (staleError) {
        log("stale_foreground_result_rejected", {
          game_id: this.gameId,
          reason: staleError.reason,
          root: rootKey,
          authoritative_generation: this.observedGeneration,
        });
        return false;
      }
      if (error instanceof LichessHttpError && error.status === 400) {
        this.lastPonderMissReason = "move_http_400_reconcile";
        log("move_reconciliation_required", {
          game_id: this.gameId,
          status: error.status,
          message: error.message,
        });
      }
      throw error;
    } finally {
      if (this.foregroundSearch === foreground) this.foregroundSearch = null;
      await lease?.release();
    }
    return true;
  }
}

export class BotController {
  constructor({ client, config, account, runtimeDir, signal, store, random = Math.random }) {
    this.client = client;
    this.config = { ...config, timing: { ...DEFAULT_TIMING_CONFIG, ...(config.timing ?? {}) } };
    this.account = normalizedUsername(account);
    this.runtimeDir = runtimeDir;
    this.signal = signal;
    this.store = store;
    this.random = random;
    this.slots = new SlotPool(config.capacity);
    this.engineStarts = new AsyncSemaphore(config.capacity.startup_parallelism);
    this.activeGames = new Map();
    this.gameSessions = new Map();
    this.foregroundCoordinator = new ForegroundSearchCoordinator({
      enabled: this.config.timing.foreground_preempts_ponder,
      sessions: () => this.gameSessions.values(),
    });
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
      const slot = this.slots.acquireStarted(audience, { opponent, direction: "recovered" });
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
      slot = this.slots.acquireStarted(audience, { opponent, direction: "event-recovery" });
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
      foregroundCoordinator: this.foregroundCoordinator,
    });
    this.gameSessions.set(gameId, session);
    const task = session.run().catch((error) => {
      log("game_error", { game_id: gameId, message: error.message });
    }).finally(async () => {
      this.activeGames.delete(gameId);
      this.gameSessions.delete(gameId);
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
      && now - candidate.createdAt >= timeout
      && (candidate.cancelRetryAt == null || now >= candidate.cancelRetryAt))) {
      const challengeId = slot.challengeId;
      if (!challengeId) continue;
      slot.cancelRetryAt = Number.POSITIVE_INFINITY;
      try {
        await this.client.post(`api/challenge/${encodeURIComponent(challengeId)}/cancel`, undefined, this.signal);
      } catch (error) {
        const retryMs = error instanceof LichessHttpError && error.status === 429
          ? Math.max(60_000, error.retryAfterMs)
          : 15_000;
        slot.cancelRetryAt = now + retryMs;
        this.needsReconciliation = true;
        log("challenge_timeout_cancel_error", {
          challenge_id: challengeId,
          opponent: slot.opponent,
          audience: slot.audience,
          message: error.message,
          retry_ms: retryMs,
        });
        continue;
      }
      this.store.updateChallenge(challengeId, "timeout", {
        cooldownMinutes: slot.audience === "bot" ? this.config.scheduler.timeout_cooldown_minutes : 0,
      }, now);
      log("challenge_timeout", {
        challenge_id: challengeId,
        opponent: slot.opponent,
        audience: slot.audience,
        canceled: true,
      });
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
      timing: {
        opponent_turn_search: this.config.timing.opponent_turn_search,
        foreground_preempts_ponder: this.config.timing.foreground_preempts_ponder,
        transport_reserve_ms: this.config.timing.initial_transport_reserve_ms,
        active_foreground_games: Array.from(this.foregroundCoordinator.activeGames),
        games: Array.from(this.gameSessions.values(), (session) => ({
          game_id: session.gameId,
          mode: session.slot.engine?.mode ?? "idle",
          authoritative_generation: session.authoritativeGeneration,
          ponder_predicted: Boolean(session.pendingOwnMove?.predictedMove),
        })),
      },
      opponents: this.store.opponentStats(),
      engine: this.config.engine.executable,
      model_root: this.config.engine.uci_options.ModelRoot,
      qualification_profile: this.config.engine.qualification_profile.profile_path,
      timing_profile_path: this.config.engine.time_profile ?? null,
      timing_profile: this.config.engine.time_profile_status
        ?? timeProfileFallbackStatus("missing", "timing-profile preflight status is unavailable"),
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
    config.engine.time_profile_status = engine.timeProfileStatus;
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
    config.engine.time_profile_status = engines[0]?.timeProfileStatus
      ?? timeProfileFallbackStatus("missing", "no timing-profile engine status was produced");
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
    timeProfilePath: options.time_profile,
  });
  if (options.command === "config") {
    console.log(JSON.stringify({
      status: "ready",
      schema: config.schema,
      engine: config.engine.executable,
      time_profile: config.engine.time_profile ?? null,
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
      timeProfile: options.time_profile ?? config.engine.time_profile,
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
        time_profile: config.engine.time_profile_status,
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
    time_profile: config.engine.time_profile_status,
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
