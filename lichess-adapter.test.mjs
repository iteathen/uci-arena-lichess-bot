import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DEFAULT_TEMPLATE,
  MANAGER_OPTIONS_SCHEMA,
  OUTBOUND_CHALLENGE_CONFIRMATION,
  RATED_PLAY_CONFIRMATION,
  BotController,
  ForegroundSearchCoordinator,
  GameSession,
  LichessClient,
  ROOT,
  UciEngine,
  TransportProfileTracker,
  bindShutdownInput,
  challengeFromSelf,
  challengeDeclineReason,
  applyAdaptiveTemporalCurveProfile,
  applySingleGameProfile,
  gameRuntimeProvenance,
  loadAdaptiveTemporalCurveProfile,
  loadCapacityProfile,
  loadRuntimeConfig,
  loadSingleGameProfile,
  loadTransportProfile,
  parseNdjsonStream,
  parseArguments,
  parseRuntimeStatus,
  probeAccount,
  resolveExternalTokenFile,
  managerOptionsProjection,
  updateManagerOptions,
  validateRuntimeStatus,
} from "./lichess-adapter.mjs";
import {
  BOUNDS,
  BOOTSTRAP_COEFFICIENTS,
  coefficientOptions,
} from "../../arena/update_mcgs_adaptive_curve.mjs";
import { ApiSafetyCoordinator, LichessHttpError } from "./lichess-scheduler.mjs";
import { LichessStore } from "./lichess-store.mjs";
import {
  AuthoritativeChessState,
  validateLegalMoveAtAuthoritativeRoot,
} from "./chess-legality.mjs";

function temporaryToken() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-"));
  const tokenFile = path.join(directory, "token");
  writeFileSync(tokenFile, "test-token\n", "utf8");
  return tokenFile;
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function qualifiedFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-profile-"));
  const executable = path.join(directory, "engine.exe");
  const executableContent = Buffer.from("qualified-engine");
  writeFileSync(executable, executableContent);
  const modelRoot = path.join(directory, "model");
  mkdirSync(modelRoot);
  const checkpointHash = "a".repeat(64);
  writeFileSync(path.join(modelRoot, "checkpoint_manifest.json"), JSON.stringify({
    model_id: "model_v1",
    checkpoint_hash: checkpointHash,
  }));
  const evidenceContent = Buffer.from("qualified-evidence");
  writeFileSync(path.join(directory, "evidence.json"), evidenceContent);
  const evidence = Object.fromEntries([
    "cursor_correctness",
    "provider_parity",
    "deadline",
    "topology",
    "complete_game",
  ].map((name) => [name, {
    passed: true,
    artifact: "evidence.json",
    artifact_sha256: sha256(evidenceContent),
  }]));
  const profilePath = path.join(directory, "profile.json");
  const profile = {
    schema: "uci_arena_single_game_profile_v1",
    qualified: true,
    published_at: "2026-07-19T00:00:00Z",
    model_id: "model_v1",
    model_fingerprint: "1234",
    checkpoint_hash: checkpointHash,
    adapter_id: "adapter_v1",
    engine_build_fingerprint: sha256(executableContent),
    hardware_driver_fingerprint: "5678",
    onnx_runtime_version: "1.22.0",
    provider_numeric_fingerprint: "9012",
    search_core: "mcgs",
    search_graph_mb: 384,
    mcgs_cpuct_permille: 1750,
    mcgs_outstanding_batches: 3,
    mcgs_book_prior_blend_permille: 250,
    provider: "directml",
    threads: 4,
    root_workers: 4,
    split_depth: 2,
    batch_size: 8,
    batch_wait_us: 150,
    speculation: false,
    qualification_probe: { depth: 4, timeout_ms: 30_000 },
    evidence,
  };
  writeFileSync(profilePath, JSON.stringify(profile));
  const temporalCurvePath = path.join(directory, "temporal-curve.json");
  const evidenceManifest = {
    bootstrap_authority: "test_fixture",
    eligible_cells: 48,
  };
  const temporalCurve = {
    schema: "uci_arena_mcgs_adaptive_temporal_curve_v1",
    revision: 1,
    generated_at: "2026-07-25T00:00:00.000Z",
    status: "qualified_live_authority",
    deployable: true,
    formula: "adaptive_curve_v1_fixed_point",
    coefficients: BOOTSTRAP_COEFFICIENTS,
    coefficient_bounds: BOUNDS,
    evidence_manifest: evidenceManifest,
    evidence_manifest_sha256: sha256(JSON.stringify(evidenceManifest)),
    promotion: { ready: true, reasons: ["test_fixture"] },
    uci_options: coefficientOptions(1, BOOTSTRAP_COEFFICIENTS),
  };
  writeFileSync(temporalCurvePath, JSON.stringify(temporalCurve));
  const config = {
    engine: {
      executable,
      working_directory: directory,
      single_game_profile: profilePath,
      temporal_curve_profile: temporalCurvePath,
      uci_options: { ModelRoot: "model", BehaviorProfile: "balanced" },
    },
  };
  return {
    config,
    profile,
    profilePath,
    temporalCurve,
    temporalCurvePath,
  };
}

function qualifiedRuntimeStatus(profile) {
  const curveOptions = profile.temporal_curve?.applied_uci_options ?? {};
  return {
    schema: "uci_runtime_status_v1",
    model_loaded: true,
    model_id: profile.model_id,
    model_fingerprint: profile.model_fingerprint,
    adapter_id: profile.adapter_id,
    provider_requested: profile.provider,
    provider_effective: profile.provider,
    provider_numeric_fingerprint: profile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: profile.hardware_driver_fingerprint,
    onnx_runtime_version: profile.onnx_runtime_version,
    search_core_configured: "mcgs",
    mcgs_time_policy_configured: "RelativeClockTemporalV1",
    mcgs_temporal_weight_profile_configured:
      curveOptions.McgsTemporalWeightProfile ?? "EarlyCurrent",
    mcgs_temporal_curve_revision_configured:
      curveOptions.McgsTemporalCurveRevision ?? 1,
    mcgs_temporal_curve_amplitude_permille_configured:
      curveOptions.McgsTemporalCurveAmplitudePermille ?? 8_000,
    mcgs_temporal_curve_span_configured:
      curveOptions.McgsTemporalCurveSpan ?? 10,
    mcgs_temporal_curve_power_configured:
      curveOptions.McgsTemporalCurvePower ?? 3,
    mcgs_temporal_work_block_batches_configured:
      curveOptions.McgsTemporalWorkBlockBatches ?? 8,
    mcgs_temporal_material_horizon_base_moves_configured:
      curveOptions.McgsTemporalMaterialHorizonBaseMoves ?? 0,
    mcgs_temporal_material_horizon_slope_permille_configured:
      curveOptions.McgsTemporalMaterialHorizonSlopePermille ?? 0,
    mcgs_temporal_curve_reference_pool_ms_configured:
      curveOptions.McgsTemporalCurveReferencePoolMs ?? 30_000,
    mcgs_temporal_curve_amplitude_log_pool_slope_permille_configured:
      curveOptions.McgsTemporalCurveAmplitudeLogPoolSlopePermille ?? 0,
    mcgs_temporal_curve_amplitude_increment_fraction_slope_permille_configured:
      curveOptions.McgsTemporalCurveAmplitudeIncrementFractionSlopePermille ?? 0,
    mcgs_temporal_curve_span_log_pool_slope_millimoves_configured:
      curveOptions.McgsTemporalCurveSpanLogPoolSlopeMillimoves ?? 3_000,
    mcgs_temporal_curve_span_increment_fraction_slope_millimoves_configured:
      curveOptions.McgsTemporalCurveSpanIncrementFractionSlopeMillimoves ?? -16_000,
    mcgs_temporal_curve_span_min_moves_configured:
      curveOptions.McgsTemporalCurveSpanMinMoves ?? 10,
    mcgs_temporal_curve_span_max_moves_configured:
      curveOptions.McgsTemporalCurveSpanMaxMoves ?? 16,
    mcgs_book_prior_blend_permille_configured:
      profile.mcgs_book_prior_blend_permille,
    threads_configured: profile.threads,
    root_workers_configured: profile.root_workers,
    split_depth_configured: profile.split_depth,
    batch_size_configured: profile.batch_size,
    batch_size_effective: profile.batch_size,
    batch_wait_us_configured: profile.batch_wait_us,
    batch_wait_us_effective: profile.batch_wait_us,
    background_search: false,
    last_search_available: true,
    last_search_core: "mcgs",
    last_search_threads: profile.threads,
    last_search_root_workers: profile.root_workers,
    actual_active_workers: 4,
    root_workers_active: true,
    worker_gate_active: true,
    persistent_workers: false,
    search_batch_coupling: true,
    mcgs_graph_nodes: 73,
    mcgs_graph_edges: 411,
    mcgs_completed_simulations: 96,
    mcgs_async_admissions: 88,
    mcgs_outstanding_peak: 16,
    mcgs_root_seeded_moves: 20,
    mcgs_root_legal_moves: 20,
    mcgs_neural_admission_closed: false,
    mcgs_provider_admission_denials: 0,
    mcgs_cache_completions_after_admission_close: 0,
    mcgs_nonprovider_backups_after_admission_close: 0,
    mcgs_stale_backups_discarded: 0,
    mcgs_reservation_leaks: 0,
    evaluation_service_async_lease_completions: 8,
    evaluation_service_stale_publications_discarded: 0,
    evaluation_service_active_async_leases: 0,
    evaluation_service_active_tickets: 0,
    model_cache_eviction_deferrals: 0,
    repetition_unbalanced_workers: 0,
    opening_book_enabled: true,
    opening_book_active: true,
    opening_book_entries: 1259,
    opening_book_identity: "123456789",
    opening_book_message: "loaded",
    ...(profile.tablebase ? {
      syzygy_active: true,
      syzygy_loaded_cardinality: profile.tablebase.loaded_cardinality,
      syzygy_identity: "123456789",
      syzygy_manifest_identity: profile.tablebase.manifest_identity,
      syzygy_probe_threads: profile.tablebase.probe_threads,
      syzygy_message: "active",
    } : {}),
  };
}

test("adaptive temporal-curve artifact is validated, applied, and conflict-safe", () => {
  const fixture = qualifiedFixture();
  const loaded = loadAdaptiveTemporalCurveProfile(fixture.temporalCurvePath);
  assert.equal(loaded.revision, 1);
  assert.match(loaded.artifact_sha256, /^sha256:[0-9a-f]{64}$/);
  const applied = applyAdaptiveTemporalCurveProfile(fixture.config);
  assert.equal(applied.formula, "adaptive_curve_v1_fixed_point");
  assert.equal(
    fixture.config.engine.uci_options.McgsTemporalWeightProfile,
    "AdaptiveCurveV1",
  );
  const conflicting = qualifiedFixture();
  conflicting.config.engine.uci_options.McgsTemporalCurveSpan = 12;
  assert.throws(
    () => applyAdaptiveTemporalCurveProfile(conflicting.config),
    /conflicts with adaptive-curve UCI option McgsTemporalCurveSpan/,
  );
});

test("adaptive temporal-curve manifest tampering fails closed", () => {
  const fixture = qualifiedFixture();
  const tampered = {
    ...fixture.temporalCurve,
    evidence_manifest: {
      ...fixture.temporalCurve.evidence_manifest,
      eligible_cells: 49,
    },
  };
  writeFileSync(fixture.temporalCurvePath, JSON.stringify(tampered));
  assert.throws(
    () => loadAdaptiveTemporalCurveProfile(fixture.temporalCurvePath),
    /evidence manifest hash mismatch/,
  );
});

test("evidence-gated adaptive temporal curve is rejected for live deployment", () => {
  const fixture = qualifiedFixture();
  const evidenceGated = {
    ...fixture.temporalCurve,
    status: "evidence_gated_non_live",
    deployable: false,
    promotion: {
      ready: false,
      reasons: ["insufficient_independent_pair_coverage"],
    },
  };
  writeFileSync(fixture.temporalCurvePath, JSON.stringify(evidenceGated));
  assert.throws(
    () => loadAdaptiveTemporalCurveProfile(fixture.temporalCurvePath),
    /not deployable/,
  );
});

function gameConfig() {
  return {
    engine: {
      search_timeout_grace_ms: 10_000,
      uci_options: {},
      qualification_profile: {
        engine_build_fingerprint: "sha256:engine",
        model_fingerprint: "model",
        provider_numeric_fingerprint: "provider",
        search_core: "mcgs",
      },
    },
    timing: {
      opponent_turn_search: true,
      foreground_preempts_ponder: true,
      initial_transport_reserve_ms: 250,
    },
  };
}

function gameFull(state, account = "arena-bot") {
  return {
    type: "gameFull",
    variant: { key: "standard" },
    initialFen: "startpos",
    white: { id: account },
    black: { id: "opponent" },
    rated: false,
    speed: "blitz",
    clock: { initial: 180_000, increment: 2_000 },
    state,
  };
}

function startedState(moves, overrides = {}) {
  return {
    type: "gameState",
    moves,
    status: "started",
    wtime: 180_000,
    btime: 180_000,
    winc: 2_000,
    binc: 2_000,
    ...overrides,
  };
}

class MockGameEngine {
  constructor(results = []) {
    this.results = [...results];
    this.runtimeGeneration = 7;
    this.searchGeneration = 0;
    this.mode = "idle";
    this.active = null;
    this.searchCalls = [];
    this.opponentCalls = [];
    this.stopCalls = [];
    this.ponderHitCalls = 0;
  }

  async newGame() {}

  isOpponentTurnSearchActive() {
    return this.active?.kind === "ponder" || this.active?.kind === "opponent_root";
  }

  opponentTurnSearchSnapshot() {
    if (!this.active) return null;
    return {
      kind: this.active.kind,
      runtimeGeneration: this.active.runtimeGeneration,
      searchGeneration: this.active.generation,
      rootKey: this.active.rootKey,
      predictedMove: this.active.predictedMove,
    };
  }

  nextResult(rootMoves) {
    const value = this.results.shift();
    assert.ok(value, "mock engine result queue is empty");
    return {
      bestmove: value.bestmove,
      ponder: value.ponder ?? null,
      telemetry: {
        nodes: value.nodes ?? 1,
        time_policy: "RelativeClockTemporalV1",
        time_opponent_remaining_ms: 180_000,
        time_opponent_increment_ms: 2_000,
        time_temporal_weight_permille: 2_000,
        time_relative_surplus_ms: 0,
        time_relative_credit_ms: 0,
        time_relative_scheduled_ms: 0,
        time_completion_kind: "searched_decision",
        time_completion_applied: 1,
        ...(value.telemetry ?? {}),
      },
      rootMoves: [...rootMoves],
      rootKey: rootMoves.join(" "),
      runtimeGeneration: this.runtimeGeneration,
      searchGeneration: ++this.searchGeneration,
      goSentAt: performance.now() - 2,
      bestmoveAt: performance.now(),
      go_to_bestmove_ms: 2,
      staleBestmoveDrained: false,
    };
  }

  async search(request) {
    this.searchCalls.push(structuredClone(request));
    return this.nextResult(request.moves);
  }

  async startOpponentTurnSearch(request) {
    this.opponentCalls.push(structuredClone(request));
    const rootMoves = request.predictedMove
      ? [...request.moves, request.predictedMove]
      : [...request.moves];
    this.active = {
      kind: request.predictedMove ? "ponder" : "opponent_root",
      generation: ++this.searchGeneration,
      runtimeGeneration: this.runtimeGeneration,
      rootKey: rootMoves.join(" "),
      predictedMove: request.predictedMove ?? null,
    };
    this.mode = this.active.kind;
    return this.active;
  }

  async ponderHit() {
    this.ponderHitCalls += 1;
    const active = this.active;
    assert.equal(active?.kind, "ponder");
    this.active = null;
    this.mode = "idle";
    return this.nextResult(active.rootKey.split(" ").filter(Boolean));
  }

  async stopAndDrain(reason) {
    if (!this.active) return { drained: false, reason };
    this.stopCalls.push({ reason, active: { ...this.active } });
    this.active = null;
    this.mode = "idle";
    return { drained: true, reason, staleBestmove: "a7a6" };
  }
}

class BlockingForegroundEngine extends MockGameEngine {
  constructor() {
    super();
    this.searchStarted = new Promise((resolve) => { this.resolveSearchStarted = resolve; });
  }

  async search(request) {
    this.searchCalls.push(structuredClone({ ...request, signal: undefined }));
    this.active = {
      kind: "foreground",
      generation: ++this.searchGeneration,
      runtimeGeneration: this.runtimeGeneration,
      rootKey: request.moves.join(" "),
      predictedMove: null,
    };
    this.mode = "foreground";
    this.resolveSearchStarted();
    return new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        this.stopCalls.push({
          reason: request.signal.reason?.reason ?? "authoritative_state_changed",
          active: { ...this.active },
        });
        this.active = null;
        this.mode = "idle";
        reject(request.signal.reason);
      }, { once: true });
    });
  }
}

class ClockCorrectionEngine extends MockGameEngine {
  constructor() {
    super([{ bestmove: "e2e4" }]);
    this.firstSearchStarted = new Promise((resolve) => { this.resolveFirstSearchStarted = resolve; });
  }

  async search(request) {
    if (this.searchCalls.length > 0) return super.search(request);
    this.searchCalls.push(structuredClone({ ...request, signal: undefined }));
    this.mode = "foreground";
    this.resolveFirstSearchStarted();
    return new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        this.stopCalls.push({ reason: request.signal.reason?.reason });
        this.mode = "idle";
        reject(request.signal.reason);
      }, { once: true });
    });
  }
}

function mockStore() {
  return {
    beginGame() {},
    finishGame() {},
  };
}

function createGameSession(engine, client) {
  let sessions = [];
  const foregroundCoordinator = new ForegroundSearchCoordinator({
    sessions: () => sessions,
  });
  const session = new GameSession({
    client,
    config: gameConfig(),
    account: "arena-bot",
    gameId: "game-1",
    signal: { aborted: false },
    slot: { id: "human-1", audience: "human", engine },
    store: mockStore(),
    foregroundCoordinator,
  });
  sessions = [session];
  return session;
}

test("runtime config is credential-free and resolves repository paths", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-config-"));
  const isolatedTemplate = path.join(directory, "config.json");
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.timing.transport_profile_path = null;
  writeFileSync(isolatedTemplate, JSON.stringify(template), "utf8");
  const config = loadRuntimeConfig({
    templatePath: isolatedTemplate,
    repoRoot: ROOT,
    modelRoot: "engine/runtime/models/example/engine",
  });
  const serialized = JSON.stringify(config).toLowerCase();
  assert.equal(serialized.includes("test-token"), false);
  assert.equal(serialized.includes("oauth_token"), false);
  assert.equal(config.schema, "uci_arena_lichess_adapter_v6");
  assert.equal(config.timing.opponent_turn_search, true);
  assert.equal(config.timing.foreground_preempts_ponder, true);
  assert.equal(config.timing.initial_transport_reserve_ms, 650);
  assert.equal(config.timing.bootstrap_transport_reserve_ms, 650);
  assert.equal(config.engine.uci_options.ModelRoot, "engine/runtime/models/example/engine");
  assert.equal(config.engine.uci_options.McgsTimePolicy, "RelativeClockTemporalV1");
  assert.equal(config.engine.uci_options.McgsTemporalWeightProfile, "EarlyCurrent");
  assert.equal(config.engine.temporal_curve_profile, null);
  assert.equal(config.engine.uci_options.OwnBook, true);
  assert.equal(config.engine.executable.includes(ROOT.replaceAll("\\", "/")), true);
});

test("Manager options projection is bounded and configuration updates are atomic", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-manager-options-"));
  const configPath = path.join(directory, "config.json");
  const original = readFileSync(DEFAULT_TEMPLATE, "utf8");
  writeFileSync(configPath, original, "utf8");

  const before = loadRuntimeConfig({ templatePath: configPath, repoRoot: ROOT });
  const projection = managerOptionsProjection(before);
  assert.equal(projection.schema, MANAGER_OPTIONS_SCHEMA);
  assert.deepEqual(Object.keys(projection), [
    "schema",
    "capacity",
    "inbound_challenges",
    "outbound_challenge",
    "scheduler",
    "opponent_selection",
  ]);
  assert.equal(Object.hasOwn(projection, "engine"), false);
  assert.equal(JSON.stringify(projection).includes("capacity_profile"), false);

  const updated = updateManagerOptions({
    templatePath: configPath,
    repoRoot: ROOT,
    settings: {
      inbound_challenges: { accept_bots: false, speeds: ["rapid"] },
      outbound_challenge: { color: "white", clock_limit: 900 },
      scheduler: { discovery_interval_seconds: 90 },
      opponent_selection: { rating_target: 2100, rating_spread: 500 },
    },
  });
  assert.equal(updated.inbound_challenges.accept_bots, false);
  assert.deepEqual(updated.inbound_challenges.speeds, ["rapid"]);
  assert.equal(updated.outbound_challenge.color, "white");
  assert.equal(updated.scheduler.discovery_interval_seconds, 90);
  assert.equal(updated.opponent_selection.rating_target, 2100);

  const persisted = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(persisted.engine.executable, JSON.parse(original).engine.executable);
  assert.equal(persisted.engine.executable.includes("<UCI_ARENA_REPO>"), true);
  assert.equal(persisted.challenges.accept_bots, false);

  const stable = readFileSync(configPath, "utf8");
  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      repoRoot: ROOT,
      settings: { engine: { executable: "untrusted.exe" } },
    }),
    /settings\.engine is not editable/,
  );
  assert.equal(readFileSync(configPath, "utf8"), stable);
});

test("Manager options require explicit rated and outbound confirmations", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-manager-confirm-"));
  const configPath = path.join(directory, "config.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  raw.scheduler.enabled = false;
  writeFileSync(configPath, JSON.stringify(raw), "utf8");

  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      repoRoot: ROOT,
      settings: { outbound_challenge: { rated: true } },
    }),
    new RegExp(RATED_PLAY_CONFIRMATION),
  );
  updateManagerOptions({
    templatePath: configPath,
    repoRoot: ROOT,
    ratedConfirmation: RATED_PLAY_CONFIRMATION,
    settings: { outbound_challenge: { rated: true } },
  });

  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      repoRoot: ROOT,
      settings: { inbound_challenges: { modes: ["casual", "rated"] } },
    }),
    new RegExp(RATED_PLAY_CONFIRMATION),
  );
  updateManagerOptions({
    templatePath: configPath,
    repoRoot: ROOT,
    ratedConfirmation: RATED_PLAY_CONFIRMATION,
    settings: { inbound_challenges: { modes: ["casual", "rated"] } },
  });

  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      repoRoot: ROOT,
      settings: { scheduler: { enabled: true } },
    }),
    new RegExp(OUTBOUND_CHALLENGE_CONFIRMATION),
  );
  const updated = updateManagerOptions({
    templatePath: configPath,
    repoRoot: ROOT,
    outboundConfirmation: OUTBOUND_CHALLENGE_CONFIRMATION,
    settings: { scheduler: { enabled: true } },
  });
  assert.equal(updated.scheduler.enabled, true);
});

test("Manager capacity updates reject summary-only evidence without exact bindings", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-manager-capacity-"));
  const configPath = path.join(directory, "config.json");
  const capacityPath = path.join(directory, "capacity.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  raw.capacity.capacity_profile = capacityPath;
  writeFileSync(capacityPath, JSON.stringify({
    schema: "uci_arena_lichess_capacity_profile_v2",
    qualified: true,
    maximum_concurrency: 2,
  }), "utf8");
  writeFileSync(configPath, JSON.stringify(raw), "utf8");
  const stable = readFileSync(configPath, "utf8");

  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      repoRoot: ROOT,
      settings: {
        capacity: { total_slots: 3, human: { slots: 1 }, bot: { slots: 2 } },
      },
    }),
    /present qualified capacity profile/,
  );
  assert.equal(readFileSync(configPath, "utf8"), stable);

  const projection = managerOptionsProjection(
    loadRuntimeConfig({ templatePath: configPath, repoRoot: ROOT }),
  );
  assert.equal(projection.capacity.evidence.status, "rejected");
  assert.equal(projection.capacity.evidence.qualified, false);
});

test("runtime config accepts the shared active model environment override", () => {
  const selected = "engine/runtime/models/compact_chessformer_gab_v1/engine";
  const config = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    repoRoot: ROOT,
    environment: { UCI_ARENA_MODEL_ROOT: selected },
  });
  assert.equal(config.engine.uci_options.ModelRoot, selected);

  const explicit = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    repoRoot: ROOT,
    modelRoot: "engine/runtime/models/explicit/engine",
    environment: { UCI_ARENA_MODEL_ROOT: selected },
  });
  assert.equal(explicit.engine.uci_options.ModelRoot, "engine/runtime/models/explicit/engine");
});

test("runtime config accepts exact installed engine and working-directory overrides", () => {
    const engine = path.resolve("installed/bin/uci_arena_engine.exe");
  const workingDirectory = path.resolve("installed");
  const config = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    repoRoot: ROOT,
    enginePath: engine,
    workingDirectory,
  });
  assert.equal(config.engine.executable, engine);
  assert.equal(config.engine.working_directory, workingDirectory);
});

test("timing profile has a distinct config, environment, and CLI path", () => {
  const selected = "runtime_state/models/model/cache/uci_time_profile_v1.json";
  const config = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    repoRoot: ROOT,
    environment: { UCI_ARENA_TIME_PROFILE: selected },
  });
  assert.equal(config.engine.time_profile, selected);
  assert.equal(config.engine.uci_options.IterativeTimeController, false);
  assert.equal(config.engine.uci_options.TimeProfileProviderReserveUs, 0);
  assert.equal(config.engine.uci_options.TimeProfileIterationForecastScalePermille, 1000);
  assert.deepEqual(
    parseArguments(["run", "--profile", "single.json", "--time-profile", "time.json"]),
    { command: "run", profile: "single.json", time_profile: "time.json" },
  );
});

test("credential path is explicit and outside the adapter component", () => {
  const componentRoot = path.resolve("fixture-component");
  const external = path.resolve("fixture-operator", "lichess.token");
  assert.equal(
    resolveExternalTokenFile({ token_file: external }, componentRoot),
    external,
  );
  assert.throws(
    () => resolveExternalTokenFile({}, componentRoot),
    /--token-file is required/,
  );
  assert.throws(
    () => resolveExternalTokenFile({
      token_file: path.join(componentRoot, "secrets", "lichess.token"),
    }, componentRoot),
    /outside the adapter repository/,
  );
});

test("v2 config migrates to one shared slot with automatic scheduling disabled", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-v2-config-"));
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.schema = "uci_arena_lichess_adapter_v2";
  delete template.timing;
  delete template.capacity;
  delete template.scheduler;
  template.challenges.concurrency = 1;
  const configPath = path.join(directory, "v2.json");
  writeFileSync(configPath, JSON.stringify(template));
  const config = loadRuntimeConfig({ templatePath: configPath });
  assert.equal(config.capacity.total_slots, 1);
  assert.equal(config.capacity.legacy_shared, true);
  assert.equal(config.scheduler.enabled, false);
  assert.equal(config.schema, "uci_arena_lichess_adapter_v6");
  assert.equal(config.timing.opponent_turn_search, true);
  assert.equal(config.timing.initial_transport_reserve_ms, 250);
});

test("v3 accepts a configurable sixteen-slot layout and rejects invalid sums", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-v3-config-"));
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.capacity = {
    ...template.capacity,
    total_slots: 16,
    startup_parallelism: 4,
    human: { ...template.capacity.human, slots: 2 },
    bot: { ...template.capacity.bot, slots: 14, target_active: 14 },
  };
  const configPath = path.join(directory, "v3.json");
  writeFileSync(configPath, JSON.stringify(template));
  assert.equal(loadRuntimeConfig({ templatePath: configPath }).capacity.total_slots, 16);
  template.capacity.bot.slots = 13;
  template.capacity.bot.target_active = 13;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /must sum/);
});

test("v6 timing policy rejects conflicting UCI ownership and invalid reserves", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-v4-timing-"));
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  const configPath = path.join(directory, "v4.json");
  template.engine.uci_options.Ponder = false;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /Ponder=true/);
  delete template.engine.uci_options.Ponder;
  template.engine.uci_options["Move Overhead"] = 100;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /Move Overhead conflicts/);
  delete template.engine.uci_options["Move Overhead"];
  template.engine.uci_options.IterativeTimeController = true;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /IterativeTimeController=false/);
  template.engine.uci_options.IterativeTimeController = false;
  template.engine.uci_options.TimeProfileProviderReserveUs = 1;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /timing-profile-owned/);
  template.engine.uci_options.TimeProfileProviderReserveUs = 0;
  template.engine.uci_options.TimeProfileBackupEmitReserveUs = 1001;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /timing-profile-owned/);
  template.engine.uci_options.TimeProfileBackupEmitReserveUs = 1000;
  template.engine.uci_options.TimeProfileIterationForecastScalePermille = 1001;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /timing-profile-owned/);
  template.engine.uci_options.TimeProfileIterationForecastScalePermille = 1000;
  template.engine.uci_options.McgsTimePolicy = "Legacy";
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /RelativeClockTemporalV1/);
  template.engine.uci_options.McgsTimePolicy = "RelativeClockTemporalV1";
  template.timing.initial_transport_reserve_ms = 5_001;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /0\.\.5000/);
  template.timing.initial_transport_reserve_ms = 250;
  template.timing.foreground_preempts_ponder = false;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /no qualified capacity profile/);
});

test("qualified MCGS single-game profile is identity-bound and owns the parallel topology", () => {
  const fixture = qualifiedFixture();
  const loaded = loadSingleGameProfile(fixture.profilePath);
  assert.equal(loaded.model_id, fixture.profile.model_id);
  applySingleGameProfile(fixture.config);
  assert.deepEqual(
    Object.fromEntries(Object.entries(fixture.config.engine.uci_options).filter(([name]) => [
      "SearchCore",
      "Threads",
      "RootWorkers",
      "V2SplitDepth",
      "OnnxProvider",
      "NNBatchSize",
      "NNBatchWaitUs",
      "NNSpeculation",
      "BackgroundSearch",
      "SearchGraphMB",
      "McgsCpuctPermille",
      "McgsOutstandingBatches",
    ].includes(name))),
    {
      SearchCore: "mcgs",
      Threads: 4,
      RootWorkers: 4,
      V2SplitDepth: 2,
      OnnxProvider: "directml",
      NNBatchSize: 8,
      NNBatchWaitUs: 150,
      NNSpeculation: false,
      BackgroundSearch: false,
      SearchGraphMB: 384,
      McgsCpuctPermille: 1750,
      McgsOutstandingBatches: 3,
    },
  );
});

test("qualified static temporal profile remains live without an adaptive artifact", () => {
  const fixture = qualifiedFixture();
  fixture.config.engine.temporal_curve_profile = null;
  fixture.config.engine.uci_options.McgsTemporalWeightProfile = "EarlyCurrent";
  const profile = applySingleGameProfile(fixture.config);
  assert.equal(profile.temporal_curve, null);
  assert.equal(fixture.config.engine.temporal_curve_profile_status, null);
  assert.equal(
    fixture.config.engine.uci_options.McgsTemporalWeightProfile,
    "EarlyCurrent",
  );
});

test("profile application verifies and owns the complete Syzygy asset identity", () => {
  const fixture = qualifiedFixture();
  const directory = path.dirname(fixture.profilePath);
  const tablebasePath = path.join(directory, "syzygy");
  mkdirSync(tablebasePath);
  const wdl = Buffer.from("wdl");
  const dtz = Buffer.from("dtz");
  writeFileSync(path.join(tablebasePath, "KQvK.rtbw"), wdl);
  writeFileSync(path.join(tablebasePath, "KQvK.rtbz"), dtz);
  const manifest = {
    schema: "uci_arena_syzygy_manifest_v1",
    cardinality: 6,
    identity_sha256: `sha256:${"c".repeat(64)}`,
    files: [
      {
        name: "KQvK.rtbw",
        directory: "6-wdl",
        bytes: wdl.length,
        sha256: createHash("sha256").update(wdl).digest("hex"),
      },
      {
        name: "KQvK.rtbz",
        directory: "6-dtz",
        bytes: dtz.length,
        sha256: createHash("sha256").update(dtz).digest("hex"),
      },
    ],
  };
  const manifestPath = path.join(tablebasePath, "syzygy_manifest_v1.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(manifestPath, manifestBytes);
  fixture.profile.tablebase = {
    path: tablebasePath,
    manifest: manifestPath,
    manifest_identity: manifest.identity_sha256,
    manifest_file_sha256: sha256(manifestBytes),
    loaded_cardinality: 6,
    probe_limit: 6,
    probe_threads: 4,
    rule50: true,
    root_probe: true,
    internal_probe: true,
  };
  writeFileSync(fixture.profilePath, JSON.stringify(fixture.profile));

  applySingleGameProfile(fixture.config);
  assert.equal(fixture.config.engine.uci_options.SyzygyPath, tablebasePath);
  assert.equal(fixture.config.engine.uci_options.SyzygyManifest, manifestPath);
  assert.equal(fixture.config.engine.uci_options.SyzygyProbeThreads, 4);
  assert.equal(fixture.config.engine.uci_options.SyzygyInternalProbe, true);

  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.throws(
    () => applySingleGameProfile(fixture.config),
    /Syzygy manifest file hash mismatch/,
  );

  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(path.join(tablebasePath, "KQvK.rtbw"), Buffer.from("partial"));
  assert.throws(
    () => applySingleGameProfile(fixture.config),
    /Syzygy table file is missing or partial: KQvK\.rtbw/,
  );
});

test("live profile application rejects V2 search authority", () => {
  const fixture = qualifiedFixture();
  fixture.profile.search_core = "v2";
  delete fixture.profile.search_graph_mb;
  delete fixture.profile.mcgs_cpuct_permille;
  delete fixture.profile.mcgs_outstanding_batches;
  delete fixture.profile.mcgs_book_prior_blend_permille;
  writeFileSync(fixture.profilePath, JSON.stringify(fixture.profile));
  assert.throws(
    () => applySingleGameProfile(fixture.config),
    /requires a qualified MCGS single-game profile/,
  );
});

test("alternate search fallback bundles are rejected", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-no-search-fallback-"));
  const templatePath = path.join(directory, "config.json");
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.engine.fallback_bundle = {
    executable: template.engine.executable,
    working_directory: template.engine.working_directory,
    single_game_profile: "fallback-single.json",
    time_profile: "fallback-time.json",
    capacity_profile: "fallback-capacity.json",
    uci_options: {
      ModelBackend: "onnx",
      ModelRoot: "fallback-model",
    },
  };
  writeFileSync(templatePath, JSON.stringify(template));
  assert.throws(
    () => loadRuntimeConfig({ templatePath, repoRoot: ROOT }),
    /fallback_bundle is disabled/,
  );
});

test("qualified MCGS profile owns graph and batching topology", () => {
  const fixture = qualifiedFixture();
  Object.assign(fixture.profile, {
    search_core: "mcgs",
    search_graph_mb: 384,
    mcgs_cpuct_permille: 1750,
    mcgs_outstanding_batches: 3,
    mcgs_book_prior_blend_permille: 250,
  });
  writeFileSync(fixture.profilePath, JSON.stringify(fixture.profile));
  const loaded = loadSingleGameProfile(fixture.profilePath);
  assert.equal(loaded.search_core, "mcgs");
  applySingleGameProfile(fixture.config);
  assert.equal(fixture.config.engine.uci_options.SearchCore, "mcgs");
  assert.equal(fixture.config.engine.uci_options.SearchGraphMB, 384);
  assert.equal(fixture.config.engine.uci_options.McgsCpuctPermille, 1750);
  assert.equal(fixture.config.engine.uci_options.McgsOutstandingBatches, 3);
  assert.equal(fixture.config.engine.uci_options.McgsBookPriorBlendPermille, 250);
});

test("MCGS timing identity includes graph and outstanding-work topology", () => {
  const engine = Object.create(UciEngine.prototype);
  engine.config = {
    uci_options: {
      SearchCore: "mcgs",
      Threads: 10,
      RootWorkers: 4,
      V2SplitDepth: 2,
      SearchGraphMB: 64,
      McgsCpuctPermille: 1500,
      McgsOutstandingBatches: 2,
      McgsTimePolicy: "RelativeClockTemporalV1",
      NNBatchSize: 32,
      NNBatchWaitUs: 150,
      OnnxProvider: "directml",
      BackgroundSearch: false,
      NNSpeculation: false,
      ModelRoot: "model",
    },
  };
  engine.timing = { initial_transport_reserve_ms: 650 };

  const configuration = engine.timeProfileConfiguration();
  assert.equal(configuration.searchGraphMb, 64);
  assert.equal(configuration.mcgsCpuctPermille, 1500);
  assert.equal(configuration.mcgsOutstandingBatches, 2);
  assert.equal(configuration.mcgsTimePolicy, "RelativeClockTemporalV1");
});

test("runtime qualification waits for detached provider tickets to drain", async () => {
  const engine = Object.create(UciEngine.prototype);
  const statuses = [
    { evaluation_service_active_async_leases: 0, evaluation_service_active_tickets: 1 },
    { evaluation_service_active_async_leases: 0, evaluation_service_active_tickets: 0 },
  ];
  engine.runtimeStatus = async () => statuses.shift();

  const status = await engine.runtimeStatusAfterInferenceDrain(1_000);
  assert.equal(status.evaluation_service_active_tickets, 0);
  assert.equal(statuses.length, 0);
});

test("profile-owned topology rejects a conflicting tracked option", () => {
  const fixture = qualifiedFixture();
  fixture.config.engine.uci_options.SearchCore = "legacy";
  assert.throws(() => applySingleGameProfile(fixture.config), /conflicts.*SearchCore/);
});

test("MCGS rejects a capacity profile without timing-profile identity", () => {
  const fixture = qualifiedFixture();
  const single = loadSingleGameProfile(fixture.profilePath);
  fixture.config.capacity = { total_slots: 2, legacy_shared: false };
  const capacityPath = path.join(path.dirname(fixture.profilePath), "capacity.json");
  const capacity = {
    schema: "uci_arena_lichess_capacity_profile_v1",
    qualified: true,
    published_at: "2026-07-20T00:00:00Z",
    maximum_concurrency: 4,
    engine_build_fingerprint: fixture.profile.engine_build_fingerprint,
    single_game_profile_sha256: sha256(readFileSync(fixture.profilePath)),
    model_fingerprint: fixture.profile.model_fingerprint,
    provider_numeric_fingerprint: fixture.profile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: fixture.profile.hardware_driver_fingerprint,
    evidence: Array.from({ length: 4 }, (_, index) => ({ child: index + 1, qualified: true })),
  };
  writeFileSync(capacityPath, JSON.stringify(capacity));
  assert.throws(
    () => loadCapacityProfile(capacityPath, fixture.config, single),
    /requires a timing-bound Lichess capacity profile v2/,
  );
  capacity.model_fingerprint = "different";
  writeFileSync(capacityPath, JSON.stringify(capacity));
  assert.throws(() => loadCapacityProfile(capacityPath, fixture.config, single), /model_fingerprint mismatch/);
});

test("runtime status gate accepts active one-game MCGS batching and rejects fallback", () => {
  const { profile } = qualifiedFixture();
  const status = qualifiedRuntimeStatus(profile);
  const line = `info string runtime_status_v1 ${JSON.stringify(status)}`;
  assert.deepEqual(parseRuntimeStatus(line), status);
  assert.equal(validateRuntimeStatus(profile, status), status);
  assert.throws(
    () => validateRuntimeStatus(profile, { ...status, provider_effective: "cpu" }),
    /GPU provider fallback/,
  );
});

test("runtime status gate binds the complete Syzygy manifest and worker topology", () => {
  const { profile } = qualifiedFixture();
  profile.tablebase = {
    path: "E:/syzygy/standard/6",
    manifest: "E:/syzygy/standard/6/syzygy_manifest_v1.json",
    manifest_identity: `sha256:${"c".repeat(64)}`,
    loaded_cardinality: 6,
    probe_limit: 6,
    probe_threads: 2,
    rule50: true,
    root_probe: true,
    internal_probe: true,
  };
  const status = qualifiedRuntimeStatus(profile);
  assert.equal(validateRuntimeStatus(profile, status), status);
  assert.throws(
    () => validateRuntimeStatus(profile, { ...status, syzygy_loaded_cardinality: 5 }),
    /Syzygy cardinality mismatch/,
  );
  assert.throws(
    () => validateRuntimeStatus(profile, { ...status, syzygy_manifest_identity: `sha256:${"d".repeat(64)}` }),
    /Syzygy manifest identity mismatch/,
  );
});

test("MCGS capacity profile v2 binds the accepted timing profile", () => {
  const fixture = qualifiedFixture();
  const single = { ...loadSingleGameProfile(fixture.profilePath), search_core: "mcgs" };
  fixture.config.capacity = { total_slots: 2, legacy_shared: false };
  const directory = path.dirname(fixture.profilePath);
  const capacityPath = path.join(directory, "capacity-v2.json");
  const timeProfilePath = path.join(directory, "time-v3.json");
  writeFileSync(timeProfilePath, JSON.stringify({ schema: "uci_time_profile_v3" }));
  fixture.config.engine.time_profile = timeProfilePath;
  fixture.config.engine.time_profile_status = {
    accepted: true,
    applied: true,
    profile_path: timeProfilePath,
    identity_sha256: "sha256:time-identity",
  };
  const capacity = {
    schema: "uci_arena_lichess_capacity_profile_v2",
    qualified: true,
    published_at: "2026-07-20T00:00:00Z",
    maximum_concurrency: 4,
    engine_build_fingerprint: fixture.profile.engine_build_fingerprint,
    single_game_profile_sha256: sha256(readFileSync(fixture.profilePath)),
    model_fingerprint: fixture.profile.model_fingerprint,
    provider_numeric_fingerprint: fixture.profile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: fixture.profile.hardware_driver_fingerprint,
    time_profile_sha256: sha256(readFileSync(timeProfilePath)),
    time_profile_identity_sha256: "sha256:time-identity",
    search_core: "mcgs",
    evidence: Array.from({ length: 4 }, (_, index) => ({ child: index + 1, qualified: true })),
  };
  writeFileSync(capacityPath, JSON.stringify(capacity));
  assert.equal(loadCapacityProfile(capacityPath, fixture.config, single).schema,
    "uci_arena_lichess_capacity_profile_v2");
  fixture.config.capacity.total_slots = 5;
  assert.throws(() => loadCapacityProfile(capacityPath, fixture.config, single), /exceeds qualified/);
  fixture.config.capacity.total_slots = 2;
  capacity.time_profile_identity_sha256 = "sha256:stale";
  writeFileSync(capacityPath, JSON.stringify(capacity));
  assert.throws(
    () => loadCapacityProfile(capacityPath, fixture.config, single),
    /time_profile_identity_sha256 mismatch/,
  );
});

test("runtime status gate accepts qualified batched MCGS and rejects incomplete root coverage", () => {
  const { profile } = qualifiedFixture();
  Object.assign(profile, {
    search_core: "mcgs",
    search_graph_mb: 384,
    mcgs_cpuct_permille: 1750,
    mcgs_outstanding_batches: 3,
    mcgs_book_prior_blend_permille: 250,
  });
  const status = {
    ...qualifiedRuntimeStatus(profile),
    search_core_configured: "mcgs",
    last_search_core: "mcgs",
    last_search_root_workers: profile.threads,
    persistent_workers: false,
    mcgs_graph_nodes: 73,
    mcgs_graph_edges: 411,
    mcgs_completed_simulations: 96,
    mcgs_async_admissions: 88,
    mcgs_outstanding_peak: 16,
    mcgs_root_seeded_moves: 20,
    mcgs_root_legal_moves: 20,
    mcgs_stale_backups_discarded: 0,
    mcgs_reservation_leaks: 0,
  };
  assert.equal(validateRuntimeStatus(profile, status), status);
  assert.throws(
    () => validateRuntimeStatus(profile, { ...status, mcgs_root_seeded_moves: 19 }),
    /did not seed every legal root move/,
  );
});

test("runtime qualification bypasses the book probe and restores live book play", async () => {
  const { profile } = qualifiedFixture();
  const engine = new UciEngine({ uci_options: {}, qualification_profile: profile });
  engine.advertisedOptions.add("OwnBook");
  const commands = [];
  engine.send = (command) => commands.push(command);
  engine.newGame = async () => commands.push("ucinewgame+isready");
  engine.exchange = async (command) => {
    commands.push(command);
    if (command.startsWith("go depth ")) return "bestmove e2e4";
    if (command === "isready") return "readyok";
    throw new Error(`Unexpected command: ${command}`);
  };
  engine.runtimeStatus = async () => qualifiedRuntimeStatus(profile);

  await engine.qualifyRuntime();

  assert.deepEqual(commands, [
    "setoption name OwnBook value false",
    "isready",
    "ucinewgame+isready",
    "position startpos",
    `go depth ${profile.qualification_probe.depth}`,
    "setoption name OwnBook value true",
    "isready",
  ]);
});

test("runtime qualification rejects a configured book that did not reactivate", async () => {
  const { profile } = qualifiedFixture();
  const engine = new UciEngine({ uci_options: {}, qualification_profile: profile });
  engine.advertisedOptions.add("OwnBook");
  engine.send = () => {};
  engine.newGame = async () => {};
  engine.exchange = async (command) => command.startsWith("go depth ") ? "bestmove e2e4" : "readyok";
  let statusCalls = 0;
  engine.runtimeStatus = async () => {
    statusCalls += 1;
    return statusCalls === 1
      ? qualifiedRuntimeStatus(profile)
      : { ...qualifiedRuntimeStatus(profile), opening_book_active: false, opening_book_message: "missing" };
  };

  await assert.rejects(() => engine.qualifyRuntime(), /Opening book failed to activate: missing/);
});

test("game provenance captures exact model, effective timing options, and observed book state", () => {
  const { config, profile } = qualifiedFixture();
  config.engine.qualification_profile = { ...profile, profile_path: config.engine.single_game_profile };
  config.engine.uci_options = {
    ...config.engine.uci_options,
    SearchCore: "mcgs",
    Threads: 4,
    RootWorkers: 4,
    V2SplitDepth: 2,
    OnnxProvider: "directml",
    NNBatchSize: 8,
    NNBatchWaitUs: 150,
    NNSpeculation: false,
    BackgroundSearch: false,
    SearchGraphMB: 384,
    McgsCpuctPermille: 1750,
    McgsOutstandingBatches: 3,
    McgsBookPriorBlendPermille: 250,
    McgsTimePolicy: "RelativeClockTemporalV1",
    SyzygyPath: "E:/syzygy/standard/6",
    SyzygyManifest: "E:/syzygy/standard/6/syzygy_manifest_v1.json",
    SyzygyProbeLimit: 6,
    SyzygyProbeThreads: 2,
    Syzygy50MoveRule: true,
    SyzygyRootProbe: true,
    SyzygyInternalProbe: true,
  };
  config.timing = { initial_transport_reserve_ms: 650, opponent_turn_search: true };
  const engine = {
    qualificationStatus: {
      live_runtime_status: {
        ...qualifiedRuntimeStatus(profile),
        syzygy_active: true,
        syzygy_loaded_cardinality: 6,
        syzygy_identity: "123456789",
        syzygy_manifest_identity: `sha256:${"b".repeat(64)}`,
        syzygy_probe_threads: 2,
        syzygy_message: "active",
      },
    },
    timeProfileStatus: {
      status: "accepted",
      accepted: true,
      applied: true,
      identity_sha256: "sha256:time-profile",
      provider_service_reserve_us: 231000,
      backup_emit_reserve_us: 2000,
      iteration_forecast_scale_permille: 1050,
      iteration_transition_p95_ms: [1, 2, 3],
      predictive_controller_enabled: false,
      permissions: { provider_safety_qualified: true },
    },
  };

  const first = gameRuntimeProvenance(config, engine);
  const second = gameRuntimeProvenance(config, engine);
  assert.deepEqual(first, second);
  assert.equal(first.provenance.model.id, "model_v1");
  assert.equal(first.provenance.model.checkpoint_hash, "a".repeat(64));
  assert.equal(first.provenance.search.threads, 4);
  assert.equal(first.provenance.search.applied_uci_options["Move Overhead"], "650");
  assert.equal(first.provenance.search.applied_uci_options.OwnBook, "true");
  assert.equal(first.provenance.search.applied_uci_options.TimeProfileProviderReserveUs, "231000");
  assert.equal(first.provenance.search.applied_uci_options.TimeProfileBackupEmitReserveUs, "2000");
  assert.equal(first.provenance.timing.provider_service_reserve_us, 231000);
  assert.equal(first.provenance.timing.backup_emit_reserve_us, 2000);
  assert.equal(first.provenance.timing.transport_reserve_ms, 650);
  assert.equal(first.provenance.book.observed_active, true);
  assert.equal(first.provenance.book.observed_entries, 1259);
  assert.equal(first.provenance.book.observed_identity, "123456789");
  assert.equal(first.provenance.book.mcgs_prior_blend_permille, 250);
  assert.equal(first.provenance.tablebase.configured_probe_limit, 6);
  assert.equal(first.provenance.tablebase.observed_active, true);
  assert.equal(first.provenance.tablebase.observed_loaded_cardinality, 6);
  assert.equal(first.provenance.tablebase.observed_manifest_identity, `sha256:${"b".repeat(64)}`);
  assert.match(first.sha256, /^sha256:[0-9a-f]{64}$/);
});

test("UCI readiness requires explicit ponder and move-overhead support", () => {
  const engine = new UciEngine({
    uci_options: {},
    timing: {
      opponent_turn_search: true,
      foreground_preempts_ponder: true,
      initial_transport_reserve_ms: 250,
    },
  });
  const commands = [];
  engine.send = (command) => commands.push(command);
  engine.advertisedOptions.add("Move Overhead");
  assert.throws(() => engine.configureUciOptions(), /Ponder/);
  engine.advertisedOptions.add("Ponder");
  engine.advertisedOptions.add("IterativeTimeController");
  engine.advertisedOptions.add("TimeProfileProviderReserveUs");
  engine.advertisedOptions.add("TimeProfileBackupEmitReserveUs");
  engine.advertisedOptions.add("TimeProfileIterationForecastScalePermille");
  engine.configureUciOptions();
  assert.deepEqual(commands, [
    "setoption name Move Overhead value 250",
    "setoption name IterativeTimeController value false",
    "setoption name TimeProfileProviderReserveUs value 0",
    "setoption name TimeProfileBackupEmitReserveUs value 1000",
    "setoption name TimeProfileIterationForecastScalePermille value 1000",
    "setoption name Ponder value true",
  ]);
});

test("timing identity excludes independently validated local knowledge options", () => {
  const engine = new UciEngine({
    uci_options: {
      SearchCore: "v2",
      Threads: 6,
      RootWorkers: 6,
      V2SplitDepth: 2,
      NNBatchSize: 64,
      NNBatchWaitUs: 0,
      OnnxProvider: "directml",
      BackgroundSearch: false,
      NNSpeculation: false,
      ModelRoot: "C:/installed/models/default",
      OwnBook: true,
      BookFile: "E:/books/strong_rare_v1.bin",
      BookStatsFile: "E:/books/strong_rare_v1.ffstats",
      BookPolicyFile: "E:/books/strong_rare_v1.policy",
      BookSeed: 9,
      BookMaxPly: 30,
      SyzygyPath: "E:/syzygy/standard/6",
      SyzygyProbeLimit: 6,
      SyzygyProbeDepth: 1,
      Syzygy50MoveRule: true,
      SyzygyRootProbe: true,
      SyzygyInternalProbe: true,
      BehaviorProfile: "balanced",
        ModelBackend: "onnx",
      TimePolicy: "RelativeClockV2",
    },
    timing: { initial_transport_reserve_ms: 650 },
  });
  assert.deepEqual(
    engine.timeProfileConfiguration().extraEngineOptions,
    {
      BehaviorProfile: "balanced",
        ModelBackend: "onnx",
      TimePolicy: "RelativeClockV2",
    },
  );
});

test("missing timing profile remains observable with zero reserve and controller disabled", async () => {
  const events = [];
  const engine = new UciEngine({
    executable: "engine.exe",
    working_directory: process.cwd(),
    time_profile: path.join(os.tmpdir(), `missing-time-profile-${Date.now()}.json`),
    uci_options: {
      SearchCore: "v2",
      Threads: 4,
      RootWorkers: 4,
      V2SplitDepth: 2,
      NNBatchSize: 8,
      NNBatchWaitUs: 150,
      OnnxProvider: "directml",
      BackgroundSearch: false,
      NNSpeculation: false,
      IterativeTimeController: false,
      TimeProfileProviderReserveUs: 0,
      TimeProfileBackupEmitReserveUs: 1000,
      TimeProfileIterationForecastScalePermille: 1000,
    },
    timing: { opponent_turn_search: true },
  }, (event) => events.push(event));
  engine.runtimeStatus = async () => ({
    time_profile_provider_reserve_us: 0,
    time_profile_backup_emit_reserve_us: 1000,
    time_profile_iteration_forecast_scale_permille: 1000,
  });
  const status = await engine.configureTimeProfile();
  assert.equal(status.status, "missing");
  assert.equal(status.applied, false);
  assert.equal(status.provider_service_reserve_us, 0);
  assert.equal(status.backup_emit_reserve_us, 1000);
  assert.equal(status.predictive_controller_enabled, false);
  assert.equal(engine.timing.opponent_turn_search, false);
  assert.equal(engine.config.timing.opponent_turn_search, false);
  assert.equal(events.some((event) =>
    event.event === "opponent_turn_search_disabled"
      && event.reason === "timing_profile_not_applied"), true);
});

test("timing profile identity owns the configured MCGS book-prior blend", () => {
  const engine = new UciEngine({
    uci_options: {
      SearchCore: "mcgs",
      Threads: 3,
      RootWorkers: 1,
      V2SplitDepth: 2,
      SearchGraphMB: 64,
      McgsCpuctPermille: 1500,
      McgsOutstandingBatches: 2,
      McgsBookPriorBlendPermille: 0,
      McgsTimePolicy: "RelativeClockTemporalV1",
      NNBatchSize: 32,
      NNBatchWaitUs: 150,
      OnnxProvider: "directml",
      BackgroundSearch: false,
      NNSpeculation: false,
      SyzygyProbeLimit: 6,
      SyzygyInternalProbe: true,
    },
  });
  const configuration = engine.timeProfileConfiguration();
  assert.equal(configuration.mcgsBookPriorBlendPermille, 0);
  assert.equal(
    Object.hasOwn(configuration.extraEngineOptions, "McgsBookPriorBlendPermille"),
    false,
  );
  assert.equal(
    Object.hasOwn(configuration.extraEngineOptions, "SyzygyProbeLimit"),
    false,
  );
  assert.equal(
    Object.hasOwn(configuration.extraEngineOptions, "SyzygyInternalProbe"),
    false,
  );
});

test("UCI search telemetry retains identity across later info string lines", () => {
  const engine = new UciEngine({ uci_options: {} });
  engine.onLine("info depth 8 model_provider directml model_fingerprint 1234 model_id model_v1");
  engine.onLine("info string timing elapsed_ms 4");
  assert.deepEqual(engine.latestInfo, {
    depth: 8,
    model_provider: "directml",
    model_fingerprint: "1234",
    model_id: "model_v1",
  });
});

test("UCI book telemetry is structured without losing later search identity", () => {
  const engine = new UciEngine({ uci_options: {} });
  engine.onLine("info string book_probe_result hit book_miss_reason none book_lookup_us 9 book_evaluation_source neutral_fallback book_evaluation_us 0 book_decision_us 11 book_emit_us 1 book_snapshot_identity 12345 book_record_count 363");
  engine.onLine("info depth 0 nodes 0 model_provider directml model_fingerprint 9876 model_id model_v1 string opening_book");
  assert.equal(engine.latestInfo.book_probe_result, "hit");
  assert.equal(engine.latestInfo.book_miss_reason, "none");
  assert.equal(engine.latestInfo.book_lookup_us, 9);
  assert.equal(engine.latestInfo.book_decision_us, 11);
  assert.equal(engine.latestInfo.book_snapshot_identity, "12345");
  assert.equal(engine.latestInfo.book_record_count, 363);
  assert.equal(engine.latestInfo.model_provider, "directml");
  engine.onLine("info depth 3 mcgs_search_intent opponent_root mcgs_book_hint_result hit mcgs_book_hint_active 1 mcgs_book_hint_identity 18446744073709551615 mcgs_book_hint_candidates 2 mcgs_book_prior_blend_permille 250 mcgs_book_top_move e7e5 mcgs_book_top_frequency_ppm 700000 mcgs_book_top_neural_prior_ppm 100000 mcgs_book_top_effective_prior_ppm 250000 mcgs_root_completed_edges_at_start 4 mcgs_root_visited_edges_at_start 5");
  assert.equal(engine.latestInfo.mcgs_search_intent, "opponent_root");
  assert.equal(engine.latestInfo.mcgs_book_hint_identity, "18446744073709551615");
  assert.equal(engine.latestInfo.mcgs_book_top_move, "e7e5");
  assert.equal(engine.latestInfo.mcgs_book_top_effective_prior_ppm, 250000);
  assert.equal(engine.latestInfo.mcgs_root_completed_edges_at_start, 4);
});

test("UCI MCGS opponent-root search uses the explicit opponentroot intent", async () => {
  const engine = new UciEngine({
    uci_options: {},
    timing: {
      opponent_turn_search: true,
      foreground_preempts_ponder: true,
      initial_transport_reserve_ms: 250,
    },
  });
  engine.runtimeGeneration = 1;
  const commands = [];
  engine.send = (command) => {
    commands.push(command);
    if (command === "stop") queueMicrotask(() => engine.onLine("bestmove e7e5"));
  };
  const active = await engine.startOpponentTurnSearch({
    moves: ["e2e4"],
    predictedMove: null,
    wtime: 180_000,
    btime: 180_000,
    winc: 0,
    binc: 0,
  });
  assert.equal(active.kind, "opponent_root");
  assert.deepEqual(commands.slice(0, 2), [
    "position startpos moves e2e4",
    "go infinite opponentroot",
  ]);
  await engine.stopAndDrain("test_complete");
});

test("terminal cancellation drain accepts null bestmove while foreground remains strict", async () => {
  const engine = new UciEngine({ uci_options: {} });
  engine.runtimeGeneration = 1;
  engine.send = (command) => {
    if (command === "stop") queueMicrotask(() => engine.onLine("bestmove 0000"));
  };
  engine.beginSearch("opponent_root", "go infinite", { rootMoves: [] });
  const drained = await engine.stopAndDrain("terminal_state");
  assert.equal(drained.drained, true);
  assert.equal(drained.nullBestmove, true);
  assert.equal(drained.staleBestmove, null);
  assert.throws(() => engine.parseBestmove("bestmove 0000"), /unusable bestmove/);
});

test("transport profile publishes only after ten games and two hundred successful moves", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-transport-profile-"));
  const profilePath = path.join(directory, "transport.json");
  let clock = Date.parse("2026-07-20T00:00:00Z");
  const tracker = new TransportProfileTracker({
    profilePath,
    bootstrapReserveMs: 650,
    now: () => clock,
  });
  for (let game = 0; game < 10; game += 1) {
    for (let move = 0; move < 20; move += 1) {
      tracker.record(`game-${game}`, 500 + ((game * 20 + move) % 100));
    }
    tracker.finishGame(`game-${game}`);
    clock += 1_000;
  }
  const loaded = loadTransportProfile(profilePath, clock);
  assert.equal(loaded.qualified, true);
  assert.equal(loaded.reserveMs, 650);
  assert.equal(loaded.profile.sample_count, 200);
  assert.equal(loaded.profile.game_count, 10);
  assert.equal(loadTransportProfile(profilePath, clock + 8 * 24 * 60 * 60 * 1_000).status, "stale");
});

test("stopped ponder bestmove is drained before the foreground waiter starts", async () => {
  const engine = new UciEngine({
    uci_options: {},
    timing: {
      opponent_turn_search: true,
      foreground_preempts_ponder: true,
      initial_transport_reserve_ms: 250,
    },
  });
  engine.runtimeGeneration = 3;
  const commands = [];
  engine.send = (command) => {
    commands.push(command);
    if (command === "stop") queueMicrotask(() => engine.onLine("bestmove g8f6 ponder b1c3"));
    if (command.startsWith("go wtime")) queueMicrotask(() => engine.onLine("bestmove c2c4 ponder e7e5"));
  };
  await engine.startOpponentTurnSearch({
    moves: ["e2e4"],
    predictedMove: "e7e5",
    wtime: 179_000,
    btime: 180_000,
    winc: 2_000,
    binc: 2_000,
  });
  const result = await engine.search({
    moves: ["e2e4", "c7c5"],
    wtime: 178_000,
    btime: 179_000,
    winc: 2_000,
    binc: 2_000,
    color: "white",
  });
  assert.equal(result.bestmove, "c2c4");
  assert.equal(result.ponder, "e7e5");
  assert.equal(result.staleBestmoveDrained, true);
  assert.deepEqual(commands.slice(0, 4), [
    "position startpos moves e2e4 e7e5",
    "go ponder wtime 179000 btime 180000 winc 2000 binc 2000",
    "stop",
    "position startpos moves e2e4 c7c5",
  ]);
});

test("authoritative cancellation stops and drains the real UCI foreground waiter", async () => {
  const engine = new UciEngine({
    uci_options: {},
    search_timeout_grace_ms: 1_000,
  });
  engine.runtimeGeneration = 3;
  const commands = [];
  let notifyGo;
  const goSent = new Promise((resolve) => {
    notifyGo = resolve;
  });
  engine.send = (command) => {
    commands.push(command);
    if (command.startsWith("go wtime")) {
      notifyGo();
    }
    if (command === "stop") {
      queueMicrotask(() => engine.onLine("bestmove e2e4"));
    }
  };

  const controller = new AbortController();
  const search = engine.search({
    moves: [],
    wtime: 180_000,
    btime: 180_000,
    winc: 2_000,
    binc: 2_000,
    color: "white",
    signal: controller.signal,
  });
  await goSent;
  controller.abort(new Error("authoritative root changed"));

  await assert.rejects(search, /authoritative root changed/);
  assert.equal(commands.filter((command) => command === "stop").length, 1);
  assert.equal(engine.mode, "idle");
  assert.equal(engine.activeSearch, null);
});

test("foreground coordinator preempts every other game and resumes only when foreground is idle", async () => {
  const events = [];
  const sessions = [
    {
      gameId: "a",
      pauseOpponentSearch: async (reason) => events.push(`pause-a:${reason}`),
      resumeOpponentSearch: async () => events.push("resume-a"),
    },
    {
      gameId: "b",
      pauseOpponentSearch: async (reason) => events.push(`pause-b:${reason}`),
      resumeOpponentSearch: async () => events.push("resume-b"),
    },
  ];
  const coordinator = new ForegroundSearchCoordinator({ sessions: () => sessions });
  const leaseA = await coordinator.begin("a");
  assert.deepEqual(events, ["pause-b:foreground_preempted"]);
  const leaseB = await coordinator.begin("b");
  assert.deepEqual(events, ["pause-b:foreground_preempted", "pause-a:foreground_preempted"]);
  await leaseA.release();
  assert.equal(events.includes("resume-a"), false);
  await leaseB.release();
  assert.deepEqual(events.slice(-2), ["resume-a", "resume-b"]);
});

test("game stream promotes an exact predicted reply and never posts before authoritative turn", async () => {
  const posts = [];
  const client = {
    post: async (endpoint) => posts.push(endpoint),
  };
  const engine = new MockGameEngine([
    { bestmove: "e2e4", ponder: "e7e5", nodes: 10 },
    { bestmove: "g1f3", ponder: "b8c6", nodes: 20 },
  ]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(initial, engine);
  assert.equal(posts.length, 1);
  assert.equal(engine.active?.kind, "ponder");
  assert.equal(engine.active?.rootKey, "e2e4 e7e5");

  await session.onState(startedState("e2e4"), engine);
  assert.equal(posts.length, 1, "own-move acknowledgement is not another bot turn");
  assert.equal(engine.ponderHitCalls, 0);

  await session.onState(startedState("e2e4 e7e5"), engine);
  assert.equal(engine.ponderHitCalls, 1);
  assert.equal(posts.length, 2);
  assert.match(posts[1], /\/move\/g1f3$/);
  assert.equal(engine.searchCalls.length, 1, "ponder hit reuses the running search");
});

test("MCGS starts full opponent-root search at move POST dispatch before acknowledgement", async () => {
  let acknowledgePost;
  let markDispatched;
  const dispatched = new Promise((resolve) => { markDispatched = resolve; });
  const client = {
    post: async (_endpoint, _form, _signal, _priority, beforeDispatch) => {
      beforeDispatch();
      markDispatched();
      await new Promise((resolve) => { acknowledgePost = resolve; });
    },
  };
  const engine = new MockGameEngine([{ bestmove: "e2e4", ponder: "e7e5" }]);
  const session = createGameSession(engine, client);
  session.config.engine.uci_options.SearchCore = "mcgs";
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);

  const move = session.onState(initial, engine);
  await dispatched;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.opponentCalls.length, 1);
  assert.equal(engine.opponentCalls[0].predictedMove, null);
  assert.deepEqual(engine.opponentCalls[0].moves, ["e2e4"]);
  assert.equal(engine.active?.kind, "opponent_root");
  acknowledgePost();
  await move;
});

test("MCGS actual reply is an opponent-root reroot, not a ponder miss", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([
    { bestmove: "e2e4", ponder: "e7e5" },
    { bestmove: "g1f3", ponder: "b8c6" },
  ]);
  const session = createGameSession(engine, client);
  session.config.engine.uci_options.SearchCore = "mcgs";
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(initial, engine);
  await session.onState(startedState("e2e4"), engine);
  await session.onState(startedState("e2e4 c7c5"), engine);
  assert.equal(engine.stopCalls.at(-1).reason, "opponent_root_reroot");
  assert.equal(session.lastPonderMissReason, null);
  assert.equal(posts.length, 2);
  assert.match(posts[1], /\/move\/g1f3$/);
});

test("black starts opponent-root work from gameFull and searches only after White moves", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([{ bestmove: "e7e5", ponder: "g1f3" }]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  const full = gameFull(initial);
  full.white = { id: "opponent" };
  full.black = { id: "arena-bot" };
  await session.initialize(full, engine);
  await session.onState(initial, engine);
  assert.equal(posts.length, 0);
  assert.equal(engine.active?.kind, "opponent_root");

  await session.onState(startedState("e2e4"), engine);
  assert.equal(engine.stopCalls.at(-1).reason, "advance");
  assert.deepEqual(engine.searchCalls[0].moves, ["e2e4"]);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /\/move\/e7e5$/);
});

test("ponder miss drains stale output, reconstructs the authoritative root, and ignores duplicates", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([
    { bestmove: "e2e4", ponder: "e7e5" },
    { bestmove: "d2d4", ponder: "d7d5" },
  ]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(initial, engine);
  await session.onState(startedState("e2e4"), engine);
  await session.onState(startedState("e2e4 c7c5"), engine);

  assert.equal(engine.ponderHitCalls, 0);
  assert.equal(engine.stopCalls.length, 1);
  assert.equal(engine.stopCalls[0].reason, "predicted_move_miss");
  assert.deepEqual(engine.searchCalls[1].moves, ["e2e4", "c7c5"]);
  assert.equal(posts.length, 2);

  await session.onState(startedState("e2e4 c7c5"), engine);
  assert.equal(posts.length, 2, "duplicate authoritative state cannot duplicate a POST");
});

test("reconnect invalidates the prediction and resumes opponent-root infinite search", async () => {
  const client = { post: async () => {} };
  const engine = new MockGameEngine([{ bestmove: "e2e4", ponder: "e7e5" }]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(initial, engine);
  assert.equal(engine.active?.kind, "ponder");

  await session.invalidateOpponentSearch("reconnect");
  assert.equal(session.pendingOwnMove.predictedMove, null);
  await session.onState(startedState("e2e4"), engine, { reconciled: true });
  assert.equal(engine.active?.kind, "opponent_root");
  assert.equal(engine.opponentCalls.at(-1).predictedMove, null);
  assert.equal(engine.stopCalls.at(-1).reason, "reconnect");
});

test("runtime generation change rejects an otherwise matching ponder line", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([
    { bestmove: "e2e4", ponder: "e7e5" },
    { bestmove: "g1f3", ponder: "b8c6" },
  ]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(initial, engine);
  await session.onState(startedState("e2e4"), engine);
  engine.runtimeGeneration += 1;
  await session.onState(startedState("e2e4 e7e5"), engine);
  assert.equal(engine.ponderHitCalls, 0);
  assert.equal(engine.stopCalls.at(-1).reason, "runtime_generation_changed");
  assert.equal(engine.searchCalls.length, 2);
  assert.equal(posts.length, 2);
});

test("search identity change rejects a move before submission", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([{
    bestmove: "e2e4",
    ponder: "e7e5",
    telemetry: { model_fingerprint: "unexpected-model" },
  }]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);

  await assert.rejects(
    session.onState(initial, engine),
    /UCI search model_fingerprint mismatch/,
  );
  assert.equal(posts.length, 0);
  assert.equal(session.pendingOwnMove, null);
});

test("syntactically valid illegal bestmove is rejected at the exact authoritative root", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([{ bestmove: "e2e5", ponder: "e7e5" }]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);

  await assert.rejects(
    session.onState(initial, engine),
    /illegal at the exact authoritative root/,
  );
  assert.equal(posts.length, 0);
  assert.equal(session.pendingOwnMove, null);
});

test("authoritative legality replay covers castling, en passant, promotion, and pins", () => {
  assert.equal(validateLegalMoveAtAuthoritativeRoot({
    initialFen: "startpos",
    moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1e2", "g8f6"],
    candidate: "e1g1",
  }).legal, true);
  assert.equal(validateLegalMoveAtAuthoritativeRoot({
    initialFen: "startpos",
    moves: ["e2e4", "a7a6", "e4e5", "d7d5"],
    candidate: "e5d6",
  }).legal, true);
  assert.equal(validateLegalMoveAtAuthoritativeRoot({
    initialFen: "8/P7/8/8/8/8/7p/4K2k w - - 0 1",
    moves: [],
    candidate: "a7a8q",
  }).legal, true);
  assert.equal(validateLegalMoveAtAuthoritativeRoot({
    initialFen: "4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1",
    moves: [],
    candidate: "e2f2",
  }).legal, false);
});

test("session legality state applies ordinary updates incrementally beyond one hundred plies", () => {
  const legality = new AuthoritativeChessState("startpos");
  const moves = [];
  let maximumApplied = 0;
  for (let cycle = 0; cycle < 30; cycle += 1) {
    for (const move of ["g1f3", "g8f6", "f3g1", "f6g8"]) {
      moves.push(move);
      const synchronization = legality.synchronize(moves);
      maximumApplied = Math.max(maximumApplied, synchronization.appliedPlies);
      assert.equal(synchronization.rebuilt, false);
    }
  }
  assert.equal(moves.length, 120);
  assert.equal(maximumApplied, 1);
  assert.equal(legality.validateCandidate(moves, "e2e4").legal, true);
});

test("unsupported from-position game fails closed before search or submission", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([{ bestmove: "a7a8q" }]);
  const session = createGameSession(engine, client);
  const full = gameFull(startedState(""));
  full.initialFen = "8/P7/8/8/8/8/7p/4K2k w - - 0 1";
  await assert.rejects(session.initialize(full, engine), /Unsupported live game shape/);
  assert.equal(engine.searchCalls.length, 0);
  assert.equal(posts.length, 0);
});

test("takeback and terminal states stop opponent work without submitting stale moves", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([{ bestmove: "e2e4", ponder: "e7e5" }]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(initial, engine);
  await session.onState(startedState("e2e4"), engine);
  await session.onState(startedState("", { status: "aborted" }), engine);
  assert.equal(session.finished, true);
  assert.equal(posts.length, 1);
  assert.equal(engine.isOpponentTurnSearchActive(), false);
  assert.ok(engine.stopCalls.some((entry) => entry.reason === "takeback"));
});

test("stream intake preempts an awaited foreground search on terminal authority before POST", async () => {
  const posts = [];
  const engine = new BlockingForegroundEngine();
  const initial = startedState("");
  const terminal = startedState("", { status: "aborted" });
  const client = {
    async *stream() {
      yield gameFull(initial);
      await engine.searchStarted;
      yield terminal;
    },
    post: async (endpoint) => posts.push(endpoint),
  };
  const abort = new AbortController();
  let sessions = [];
  const session = new GameSession({
    client,
    config: gameConfig(),
    account: "arena-bot",
    gameId: "game-preempt",
    signal: abort.signal,
    slot: { id: "human-1", audience: "human", engine },
    store: mockStore(),
    foregroundCoordinator: new ForegroundSearchCoordinator({ sessions: () => sessions }),
  });
  sessions = [session];

  await session.run();
  assert.equal(session.finished, true);
  assert.equal(posts.length, 0);
  assert.equal(engine.searchCalls.length, 1);
  assert.ok(engine.stopCalls.some((entry) => entry.reason === "terminal_state"));
  assert.ok(session.observedGeneration > 1);
});

test("stream intake preempts an awaited foreground search on a takeback before POST", async () => {
  const posts = [];
  const engine = new BlockingForegroundEngine();
  const root = startedState("e2e4 e7e5");
  const takeback = startedState("e2e4");
  const client = {
    async *stream() {
      yield gameFull(root);
      await engine.searchStarted;
      yield takeback;
    },
    post: async (endpoint) => posts.push(endpoint),
  };
  const abort = new AbortController();
  let sessions = [];
  const config = gameConfig();
  config.timing.opponent_turn_search = false;
  const session = new GameSession({
    client,
    config,
    account: "arena-bot",
    gameId: "game-takeback-preempt",
    signal: abort.signal,
    slot: { id: "human-1", audience: "human", engine },
    store: mockStore(),
    foregroundCoordinator: new ForegroundSearchCoordinator({ sessions: () => sessions }),
  });
  sessions = [session];

  await session.consumeGameStream(engine);
  assert.equal(posts.length, 0);
  assert.equal(engine.searchCalls.length, 1);
  assert.ok(engine.stopCalls.some((entry) => entry.reason === "takeback"));
  assert.equal(session.authoritativeMoves.join(" "), "e2e4");
});

test("same-root authoritative clock correction cancels the old-clock search before POST", async () => {
  const posts = [];
  const engine = new ClockCorrectionEngine();
  const initial = startedState("", { wtime: 180_000 });
  const corrected = startedState("", { wtime: 170_000 });
  const client = {
    async *stream() {
      yield gameFull(initial);
      await engine.firstSearchStarted;
      yield corrected;
    },
    post: async (endpoint) => posts.push(endpoint),
  };
  const abort = new AbortController();
  let sessions = [];
  const config = gameConfig();
  config.timing.opponent_turn_search = false;
  const session = new GameSession({
    client,
    config,
    account: "arena-bot",
    gameId: "game-clock-correction",
    signal: abort.signal,
    slot: { id: "human-1", audience: "human", engine },
    store: mockStore(),
    foregroundCoordinator: new ForegroundSearchCoordinator({ sessions: () => sessions }),
  });
  sessions = [session];

  await session.consumeGameStream(engine);
  assert.equal(engine.searchCalls.length, 2);
  assert.ok(engine.stopCalls.some((entry) => entry.reason === "clock_correction"));
  assert.deepEqual(posts, ["api/bot/game/game-clock-correction/move/e2e4"]);
  assert.ok(engine.searchCalls[1].wtime <= 170_000 && engine.searchCalls[1].wtime >= 169_900);
});

test("terminal authority cancels a move blocked in the request queue before fetch dispatch", async () => {
  const fetches = [];
  let releaseBlocker;
  const blockerReady = new Promise((resolve) => {
    releaseBlocker = { ready: resolve, release: null };
  });
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async (url) => {
      const endpoint = new URL(url).pathname;
      fetches.push(endpoint);
      if (endpoint.endsWith("/blocker")) {
        return new Promise((resolve) => {
          releaseBlocker.release = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({}),
          });
          releaseBlocker.ready();
        });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const blocker = client.json("api/blocker");
  await blockerReady;

  const engine = new MockGameEngine([{ bestmove: "e2e4" }]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  const moveOperation = session.onState(initial, engine);
  while (client.requestQueue.queue.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await session.onState(startedState("", { status: "aborted" }), engine);
  releaseBlocker.release();
  await blocker;
  await moveOperation;

  assert.equal(fetches.some((endpoint) => endpoint.includes("/move/")), false);
  assert.equal(session.finished, true);
});

test("HTTP 400 move response requires an explicit authoritative reconciliation before retry", async () => {
  let postAttempts = 0;
  const client = {
    post: async () => {
      postAttempts += 1;
      if (postAttempts === 1) throw new LichessHttpError("POST", "move", 400);
    },
  };
  const engine = new MockGameEngine([
    { bestmove: "e2e4", ponder: "e7e5" },
    { bestmove: "d2d4", ponder: "d7d5" },
  ]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await assert.rejects(session.onState(initial, engine), /HTTP 400/);
  assert.equal(postAttempts, 1);
  assert.equal(session.pendingOwnMove, null);
  assert.equal(engine.isOpponentTurnSearchActive(), false);

  await session.onState(initial, engine, { reconciled: true });
  assert.equal(postAttempts, 2);
  assert.equal(engine.searchCalls.length, 2);
});

test("HTTP 429 move response does not start ponder or submit a blind retry", async () => {
  let postAttempts = 0;
  const client = {
    post: async () => {
      postAttempts += 1;
      throw new LichessHttpError("POST", "move", 429, 60_000);
    },
  };
  const engine = new MockGameEngine([{ bestmove: "e2e4", ponder: "e7e5" }]);
  const session = createGameSession(engine, client);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await assert.rejects(session.onState(initial, engine), /HTTP 429/);
  assert.equal(postAttempts, 1);
  assert.equal(session.pendingOwnMove, null);
  assert.equal(engine.opponentCalls.length, 0);
});

test("NDJSON parser handles split chunks and keepalive lines", async () => {
  const encoder = new TextEncoder();
  const chunks = ["{\"type\":\"game", "Start\"}\n\n{\"type\":\"gameFinish\"}"];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseNdjsonStream(stream)) events.push(event);
  assert.deepEqual(events, [{ type: "gameStart" }, { type: "gameFinish" }]);
});

test("API client keeps credentials in the authorization header", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new LichessClient({ token: "test-token", fetchImpl });
  await client.json("api/account");
  assert.equal(request.url.includes("test-token"), false);
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(JSON.stringify(request.options).includes("test-token"), true);
});

test("API client applies at least sixty seconds of global backoff after 429", async () => {
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "1" },
    }),
  });
  const before = Date.now();
  await assert.rejects(client.json("api/account"), /HTTP 429/);
  assert.ok(client.requestQueue.cooldownUntil >= before + 60_000);
});

test("API client exposes only bounded sanitized Lichess error detail", async () => {
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        error: `Challenge rejected\n${"x".repeat(300)}`,
        ignored: "arbitrary response document",
      }),
    }),
  });
  await assert.rejects(
    client.postJson("api/challenge/test-bot", { rated: false }),
    (error) => {
      assert.ok(error instanceof LichessHttpError);
      assert.equal(error.status, 400);
      assert.equal(error.detail.includes("\n"), false);
      assert.equal(error.detail.length, 256);
      assert.match(error.message, /Challenge rejected/);
      assert.equal(error.message.includes("arbitrary response document"), false);
      assert.equal(error.message.includes("test-token"), false);
      return true;
    },
  );
});

test("API client holds the single-flight permit through finite response consumption", async () => {
  let releaseFirst;
  const firstBody = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async (url) => {
      started.push(String(url));
      if (started.length === 1) {
        return { ok: true, status: 200, json: async () => firstBody };
      }
      return { ok: true, status: 200, json: async () => ({ second: true }) };
    },
  });
  const first = client.json("api/account");
  const second = client.json("api/account/playing");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 1);
  releaseFirst({ first: true });
  assert.deepEqual(await first, { first: true });
  assert.deepEqual(await second, { second: true });
  assert.equal(started.length, 2);
});

test("finite online-bot NDJSON blocks later requests until its body is complete", async () => {
  const encoder = new TextEncoder();
  let closeDiscovery;
  let calls = 0;
  const discoveryBody = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"username":"bot-one"}\n'));
      closeDiscovery = () => controller.close();
    },
  });
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 200, body: discoveryBody };
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  });
  const discovery = client.collectNdjson("api/bot/online?nb=512");
  const move = client.post("api/bot/game/game-1/move/e2e4");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  closeDiscovery();
  assert.deepEqual(await discovery, [{ username: "bot-one" }]);
  await move;
  assert.equal(calls, 2);
});

test("a 429 from discovery blocks move and stream handshakes until the global deadline", async () => {
  let now = 5_000;
  const timers = [];
  const coordinator = new ApiSafetyCoordinator({
    now: () => now,
    setTimer: (callback, milliseconds) => {
      timers.push({ callback, milliseconds });
      return timers.length;
    },
    clearTimer: () => {},
  });
  let calls = 0;
  const client = new LichessClient({
    token: "test-token",
    safetyCoordinator: coordinator,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, headers: { get: () => null } };
      }
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({ start(controller) { controller.close(); } }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    },
  });
  await assert.rejects(client.collectNdjson("api/bot/online?nb=512"), /HTTP 429/);
  const move = client.post("api/bot/game/game-1/move/e2e4");
  const stream = client.openStream("api/stream/event");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  now = coordinator.cooldownUntil;
  coordinator.pump();
  await move;
  const events = await stream;
  for await (const _event of events) assert.fail("empty stream emitted an event");
  assert.equal(calls, 3);
});

test("established streams coexist but duplicate stream ownership is rejected", async () => {
  const streams = [];
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async () => {
      const body = new ReadableStream({ start(controller) { controller.close(); } });
      streams.push(body);
      return { ok: true, status: 200, body };
    },
  });
  const eventStream = await client.openStream("api/stream/event");
  await assert.rejects(client.openStream("api/stream/event"), /already pending or active/);
  for await (const _event of eventStream) assert.fail("empty stream emitted an event");
  const reopened = await client.openStream("api/stream/event");
  for await (const _event of reopened) assert.fail("empty stream emitted an event");
  assert.equal(streams.length, 2);
});

test("account probe rejects a mismatched account", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ username: "other", title: "BOT" }),
  });
  await assert.rejects(
    probeAccount({ tokenFile: temporaryToken(), expectedAccount: "expected", fetchImpl }),
    /account mismatch/,
  );
});

test("account probe discovers a BOT identity when no expected account is supplied", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      username: "detected-bot",
      title: "BOT",
      count: { all: 7 },
    }),
  });
  assert.deepEqual(
    await probeAccount({ tokenFile: temporaryToken(), fetchImpl }),
    {
      username: "detected-bot",
      title: "BOT",
      is_bot: true,
      games: 7,
    },
  );
});

test("account probe explains BOT ineligibility after prior play", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ username: "expected", count: { all: 1 } }),
  });
  await assert.rejects(
    probeAccount({ tokenFile: temporaryToken(), expectedAccount: "expected", fetchImpl }),
    /prior games=1/,
  );
});

test("challenge policy accepts only the configured clean standard shape", () => {
  const policy = loadRuntimeConfig().challenges;
  const challenge = {
    id: "challenge",
    direction: "in",
    rated: false,
    speed: "rapid",
    variant: { key: "standard" },
    timeControl: { type: "clock", limit: 600, increment: 2 },
    challenger: { title: "BOT" },
  };
  assert.equal(challengeDeclineReason(challenge, policy), null);
  assert.equal(challengeDeclineReason({ ...challenge, initialFen: "startpos" }, policy), null);
  assert.equal(challengeDeclineReason({ ...challenge, rated: true }, policy), "rated");
  assert.equal(challengeDeclineReason({ ...challenge, variant: { key: "chess960" } }, policy), "variant");
  assert.equal(challengeDeclineReason({ ...challenge, initialFen: "8/8/8/8/8/8/8/8 w - - 0 1" }, policy), "variant");
  assert.equal(challengeDeclineReason(challenge, policy, 1), "later");
});

test("challenge ownership comes from challenger identity, not direction", () => {
  const selfChallenge = { direction: "in", challenger: { name: "UCI_Arena_Bot" } };
  const incomingChallenge = { direction: "out", challenger: { name: "Opponent" } };
  assert.equal(challengeFromSelf(selfChallenge, "uci_arena_bot"), true);
  assert.equal(challengeFromSelf(incomingChallenge, "UCI_Arena_Bot"), false);
});

test("nested local control commands parse without touching credentials", () => {
  assert.deepEqual(parseArguments(["owner", "add", "--username", "owner"]), {
    command: "owner", action: "add", username: "owner",
  });
  assert.deepEqual(parseArguments(["reserve", "--opponent", "owner", "--games", "2"]), {
    command: "reserve", opponent: "owner", games: "2",
  });
  assert.deepEqual(parseArguments(["config", "update", "--config", "local.json", "--settings", "{}"]), {
    command: "config", action: "update", config: "local.json", settings: "{}",
  });
});

test("private stdin shutdown command aborts the adapter cooperatively", async () => {
  const controller = new AbortController();
  const input = new PassThrough();
  const unbind = bindShutdownInput(controller, input);
  input.write("shut");
  input.write("down\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.signal.aborted, true);
  assert.match(controller.signal.reason.message, /shutdown command/);
  unbind();
  input.destroy();
});

test("concurrent inbound events cannot overbook one bot slot", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-admission-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  const posts = [];
  const client = {
    post: async (endpoint, form) => {
      posts.push({ endpoint, form });
      return { json: async () => ({}) };
    },
  };
  const config = {
    capacity: {
      total_slots: 1,
      startup_parallelism: 1,
      legacy_shared: false,
      human: { slots: 0, allow_borrowing: false, accept_public: true },
      bot: { slots: 1, target_active: 0 },
    },
    challenges: {
      accept_bots: true,
      min_base: 180,
      max_base: 1800,
      min_increment: 0,
      max_increment: 10,
      speeds: ["blitz", "rapid", "classical"],
      modes: ["casual"],
    },
    scheduler: { decline_cooldown_minutes: 360 },
  };
  const controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  controller.prepareSlot = async (slot) => {
    await preparationGate;
    controller.slots.attachEngine(slot, { close: async () => {} });
    return slot;
  };
  const challenge = (id, name) => ({
    id,
    rated: false,
    speed: "blitz",
    variant: { key: "standard" },
    timeControl: { type: "clock", limit: 180, increment: 2 },
    challenger: { id: name, title: "BOT" },
  });
  try {
    const first = controller.onChallenge(challenge("one", "bot-one"));
    const second = controller.onChallenge(challenge("two", "bot-two"));
    releasePreparation();
    await Promise.all([first, second]);
    assert.equal(posts.filter((entry) => entry.endpoint.endsWith("/accept")).length, 1);
    assert.equal(posts.filter((entry) => entry.endpoint.endsWith("/decline")
      && entry.form.reason === "later").length, 1);
    assert.equal(controller.slots.snapshot().byAudience.bot.pending, 1);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("cooldown-delayed inbound acceptance expires before fetch dispatch", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-stale-challenge-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let now = 1_000;
  let fetches = 0;
  const client = {
    post: async (_endpoint, _form, _signal, _priority, beforeDispatch) => {
      now += 20_000;
      beforeDispatch();
      fetches += 1;
    },
  };
  const config = {
    capacity: {
      total_slots: 1,
      startup_parallelism: 1,
      legacy_shared: false,
      human: { slots: 0, allow_borrowing: false, accept_public: true },
      bot: { slots: 1, target_active: 0 },
    },
    challenges: {
      accept_bots: true,
      min_base: 180,
      max_base: 1800,
      min_increment: 0,
      max_increment: 10,
      speeds: ["blitz", "rapid", "classical"],
      modes: ["casual"],
    },
    scheduler: { decline_cooldown_minutes: 360 },
  };
  const controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
    now: () => now,
  });
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => {} });
    return slot;
  };
  try {
    await controller.onChallenge({
      id: "stale",
      rated: false,
      speed: "blitz",
      variant: { key: "standard" },
      timeControl: { type: "clock", limit: 180, increment: 2 },
      challenger: { id: "bot-one", title: "BOT" },
    });
    assert.equal(fetches, 0);
    assert.equal(controller.slots.snapshot().byAudience.bot.empty, 1);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("restart recovery prefers canonical opponent id over a title-prefixed display name", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-recovery-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  store.replaceOnlineBots([{ username: "usunfish", title: "BOT" }]);
  let requestedEndpoint;
  const client = {
    json: async (endpoint) => {
      requestedEndpoint = endpoint;
      return {
        nowPlaying: [{
          gameId: "game",
          opponent: { id: "usunfish", username: "BOT uSunfish" },
        }],
      };
    },
  };
  const config = {
    capacity: {
      total_slots: 2,
      startup_parallelism: 2,
      human: { slots: 1, allow_borrowing: false, accept_public: true },
      bot: { slots: 1, target_active: 1 },
    },
  };
  const controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  let recovered;
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => {} });
    return slot;
  };
  controller.startGame = async (game, slot) => { recovered = { game, slot }; };
  try {
    await controller.recoverPlayingGames();
    assert.equal(requestedEndpoint, "api/account/playing?nb=50");
    assert.equal(recovered.slot.opponent, "usunfish");
    assert.equal(recovered.slot.audience, "bot");
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("outbound timeout cancels the remote challenge before releasing its slot", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-timeout-cancel-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  const posts = [];
  let closes = 0;
  const controller = new BotController({
    client: {
      post: async (endpoint, form) => {
        posts.push({ endpoint, form });
        return { json: async () => ({}) };
      },
    },
    config: {
      capacity: {
        total_slots: 1,
        startup_parallelism: 1,
        human: { slots: 0, allow_borrowing: false, accept_public: true },
        bot: { slots: 1, target_active: 1 },
      },
      scheduler: { challenge_timeout_seconds: 25, timeout_cooldown_minutes: 30 },
    },
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  const slot = controller.slots.acquire("bot", {
    opponent: "late-bot",
    direction: "outbound",
    createdAt: 1,
  });
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } });
  controller.slots.pending(slot, "late-challenge");
  store.recordChallenge({
    id: "late-challenge",
    opponent: "late-bot",
    audience: "bot",
    direction: "outbound",
    status: "created",
    clockLimit: 180,
    clockIncrement: 2,
  }, 1);
  try {
    await controller.expirePending(25_001);
    assert.deepEqual(posts, [{
      endpoint: "api/challenge/late-challenge/cancel",
      form: undefined,
    }]);
    assert.equal(closes, 1);
    assert.equal(slot.state, "empty");
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("permanent timeout cancellation failure retains the slot and faults outbound scheduling", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-timeout-race-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let closes = 0;
  const controller = new BotController({
    client: {
      post: async (endpoint) => {
        throw new LichessHttpError("POST", endpoint, 400);
      },
      json: async () => ({ nowPlaying: [] }),
    },
    config: {
      capacity: {
        total_slots: 1,
        startup_parallelism: 1,
        human: { slots: 0, allow_borrowing: false, accept_public: true },
        bot: { slots: 1, target_active: 1 },
      },
      scheduler: { challenge_timeout_seconds: 25, timeout_cooldown_minutes: 30 },
    },
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  const slot = controller.slots.acquire("bot", {
    opponent: "late-bot",
    direction: "outbound",
    createdAt: 1,
  });
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } });
  controller.slots.pending(slot, "late-challenge");
  try {
    await controller.expirePending(25_001);
    assert.equal(slot.state, "cancelling");
    assert.equal(slot.challengeId, "late-challenge");
    assert.equal(slot.cancelRetryAt, Number.POSITIVE_INFINITY);
    assert.equal(controller.schedulerFault.kind, "permanent_cancel_error");
    assert.equal(closes, 0);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("timeout cancellation 404 reconciles once then releases after the late-event grace", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-timeout-404-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let posts = 0;
  let closes = 0;
  const controller = new BotController({
    client: {
      post: async (endpoint) => {
        posts += 1;
        throw new LichessHttpError("POST", endpoint, 404);
      },
      json: async () => ({ nowPlaying: [] }),
    },
    config: {
      capacity: {
        total_slots: 1,
        startup_parallelism: 1,
        human: { slots: 0, allow_borrowing: false, accept_public: true },
        bot: { slots: 1, target_active: 1 },
      },
      scheduler: { challenge_timeout_seconds: 25, timeout_cooldown_minutes: 30 },
    },
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  const slot = controller.slots.acquire("bot", {
    opponent: "gone-bot",
    direction: "outbound",
    createdAt: 1,
  });
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } });
  controller.slots.pending(slot, "gone-challenge");
  try {
    await controller.expirePending(25_001);
    assert.equal(slot.state, "cancelling");
    assert.equal(posts, 1);
    const releaseAt = slot.reconcileReleaseAt;
    await controller.expirePending(releaseAt - 1);
    assert.equal(posts, 1);
    assert.equal(slot.state, "cancelling");
    await controller.expirePending(releaseAt);
    assert.equal(posts, 1);
    assert.equal(slot.state, "empty");
    assert.equal(closes, 1);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("timeout cancellation 404 recovers an already-started game without releasing its child", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-timeout-404-game-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  let closes = 0;
  const controller = new BotController({
    client: {
      post: async (endpoint) => { throw new LichessHttpError("POST", endpoint, 404); },
      json: async () => ({ nowPlaying: [{ gameId: "accepted-challenge" }] }),
    },
    config: {
      capacity: {
        total_slots: 1,
        startup_parallelism: 1,
        human: { slots: 0, allow_borrowing: false, accept_public: true },
        bot: { slots: 1, target_active: 1 },
      },
      scheduler: { challenge_timeout_seconds: 25, timeout_cooldown_minutes: 30 },
    },
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  const slot = controller.slots.acquire("bot", {
    opponent: "accepted-bot",
    direction: "outbound",
    createdAt: 1,
  });
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } });
  controller.slots.pending(slot, "accepted-challenge");
  controller.startGame = async (game, recoveredSlot) => {
    controller.slots.active(recoveredSlot, game.gameId);
  };
  try {
    await controller.expirePending(25_001);
    assert.equal(slot.state, "active");
    assert.equal(slot.gameId, "accepted-challenge");
    assert.equal(closes, 0);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});
