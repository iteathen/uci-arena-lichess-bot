#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  AsyncSemaphore,
  API_REQUEST_PRIORITY,
  ApiSafetyCoordinator,
  LichessHttpError,
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
  installLinuxStartup,
  queryLinuxStartup,
  uninstallLinuxStartup,
} from "./linux-startup.mjs";
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
export const LIVE_ACCEPTANCE_CONFIRMATION = "I_ACCEPT_ONE_BOT_GAME";

const PROFILE_OWNED_UCI_OPTIONS = Object.freeze({
  search_core: "SearchCore",
  threads: "Threads",
  root_workers: "RootWorkers",
  split_depth: "V2SplitDepth",
  search_graph_mb: "SearchGraphMB",
  mcgs_cpuct_permille: "McgsCpuctPermille",
  mcgs_outstanding_batches: "McgsOutstandingBatches",
  mcgs_book_prior_blend_permille: "McgsBookPriorBlendPermille",
  provider: "OnnxProvider",
  batch_size: "NNBatchSize",
  batch_wait_us: "NNBatchWaitUs",
  speculation: "NNSpeculation",
  background_search: "BackgroundSearch",
  syzygy_path: "SyzygyPath",
  syzygy_manifest: "SyzygyManifest",
  syzygy_probe_limit: "SyzygyProbeLimit",
  syzygy_probe_threads: "SyzygyProbeThreads",
  syzygy_rule50: "Syzygy50MoveRule",
  syzygy_root_probe: "SyzygyRootProbe",
  syzygy_internal_probe: "SyzygyInternalProbe",
});
const ADAPTIVE_CURVE_SCHEMA = "uci_arena_mcgs_adaptive_temporal_curve_v1";
const ADAPTIVE_CURVE_FORMULA = "adaptive_curve_v1_fixed_point";
const ADAPTIVE_CURVE_STATUS = new Set(["qualified_live_authority"]);
const QUALIFIED_STATIC_TEMPORAL_PROFILE = "EarlyCurrent";
const ADAPTIVE_CURVE_FIELDS = Object.freeze({
  reference_pool_ms: {
    option: "McgsTemporalCurveReferencePoolMs",
    minimum: 1_000,
    maximum: 3_600_000,
  },
  amplitude_base_permille: {
    option: "McgsTemporalCurveAmplitudePermille",
    minimum: 0,
    maximum: 16_000,
  },
  amplitude_log_pool_slope_permille: {
    option: "McgsTemporalCurveAmplitudeLogPoolSlopePermille",
    minimum: -16_000,
    maximum: 16_000,
  },
  amplitude_increment_fraction_slope_permille: {
    option: "McgsTemporalCurveAmplitudeIncrementFractionSlopePermille",
    minimum: -16_000,
    maximum: 16_000,
  },
  span_base_moves: {
    option: "McgsTemporalCurveSpan",
    minimum: 4,
    maximum: 20,
  },
  span_log_pool_slope_millimoves: {
    option: "McgsTemporalCurveSpanLogPoolSlopeMillimoves",
    minimum: -20_000,
    maximum: 20_000,
  },
  span_increment_fraction_slope_millimoves: {
    option: "McgsTemporalCurveSpanIncrementFractionSlopeMillimoves",
    minimum: -20_000,
    maximum: 20_000,
  },
  span_min_moves: {
    option: "McgsTemporalCurveSpanMinMoves",
    minimum: 4,
    maximum: 20,
  },
  span_max_moves: {
    option: "McgsTemporalCurveSpanMaxMoves",
    minimum: 4,
    maximum: 20,
  },
  power: {
    option: "McgsTemporalCurvePower",
    minimum: 1,
    maximum: 5,
  },
  work_block_batches: {
    option: "McgsTemporalWorkBlockBatches",
    minimum: 0,
    maximum: 64,
  },
  material_horizon_base_moves: {
    option: "McgsTemporalMaterialHorizonBaseMoves",
    minimum: 0,
    maximum: 20,
  },
  material_horizon_slope_permille: {
    option: "McgsTemporalMaterialHorizonSlopePermille",
    minimum: 0,
    maximum: 4_000,
  },
});
const REQUIRED_PROFILE_EVIDENCE = Object.freeze([
  "cursor_correctness",
  "provider_parity",
  "deadline",
  "topology",
  "complete_game",
]);
const CURRENT_CONFIG_SCHEMA = "uci_arena_lichess_adapter_v6";
const LEGACY_CONFIG_SCHEMAS = new Set([
  "uci_arena_lichess_adapter_v2",
  "uci_arena_lichess_adapter_v3",
  "uci_arena_lichess_adapter_v4",
  "uci_arena_lichess_adapter_v5",
]);
const DEFAULT_TIMING_CONFIG = Object.freeze({
  opponent_turn_search: true,
  foreground_preempts_ponder: true,
  initial_transport_reserve_ms: 650,
  transport_profile_path: null,
});
const TRANSPORT_PROFILE_SCHEMA = "uci_arena_lichess_transport_profile_v1";
const TRANSPORT_PROFILE_MINIMUM_SAMPLES = 200;
const TRANSPORT_PROFILE_MINIMUM_GAMES = 10;
const TRANSPORT_PROFILE_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const TRANSPORT_PROFILE_MAXIMUM_SAMPLES = 2_000;
const TRANSPORT_RESERVE_MINIMUM_MS = 250;
const TRANSPORT_RESERVE_MAXIMUM_MS = 1_500;
const CHALLENGE_RESPONSE_MAX_AGE_MS = 20_000;
const UCI_MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const TIME_PROFILE_RESERVED_OPTIONS = new Set([
  "SearchCore", "Threads", "RootWorkers", "V2SplitDepth", "BackgroundSearch",
  "SearchGraphMB", "McgsCpuctPermille", "McgsOutstandingBatches",
  "McgsBookPriorBlendPermille", "McgsTimePolicy",
  "NNSpeculation", "ModelRoot", "NNBatchSize", "NNBatchWaitUs", "OnnxProvider",
  "IterativeTimeController", "TimeProfileProviderReserveUs", "TimeProfileBackupEmitReserveUs",
  "TimeProfileIterationForecastScalePermille", "Move Overhead", "Ponder",
  "OwnBook",
]);

function percentile(values, quantile) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index];
}

function transportReserveFromP99(p99) {
  if (!Number.isFinite(p99)) return null;
  const rounded = Math.ceil((p99 + 50) / 50) * 50;
  return Math.max(TRANSPORT_RESERVE_MINIMUM_MS, Math.min(TRANSPORT_RESERVE_MAXIMUM_MS, rounded));
}

export function loadTransportProfile(profilePath, now = Date.now()) {
  if (!profilePath || !existsSync(profilePath)) {
    return { status: "missing", qualified: false, reason: "transport profile is unavailable" };
  }
  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    if (profile.schema !== TRANSPORT_PROFILE_SCHEMA) throw new Error("unsupported schema");
    const generatedAt = Date.parse(profile.generated_at);
    if (!Number.isFinite(generatedAt)) throw new Error("generated_at is invalid");
    const samples = Array.isArray(profile.samples) ? profile.samples : [];
    const values = samples.map((sample) => Number(sample?.post_dispatch_to_ack_ms));
    const gameCount = new Set(samples.map((sample) => String(sample?.game_id ?? "")).filter(Boolean)).size;
    const p99 = percentile(values, 0.99);
    const reserve = transportReserveFromP99(p99);
    const qualified = profile.qualified === true
      && samples.length >= TRANSPORT_PROFILE_MINIMUM_SAMPLES
      && gameCount >= TRANSPORT_PROFILE_MINIMUM_GAMES
      && reserve === Number(profile.effective_reserve_ms);
    if (!qualified) {
      return { status: "collecting", qualified: false, reason: "transport profile lacks qualified evidence", profile };
    }
    if (now - generatedAt > TRANSPORT_PROFILE_MAXIMUM_AGE_MS) {
      return { status: "stale", qualified: false, reason: "transport profile is older than seven days", profile };
    }
    return { status: "accepted", qualified: true, reserveMs: reserve, profile };
  } catch (error) {
    return { status: "rejected", qualified: false, reason: error.message };
  }
}

export class TransportProfileTracker {
  constructor({ profilePath, bootstrapReserveMs = 650, now = Date.now, telemetry = () => {} }) {
    this.profilePath = profilePath;
    this.bootstrapReserveMs = bootstrapReserveMs;
    this.now = now;
    this.telemetry = telemetry;
    this.samples = [];
    this.pendingGames = new Set();
    this.effectiveReserveMs = bootstrapReserveMs;
    if (profilePath && existsSync(profilePath)) {
      try {
        const profile = JSON.parse(readFileSync(profilePath, "utf8"));
        if (profile.schema === TRANSPORT_PROFILE_SCHEMA && Array.isArray(profile.samples)) {
          const cutoff = this.now() - TRANSPORT_PROFILE_MAXIMUM_AGE_MS;
          this.samples = profile.samples.filter((sample) => Number(sample?.recorded_at_ms) >= cutoff)
            .slice(-TRANSPORT_PROFILE_MAXIMUM_SAMPLES);
        }
      } catch {
        this.samples = [];
      }
    }
    const accepted = loadTransportProfile(profilePath, this.now());
    if (accepted.qualified) this.effectiveReserveMs = accepted.reserveMs;
  }

  record(gameId, durationMs) {
    if (!gameId || !Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples.push({
      game_id: String(gameId),
      post_dispatch_to_ack_ms: Math.round(durationMs * 1_000) / 1_000,
      recorded_at_ms: this.now(),
    });
    this.samples = this.samples.slice(-TRANSPORT_PROFILE_MAXIMUM_SAMPLES);
    this.pendingGames.add(String(gameId));
  }

  finishGame(gameId) {
    if (!this.pendingGames.delete(String(gameId)) || !this.profilePath) return this.effectiveReserveMs;
    const values = this.samples.map((sample) => sample.post_dispatch_to_ack_ms);
    const gameCount = new Set(this.samples.map((sample) => sample.game_id)).size;
    const p50 = percentile(values, 0.50);
    const p95 = percentile(values, 0.95);
    const p99 = percentile(values, 0.99);
    const reserve = transportReserveFromP99(p99);
    const qualified = this.samples.length >= TRANSPORT_PROFILE_MINIMUM_SAMPLES
      && gameCount >= TRANSPORT_PROFILE_MINIMUM_GAMES
      && reserve !== null;
    if (qualified) this.effectiveReserveMs = reserve;
    const profile = {
      schema: TRANSPORT_PROFILE_SCHEMA,
      generated_at: new Date(this.now()).toISOString(),
      qualified,
      sample_count: this.samples.length,
      game_count: gameCount,
      dispatch_to_ack_ms: { p50, p95, p99 },
      effective_reserve_ms: qualified ? reserve : this.bootstrapReserveMs,
      samples: this.samples,
    };
    mkdirSync(path.dirname(this.profilePath), { recursive: true });
    const temporary = `${this.profilePath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    renameSync(temporary, this.profilePath);
    this.telemetry({
      event: "transport_profile_status",
      qualified,
      sample_count: this.samples.length,
      game_count: gameCount,
      effective_reserve_ms: this.effectiveReserveMs,
      p95_ms: p95,
      p99_ms: p99,
    });
    return this.effectiveReserveMs;
  }
}

class StaleAuthoritativeSearchError extends Error {
  constructor(gameId, reason) {
    super(`Authoritative Lichess state changed during search for ${gameId}: ${reason}`);
    this.name = "StaleAuthoritativeSearchError";
    this.reason = reason;
  }
}

class StaleApiOperationError extends Error {
  constructor(operation, reason) {
    super(`Stale Lichess ${operation} operation: ${reason}`);
    this.name = "StaleApiOperationError";
    this.operation = operation;
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

function sha256Json(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
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
  if (config.timing.transport_profile_path !== null
      && config.timing.transport_profile_path !== undefined
      && typeof config.timing.transport_profile_path !== "string") {
    throw new Error("timing.transport_profile_path must be a path or null");
  }
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
  const configuredBackupEmitReserve = config.engine?.uci_options?.TimeProfileBackupEmitReserveUs;
  if (configuredBackupEmitReserve !== undefined && Number(configuredBackupEmitReserve) !== 1000) {
    throw new Error("TimeProfileBackupEmitReserveUs is timing-profile-owned and must start at 1000");
  }
  const configuredForecastScale =
    config.engine?.uci_options?.TimeProfileIterationForecastScalePermille;
  if (configuredForecastScale !== undefined && Number(configuredForecastScale) !== 1000) {
    throw new Error(
      "TimeProfileIterationForecastScalePermille is timing-profile-owned and must start at 1000",
    );
  }
  const configuredMcgsTimePolicy = config.engine?.uci_options?.McgsTimePolicy;
  if (configuredMcgsTimePolicy !== undefined
      && String(configuredMcgsTimePolicy) !== "RelativeClockTemporalV1") {
    throw new Error("Live MCGS requires McgsTimePolicy=RelativeClockTemporalV1");
  }
  config.engine.uci_options.McgsTimePolicy = "RelativeClockTemporalV1";
  config.engine.uci_options.IterativeTimeController = false;
  config.engine.uci_options.TimeProfileProviderReserveUs = 0;
  config.engine.uci_options.TimeProfileBackupEmitReserveUs = 1000;
  config.engine.uci_options.TimeProfileIterationForecastScalePermille = 1000;
  config.schema = CURRENT_CONFIG_SCHEMA;
  config.timing.bootstrap_transport_reserve_ms = config.timing.initial_transport_reserve_ms;
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
  enginePath,
  workingDirectory,
  modelRoot,
  profilePath,
  timeProfilePath,
  temporalCurvePath,
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
  if (config.schema !== CURRENT_CONFIG_SCHEMA) {
    config.timing ??= {};
    config.timing.initial_transport_reserve_ms ??= 250;
  }
  if (!config.engine?.executable || !config.engine?.working_directory) {
    throw new Error("Lichess adapter config is missing engine paths");
  }
  if (enginePath) config.engine.executable = path.resolve(enginePath);
  if (workingDirectory) config.engine.working_directory = path.resolve(workingDirectory);
  if (!config.engine.uci_options || typeof config.engine.uci_options !== "object") {
    throw new Error("Lichess adapter config is missing engine UCI options");
  }
  if (config.engine.fallback_bundle !== null && config.engine.fallback_bundle !== undefined) {
    throw new Error("engine.fallback_bundle is disabled; live search authority is MCGS only");
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
  const selectedTemporalCurve = temporalCurvePath
    || environment.UCI_ARENA_TEMPORAL_CURVE_PROFILE?.trim();
  if (selectedTemporalCurve) {
    config.engine.temporal_curve_profile = selectedTemporalCurve;
  }
  if (config.engine.temporal_curve_profile) {
    config.engine.temporal_curve_profile = path.isAbsolute(
      config.engine.temporal_curve_profile,
    )
      ? config.engine.temporal_curve_profile
      : path.resolve(
        config.engine.working_directory,
        config.engine.temporal_curve_profile,
      );
    if (config.engine.uci_options.McgsTemporalWeightProfile
        === QUALIFIED_STATIC_TEMPORAL_PROFILE) {
      delete config.engine.uci_options.McgsTemporalWeightProfile;
    }
  } else {
    config.engine.temporal_curve_profile = null;
    if (config.engine.uci_options.McgsTemporalWeightProfile
        !== QUALIFIED_STATIC_TEMPORAL_PROFILE) {
      throw new Error(
        `Live MCGS config without a qualified adaptive curve requires `
        + `McgsTemporalWeightProfile=${QUALIFIED_STATIC_TEMPORAL_PROFILE}`,
      );
    }
  }
  config.engine.selected_bundle = "mcgs";
  normalizeTimingConfig(config);
  if (config.timing.transport_profile_path) {
    config.timing.transport_profile_path = path.isAbsolute(config.timing.transport_profile_path)
      ? config.timing.transport_profile_path
      : path.resolve(config.engine.working_directory, config.timing.transport_profile_path);
  }
  const transportProfile = loadTransportProfile(config.timing.transport_profile_path);
  config.timing.transport_profile_status = transportProfile;
  if (transportProfile.qualified) {
    config.timing.initial_transport_reserve_ms = transportProfile.reserveMs;
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
  if (!new Set(["v2", "mcgs"]).has(profile.search_core)) {
    throw new Error("Single-game profile must select SearchCore v2 or mcgs");
  }
  if (!new Set(["directml", "cuda"]).has(profile.provider)) {
    throw new Error("Single-game profile provider must be directml or cuda");
  }
  requireInteger(profile.threads, "threads", 1, 64);
  requireInteger(profile.root_workers, "root_workers", 1, 16);
  requireInteger(profile.split_depth, "split_depth", 2, 64);
  if (profile.search_core === "mcgs") {
    requireInteger(profile.search_graph_mb, "search_graph_mb", 64, 4_096);
    requireInteger(profile.mcgs_cpuct_permille, "mcgs_cpuct_permille", 100, 10_000);
    requireInteger(profile.mcgs_outstanding_batches, "mcgs_outstanding_batches", 1, 4);
    requireInteger(
      profile.mcgs_book_prior_blend_permille,
      "mcgs_book_prior_blend_permille",
      0,
      500,
    );
  }
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

export function loadAdaptiveTemporalCurveProfile(profilePath) {
  const resolvedPath = path.resolve(profilePath);
  const artifact = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (artifact.schema !== ADAPTIVE_CURVE_SCHEMA) {
    throw new Error(
      `Unsupported adaptive temporal-curve schema: ${artifact.schema ?? "missing"}`,
    );
  }
  requireInteger(artifact.revision, "temporal curve revision", 1);
  requireString(artifact.generated_at, "temporal curve generated_at");
  if (!Number.isFinite(Date.parse(artifact.generated_at))) {
    throw new Error("Adaptive temporal-curve generated_at is not RFC3339");
  }
  if (!ADAPTIVE_CURVE_STATUS.has(artifact.status) || artifact.deployable !== true) {
    throw new Error("Adaptive temporal-curve artifact is not deployable");
  }
  if (artifact.formula !== ADAPTIVE_CURVE_FORMULA) {
    throw new Error("Adaptive temporal-curve formula identity mismatch");
  }
  if (!artifact.coefficients || typeof artifact.coefficients !== "object") {
    throw new Error("Adaptive temporal-curve coefficients are missing");
  }
  if (!artifact.coefficient_bounds || typeof artifact.coefficient_bounds !== "object") {
    throw new Error("Adaptive temporal-curve coefficient bounds are missing");
  }
  const options = {
    McgsTemporalWeightProfile: "AdaptiveCurveV1",
    McgsTemporalCurveRevision: artifact.revision,
  };
  for (const [field, contract] of Object.entries(ADAPTIVE_CURVE_FIELDS)) {
    const declaredBounds = artifact.coefficient_bounds[field];
    if (!Array.isArray(declaredBounds)
        || declaredBounds.length !== 2
        || declaredBounds[0] !== contract.minimum
        || declaredBounds[1] !== contract.maximum) {
      throw new Error(`Adaptive temporal-curve coefficient bounds mismatch: ${field}`);
    }
    options[contract.option] = requireInteger(
      artifact.coefficients[field],
      `temporal curve coefficients.${field}`,
      contract.minimum,
      contract.maximum,
    );
  }
  if (artifact.coefficients.span_min_moves > artifact.coefficients.span_max_moves) {
    throw new Error("Adaptive temporal-curve span bounds are inverted");
  }
  if (!artifact.evidence_manifest || typeof artifact.evidence_manifest !== "object") {
    throw new Error("Adaptive temporal-curve evidence manifest is missing");
  }
  requireString(
    artifact.evidence_manifest_sha256,
    "temporal curve evidence_manifest_sha256",
    /^sha256:[0-9a-f]{64}$/,
  );
  if (sha256Json(artifact.evidence_manifest) !== artifact.evidence_manifest_sha256) {
    throw new Error("Adaptive temporal-curve evidence manifest hash mismatch");
  }
  if (!artifact.promotion || typeof artifact.promotion !== "object"
      || artifact.promotion.ready !== true
      || !Array.isArray(artifact.promotion.reasons)) {
    throw new Error("Adaptive temporal-curve promotion authority is invalid");
  }
  const projectedEntries = artifact.uci_options
      && typeof artifact.uci_options === "object"
    ? Object.entries(artifact.uci_options).toSorted(([left], [right]) => (
      left.localeCompare(right)
    ))
    : [];
  const expectedEntries = Object.entries(options).toSorted(([left], [right]) => (
    left.localeCompare(right)
  ));
  if (projectedEntries.length !== expectedEntries.length
      || projectedEntries.some(([name, value], index) => (
        name !== expectedEntries[index][0] || value !== expectedEntries[index][1]
      ))) {
    throw new Error("Adaptive temporal-curve UCI option projection mismatch");
  }
  return {
    ...artifact,
    profile_path: resolvedPath,
    artifact_sha256: sha256File(resolvedPath),
    applied_uci_options: options,
  };
}

export function applyAdaptiveTemporalCurveProfile(config) {
  if (!config.engine.temporal_curve_profile) {
    throw new Error("Live MCGS config is missing an adaptive temporal-curve profile");
  }
  const artifact = loadAdaptiveTemporalCurveProfile(
    config.engine.temporal_curve_profile,
  );
  for (const [name, value] of Object.entries(artifact.applied_uci_options)) {
    if (Object.hasOwn(config.engine.uci_options, name)
        && String(config.engine.uci_options[name]) !== String(value)) {
      throw new Error(`Tracked config conflicts with adaptive-curve UCI option ${name}`);
    }
  }
  config.engine.uci_options = {
    ...config.engine.uci_options,
    ...artifact.applied_uci_options,
  };
  config.engine.temporal_curve_profile_status = artifact;
  return artifact;
}

export function applySingleGameProfile(config) {
  const profile = loadSingleGameProfile(config.engine.single_game_profile);
  if (profile.search_core !== "mcgs") {
    throw new Error("Live deployment requires a qualified MCGS single-game profile");
  }
  if (profile.tablebase !== undefined) {
    if (!profile.tablebase || typeof profile.tablebase !== "object") {
      throw new Error("Single-game profile tablebase must be an object");
    }
    requireString(profile.tablebase.path, "tablebase.path");
    requireString(profile.tablebase.manifest, "tablebase.manifest");
    requireString(
      profile.tablebase.manifest_identity,
      "tablebase.manifest_identity",
      /^sha256:[0-9a-f]{64}$/,
    );
    requireString(
      profile.tablebase.manifest_file_sha256,
      "tablebase.manifest_file_sha256",
      /^sha256:[0-9a-f]{64}$/,
    );
    requireInteger(profile.tablebase.loaded_cardinality, "tablebase.loaded_cardinality", 3, 7);
    requireInteger(profile.tablebase.probe_limit, "tablebase.probe_limit", 3, 7);
    requireInteger(profile.tablebase.probe_threads, "tablebase.probe_threads", 2, 8);
    for (const field of ["rule50", "root_probe", "internal_probe"]) {
      if (typeof profile.tablebase[field] !== "boolean") {
        throw new Error(`Single-game profile tablebase.${field} must be boolean`);
      }
    }
    const manifestPath = path.isAbsolute(profile.tablebase.manifest)
      ? profile.tablebase.manifest
      : path.resolve(config.engine.working_directory, profile.tablebase.manifest);
    if (!existsSync(manifestPath)) {
      throw new Error("Single-game profile Syzygy manifest is missing");
    }
    if (sha256File(manifestPath) !== profile.tablebase.manifest_file_sha256) {
      throw new Error("Single-game profile Syzygy manifest file hash mismatch");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.identity_sha256 !== profile.tablebase.manifest_identity) {
      throw new Error("Single-game profile Syzygy manifest content identity mismatch");
    }
    if (manifest.schema !== "uci_arena_syzygy_manifest_v1"
        || manifest.cardinality !== profile.tablebase.loaded_cardinality
        || !Array.isArray(manifest.files)
        || manifest.files.length === 0) {
      throw new Error("Single-game profile Syzygy manifest contract mismatch");
    }
    const tablebasePath = path.isAbsolute(profile.tablebase.path)
      ? profile.tablebase.path
      : path.resolve(config.engine.working_directory, profile.tablebase.path);
    let hasMaximumWdl = false;
    let hasMaximumDtz = false;
    for (const entry of manifest.files) {
      if (!entry || typeof entry !== "object"
          || typeof entry.name !== "string"
          || path.basename(entry.name) !== entry.name
          || !Number.isSafeInteger(entry.bytes)
          || entry.bytes <= 0
          || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
        throw new Error("Single-game profile Syzygy manifest file entry is invalid");
      }
      hasMaximumWdl ||= entry.directory === `${profile.tablebase.loaded_cardinality}-wdl`
        && entry.name.endsWith(".rtbw");
      hasMaximumDtz ||= entry.directory === `${profile.tablebase.loaded_cardinality}-dtz`
        && entry.name.endsWith(".rtbz");
      const tableFile = path.join(tablebasePath, entry.name);
      const tableMetadata = existsSync(tableFile) ? statSync(tableFile) : null;
      if (tableMetadata === null || !tableMetadata.isFile()
          || tableMetadata.size !== entry.bytes) {
        throw new Error(`Single-game profile Syzygy table file is missing or partial: ${entry.name}`);
      }
    }
    if (!hasMaximumWdl || !hasMaximumDtz) {
      throw new Error("Single-game profile Syzygy manifest lacks maximum-cardinality WDL or DTZ files");
    }
  }
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
  if (profile.search_core === "mcgs") {
    profileValues.SearchGraphMB = profile.search_graph_mb;
    profileValues.McgsCpuctPermille = profile.mcgs_cpuct_permille;
    profileValues.McgsOutstandingBatches = profile.mcgs_outstanding_batches;
    profileValues.McgsBookPriorBlendPermille = profile.mcgs_book_prior_blend_permille;
  }
  if (profile.tablebase) {
    Object.assign(profileValues, {
      SyzygyPath: profile.tablebase.path,
      SyzygyManifest: profile.tablebase.manifest,
      SyzygyProbeLimit: profile.tablebase.probe_limit,
      SyzygyProbeThreads: profile.tablebase.probe_threads,
      Syzygy50MoveRule: profile.tablebase.rule50,
      SyzygyRootProbe: profile.tablebase.root_probe,
      SyzygyInternalProbe: profile.tablebase.internal_probe,
    });
  }
  for (const optionName of Object.values(PROFILE_OWNED_UCI_OPTIONS)
    .filter((name) => Object.hasOwn(profileValues, name))) {
    if (Object.hasOwn(config.engine.uci_options, optionName)
        && String(config.engine.uci_options[optionName]) !== String(profileValues[optionName])) {
      throw new Error(`Tracked config conflicts with profile-owned UCI option ${optionName}`);
    }
  }
  config.engine.uci_options = { ...config.engine.uci_options, ...profileValues };
  if (config.engine.temporal_curve_profile) {
    profile.temporal_curve = applyAdaptiveTemporalCurveProfile(config);
  } else {
    if (config.engine.uci_options.McgsTemporalWeightProfile
        !== QUALIFIED_STATIC_TEMPORAL_PROFILE) {
      throw new Error(
        `Live MCGS config without a qualified adaptive curve requires `
        + `McgsTemporalWeightProfile=${QUALIFIED_STATIC_TEMPORAL_PROFILE}`,
      );
    }
    profile.temporal_curve = null;
    config.engine.temporal_curve_profile_status = null;
  }
  config.engine.qualification_profile = profile;
  return profile;
}

export function loadCapacityProfile(profilePath, config, singleGameProfile) {
  if (config.capacity.legacy_shared) return null;
  const resolvedPath = path.resolve(profilePath);
  const capacity = JSON.parse(readFileSync(resolvedPath, "utf8"));
  if (!new Set([
    "uci_arena_lichess_capacity_profile_v1",
    "uci_arena_lichess_capacity_profile_v2",
  ]).has(capacity.schema)) {
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
  if (singleGameProfile.search_core === "mcgs"
      && capacity.schema !== "uci_arena_lichess_capacity_profile_v2") {
    throw new Error("MCGS deployment requires a timing-bound Lichess capacity profile v2");
  }
  if (capacity.schema === "uci_arena_lichess_capacity_profile_v2") {
    const timeProfilePath = config.engine.time_profile_status?.profile_path
      ?? config.engine.time_profile;
    if (config.engine.time_profile_status?.accepted !== true || !timeProfilePath
        || !existsSync(path.resolve(timeProfilePath))) {
      throw new Error("Lichess capacity profile v2 requires an accepted timing profile");
    }
    const timingBindings = {
      time_profile_sha256: sha256File(path.resolve(timeProfilePath)),
      time_profile_identity_sha256: config.engine.time_profile_status.identity_sha256,
      search_core: singleGameProfile.search_core,
    };
    for (const [name, expected] of Object.entries(timingBindings)) {
      if (capacity[name] !== expected) {
        throw new Error(`Lichess capacity profile ${name} mismatch`);
      }
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
  if (config.engine.time_profile_status?.accepted !== true) {
    throw new Error("Capacity qualification requires an accepted timing profile");
  }
  const timeProfilePath = config.engine.time_profile_status.profile_path ?? config.engine.time_profile;
  const profile = {
    schema: "uci_arena_lichess_capacity_profile_v2",
    qualified: true,
    published_at: new Date().toISOString(),
    maximum_concurrency: maximumConcurrency,
    engine_build_fingerprint: sha256File(config.engine.executable),
    single_game_profile_sha256: sha256File(singleGameProfile.profile_path),
    model_fingerprint: singleGameProfile.model_fingerprint,
    provider_numeric_fingerprint: singleGameProfile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: singleGameProfile.hardware_driver_fingerprint,
    time_profile_sha256: sha256File(path.resolve(timeProfilePath)),
    time_profile_identity_sha256: config.engine.time_profile_status.identity_sha256,
    search_core: singleGameProfile.search_core,
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
      mcgs_graph_nodes: status.mcgs_graph_nodes,
      mcgs_graph_edges: status.mcgs_graph_edges,
      mcgs_completed_simulations: status.mcgs_completed_simulations,
      mcgs_async_admissions: status.mcgs_async_admissions,
      mcgs_outstanding_peak: status.mcgs_outstanding_peak,
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

async function discardResponseBody(response) {
  if (typeof response?.arrayBuffer === "function") {
    await response.arrayBuffer();
    return;
  }
  if (typeof response?.text === "function") {
    await response.text();
    return;
  }
  if (typeof response?.body?.cancel === "function") await response.body.cancel();
}

function apiRequestClass(endpoint, method = "GET") {
  const normalized = String(endpoint).replace(/^\/+/, "");
  if (normalized.includes("/move/")) return "move";
  if (normalized.startsWith("api/bot/game/stream/")) return "game_stream";
  if (normalized === "api/stream/event") return "event_stream";
  if (normalized.startsWith("api/account/playing")) return "reconciliation";
  if (normalized === "api/account") return "identity";
  if (normalized.startsWith("api/bot/online") || normalized.startsWith("api/user/")) {
    return "discovery";
  }
  if (normalized.startsWith("api/challenge/")) {
    if (method === "POST" && !/\/(?:accept|decline|cancel)$/.test(normalized)) {
      return "challenge_create";
    }
    return "challenge_control";
  }
  return "ordinary";
}

function streamKey(endpoint) {
  const normalized = String(endpoint).replace(/^\/+/, "");
  if (normalized === "api/stream/event") return "event";
  if (normalized.startsWith("api/bot/game/stream/")) {
    return `game:${normalized.slice("api/bot/game/stream/".length)}`;
  }
  return `stream:${normalized}`;
}

export class LichessClient {
  constructor({
    token,
    baseUrl = "https://lichess.org/",
    fetchImpl = globalThis.fetch,
    requestQueue,
    safetyCoordinator,
  }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.requestQueue = safetyCoordinator ?? requestQueue ?? new ApiSafetyCoordinator();
    this.activeStreamKeys = new Set();
  }

  async requestDirect(endpoint, {
    method = "GET",
    form,
    stream = false,
    signal,
    requestClass = apiRequestClass(endpoint, method),
  } = {}) {
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
        retryAfterMs = await this.requestQueue.registerRateLimit(
          response.headers?.get?.("retry-after"),
          requestClass,
        );
      }
      await discardResponseBody(response);
      throw new LichessHttpError(method, endpoint, response.status, retryAfterMs, requestClass);
    }
    return response;
  }

  dispatch(endpoint, options, consume) {
    const method = options.method ?? "GET";
    const requestClass = options.requestClass ?? apiRequestClass(endpoint, method);
    const priority = options.priority ?? API_REQUEST_PRIORITY[requestClass]
      ?? API_REQUEST_PRIORITY.ordinary;
    return this.requestQueue.enqueue(async () => {
      options.beforeDispatch?.();
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Lichess request was cancelled before dispatch");
      }
      const response = await this.requestDirect(endpoint, { ...options, method, requestClass });
      return consume(response);
    }, { priority, requestClass, signal: options.signal });
  }

  json(endpoint, options = {}) {
    return this.dispatch(endpoint, options, (response) => response.json());
  }

  async post(endpoint, form, signal, priority, beforeDispatch) {
    return this.dispatch(endpoint, {
      method: "POST",
      form,
      signal,
      priority,
      beforeDispatch,
    }, async (response) => {
      await discardResponseBody(response);
      return undefined;
    });
  }

  async postJson(endpoint, form, signal, priority, beforeDispatch) {
    return this.dispatch(endpoint, {
      method: "POST",
      form,
      signal,
      priority,
      beforeDispatch,
      requestClass: "challenge_create",
    }, (response) => response.json());
  }

  async openStream(endpoint, signal) {
    const key = streamKey(endpoint);
    if (this.activeStreamKeys.has(key)) {
      throw new Error(`Lichess stream is already pending or active: ${key}`);
    }
    this.activeStreamKeys.add(key);
    try {
      const requestClass = apiRequestClass(endpoint);
      const response = await this.dispatch(endpoint, {
        stream: true,
        signal,
        requestClass,
      }, (opened) => opened);
      return this.trackedStream(response.body, key);
    } catch (error) {
      this.activeStreamKeys.delete(key);
      throw error;
    }
  }

  async *trackedStream(body, key) {
    try {
      yield* parseNdjsonStream(body);
    } finally {
      this.activeStreamKeys.delete(key);
    }
  }

  async *stream(endpoint, signal) {
    yield* await this.openStream(endpoint, signal);
  }

  collectNdjson(endpoint, signal) {
    return this.dispatch(endpoint, {
      signal,
      requestClass: "discovery",
    }, async (response) => {
      const items = [];
      for await (const item of parseNdjsonStream(response.body)) items.push(item);
      return items;
    });
  }

  safetySnapshot() {
    return {
      ...this.requestQueue.snapshot(),
      active_streams: Array.from(this.activeStreamKeys).sort(),
    };
  }

  isCoolingDown() {
    return this.requestQueue.isCoolingDown();
  }
}

export async function probeAccount({
  tokenFile,
  expectedAccount,
  url = "https://lichess.org/",
  fetchImpl = globalThis.fetch,
  client,
  signal,
}) {
  const apiClient = client ?? new LichessClient({
    token: readTokenForRuntime(tokenFile),
    baseUrl: url,
    fetchImpl,
  });
  const profile = await apiClient.json("api/account", { signal });
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

export async function validateLiveAcceptanceParticipants({
  client,
  account,
  target,
  signal,
}) {
  const expectedAccount = normalizedUsername(account);
  const expectedTarget = normalizedUsername(target);
  if (!expectedAccount || !expectedTarget) {
    throw new Error("Live acceptance requires both operator and target account names");
  }
  if (expectedAccount === expectedTarget) {
    throw new Error("Live acceptance target must be distinct from the operator account");
  }
  const targetProfile = await client.json(
    `api/user/${encodeURIComponent(expectedTarget)}`,
    { signal },
  );
  const resolvedTarget = normalizedUsername(targetProfile.username ?? targetProfile.id);
  if (resolvedTarget !== expectedTarget) {
    throw new Error(`Live acceptance target identity mismatch: ${resolvedTarget || "missing"}`);
  }
  if (String(targetProfile.title ?? "").toUpperCase() !== "BOT") {
    throw new Error(`Live acceptance target is not BOT-titled: ${resolvedTarget}`);
  }
  if (targetProfile.disabled === true || targetProfile.tosViolation === true) {
    throw new Error(`Live acceptance target is not a public usable account: ${resolvedTarget}`);
  }
  if (targetProfile.online !== true) {
    throw new Error(`Live acceptance target is not online: ${resolvedTarget}`);
  }
  const playing = await client.json("api/account/playing?nb=50", { signal });
  const active = (playing.nowPlaying ?? []).map((game) => ({
    gameId: String(game.gameId ?? game.id ?? ""),
    opponent: normalizedUsername(
      game.opponent?.id ?? game.opponent?.username ?? game.opponent?.name,
    ),
  }));
  const unrelated = active.filter((game) => game.opponent !== expectedTarget);
  if (unrelated.length) {
    throw new Error("Live acceptance operator account has an unrelated active game");
  }
  if (active.length > 1) {
    throw new Error("Live acceptance operator account has multiple active games");
  }
  return {
    account: expectedAccount,
    target: resolvedTarget,
    target_title: "BOT",
    target_online: true,
    recovered_game_id: active[0]?.gameId || null,
  };
}

export function apiAuthorityKey(url, expectedAccount) {
  return `${new URL(url).origin.toLocaleLowerCase()}|${normalizedUsername(expectedAccount)}`;
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
    "mcgs_graph_nodes",
    "mcgs_graph_edges",
    "mcgs_graph_reuses",
    "mcgs_completed_simulations",
    "mcgs_outstanding_peak",
    "mcgs_async_admissions",
    "mcgs_async_capacity_deferrals",
    "mcgs_root_seeded_moves",
    "mcgs_root_legal_moves",
    "mcgs_book_hint_active",
    "mcgs_book_hint_candidates",
    "mcgs_book_prior_blend_permille",
    "mcgs_book_top_frequency_ppm",
    "mcgs_book_top_neural_prior_ppm",
    "mcgs_book_top_effective_prior_ppm",
    "mcgs_root_completed_edges_at_start",
    "mcgs_root_visited_edges_at_start",
    "mcgs_provider_admission_denials",
    "mcgs_cache_completions_after_admission_close",
    "mcgs_nonprovider_backups_after_admission_close",
    "mcgs_stale_backups_discarded",
    "mcgs_reservation_leaks",
    "mcgs_snapshot_sequence",
    "time_opponent_remaining_ms",
    "time_opponent_increment_ms",
    "time_horizon_moves",
    "time_safety_reserve_ms",
    "time_safe_ms",
    "time_decision_index",
    "time_temporal_weight_permille",
    "time_temporal_weight_sum_permille",
    "time_unweighted_optimum_ms",
    "time_phase_optimum_ms",
    "time_relative_surplus_ms",
    "time_relative_credit_ms",
    "time_relative_scheduled_ms",
    "time_book_credit_before_ms",
    "time_book_credit_scheduled_ms",
    "time_book_credit_after_ms",
    "time_searched_decisions_completed",
    "time_completion_applied",
  ]) {
    const match = line.match(new RegExp(`(?:^| )${key} (\\d+)`));
    if (match) telemetry[key] = Number(match[1]);
  }
  for (const key of [
    "book_lookup_us",
    "book_evaluation_us",
    "book_decision_us",
    "book_emit_us",
    "book_record_count",
  ]) {
    const match = line.match(new RegExp(`(?:^| )${key} (\\d+)`));
    if (match) telemetry[key] = Number(match[1]);
  }
  for (const key of [
    "book_probe_result",
    "book_miss_reason",
    "book_evaluation_source",
    "book_snapshot_identity",
    "mcgs_search_intent",
    "mcgs_book_hint_result",
    "mcgs_book_hint_identity",
    "mcgs_book_top_move",
    "time_policy",
    "time_completion_kind",
  ]) {
    const match = line.match(new RegExp(`(?:^| )${key} ([^ ]+)`));
    if (match) telemetry[key] = match[1];
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

function requireQualifiedMcgsTimeTelemetry(profile, telemetry) {
  if (profile.search_core !== "mcgs") {
    throw new Error("Live move authority is not MCGS");
  }
  if (telemetry.time_policy !== "RelativeClockTemporalV1") {
    throw new Error(
      `UCI move did not use RelativeClockTemporalV1: ${telemetry.time_policy ?? "missing"}`,
    );
  }
  for (const field of [
    "time_opponent_remaining_ms",
    "time_opponent_increment_ms",
    "time_temporal_weight_permille",
    "time_relative_surplus_ms",
    "time_relative_credit_ms",
    "time_relative_scheduled_ms",
    "time_completion_applied",
  ]) {
    if (!Number.isSafeInteger(telemetry[field]) || telemetry[field] < 0) {
      throw new Error(`UCI move timing telemetry is missing ${field}`);
    }
  }
  if (typeof telemetry.time_completion_kind !== "string") {
    throw new Error("UCI move timing telemetry is missing completion authority");
  }
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
  requireRuntimeStatus(
    status.search_core_configured === profile.search_core,
    `SearchCore ${profile.search_core} is not configured`,
  );
  if (profile.tablebase) {
    requireRuntimeStatus(status.syzygy_active === true, "Syzygy provider is inactive");
    requireRuntimeStatus(
      status.syzygy_loaded_cardinality === profile.tablebase.loaded_cardinality,
      "Syzygy cardinality mismatch",
    );
    requireRuntimeStatus(
      status.syzygy_manifest_identity === profile.tablebase.manifest_identity,
      "Syzygy manifest identity mismatch",
    );
    requireRuntimeStatus(
      status.syzygy_probe_threads === profile.tablebase.probe_threads,
      "Syzygy worker topology mismatch",
    );
  }
  requireRuntimeStatus(status.threads_configured === profile.threads, "thread topology mismatch");
  if (profile.search_core === "mcgs") {
    requireRuntimeStatus(
      status.mcgs_book_prior_blend_permille_configured
        === profile.mcgs_book_prior_blend_permille,
      "MCGS book-prior blend mismatch",
    );
  }
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
  requireRuntimeStatus(
    status.last_search_core === profile.search_core,
    `qualification search did not use ${profile.search_core}`,
  );
  requireRuntimeStatus(status.last_search_threads === profile.threads, "active thread topology mismatch");
  if (profile.search_core === "v2") {
    requireRuntimeStatus(
      status.last_search_root_workers === profile.root_workers,
      "active root-worker topology mismatch",
    );
  }
  requireRuntimeStatus(status.actual_active_workers > 0, "no search worker became active");
  requireRuntimeStatus(status.root_workers_active === true, "root workers were inactive");
  requireRuntimeStatus(status.worker_gate_active === true, "parallel worker gate was inactive");
  requireRuntimeStatus(status.search_batch_coupling === true, "search/batch coupling was inactive");
  if (profile.search_core === "v2") {
    requireRuntimeStatus(status.persistent_workers === true, "persistent workers were inactive");
    requireRuntimeStatus(status.v2_cursor_admissions > 0, "no root cursor was admitted");
    requireRuntimeStatus(status.v2_cursor_async_pending > 0, "no root cursor suspended on inference");
    requireRuntimeStatus(status.v2_cursor_ready_resumes > 0, "no ready root cursor resumed");
    requireRuntimeStatus(status.v2_cursor_peak_waiting > 0, "no concurrent cursor wait was observed");
  } else {
    requireRuntimeStatus(
      status.mcgs_time_policy_configured === "RelativeClockTemporalV1",
      "MCGS relative-clock temporal policy was inactive",
    );
    if (profile.temporal_curve) {
      requireRuntimeStatus(
        status.mcgs_temporal_weight_profile_configured === "AdaptiveCurveV1",
        "AdaptiveCurveV1 was inactive",
      );
      const coefficientStatusFields = {
        McgsTemporalCurveRevision: "mcgs_temporal_curve_revision_configured",
        McgsTemporalCurveAmplitudePermille:
          "mcgs_temporal_curve_amplitude_permille_configured",
        McgsTemporalCurveSpan: "mcgs_temporal_curve_span_configured",
        McgsTemporalCurvePower: "mcgs_temporal_curve_power_configured",
        McgsTemporalWorkBlockBatches:
          "mcgs_temporal_work_block_batches_configured",
        McgsTemporalMaterialHorizonBaseMoves:
          "mcgs_temporal_material_horizon_base_moves_configured",
        McgsTemporalMaterialHorizonSlopePermille:
          "mcgs_temporal_material_horizon_slope_permille_configured",
        McgsTemporalCurveReferencePoolMs:
          "mcgs_temporal_curve_reference_pool_ms_configured",
        McgsTemporalCurveAmplitudeLogPoolSlopePermille:
          "mcgs_temporal_curve_amplitude_log_pool_slope_permille_configured",
        McgsTemporalCurveAmplitudeIncrementFractionSlopePermille:
          "mcgs_temporal_curve_amplitude_increment_fraction_slope_permille_configured",
        McgsTemporalCurveSpanLogPoolSlopeMillimoves:
          "mcgs_temporal_curve_span_log_pool_slope_millimoves_configured",
        McgsTemporalCurveSpanIncrementFractionSlopeMillimoves:
          "mcgs_temporal_curve_span_increment_fraction_slope_millimoves_configured",
        McgsTemporalCurveSpanMinMoves:
          "mcgs_temporal_curve_span_min_moves_configured",
        McgsTemporalCurveSpanMaxMoves:
          "mcgs_temporal_curve_span_max_moves_configured",
      };
      for (const [option, statusField] of Object.entries(coefficientStatusFields)) {
        requireRuntimeStatus(
          status[statusField] === profile.temporal_curve.applied_uci_options[option],
          `adaptive temporal-curve option ${option} mismatch`,
        );
      }
    }
    requireRuntimeStatus(status.mcgs_graph_nodes > 0, "MCGS graph contains no nodes");
    requireRuntimeStatus(status.mcgs_graph_edges > 0, "MCGS graph contains no edges");
    requireRuntimeStatus(status.mcgs_completed_simulations > 0, "MCGS completed no simulations");
    requireRuntimeStatus(status.mcgs_async_admissions > 0, "MCGS admitted no asynchronous leaves");
    requireRuntimeStatus(status.mcgs_outstanding_peak > 0, "MCGS observed no inference overlap");
    requireRuntimeStatus(
      status.mcgs_root_seeded_moves === status.mcgs_root_legal_moves,
      "MCGS did not seed every legal root move",
    );
    requireRuntimeStatus(
      status.mcgs_stale_backups_discarded === 0,
      "MCGS discarded a stale backup during qualification",
    );
    requireRuntimeStatus(status.mcgs_reservation_leaks === 0, "MCGS leaked reservations");
    for (const field of [
      "mcgs_provider_admission_denials",
      "mcgs_cache_completions_after_admission_close",
      "mcgs_nonprovider_backups_after_admission_close",
    ]) {
      requireRuntimeStatus(
        Number.isSafeInteger(status[field]) && status[field] >= 0,
        `MCGS deadline-tail telemetry ${field} is missing`,
      );
    }
    requireRuntimeStatus(
      (status.mcgs_provider_admission_denials === 0
        && status.mcgs_cache_completions_after_admission_close === 0
        && status.mcgs_nonprovider_backups_after_admission_close === 0)
        || status.mcgs_neural_admission_closed === true,
      "MCGS reported post-admission-close work without closing admission",
    );
  }
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
      "TimeProfileBackupEmitReserveUs",
      "TimeProfileIterationForecastScalePermille",
    ];
    if (String(this.config.uci_options.SearchCore) === "mcgs"
        || this.config.qualification_profile?.search_core === "mcgs") {
      requiredTimingOptions.push("McgsTimePolicy");
    }
    if (this.timing.opponent_turn_search) requiredTimingOptions.push("Ponder");
    const missingTimingOptions = requiredTimingOptions
      .filter((name) => !this.advertisedOptions.has(name));
    if (missingTimingOptions.length) {
      throw new Error(`Required time-management UCI options are not advertised: ${missingTimingOptions.join(", ")}`);
    }
    for (const [name, value] of Object.entries(this.config.uci_options)) {
      if (name === "Move Overhead" || name === "Ponder"
          || name === "IterativeTimeController"
          || name === "TimeProfileProviderReserveUs"
          || name === "TimeProfileBackupEmitReserveUs"
          || name === "TimeProfileIterationForecastScalePermille") continue;
      this.send(`setoption name ${name} value ${String(value)}`);
    }
    this.send(`setoption name Move Overhead value ${this.timing.initial_transport_reserve_ms}`);
    this.send("setoption name IterativeTimeController value false");
    this.send("setoption name TimeProfileProviderReserveUs value 0");
    this.send("setoption name TimeProfileBackupEmitReserveUs value 1000");
    this.send("setoption name TimeProfileIterationForecastScalePermille value 1000");
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

  async runtimeStatusAfterInferenceDrain(timeoutMs = 30_000) {
    const deadline = performance.now() + timeoutMs;
    let status;
    do {
      status = await this.runtimeStatus();
      if (status.evaluation_service_active_async_leases === 0
          && status.evaluation_service_active_tickets === 0) {
        return status;
      }
      if (performance.now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (true);
  }

  timeProfileConfiguration(appliedTimeProfileReserveUs = 0, appliedBackupEmitReserveUs = 1000) {
    const options = this.config.uci_options;
    const extraEngineOptions = Object.fromEntries(
      Object.entries(options)
        .filter(([name]) => !TIME_PROFILE_RESERVED_OPTIONS.has(name))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, String(value)]),
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
      searchGraphMb: Number(options.SearchGraphMB),
      mcgsCpuctPermille: Number(options.McgsCpuctPermille),
      mcgsOutstandingBatches: Number(options.McgsOutstandingBatches),
      mcgsBookPriorBlendPermille: Number(options.McgsBookPriorBlendPermille),
      mcgsTimePolicy: String(options.McgsTimePolicy),
      batchSize: Number(options.NNBatchSize),
      batchWaitUs: Number(options.NNBatchWaitUs),
      provider: String(options.OnnxProvider),
      backgroundSearch: booleanOption("BackgroundSearch"),
      nnSpeculation: booleanOption("NNSpeculation"),
      moveOverheadMs: this.timing.initial_transport_reserve_ms,
      iterativeTimeController: false,
      appliedTimeProfileReserveUs,
      appliedBackupEmitReserveUs,
      iterationForecastScalePermille: 1000,
      modelRoot: options.ModelRoot,
      extraEngineOptions,
    };
  }

  async configureTimeProfile() {
    const initialStatus = await this.runtimeStatus();
    if (initialStatus.time_profile_provider_reserve_us !== 0) {
      throw new Error("UCI timing-profile provider reserve did not initialize to zero");
    }
    if (initialStatus.time_profile_backup_emit_reserve_us !== 1000) {
      throw new Error("UCI timing-profile backup/emission reserve did not initialize to 1000");
    }
    if (initialStatus.time_profile_iteration_forecast_scale_permille !== 1000) {
      throw new Error("UCI timing-profile iteration forecast scale did not initialize to 1000");
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
      for (const option of accepted.uci_options) {
        this.send(`setoption name ${option.name} value ${option.value}`);
      }
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
        configuration: {
          ...this.timeProfileConfiguration(
            accepted.provider_service_reserve_us,
            accepted.backup_emit_reserve_us,
          ),
          iterationForecastScalePermille: accepted.iteration_forecast_scale_permille,
        },
      });
      this.timeProfileStatus = validateAppliedTimeProfileReserve(profile, appliedStatus);
    } catch (error) {
      if (reserveWasSet) {
        this.send("setoption name TimeProfileProviderReserveUs value 0");
        this.send("setoption name TimeProfileBackupEmitReserveUs value 1000");
        this.send("setoption name TimeProfileIterationForecastScalePermille value 1000");
        await this.exchange("isready", (line) => line === "readyok", 30_000);
        const resetStatus = await this.runtimeStatus();
        if (resetStatus.time_profile_provider_reserve_us !== 0) {
          throw new Error(`Timing-profile rejection could not restore reserve zero: ${error.message}`);
        }
        if (resetStatus.time_profile_backup_emit_reserve_us !== 1000) {
          throw new Error(`Timing-profile rejection could not restore backup/emission reserve 1000: ${error.message}`);
        }
        if (resetStatus.time_profile_iteration_forecast_scale_permille !== 1000) {
          throw new Error(`Timing-profile rejection could not restore forecast scale 1000: ${error.message}`);
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
      this.qualificationStatus = validateRuntimeStatus(
        profile,
        await this.runtimeStatusAfterInferenceDrain(),
      );
      return this.qualificationStatus;
    } finally {
      this.send(`setoption name OwnBook value ${restoredOwnBook}`);
      await this.exchange("isready", (line) => line === "readyok", 30_000);
      if (this.qualificationStatus) {
        const liveRuntimeStatus = await this.runtimeStatus();
        const bookExpected = String(restoredOwnBook).trim().toLocaleLowerCase() === "true";
        if (liveRuntimeStatus.opening_book_enabled !== bookExpected) {
          throw new Error("Restored OwnBook setting does not match runtime status");
        }
        if (bookExpected && liveRuntimeStatus.opening_book_active !== true) {
          throw new Error(`Opening book failed to activate: ${liveRuntimeStatus.opening_book_message}`);
        }
        this.qualificationStatus = {
          ...this.qualificationStatus,
          live_runtime_status: liveRuntimeStatus,
        };
      }
    }
    return this.qualificationStatus;
  }

  parseBestmove(line, { allowNullBestmove = false } = {}) {
    const parts = String(line).trim().split(/\s+/);
    const bestmove = parts[0] === "bestmove" ? parts[1] : null;
    if (bestmove === "0000" && allowNullBestmove) {
      return { bestmove: null, ponder: null, nullBestmove: true };
    }
    if (!UCI_MOVE_PATTERN.test(bestmove ?? "")) {
      throw new Error(`UCI engine returned unusable bestmove: ${bestmove ?? "missing"}`);
    }
    const ponderIndex = parts.indexOf("ponder");
    const ponder = ponderIndex >= 0 && UCI_MOVE_PATTERN.test(parts[ponderIndex + 1] ?? "")
      ? parts[ponderIndex + 1]
      : null;
    return { bestmove, ponder, nullBestmove: false };
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

  async awaitSearch(active, timeoutMs, { allowNullBestmove = false } = {}) {
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
    const move = this.parseBestmove(outcome.line, { allowNullBestmove });
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
    const drainStartedAt = performance.now();
    const result = await this.awaitSearch(active, timeoutMs, { allowNullBestmove: true });
    const drainElapsedMs = performance.now() - drainStartedAt;
    this.telemetry({
      event: "stale_bestmove_drained",
      search_kind: active.kind,
      search_generation: active.generation,
      reason,
      move: result.bestmove,
      null_bestmove: result.nullBestmove,
      drain_elapsed_ms: drainElapsedMs,
    });
    return {
      drained: true,
      reason,
      searchKind: active.kind,
      searchGeneration: active.generation,
      staleBestmove: result.bestmove,
      nullBestmove: result.nullBestmove,
      elapsedMs: drainElapsedMs,
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
    return this.beginSearch("opponent_root", "go infinite opponentroot", { rootMoves: moves });
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

function optionalFileFingerprint(filePath, workingDirectory) {
  const configured = String(filePath ?? "").trim();
  if (!configured) return "";
  const resolved = path.isAbsolute(configured)
    ? configured
    : path.resolve(workingDirectory ?? ROOT, configured);
  return existsSync(resolved) ? sha256File(resolved) : "";
}

export function gameRuntimeProvenance(config, engine) {
  const profile = config.engine.qualification_profile ?? {};
  const liveRuntime = engine.qualificationStatus?.live_runtime_status ?? {};
  const timeProfile = engine.timeProfileStatus ?? config.engine.time_profile_status ?? {};
  const configuredBook = String(config.engine.uci_options?.OwnBook ?? "true").toLocaleLowerCase() === "true";
  const transitionProfile = timeProfile.iteration_transition_p95_ms ?? Array(48).fill(0);
  const appliedOptions = {
    ...(config.engine.uci_options ?? {}),
    "Move Overhead": config.timing?.initial_transport_reserve_ms ?? 0,
    Ponder: config.timing?.opponent_turn_search ?? false,
    OwnBook: configuredBook,
    IterativeTimeController: timeProfile.predictive_controller_enabled ?? false,
    TimeProfileProviderReserveUs: timeProfile.provider_service_reserve_us ?? 0,
    TimeProfileBackupEmitReserveUs: timeProfile.backup_emit_reserve_us ?? 1000,
    TimeProfileIterationForecastScalePermille:
      timeProfile.iteration_forecast_scale_permille ?? 1000,
    TimeProfileIterationTransitionP95Ms:
      Array.isArray(transitionProfile) ? transitionProfile.join(",") : String(transitionProfile),
  };
  const uciOptions = Object.fromEntries(
    Object.entries(appliedOptions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, String(value)]),
  );
  const provenance = {
    schema: "uci_arena_game_runtime_provenance_v1",
    engine: {
      build_fingerprint: profile.engine_build_fingerprint ?? "",
    },
    model: {
      id: profile.model_id ?? "",
      fingerprint: profile.model_fingerprint ?? "",
      checkpoint_hash: profile.checkpoint_hash ?? "",
      adapter_id: profile.adapter_id ?? "",
    },
    provider: {
      name: profile.provider ?? "",
      numeric_fingerprint: profile.provider_numeric_fingerprint ?? "",
      hardware_driver_fingerprint: profile.hardware_driver_fingerprint ?? "",
      onnx_runtime_version: profile.onnx_runtime_version ?? "",
    },
    search: {
      core: profile.search_core ?? "",
      threads: profile.threads ?? 0,
      root_workers: profile.root_workers ?? 0,
      split_depth: profile.split_depth ?? 0,
      batch_size: profile.batch_size ?? 0,
      batch_wait_us: profile.batch_wait_us ?? 0,
      speculation: profile.speculation ?? false,
      background_search: profile.background_search ?? false,
      applied_uci_options: uciOptions,
    },
    timing: {
      profile_identity_sha256: timeProfile.identity_sha256 ?? "",
      profile_file_sha256: optionalFileFingerprint(
        config.engine.time_profile,
        config.engine.working_directory,
      ),
      status: timeProfile.status ?? "",
      accepted: timeProfile.accepted ?? false,
      applied: timeProfile.applied ?? false,
      permissions: timeProfile.permissions ?? {},
      provider_service_reserve_us: timeProfile.provider_service_reserve_us ?? 0,
      backup_emit_reserve_us: timeProfile.backup_emit_reserve_us ?? 1000,
      iteration_forecast_scale_permille:
        timeProfile.iteration_forecast_scale_permille ?? 1000,
      iteration_transition_p95_ms: transitionProfile,
      predictive_controller_enabled: timeProfile.predictive_controller_enabled ?? false,
      transport_reserve_ms: config.timing?.initial_transport_reserve_ms ?? 0,
      fallback_policy: timeProfile.fallback_policy ?? "",
      reason: timeProfile.reason ?? "",
      adaptive_curve: {
        revision: profile.temporal_curve?.revision ?? 0,
        status: profile.temporal_curve?.status ?? "",
        formula: profile.temporal_curve?.formula ?? "",
        artifact_sha256: profile.temporal_curve?.artifact_sha256 ?? "",
        evidence_manifest_sha256:
          profile.temporal_curve?.evidence_manifest_sha256 ?? "",
      },
    },
    book: {
      configuration_identity: bookConfigurationIdentity(config),
      configured_enabled: configuredBook,
      observed_enabled: liveRuntime.opening_book_enabled ?? null,
      observed_active: liveRuntime.opening_book_active ?? null,
      observed_entries: liveRuntime.opening_book_entries ?? null,
      observed_identity: liveRuntime.opening_book_identity ?? "",
      mcgs_prior_blend_permille:
        Number(config.engine.uci_options?.McgsBookPriorBlendPermille ?? 0),
      observed_message: liveRuntime.opening_book_message ?? "",
    },
    tablebase: {
      configured_path: config.engine.uci_options?.SyzygyPath ?? "",
      configured_manifest: config.engine.uci_options?.SyzygyManifest ?? "",
      configured_manifest_file_sha256: optionalFileFingerprint(
        config.engine.uci_options?.SyzygyManifest,
        config.engine.working_directory,
      ),
      configured_probe_limit: Number(config.engine.uci_options?.SyzygyProbeLimit ?? 0),
      configured_probe_threads: Number(config.engine.uci_options?.SyzygyProbeThreads ?? 0),
      configured_rule50: String(
        config.engine.uci_options?.Syzygy50MoveRule ?? false,
      ).toLocaleLowerCase() === "true",
      configured_root_probe: String(
        config.engine.uci_options?.SyzygyRootProbe ?? false,
      ).toLocaleLowerCase() === "true",
      configured_internal_probe: String(
        config.engine.uci_options?.SyzygyInternalProbe ?? false,
      ).toLocaleLowerCase() === "true",
      observed_active: liveRuntime.syzygy_active ?? null,
      observed_loaded_cardinality: liveRuntime.syzygy_loaded_cardinality ?? null,
      observed_identity: liveRuntime.syzygy_identity ?? "",
      observed_manifest_identity: liveRuntime.syzygy_manifest_identity ?? "",
      observed_probe_threads: liveRuntime.syzygy_probe_threads ?? null,
      observed_message: liveRuntime.syzygy_message ?? "",
    },
    profiles: {
      single_game_sha256: optionalFileFingerprint(
        profile.profile_path,
        config.engine.working_directory,
      ),
      capacity_sha256: optionalFileFingerprint(
        config.capacity_profile?.profile_path,
        config.engine.working_directory,
      ),
      temporal_curve_sha256: optionalFileFingerprint(
        profile.temporal_curve?.profile_path,
        config.engine.working_directory,
      ),
    },
  };
  const serialized = JSON.stringify(provenance);
  return {
    provenance,
    sha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
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

  canStartOpponentTurnSearch(gameId = null) {
    if (!this.enabled || this.activeGames.size === 0) return true;
    return gameId !== null
      && this.activeGames.size === 1
      && this.activeGames.has(String(gameId));
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
  constructor({
    client,
    config,
    account,
    gameId,
    signal,
    slot,
    store,
    foregroundCoordinator,
    onMoveTransportSample = () => {},
  }) {
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
    this.opponentSearchDrainMs = 0;
    this.onMoveTransportSample = onMoveTransportSample;
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
    const runtimeProvenance = gameRuntimeProvenance(this.config, engine);
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
      modelId: profile.model_id,
      modelFingerprint: profile.model_fingerprint,
      checkpointHash: profile.checkpoint_hash,
      adapterId: profile.adapter_id,
      provider: profile.provider,
      providerFingerprint: profile.provider_numeric_fingerprint,
      hardwareDriverFingerprint: profile.hardware_driver_fingerprint,
      onnxRuntimeVersion: profile.onnx_runtime_version,
      searchCore: profile.search_core,
      threads: profile.threads,
      rootWorkers: profile.root_workers,
      splitDepth: profile.split_depth,
      batchSize: profile.batch_size,
      batchWaitUs: profile.batch_wait_us,
      timeProfileIdentity: engine.timeProfileStatus?.identity_sha256 ?? "",
      bookIdentity: bookConfigurationIdentity(this.config),
      runtimeProvenanceSha256: runtimeProvenance.sha256,
      runtimeProvenance: runtimeProvenance.provenance,
    });
    this.initialized = true;
    log("game_ready", {
      game_id: this.gameId,
      audience: this.slot.audience,
      opponent: this.opponent,
      color: this.color,
      runtime_provenance_sha256: runtimeProvenance.sha256,
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
      this.opponentSearchDrainMs += Number(drained.elapsedMs ?? 0);
      if (reason === "foreground_preempted") this.lastPonderMissReason = reason;
      return drained;
    });
  }

  async invalidateOpponentSearch(reason) {
    const drained = await this.pauseOpponentSearch(reason);
    if (this.pendingOwnMove) this.pendingOwnMove.predictedMove = null;
    this.lastPonderMissReason = reason === "opponent_root_reroot" ? null : reason;
    return drained;
  }

  resumeOpponentSearch() {
    return this.serializeOpponentOperation(async () => {
      const engine = this.slot.engine;
      if (!engine || this.finished || !this.initialized
          || !this.config.timing.opponent_turn_search
          || engine.mode !== "idle"
          || this.authoritativeGeneration !== this.observedGeneration
          || !this.foregroundCoordinator.canStartOpponentTurnSearch(this.gameId)) return null;

      let moves;
      let predictedMove = null;
      let clocks = this.lastClock;
      if (this.pendingOwnMove) {
        moves = this.pendingOwnMove.projectedMoves;
        predictedMove = String(this.config.engine.uci_options.SearchCore).toLowerCase() === "mcgs"
          ? null
          : this.pendingOwnMove.predictedMove;
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
    if (!pending?.predictedMove) {
      const opponentRootReroot = Boolean(
        pending
        && active?.kind === "opponent_root"
        && startsWithMoves(moves, pending.projectedMoves)
        && moves.length === pending.projectedMoves.length + 1
        && active.rootKey === movesKey(pending.projectedMoves)
        && active.runtimeGeneration === pending.runtimeGeneration
        && engine.runtimeGeneration === pending.runtimeGeneration
      );
      return {
        hit: false,
        reason: opponentRootReroot ? null : "no_predicted_move",
        opponentRootReroot,
      };
    }
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
    observation.authorityValidatedAt = performance.now();
    observation.authorityValidationMs = observation.authorityValidatedAt - receivedAt;
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
          : ponder.opponentRootReroot ? "opponent_root_reroot" : ponder.reason;
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
      opponentRootReroot: Boolean(ponder.opponentRootReroot),
      ponderMissReason: ponder.hit || ponder.opponentRootReroot
        ? null
        : ponder.reason ?? this.lastPonderMissReason,
      staleBestmoveDrained: drained || this.staleBestmoveDrained,
    });
  }

  async playMove(state, engine, {
    moves,
    receivedAt,
    observation,
    ponderHit,
    opponentRootReroot = false,
    ponderMissReason,
    staleBestmoveDrained,
  }) {
    const rootKey = movesKey(moves);
    const stateGeneration = observation.generation;
    const stateValidatedAt = observation.authorityValidatedAt ?? performance.now();
    const controller = new AbortController();
    const foreground = { controller, rootKey, stateGeneration };
    this.foregroundSearch = foreground;
    let lease = null;
    let result;
    let legality = null;
    let foregroundLeaseWaitMs = 0;
    let bestmoveToLegalityMs = 0;
    let moveQueueWaitMs = 0;
    let projectedSearchRequested = false;
    try {
      if (!this.observationIsCurrent(observation)) {
        throw new StaleAuthoritativeSearchError(this.gameId, "superseded_before_search");
      }
      const leaseWaitStartedAt = performance.now();
      lease = await this.foregroundCoordinator.begin(this.gameId);
      foregroundLeaseWaitMs = performance.now() - leaseWaitStartedAt;
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
      requireQualifiedMcgsTimeTelemetry(
        this.config.engine.qualification_profile,
        result.telemetry ?? {},
      );
      if (!UCI_MOVE_PATTERN.test(result.bestmove)) {
        throw new Error(`UCI bestmove failed legal-root syntax validation: ${result.bestmove ?? "missing"}`);
      }
      legality = this.legalityState.validateCandidate(moves, result.bestmove);
      const bestmoveAt = Number.isFinite(result.bestmoveAt) ? result.bestmoveAt : performance.now();
      bestmoveToLegalityMs = performance.now() - bestmoveAt;
      if (!legality.legal) {
        throw new Error(
          `UCI bestmove is illegal at the exact authoritative root: ${result.bestmove}`,
        );
      }
      if (!this.observationIsCurrent(observation)) {
        throw new StaleAuthoritativeSearchError(this.gameId, "superseded_during_legality_replay");
      }

      const moveQueuedAt = performance.now();
      let postDispatchedAt = moveQueuedAt;
      const postSignal = this.signal && typeof this.signal.addEventListener === "function"
        ? AbortSignal.any([this.signal, controller.signal])
        : controller.signal;
      const startProjectedSearch = (dispatchedAt) => {
        if (projectedSearchRequested) return;
        postDispatchedAt = dispatchedAt;
        moveQueueWaitMs = postDispatchedAt - moveQueuedAt;
        const elapsedClockMs = Math.max(0, Math.ceil(postDispatchedAt - receivedAt));
        const estimatedClock = subtractLocalClockDelay(this.lastClock, this.color, elapsedClockMs);
        const ownTimeKey = this.color === "white" ? "wtime" : "btime";
        const ownIncrementKey = this.color === "white" ? "winc" : "binc";
        estimatedClock[ownTimeKey] += estimatedClock[ownIncrementKey];
        this.pendingOwnMove = {
          baseRootKey: rootKey,
          projectedMoves: [...moves, result.bestmove],
          predictedMove: String(this.config.engine.uci_options.SearchCore).toLowerCase() === "mcgs"
            ? null
            : result.ponder,
          runtimeGeneration: result.runtimeGeneration,
          ponderSearchGeneration: null,
          estimatedClock,
        };
        this.lastPonderMissReason = null;
        this.staleBestmoveDrained = false;
        projectedSearchRequested = true;
        void this.resumeOpponentSearch().catch((error) => {
          log("projected_opponent_search_failed", {
            game_id: this.gameId,
            message: error.message,
          });
        });
      };
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
          startProjectedSearch(performance.now());
        },
      );
      const postAcknowledgedAt = performance.now();
      startProjectedSearch(postAcknowledgedAt);
      this.onMoveTransportSample(this.gameId, postAcknowledgedAt - postDispatchedAt);
      this.lastSubmittedRootKey = rootKey;
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
        authority_validation_ms: observation.authorityValidationMs ?? null,
        foreground_lease_wait_ms: foregroundLeaseWaitMs,
        opponent_search_drain_ms: this.opponentSearchDrainMs,
        authoritative_state_to_bestmove_ms: Math.max(0, bestmoveAt - receivedAt),
        bestmove_to_legality_ms: bestmoveToLegalityMs,
        move_queue_wait_ms: moveQueueWaitMs,
        state_received_to_dispatch_ms: postDispatchedAt - receivedAt,
        post_dispatch_to_ack_ms: postAcknowledgedAt - postDispatchedAt,
        ponder_mode: ponderHit
          ? "ponder"
          : opponentRootReroot ? "opponent_root_reroot" : "foreground",
        ponder_hit: Boolean(ponderHit),
        opponent_root_reroot: Boolean(opponentRootReroot),
        ponder_miss_reason: ponderMissReason,
        stale_bestmove_drained: Boolean(staleBestmoveDrained),
        transport_reserve_ms: this.config.timing.initial_transport_reserve_ms,
        root_legality_validation_ms: legality.elapsedMs,
        root_legality_sync_ms: observation.legalitySynchronization?.elapsedMs ?? null,
        root_legality_applied_plies: observation.legalitySynchronization?.appliedPlies ?? null,
        root_legality_rebuilt: observation.legalitySynchronization?.rebuilt ?? null,
        book_hit: result.telemetry?.book_probe_result === "hit",
        ...result.telemetry,
      });
      this.opponentSearchDrainMs = 0;
    } catch (error) {
      this.lastSubmittedRootKey = null;
      if (projectedSearchRequested) {
        await this.invalidateOpponentSearch("move_post_failed").catch(() => {});
      }
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
  constructor({ client, config, account, runtimeDir, signal, store, random = Math.random, now = Date.now }) {
    this.client = client;
    this.config = { ...config, timing: { ...DEFAULT_TIMING_CONFIG, ...(config.timing ?? {}) } };
    this.config.engine = { ...config.engine, timing: this.config.timing };
    this.account = normalizedUsername(account);
    this.runtimeDir = runtimeDir;
    this.signal = signal;
    this.store = store;
    this.random = random;
    this.now = now;
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
    this.schedulerFault = null;
    const transportProfilePath = this.config.timing.transport_profile_path
      || path.join(runtimeDir, "transport_profile_v1.json");
    this.transportProfile = new TransportProfileTracker({
      profilePath: transportProfilePath,
      bootstrapReserveMs: this.config.timing.bootstrap_transport_reserve_ms
        ?? this.config.timing.initial_transport_reserve_ms,
      telemetry: (details) => log(details.event, details),
    });
    this.config.timing.initial_transport_reserve_ms = this.transportProfile.effectiveReserveMs;
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
    const slotGeneration = slot.generation;
    let engine = null;
    try {
      engine = await this.engineStarts.run(async () => {
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
      this.slots.attachEngine(slot, engine, slotGeneration);
      return slot;
    } catch (error) {
      if (engine && slot.engine !== engine) await engine.close();
      await this.slots.release(slot, slotGeneration);
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

  async recoverTimedOutSlot(slot, expectedGeneration = slot?.generation) {
    if (!slot || slot.generation !== expectedGeneration) return false;
    const playing = await this.client.json("api/account/playing?nb=50", { signal: this.signal });
    const challengeId = String(slot.challengeId ?? "");
    const game = (playing.nowPlaying ?? []).find((candidate) => (
      String(candidate.gameId ?? candidate.id ?? "") === challengeId
    ));
    this.lastReconciliationAt = Date.now();
    if (!game || slot.generation !== expectedGeneration
        || !["pending", "cancelling"].includes(slot.state)) return false;
    await this.startGame(game, slot);
    log("challenge_timeout_recovered_game", {
      challenge_id: challengeId,
      slot_id: slot.id,
      slot_generation: expectedGeneration,
    });
    return true;
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
    const receivedAt = this.now();
    const audience = String(challenge.challenger?.title ?? "").toUpperCase() === "BOT" ? "bot" : "human";
    let reason = challengeDeclineReason(challenge, this.config.challenges, 0);
    if (!reason && this.client.isCoolingDown?.()) reason = "later";
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
      try {
        await this.client.post(`${endpoint}/decline`, { reason }, this.signal, undefined, () => {
          if (this.now() - receivedAt >= CHALLENGE_RESPONSE_MAX_AGE_MS) {
            throw new StaleApiOperationError("decline", "challenge response window expired");
          }
        });
      } catch (error) {
        if (error instanceof StaleApiOperationError) {
          log("stale_challenge_response_skipped", {
            challenge_id: challenge.id,
            operation: error.operation,
            reason: error.reason,
          });
          return;
        }
        throw error;
      }
      log("challenge_declined", { challenge_id: challenge.id, opponent, audience, reason });
      return;
    }
    const slotGeneration = slot.generation;
    try {
      await this.prepareSlot(slot);
      await this.client.post(`${endpoint}/accept`, undefined, this.signal, undefined, () => {
        this.slots.requireOwned(slot, "preparing", slotGeneration);
        if (this.now() - receivedAt >= CHALLENGE_RESPONSE_MAX_AGE_MS) {
          throw new StaleApiOperationError("accept", "challenge response window expired");
        }
      });
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
      if (error instanceof StaleApiOperationError) {
        log("stale_challenge_response_skipped", {
          challenge_id: challenge.id,
          operation: error.operation,
          reason: error.reason,
        });
        return;
      }
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
    if (["pending", "cancelling", "preparing"].includes(slot?.state)) await this.slots.release(slot);
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
      onMoveTransportSample: (id, durationMs) => this.transportProfile.record(id, durationMs),
    });
    this.gameSessions.set(gameId, session);
    const task = session.run().catch((error) => {
      log("game_error", { game_id: gameId, message: error.message });
    }).finally(async () => {
      this.activeGames.delete(gameId);
      this.gameSessions.delete(gameId);
      await this.slots.release(slot);
      const reserve = this.transportProfile.finishGame(gameId);
      this.config.timing.initial_transport_reserve_ms = reserve;
      this.config.engine.timing.initial_transport_reserve_ms = reserve;
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
    const slotGeneration = slot.generation;
    try {
      await this.prepareSlot(slot);
      const outbound = this.config.outbound_challenge;
      if (audience === "bot") this.lastBotChallengeAt = Date.now();
      else this.lastOwnerChallengeAt = Date.now();
      const challenge = await this.client.postJson(`api/challenge/${encodeURIComponent(normalized)}`, {
        rated: outbound.rated,
        color: outbound.color,
        variant: "standard",
        "clock.limit": outbound.clock_limit,
        "clock.increment": outbound.clock_increment,
        keepAliveStream: false,
      }, this.signal, undefined, () => {
        this.slots.requireOwned(slot, "preparing", slotGeneration);
        if (!this.streamConnected || this.store.control().paused) {
          throw new StaleApiOperationError("challenge_create", "scheduler authority changed");
        }
      });
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
      if (error instanceof StaleApiOperationError) return false;
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
      if (this.client.isCoolingDown?.()) return;
      if (this.needsReconciliation) {
        if (now - this.lastReconciliationAt < 15_000) return;
        await this.recoverPlayingGames();
      }
      await this.expirePending(now);
      if (this.schedulerFault) return;
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
    const bots = await this.client.collectNdjson("api/bot/online?nb=512", this.signal);
    this.store.replaceOnlineBots(bots, now);
    this.lastDiscoveryAt = now;
    log("bot_discovery_complete", { online_bots: bots.length });
  }

  async expirePending(now = Date.now()) {
    const timeout = this.config.scheduler.challenge_timeout_seconds * 1_000;
    for (const slot of this.slots.slots.filter((candidate) => candidate.state === "cancelling"
      && candidate.reconcileReleaseAt != null
      && now >= candidate.reconcileReleaseAt
      && !candidate.cancelInFlight)) {
      const generation = slot.generation;
      if (await this.recoverTimedOutSlot(slot, generation)) continue;
      if (slot.generation !== generation || slot.state !== "cancelling") continue;
      this.store.updateChallenge(slot.challengeId, "timeout", {
        cooldownMinutes: slot.audience === "bot" ? this.config.scheduler.timeout_cooldown_minutes : 0,
      }, now);
      log("challenge_timeout_not_found_released", {
        challenge_id: slot.challengeId,
        opponent: slot.opponent,
        audience: slot.audience,
        grace_ms: 2_000,
      });
      await this.slots.release(slot, generation);
    }
    for (const slot of this.slots.slots.filter((candidate) => ["pending", "cancelling"].includes(candidate.state)
      && candidate.direction === "outbound"
      && now - candidate.createdAt >= timeout
      && candidate.reconcileReleaseAt == null
      && !candidate.cancelInFlight
      && (candidate.cancelRetryAt == null || now >= candidate.cancelRetryAt))) {
      const challengeId = slot.challengeId;
      if (!challengeId) continue;
      const generation = slot.generation;
      this.slots.cancelling(slot);
      slot.cancelRetryAt = Number.POSITIVE_INFINITY;
      try {
        await this.client.post(
          `api/challenge/${encodeURIComponent(challengeId)}/cancel`,
          undefined,
          this.signal,
          undefined,
          () => this.slots.requireOwned(slot, "cancelling", generation),
        );
      } catch (error) {
        if (slot.generation !== generation || slot.state !== "cancelling") continue;
        slot.cancelInFlight = false;
        if (error instanceof StaleApiOperationError) continue;
        const status = error instanceof LichessHttpError ? error.status : null;
        if (status === 404) {
          if (await this.recoverTimedOutSlot(slot, generation)) continue;
          if (slot.generation !== generation || slot.state !== "cancelling") continue;
          slot.reconcileReleaseAt = Date.now() + 2_000;
          slot.cancelRetryAt = Number.POSITIVE_INFINITY;
          log("challenge_timeout_cancel_not_found", {
            challenge_id: challengeId,
            opponent: slot.opponent,
            audience: slot.audience,
            release_grace_ms: 2_000,
          });
          continue;
        }
        if (status === 429) {
          const retryMs = Math.max(60_000, error.retryAfterMs);
          slot.cancelRetryAt = now + retryMs;
          log("challenge_timeout_cancel_rate_limited", {
            challenge_id: challengeId,
            retry_ms: retryMs,
          });
          continue;
        }
        if (status === 401 || status === 403) {
          this.schedulerFault = {
            kind: "authentication",
            challenge_id: challengeId,
            status,
            message: error.message,
          };
          log("challenge_timeout_cancel_fatal", this.schedulerFault);
          continue;
        }
        if (status !== null && status >= 400 && status < 500) {
          if (await this.recoverTimedOutSlot(slot, generation)) continue;
          this.schedulerFault = {
            kind: "permanent_cancel_error",
            challenge_id: challengeId,
            status,
            message: error.message,
          };
          log("challenge_timeout_cancel_fatal", this.schedulerFault);
          continue;
        }
        const retrySchedule = [15_000, 30_000, 60_000, 120_000, 300_000];
        slot.cancelAttempts += 1;
        if (slot.cancelAttempts > retrySchedule.length) {
          this.schedulerFault = {
            kind: "cancel_retry_exhausted",
            challenge_id: challengeId,
            attempts: slot.cancelAttempts,
            message: error.message,
          };
          log("challenge_timeout_cancel_fatal", this.schedulerFault);
          continue;
        }
        const retryMs = retrySchedule[slot.cancelAttempts - 1];
        slot.cancelRetryAt = now + retryMs;
        log("challenge_timeout_cancel_error", {
          challenge_id: challengeId,
          opponent: slot.opponent,
          audience: slot.audience,
          message: error.message,
          attempt: slot.cancelAttempts,
          retry_ms: retryMs,
        });
        continue;
      }
      if (slot.generation !== generation || slot.state !== "cancelling") continue;
      slot.cancelInFlight = false;
      this.store.updateChallenge(challengeId, "timeout", {
        cooldownMinutes: slot.audience === "bot" ? this.config.scheduler.timeout_cooldown_minutes : 0,
      }, now);
      log("challenge_timeout", {
        challenge_id: challengeId,
        opponent: slot.opponent,
        audience: slot.audience,
        canceled: true,
      });
      await this.slots.release(slot, generation);
    }
  }

  async writeStatus() {
    writeRuntimeMetadata(this.runtimeDir, {
      schema: "uci_arena_lichess_runtime_v3",
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
        fault: this.schedulerFault,
        request_queue: this.client.requestQueue?.snapshot?.() ?? null,
        ...this.store.control(),
      },
      api_safety: {
        ...this.client.safetySnapshot(),
        active_client_leases: this.store.activeApiLeases().length,
      },
      timing: {
        opponent_turn_search: this.config.timing.opponent_turn_search,
        foreground_preempts_ponder: this.config.timing.foreground_preempts_ponder,
        transport_reserve_ms: this.config.timing.initial_transport_reserve_ms,
        bootstrap_transport_reserve_ms: this.config.timing.bootstrap_transport_reserve_ms,
        transport_profile_path: this.transportProfile.profilePath,
        transport_profile_sample_count: this.transportProfile.samples.length,
        transport_profile_game_count: new Set(
          this.transportProfile.samples.map((sample) => sample.game_id),
        ).size,
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
      deployment_bundle: "mcgs",
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

async function preflightDeploymentBundle(config) {
  const qualificationProfile = applySingleGameProfile(config);
  const qualificationStatus = await preflightQualifiedEngine(config);
  if (config.engine.time_profile_status?.accepted !== true) {
    throw new Error(
      `MCGS timing profile was rejected: ${config.engine.time_profile_status?.reason ?? "unknown reason"}`,
    );
  }
  return { qualificationProfile, qualificationStatus };
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
    const startup = process.platform === "win32"
      ? await queryWindowsStartup()
      : process.platform === "linux"
        ? await queryLinuxStartup()
        : (() => { throw new Error(`Unsupported startup platform: ${process.platform}`); })();
    console.log(JSON.stringify({ status: "ready", startup }));
    return 0;
  }
  if (options.command === "startup" && options.action === "uninstall") {
    const startup = process.platform === "win32"
      ? await uninstallWindowsStartup(runtimeDir)
      : process.platform === "linux"
        ? await uninstallLinuxStartup(runtimeDir)
        : (() => { throw new Error(`Unsupported startup platform: ${process.platform}`); })();
    console.log(JSON.stringify({ status: "ready", startup }));
    return 0;
  }
  const config = loadRuntimeConfig({
    templatePath: path.resolve(options.config ?? DEFAULT_TEMPLATE),
    repoRoot: path.resolve(options.repo_root ?? ROOT),
    enginePath: options.engine,
    workingDirectory: options.working_directory,
    modelRoot: options.model_root,
    profilePath: options.profile,
    timeProfilePath: options.time_profile,
    temporalCurvePath: options.temporal_curve_profile,
  });
  if (options.command === "config") {
    console.log(JSON.stringify({
      status: "ready",
      schema: config.schema,
      engine: config.engine.executable,
      time_profile: config.engine.time_profile ?? null,
      temporal_curve_profile: config.engine.temporal_curve_profile ?? null,
      capacity: config.capacity,
      scheduler: config.scheduler,
    }));
    return 0;
  }
  if (options.command === "startup" && options.action === "install") {
    const { qualificationProfile } = await preflightDeploymentBundle(config);
    loadCapacityProfile(
      options.capacity_profile ?? config.capacity.capacity_profile,
      config,
      qualificationProfile,
    );
    const startupOptions = {
      config: path.resolve(options.config ?? DEFAULT_TEMPLATE),
      tokenFile: path.resolve(options.token_file ?? DEFAULT_TOKEN_FILE),
      expectedAccount: options.expected_account,
      runtimeDir,
      profile: config.engine.single_game_profile,
      timeProfile: options.time_profile ?? config.engine.time_profile,
      capacityProfile: options.capacity_profile ?? config.capacity.capacity_profile,
      modelRoot: config.engine.uci_options.ModelRoot,
    };
    const startup = process.platform === "win32"
      ? await installWindowsStartup(startupOptions)
      : process.platform === "linux"
        ? await installLinuxStartup(startupOptions)
        : (() => { throw new Error(`Unsupported startup platform: ${process.platform}`); })();
    console.log(JSON.stringify({ status: "ready", startup }));
    return 0;
  }
  if (!new Set(["qualify", "capacity-qualify", "probe", "run"]).has(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  let qualificationStatus;
  if (new Set(["qualify", "capacity-qualify", "run"]).has(options.command)) {
    let qualificationProfile = applySingleGameProfile(config);
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
    if (options.command === "run" && config.engine.time_profile_status?.accepted !== true) {
      throw new Error(
        `MCGS timing profile was rejected: ${config.engine.time_profile_status?.reason ?? "unknown reason"}`,
      );
    }
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
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => controller.abort(new Error(`Received ${signal}`)));
  }
  const store = new LichessStore(path.resolve(options.store ?? path.join(runtimeDir, "matches.sqlite")));
  const authority = apiAuthorityKey(config.url, expectedAccount);
  const leaseOwner = randomUUID();
  let leaseHeartbeat = null;
  try {
    store.acquireApiLease(authority, leaseOwner, process.pid);
    const safetyCoordinator = new ApiSafetyCoordinator({
      initialState: store.apiSafetyState(authority),
      persistSafetyState: (state) => store.saveApiSafetyState(authority, state),
      onStateChange: (state) => log(state.event, {
        request_class: state.requestClass ?? null,
        cooldown_until: state.cooldownUntil || null,
        strike_count: state.strikeCount,
        last_retry_after_ms: state.lastRetryAfterMs,
      }),
    });
    if (options.command === "probe" && safetyCoordinator.isCoolingDown()) {
      throw new Error(
        `Lichess API cooldown is active until ${new Date(safetyCoordinator.cooldownUntil).toISOString()}`,
      );
    }
    if (options.command === "run") {
      leaseHeartbeat = setInterval(() => {
        try {
          store.heartbeatApiLease(authority, leaseOwner, process.pid);
        } catch (error) {
          controller.abort(error);
        }
      }, 10_000);
    }
    const client = new LichessClient({
      token: readTokenForRuntime(tokenFile),
      baseUrl: config.url,
      safetyCoordinator,
    });
    const profile = await probeAccount({ client, expectedAccount, url: config.url, signal: controller.signal });
    if (options.command === "probe") {
      console.log(JSON.stringify({ status: "ready", account: profile.username, is_bot: true, games: profile.games }));
      return 0;
    }
    if (options.acceptance_mode) {
      if (options.acceptance_mode !== "operator-bot-v1") {
        throw new Error(`Unsupported live acceptance mode: ${options.acceptance_mode}`);
      }
      if (options.acceptance_confirm !== LIVE_ACCEPTANCE_CONFIRMATION) {
        throw new Error("Live acceptance requires the exact explicit confirmation phrase");
      }
      if (!options.opponent) throw new Error("Live acceptance requires --opponent");
      if (config.outbound_challenge.rated !== false
          || config.scheduler.enabled
          || config.capacity.bot.target_active !== 0) {
        throw new Error(
          "Live acceptance config must be casual and disable automatic bot scheduling",
        );
      }
      const participants = await validateLiveAcceptanceParticipants({
        client,
        account: profile.username,
        target: options.opponent,
        signal: controller.signal,
      });
      log("live_acceptance_participants_ready", participants);
    }
    log("adapter_started", {
      account: profile.username,
      opponent: options.opponent ?? null,
      configured_capacity: config.capacity.total_slots,
      qualified_capacity: config.capacity_profile?.maximum_concurrency ?? 1,
      provider: qualificationStatus.provider_effective,
      time_profile: config.engine.time_profile_status,
    });
    await new BotController({
      client,
      config,
      account: profile.username,
      runtimeDir,
      signal: controller.signal,
      store,
    }).run(options.opponent);
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    store.releaseApiLease(authority, leaseOwner);
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
