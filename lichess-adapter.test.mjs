import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  bookMoveWasUsed,
  exactEvidenceRequalification,
  engineComponentIdentity,
  gameRuntimeProvenance,
  loadAdaptiveTemporalCurveProfile,
  loadCapacityProfile,
  loadManagerConfig,
  loadRuntimeConfig,
  loadSingleGameProfile,
  loadTransportProfile,
  parseNdjsonStream,
  parseArguments,
  parseRuntimeStatus,
  probeAccount,
  providerComponentIdentity,
  providerStatusProjection,
  replacementStartupReadiness,
  qualificationFailureProjection,
  resolveExternalTokenFile,
  resolveProviderRuntimeDirectory,
  startupIsExplicitlyDisabledAndInactive,
  managerOptionsProjection,
  main,
  observeApiSafetyIncident,
  updateManagerOptions,
  unexpectedStartupIncident,
  validateRuntimeStatus,
} from "./lichess-adapter.mjs";
import {
  BOUNDS,
  BOOTSTRAP_COEFFICIENTS,
  coefficientOptions,
} from "./test-fixtures/adaptive-temporal-curve.mjs";
import { ApiSafetyCoordinator, LichessHttpError } from "./lichess-scheduler.mjs";
import { LichessStore } from "./lichess-store.mjs";
import { startFakeLichessApi } from "./fake-api-server.mjs";
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

test("provider status distinguishes inactive, disconnected, and ready states", () => {
  const missing = providerStatusProjection();
  assert.equal(missing.active, false);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.blockers, [
    "runtime_status_missing",
    "provider_process_inactive",
    "incident_storage_unavailable",
    "game_archive_storage_unavailable",
  ]);
  assert.equal(missing.schema, "uci_arena_lichess_status_v5");
  assert.equal(missing.incidents.available, false);
  assert.equal(missing.games.archive_available, false);

  const disabled = providerStatusProjection({
    startup: { installed: true, enabled: false, active: false },
  });
  assert.equal(disabled.registered, true);
  assert.equal(disabled.active, false);
  assert.equal(disabled.blockers.includes("startup_registration_disabled"), true);

  const restartPending = providerStatusProjection({
    startup: {
      installed: true,
      enabled: true,
      active: false,
      restartPending: true,
      exitReceiptState: "failed",
      lastUnexpectedExit: { child_exit_code: 3221226505 },
    },
  });
  assert.equal(restartPending.blockers.includes("provider_restart_pending"), true);
  assert.equal(restartPending.blockers.includes("provider_last_exit_unexpected"), true);
  assert.equal(restartPending.blockers.includes("startup_exit_receipt_unavailable"), true);

  const runtime = {
    schema: "uci_arena_lichess_runtime_v3",
    pid: 42,
    account: "arena-bot",
    stream_connected: false,
    stream_lifecycle: "disconnected",
    configured_capacity: 2,
    qualified_capacity: 2,
    slots: [
      { state: "active", audience: "human" },
      { state: "cancelling", audience: "bot" },
    ],
    scheduler: { enabled: true, paused: false, target_active_bots: 1, fault: null },
    api_safety: {
      state: "ready",
      queue_depth: 0,
      challenge_state: "ready",
      challenge_remaining_ms: 0,
      client_lease: {
        state: "authoritative",
        active_clients: 1,
        heartbeat_at: Date.parse("2026-08-01T00:00:00.000Z"),
        expires_at: Date.parse("2026-08-01T00:01:00.000Z"),
      },
    },
    incidents: {
      available: true,
      active_count: 0,
      highest_severity: null,
      latest_cursor: 0,
      truncated: false,
      truncated_rows: 0,
    },
    game_archive: {
      available: true,
      total_games: 3,
      complete_games: 1,
      incomplete_games: 1,
      live_games: 1,
      logical_storage_bytes: 16_384,
    },
    updated_at: "2026-08-01T00:00:00.000Z",
  };
  const disconnected = providerStatusProjection({
    runtime,
    active: true,
    startup: { installed: true },
    now: Date.parse(runtime.updated_at),
  });
  assert.equal(disconnected.registered, true);
  assert.equal(disconnected.active, true);
  assert.equal(disconnected.ready, false);
  assert.deepEqual(disconnected.blockers, ["event_stream_disconnected"]);
  assert.equal(disconnected.games.active, 1);
  assert.equal(disconnected.games.cancelling, 1);
  assert.equal(disconnected.games.archive_available, true);
  assert.equal(disconnected.games.total, 3);

  const recovering = providerStatusProjection({
    runtime: {
      ...runtime,
      stream_lifecycle: "reconciling",
      scheduler: { ...runtime.scheduler, reconciliation_pending: true },
    },
    active: true,
    startup: { installed: true },
    now: Date.parse(runtime.updated_at),
  });
  assert.equal(recovering.ready, false);
  assert.deepEqual(recovering.blockers, ["startup_reconciliation_pending"]);

  const coolingDown = providerStatusProjection({
    runtime: {
      ...runtime,
      stream_lifecycle: "waiting_for_api_cooldown",
      scheduler: { ...runtime.scheduler, reconciliation_pending: true },
      api_safety: {
        ...runtime.api_safety,
        state: "cooldown",
        cooldown_remaining_ms: 60_000,
        challenge_state: "quarantined",
        challenge_remaining_ms: 21_600_000,
      },
    },
    active: true,
    startup: { installed: true },
    now: Date.parse(runtime.updated_at),
  });
  assert.equal(coolingDown.active, true);
  assert.equal(coolingDown.stream_state, "waiting_for_api_cooldown");
  assert.deepEqual(coolingDown.blockers, [
    "event_stream_waiting_for_api_cooldown",
    "startup_reconciliation_pending",
    "api_global_cooldown",
    "outbound_challenge_quarantined",
  ]);

  const ready = providerStatusProjection({
    runtime: {
      ...runtime,
      stream_connected: true,
      stream_lifecycle: "connected",
      incidents: {
        available: true,
        active_count: 2,
        highest_severity: "critical",
        latest_cursor: 7,
        truncated: true,
        truncated_rows: 3,
      },
    },
    active: true,
    startup: {
      installed: true,
      supervisionState: "active",
      restartPending: false,
      exitReceiptState: "ready",
      lastExit: {
        disposition: "unexpected_exit",
        exited_at: "2026-07-31T23:59:00.000Z",
        child_exit_code: 1,
      },
    },
    now: Date.parse(runtime.updated_at),
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual(Object.keys(ready.account), ["username", "bot"]);
  assert.deepEqual(ready.supervision, {
    state: "active",
    restart_pending: false,
    exit_receipt_state: "ready",
    last_exit: {
      disposition: "unexpected_exit",
      exited_at: "2026-07-31T23:59:00.000Z",
      child_exit_code: 1,
    },
  });
  assert.deepEqual(ready.incidents, {
    available: true,
    active_count: 2,
    highest_severity: "critical",
    latest_cursor: 7,
    truncated: true,
    truncated_rows: 3,
  });

  const engineFaulted = providerStatusProjection({
    runtime: {
      ...runtime,
      stream_connected: true,
      stream_lifecycle: "connected",
      game_engine_incidents: [{ game_id: "retained-game", code: "engine_contract_failure", operation: "move_validation" }],
    },
    active: true,
    now: Date.parse(runtime.updated_at),
  });
  assert.equal(engineFaulted.active, true);
  assert.equal(engineFaulted.stream_connected, true);
  assert.equal(engineFaulted.games.active, 1);
  assert.equal(engineFaulted.ready, false);
  assert.deepEqual(engineFaulted.blockers, ["game_engine_contract_failure"]);

  const stale = providerStatusProjection({
    runtime: { ...runtime, stream_connected: true, stream_lifecycle: "connected" },
    active: true,
    startup: { installed: true },
    now: Date.parse(runtime.updated_at) + 15_001,
  });
  assert.equal(stale.active, false);
  assert.equal(stale.ready, false);
  assert.deepEqual(stale.blockers, ["runtime_status_stale", "provider_process_inactive"]);
});

test("startup incident identity excludes clean exits and is stable for one unexpected receipt", () => {
  assert.equal(unexpectedStartupIncident({ disposition: "clean_exit" }), null);
  const receipt = {
    disposition: "unexpected_exit",
    started_at: "2026-08-01T00:00:00.000Z",
    exited_at: "2026-08-01T00:00:01.000Z",
    child_exit_code: 1,
    process_instance: {
      schema: "uci_arena_process_instance_receipt_v1",
      platform: "win32",
      pid: 42,
      creation_time_100ns: "123",
    },
  };
  const first = unexpectedStartupIncident(receipt);
  const second = unexpectedStartupIncident({ ...receipt });
  assert.deepEqual(first, second);
  assert.match(first.episodeScope, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(first).includes("started_at"), false);
  assert.equal(JSON.stringify(first).includes("process_instance"), false);
});

test("post-replacement deferral accepts only exact Engine evidence drift", () => {
  assert.deepEqual(
    exactEvidenceRequalification(
      new Error("Single-game profile engine build fingerprint mismatch"),
    ),
    {
      requalificationRequired: true,
      requalificationReason: "exact_engine_evidence_stale",
    },
  );
  assert.equal(
    exactEvidenceRequalification(
      new Error("Single-game profile model/checkpoint identity mismatch"),
    ),
    null,
  );
  assert.equal(
    startupIsExplicitlyDisabledAndInactive({
      installed: true,
      enabled: false,
      active: false,
    }),
    true,
  );
  assert.equal(
    startupIsExplicitlyDisabledAndInactive({
      installed: true,
      enabled: true,
      active: false,
    }),
    false,
  );
  assert.equal(
    startupIsExplicitlyDisabledAndInactive({
      installed: true,
      enabled: "disabled",
      active: "inactive",
    }),
    true,
  );
});

test("post-replacement readiness preserves a durable global API cooldown", () => {
  const coolingDown = {
    active: true,
    ready: false,
    stream_state: "waiting_for_api_cooldown",
    scheduler: { fault: null },
    rate_limit: {
      state: "cooldown",
      cooldown_remaining_ms: 3_600_000,
      client_lease: { state: "authoritative" },
    },
    blockers: [
      "event_stream_waiting_for_api_cooldown",
      "api_global_cooldown",
      "outbound_challenge_quarantined",
    ],
  };
  assert.deepEqual(replacementStartupReadiness(coolingDown), {
    stable: true,
    providerReady: false,
    apiCooldownDeferred: true,
    startupPending: false,
  });
  assert.equal(replacementStartupReadiness({
    ...coolingDown,
    blockers: [...coolingDown.blockers, "startup_reconciliation_pending"],
  }).stable, false);
  assert.equal(replacementStartupReadiness({
    ...coolingDown,
    rate_limit: {
      ...coolingDown.rate_limit,
      client_lease: { state: "conflict" },
    },
  }).stable, false);
  assert.deepEqual(replacementStartupReadiness({ ready: true }), {
    stable: true,
    providerReady: true,
    apiCooldownDeferred: false,
    startupPending: false,
  });
});

test("post-replacement readiness accepts only authoritative supervised startup pending", () => {
  const starting = {
    active: true,
    ready: false,
    stream_state: "starting",
    scheduler: { fault: null },
    rate_limit: { client_lease: { state: "authoritative" } },
    blockers: ["provider_starting", "startup_reconciliation_pending"],
  };
  assert.deepEqual(replacementStartupReadiness(starting), {
    stable: true,
    providerReady: false,
    apiCooldownDeferred: false,
    startupPending: true,
  });
  assert.equal(replacementStartupReadiness({
    ...starting,
    blockers: [...starting.blockers, "runtime_status_stale"],
  }).stable, false);
  assert.equal(replacementStartupReadiness({
    ...starting,
    rate_limit: { client_lease: { state: "conflict" } },
  }).stable, false);
  assert.equal(replacementStartupReadiness({
    ...starting,
    scheduler: { fault: { kind: "startup" } },
  }).stable, false);
});

test("Engine fingerprint drift cannot mask model or search-authority drift", () => {
  const fixture = qualifiedFixture();
  writeFileSync(fixture.config.engine.executable, "replacement-engine");
  writeFileSync(
    path.join(fixture.config.engine.working_directory, "model", "checkpoint_manifest.json"),
    JSON.stringify({ model_id: "different-model", checkpoint_hash: "b".repeat(64) }),
  );
  assert.throws(
    () => applySingleGameProfile(fixture.config),
    /model\/checkpoint identity mismatch/,
  );

  writeFileSync(
    path.join(fixture.config.engine.working_directory, "model", "checkpoint_manifest.json"),
    JSON.stringify({
      model_id: fixture.profile.model_id,
      checkpoint_hash: fixture.profile.checkpoint_hash,
    }),
  );
  fixture.config.engine.uci_options.SearchCore = "v2";
  assert.throws(
    () => applySingleGameProfile(fixture.config),
    /conflicts with profile-owned UCI option SearchCore/,
  );

  delete fixture.config.engine.uci_options.SearchCore;
  assert.throws(
    () => applySingleGameProfile(fixture.config),
    /engine build fingerprint mismatch/,
  );
});

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
    opening_book_statistics_available: true,
    opening_book_entries: 1259,
    opening_book_identity: "123456789",
    opening_book_message: "loaded",
    ...(profile.tablebase ? {
      syzygy_active: true,
      syzygy_loaded_cardinality: profile.tablebase.loaded_cardinality,
      syzygy_identity: "123456789",
      syzygy_manifest_identity: profile.tablebase.manifest_identity,
      syzygy_probe_limit: profile.tablebase.probe_limit,
      syzygy_probe_threads: profile.tablebase.probe_threads,
      syzygy_rule50: profile.tablebase.rule50,
      syzygy_root_probe: profile.tablebase.root_probe,
      syzygy_internal_probe: profile.tablebase.internal_probe,
      syzygy_message: "active",
    } : {}),
  };
}

test("provider persistence follows runtime then configuration workspace authority", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-runtime-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const componentRoot = path.join(directory, "immutable-component");
  const workspace = path.join(directory, "preserved-workspace");
  const explicitRuntime = path.join(directory, "explicit-runtime");
  const configPath = path.join(workspace, "manager-config.json");
  mkdirSync(componentRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(configPath, "{}", "utf8");

  assert.equal(
    resolveProviderRuntimeDirectory({ config: configPath }, componentRoot),
    workspace,
  );
  assert.equal(
    resolveProviderRuntimeDirectory(
      { config: configPath, runtime_dir: explicitRuntime },
      componentRoot,
    ),
    explicitRuntime,
  );
  assert.equal(
    resolveProviderRuntimeDirectory({}, componentRoot),
    path.join(componentRoot, "runtime_state", "lichess"),
  );
  assert.throws(
    () => resolveProviderRuntimeDirectory({ runtime_dir: " " }, componentRoot),
    /--runtime-dir must be a non-empty path/,
  );

  const messages = [];
  const originalLog = console.log;
  console.log = (message) => messages.push(message);
  try {
    assert.equal(await main(["owner", "list", "--config", configPath]), 0);
  } finally {
    console.log = originalLog;
  }
  assert.equal(JSON.parse(messages.at(-1)).status, "ready");
  assert.equal(existsSync(path.join(workspace, "matches.sqlite")), true);
  assert.equal(existsSync(path.join(componentRoot, "runtime_state")), false);

  messages.length = 0;
  console.log = (message) => messages.push(message);
  try {
    assert.equal(await main([
      "owner",
      "list",
      "--config",
      configPath,
      "--runtime-dir",
      explicitRuntime,
    ]), 0);
  } finally {
    console.log = originalLog;
  }
  assert.equal(JSON.parse(messages.at(-1)).status, "ready");
  assert.equal(existsSync(path.join(explicitRuntime, "matches.sqlite")), true);
});

function installQualifiedBookFixture(engineConfig) {
  const directory = path.join(engineConfig.working_directory, "book-fixture");
  mkdirSync(directory, { recursive: true });
  const bookFile = path.join(directory, "strong_rare_v1.bin");
  const statsFile = path.join(directory, "strong_rare_v1.stats");
  const policyFile = path.join(directory, "strong_rare_v1.policy");
  writeFileSync(bookFile, Buffer.alloc(1259 * 16));
  writeFileSync(
    statsFile,
    "# uci_arena_book_stats_v1 book_fnv1a64=00000000075bcd15 rows=1259\n",
  );
  writeFileSync(policyFile, "fixture=true\n");
  Object.assign(engineConfig.uci_options, {
    OwnBook: true,
    BookFile: bookFile,
    BookStatsFile: statsFile,
    BookPolicyFile: policyFile,
  });
  return {
    opening_book_file: bookFile,
    opening_book_stats_file: statsFile,
    opening_book_policy_file: policyFile,
  };
}

function installManifestBookFixture(engineConfig) {
  const bookStatus = installQualifiedBookFixture(engineConfig);
  const manifestPath = path.join(path.dirname(bookStatus.opening_book_file), "snapshot.manifest.json");
  const artifacts = Object.fromEntries([
    ["strong_rare_v1.bin", bookStatus.opening_book_file],
    ["strong_rare_v1.stats", bookStatus.opening_book_stats_file],
    ["strong_rare_v1.policy", bookStatus.opening_book_policy_file],
  ].map(([name, filePath]) => [name, sha256(readFileSync(filePath)).slice("sha256:".length)]));
  const manifest = {
    schema: "uci_arena_book_snapshot_v2",
    snapshot_id: "integration-0123456789abcdefabcd",
    record_count: 1259,
    artifacts,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const manifestSha256 = sha256(readFileSync(manifestPath)).slice("sha256:".length);
  return {
    ...bookStatus,
    opening_book_snapshot_identity: `sha256:${manifestSha256}`,
    opening_book_snapshot_generation: manifest.snapshot_id,
    opening_book_manifest_sha256: manifestSha256,
    opening_book_policy_sha256: artifacts["strong_rare_v1.policy"],
    opening_book_validation: "manifest_verified",
  };
}

function installBaseBookFixture(engineConfig) {
  const directory = path.join(engineConfig.working_directory, "base-book-fixture");
  mkdirSync(directory, { recursive: true });
  const bookFile = path.join(directory, "external.bin");
  writeFileSync(bookFile, Buffer.alloc(32));
  Object.assign(engineConfig.uci_options, {
    OwnBook: true,
    BookFile: bookFile,
    BookStatsFile: "",
    BookPolicyFile: "",
  });
  return {
    opening_book_file: bookFile,
    opening_book_stats_file: "",
    opening_book_policy_file: "",
    opening_book_statistics_available: false,
    opening_book_entries: 2,
    opening_book_identity: "123456789",
    opening_book_message: "active_polyglot",
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
    reconcileGameLine() {},
    finishGame() {},
  };
}

function createGameSession(engine, client, config = gameConfig(), overrides = {}) {
  let sessions = [];
  const foregroundCoordinator = new ForegroundSearchCoordinator({
    sessions: () => sessions,
  });
  const session = new GameSession({
    client,
    config,
    account: "arena-bot",
    gameId: "game-1",
    signal: overrides.signal ?? { aborted: false },
    slot: { id: "human-1", audience: "human", engine },
    store: overrides.store ?? mockStore(),
    foregroundCoordinator,
    scheduleTimeout: overrides.scheduleTimeout,
    cancelTimeout: overrides.cancelTimeout,
  });
  sessions = [session];
  return session;
}

test("game sessions publish one canonical replay port with only the exact actor clock", async () => {
  const begins = [];
  const lines = [];
  const finishes = [];
  const store = {
    beginGame: (game) => begins.push(game),
    reconcileGameLine: (line) => lines.push(line),
    finishGame: (game) => finishes.push(game),
  };
  const engine = new MockGameEngine();
  const session = createGameSession(engine, { post: async () => {} }, gameConfig(), { store });
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(startedState("e2e4", {
    status: "resign",
    winner: "black",
    wtime: 179_123,
    btime: 180_000,
  }), engine);

  assert.equal(begins.length, 1);
  assert.equal(begins[0].initialFen,
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.equal(begins[0].providerComponent.componentId, "lichess.adapter");
  assert.equal(begins[0].engineComponent, null);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].plies.map((ply) => ({
    move: ply.uciMove,
    actor: ply.actorColor,
    clock: ply.clockMs,
  })), [{ move: "e2e4", actor: "white", clock: 179_123 }]);
  assert.deepEqual(finishes, [{
    id: "game-1",
    status: "resign",
    result: "loss",
    winner: "black",
    plies: 1,
  }]);
});

test("runtime config is credential-free and resolves repository paths", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-config-"));
  const isolatedTemplate = path.join(directory, "config.json");
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.timing.transport_profile_path = null;
  writeFileSync(isolatedTemplate, JSON.stringify(template), "utf8");
  const config = loadRuntimeConfig({
    templatePath: isolatedTemplate,
    engineRoot: ROOT,
    modelRoot: "engine/runtime/models/example/engine",
  });
  const serialized = JSON.stringify(config).toLowerCase();
  assert.equal(serialized.includes("test-token"), false);
  assert.equal(serialized.includes("oauth_token"), false);
  assert.equal(config.schema, "uci_arena_lichess_adapter_v8");
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

test("component identity is explicit, inventory-bound, and null for external UCI engines", () => {
  assert.equal(engineComponentIdentity({ engine: { executable: process.execPath } }), null);
  const provider = providerComponentIdentity();
  assert.deepEqual(provider, {
    componentId: "lichess.adapter",
    version: "1.0.30",
    manifestSha256: sha256(readFileSync(path.join(ROOT, "contracts", "component-manifest.json"))),
  });

  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-engine-component-"));
  const executable = path.join(directory, "bin", "engine.exe");
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, "exact-engine-binary", "utf8");
  const manifestPath = path.join(directory, "arena-component.json");
  writeFileSync(manifestPath, JSON.stringify({
    schema: "arena_install_component_v1",
    schema_version: 1,
    component_id: "uci_arena.engine",
    component_version: "0.9.0",
    files: [{
      path: "bin/engine.exe",
      sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      size_bytes: readFileSync(executable).byteLength,
    }],
  }), "utf8");
  assert.deepEqual(engineComponentIdentity({
    engine: { executable, component_manifest: manifestPath },
  }), {
    componentId: "uci_arena.engine",
    version: "0.9.0",
    manifestSha256: sha256(readFileSync(manifestPath)),
  });
  writeFileSync(executable, "tampered-engine-binary", "utf8");
  assert.throws(
    () => engineComponentIdentity({ engine: { executable, component_manifest: manifestPath } }),
    /does not match its manifest inventory/,
  );
});

test("configuration recursively rejects hidden credential fields and bearer values", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-credential-config-"));
  const configPath = path.join(directory, "config.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  raw.unrelated = { nested: { token: "not-allowed" } };
  writeFileSync(configPath, JSON.stringify(raw), "utf8");
  assert.throws(
    () => loadManagerConfig({ templatePath: configPath }),
    /credential field/,
  );
  delete raw.unrelated;
  raw.label = "Bearer not-allowed";
  writeFileSync(configPath, JSON.stringify(raw), "utf8");
  assert.throws(
    () => loadManagerConfig({ templatePath: configPath }),
    /bearer credential/,
  );
});

test("explicit engine path options can complete an otherwise unbound standard UCI config", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-engine-override-"));
  const configPath = path.join(directory, "config.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  raw.engine = {
    adapter: "standard_uci_v1",
    executable: "",
    working_directory: "",
    arguments: [],
    uci_options: {},
  };
  raw.capacity = {
    total_slots: 1,
    capacity_profile: null,
    startup_parallelism: 1,
    human: { slots: 1, allow_borrowing: false, accept_public: true },
    bot: { slots: 0, target_active: 0 },
  };
  raw.scheduler.enabled = false;
  writeFileSync(configPath, JSON.stringify(raw), "utf8");
  const config = loadRuntimeConfig({
    templatePath: configPath,
    enginePath: process.execPath,
    workingDirectory: directory,
  });
  assert.equal(config.engine.executable, path.resolve(process.execPath));
  assert.equal(config.engine.working_directory, path.resolve(directory));
});

test("standard UCI adapter qualifies a conforming engine without UCI Arena extensions", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-standard-uci-"));
  const fixtureEngine = path.join(directory, "fixture-uci.mjs");
  writeFileSync(fixtureEngine, `
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line === "uci") {
    console.log("id name Contract Fixture");
    console.log("id author UCI Arena Tests");
    console.log("option name Ponder type check default false");
    console.log("uciok");
  } else if (line === "isready") console.log("readyok");
  else if (line.startsWith("go ")) console.log("bestmove e2e4 ponder e7e5");
  else if (line === "stop") console.log("bestmove 0000");
  else if (line === "quit") process.exit(0);
}
`, "utf8");
  const configPath = path.join(directory, "config.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  raw.engine = {
    adapter: "standard_uci_v1",
    executable: process.execPath,
    arguments: [fixtureEngine],
    working_directory: directory,
    search_timeout_grace_ms: 1_000,
    shutdown_grace_ms: 1_000,
    uci_options: {},
  };
  raw.capacity = {
    total_slots: 1,
    capacity_profile: null,
    startup_parallelism: 1,
    human: { slots: 1, allow_borrowing: false, accept_public: true },
    bot: { slots: 0, target_active: 0 },
  };
  raw.scheduler.enabled = false;
  writeFileSync(configPath, JSON.stringify(raw), "utf8");

  const config = loadRuntimeConfig({ templatePath: configPath });
  assert.equal(config.engine.single_game_profile, undefined);
  const engine = new UciEngine(config.engine);
  try {
    await engine.start();
    assert.equal(engine.qualificationStatus.qualified, true);
    assert.equal(engine.qualificationStatus.engine_adapter, "standard_uci_v1");
    assert.match(engine.qualificationStatus.uci_identity_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.match(engine.qualificationStatus.engine_launch_identity_sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(engine.timeProfileStatus.applied, false);
    assert.equal(config.timing.opponent_turn_search, true);
    assert.equal(engine.timing.opponent_turn_search, true);
    assert.equal(loadCapacityProfile(
      null,
      config,
      null,
      engine.qualificationStatus,
    ).maximum_concurrency, 1);
    const provenance = gameRuntimeProvenance(config, engine).provenance;
    assert.equal(provenance.engine.adapter, "standard_uci_v1");
    assert.equal(provenance.model.id, "");
    assert.equal(provenance.search.core, "engine_owned");
    assert.equal(Object.hasOwn(provenance.search.applied_uci_options, "OnnxProvider"), false);
  } finally {
    await engine.close();
  }
});

test("UCI process adapter rejects command injection and protocol overflow", () => {
  const writes = [];
  let killed = false;
  const engine = new UciEngine({ timing: {}, uci_options: {} });
  engine.child = {
    stdin: { writable: true, write: (value) => writes.push(value) },
    kill: () => { killed = true; },
  };
  assert.throws(() => engine.setOption("Hash", "16\nisready"), /single-line UCI value/);
  assert.deepEqual(writes, []);
  engine.onLine(`info string ${"x".repeat(64 * 1024)}`);
  assert.equal(killed, true);
});

test("runtime token input is one bounded non-whitespace file value", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-token-shape-"));
  const tokenFile = path.join(directory, "token");
  writeFileSync(tokenFile, "two tokens\n", "utf8");
  await assert.rejects(
    probeAccount({ tokenFile, fetchImpl: async () => { throw new Error("unreachable"); } }),
    /exactly one non-whitespace token/,
  );
  writeFileSync(tokenFile, "x".repeat(4 * 1024 + 1), "utf8");
  await assert.rejects(
    probeAccount({ tokenFile, fetchImpl: async () => { throw new Error("unreachable"); } }),
    /no larger than 4096 bytes/,
  );
});

test("standard UCI games submit independently legal moves without extended telemetry", async () => {
  const posts = [];
  const client = { post: async (endpoint) => posts.push(endpoint) };
  const engine = new MockGameEngine([{ bestmove: "e2e4" }]);
  engine.qualificationStatus = {
    engine_adapter: "standard_uci_v1",
    engine_build_fingerprint: `sha256:${"a".repeat(64)}`,
    engine_launch_identity_sha256: `sha256:${"b".repeat(64)}`,
    uci_identity_sha256: `sha256:${"c".repeat(64)}`,
    uci_id_lines: ["id name Generic Fixture"],
  };
  engine.appliedUciOptions = {};
  const config = gameConfig();
  config.engine.adapter = "standard_uci_v1";
  delete config.engine.qualification_profile;
  config.timing.opponent_turn_search = false;
  const session = createGameSession(engine, client, config);
  const initial = startedState("");
  await session.initialize(gameFull(initial), engine);
  await session.onState(initial, engine);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /\/move\/e2e4$/);
});

test("Manager options projection is bounded and configuration updates are atomic", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-manager-options-"));
  const configPath = path.join(directory, "config.json");
  const original = readFileSync(DEFAULT_TEMPLATE, "utf8");
  writeFileSync(configPath, original, "utf8");

  const before = loadRuntimeConfig({ templatePath: configPath, engineRoot: ROOT });
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
    engineRoot: ROOT,
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
  assert.equal(persisted.engine.executable.includes("<UCI_ARENA_ENGINE_ROOT>"), true);
  assert.equal(persisted.challenges.accept_bots, false);

  const stable = readFileSync(configPath, "utf8");
  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      engineRoot: ROOT,
      settings: { engine: { executable: "untrusted.exe" } },
    }),
    /settings\.engine is not editable/,
  );
  assert.equal(readFileSync(configPath, "utf8"), stable);
});

test("Manager options remain usable while live-engine onboarding is incomplete", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-manager-incomplete-"));
  const configPath = path.join(directory, "config.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  delete raw.engine.single_game_profile;
  delete raw.engine.time_profile;
  writeFileSync(configPath, JSON.stringify(raw), "utf8");

  assert.throws(
    () => loadRuntimeConfig({ templatePath: configPath, engineRoot: ROOT }),
    /missing engine\.single_game_profile/,
  );
  const config = loadManagerConfig({ templatePath: configPath, engineRoot: ROOT });
  assert.equal(managerOptionsProjection(config).capacity.evidence.qualified, false);

  const updated = updateManagerOptions({
    templatePath: configPath,
    engineRoot: ROOT,
    settings: { scheduler: { discovery_interval_seconds: 75 } },
  });
  assert.equal(updated.scheduler.discovery_interval_seconds, 75);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).engine.single_game_profile, undefined);

  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      engineRoot: ROOT,
      settings: {
        capacity: { total_slots: 3, startup_parallelism: 3, bot: { slots: 2 } },
      },
    }),
    /present qualified capacity profile/,
  );

  const messages = [];
  const originalLog = console.log;
  console.log = (message) => messages.push(message);
  try {
    assert.equal(await main(["config", "get", "--config", configPath]), 0);
  } finally {
    console.log = originalLog;
  }
  const response = JSON.parse(messages.at(-1));
  assert.equal(response.schema, MANAGER_OPTIONS_SCHEMA);
  assert.deepEqual(Object.keys(response), [
    "schema",
    "capacity",
    "inbound_challenges",
    "outbound_challenge",
    "scheduler",
    "opponent_selection",
  ]);
  assert.equal(response.scheduler.discovery_interval_seconds, 75);

  messages.length = 0;
  console.log = (message) => messages.push(message);
  try {
    assert.equal(await main([
      "config",
      "update",
      "--config",
      configPath,
      "--settings",
      JSON.stringify({ scheduler: { discovery_interval_seconds: 80 } }),
    ]), 0);
  } finally {
    console.log = originalLog;
  }
  const updateResponse = JSON.parse(messages.at(-1));
  assert.equal(updateResponse.schema, MANAGER_OPTIONS_SCHEMA);
  assert.equal(updateResponse.scheduler.discovery_interval_seconds, 80);
  assert.equal(Object.hasOwn(updateResponse, "editable"), false);
});

test("Manager capacity projection publishes the standard-UCI startup evidence state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-manager-standard-uci-"));
  const configPath = path.join(directory, "config.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  raw.engine.adapter = "standard_uci_v1";
  raw.engine.executable = process.execPath;
  raw.engine.working_directory = directory;
  raw.engine.uci_options = {};
  raw.capacity = {
    total_slots: 1,
    capacity_profile: null,
    startup_parallelism: 1,
    human: { slots: 1, allow_borrowing: false, accept_public: true },
    bot: { slots: 0, target_active: 0 },
  };
  writeFileSync(configPath, JSON.stringify(raw), "utf8");

  const projected = managerOptionsProjection(loadManagerConfig({
    templatePath: configPath,
    engineRoot: ROOT,
  }));
  assert.deepEqual(projected.capacity.evidence, {
    status: "standard_uci_startup_probe_required",
    qualified: true,
    maximum_concurrency: 1,
  });
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
      engineRoot: ROOT,
      settings: { outbound_challenge: { rated: true } },
    }),
    new RegExp(RATED_PLAY_CONFIRMATION),
  );
  updateManagerOptions({
    templatePath: configPath,
    engineRoot: ROOT,
    ratedConfirmation: RATED_PLAY_CONFIRMATION,
    settings: { outbound_challenge: { rated: true } },
  });

  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      engineRoot: ROOT,
      settings: { inbound_challenges: { modes: ["casual", "rated"] } },
    }),
    new RegExp(RATED_PLAY_CONFIRMATION),
  );
  updateManagerOptions({
    templatePath: configPath,
    engineRoot: ROOT,
    ratedConfirmation: RATED_PLAY_CONFIRMATION,
    settings: { inbound_challenges: { modes: ["casual", "rated"] } },
  });

  assert.throws(
    () => updateManagerOptions({
      templatePath: configPath,
      engineRoot: ROOT,
      settings: { scheduler: { enabled: true } },
    }),
    new RegExp(OUTBOUND_CHALLENGE_CONFIRMATION),
  );
  const updated = updateManagerOptions({
    templatePath: configPath,
    engineRoot: ROOT,
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
      engineRoot: ROOT,
      settings: {
        capacity: { total_slots: 3, human: { slots: 1 }, bot: { slots: 2 } },
      },
    }),
    /present qualified capacity profile/,
  );
  assert.equal(readFileSync(configPath, "utf8"), stable);

  const projection = managerOptionsProjection(
    loadRuntimeConfig({ templatePath: configPath, engineRoot: ROOT }),
  );
  assert.equal(projection.capacity.evidence.status, "rejected");
  assert.equal(projection.capacity.evidence.qualified, false);
});

test("runtime config accepts the shared active model environment override", () => {
  const selected = "models/latticeknight";
  const config = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    engineRoot: ROOT,
    environment: { UCI_ARENA_MODEL_ROOT: selected },
  });
  assert.equal(config.engine.uci_options.ModelRoot, selected);

  const explicit = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    engineRoot: ROOT,
    modelRoot: "engine/runtime/models/explicit/engine",
    environment: { UCI_ARENA_MODEL_ROOT: selected },
  });
  assert.equal(explicit.engine.uci_options.ModelRoot, "engine/runtime/models/explicit/engine");
});

test("runtime config protects installer-composed absolute paths from ambient overrides", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-composed-paths-"));
  const configPath = path.join(directory, "config.json");
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  const configured = {
    model: path.join(directory, "installed", "model"),
    single: path.join(directory, "installed", "single.json"),
    timing: path.join(directory, "installed", "timing.json"),
    temporal: path.join(directory, "installed", "temporal.json"),
  };
  raw.engine.uci_options.ModelRoot = configured.model;
  raw.engine.single_game_profile = configured.single;
  raw.engine.time_profile = configured.timing;
  raw.engine.temporal_curve_profile = configured.temporal;
  writeFileSync(configPath, JSON.stringify(raw), "utf8");
  try {
    const config = loadRuntimeConfig({
      templatePath: configPath,
      engineRoot: ROOT,
      environment: {
        UCI_ARENA_MODEL_ROOT: "ambient/model",
        UCI_ARENA_SINGLE_GAME_PROFILE: "ambient/single.json",
        UCI_ARENA_TIME_PROFILE: "ambient/timing.json",
        UCI_ARENA_TEMPORAL_CURVE_PROFILE: "ambient/temporal.json",
      },
    });
    assert.equal(config.engine.uci_options.ModelRoot, configured.model);
    assert.equal(config.engine.single_game_profile, configured.single);
    assert.equal(config.engine.time_profile, configured.timing);
    assert.equal(config.engine.temporal_curve_profile, configured.temporal);

    const explicit = path.join(directory, "explicit", "model");
    const cli = loadRuntimeConfig({
      templatePath: configPath,
      engineRoot: ROOT,
      modelRoot: explicit,
      environment: { UCI_ARENA_MODEL_ROOT: "ambient/model" },
    });
    assert.equal(cli.engine.uci_options.ModelRoot, explicit);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime config accepts exact installed engine and working-directory overrides", () => {
    const engine = path.resolve("installed/bin/uci_arena_engine.exe");
  const workingDirectory = path.resolve("installed");
  const config = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    engineRoot: ROOT,
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
    engineRoot: ROOT,
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
  assert.equal(config.schema, "uci_arena_lichess_adapter_v8");
  assert.equal(config.scheduler.challenge_interval_seconds, 300);
  assert.equal(config.timing.opponent_turn_search, true);
  assert.equal(config.timing.initial_transport_reserve_ms, 250);
});

test("v7 config migrates unsafe challenge pacing to the v8 safety floor", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-v7-config-"));
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.schema = "uci_arena_lichess_adapter_v7";
  template.scheduler.challenge_interval_seconds = 5;
  const configPath = path.join(directory, "v7.json");
  writeFileSync(configPath, JSON.stringify(template));

  const config = loadManagerConfig({ templatePath: configPath });
  assert.equal(config.schema, "uci_arena_lichess_adapter_v8");
  assert.equal(config.scheduler.challenge_interval_seconds, 300);
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
  fixture.config.engine.uci_options.SyzygyPath = `${tablebasePath}${path.sep}.${path.sep}`;
  fixture.config.engine.uci_options.SyzygyManifest =
    `${tablebasePath}${path.sep}.${path.sep}${path.basename(manifestPath)}`;

  const validationProgress = [];
  applySingleGameProfile(fixture.config, {
    onValidationProgress: (progress) => validationProgress.push(progress),
  });
  assert.deepEqual(validationProgress, [
    {
      phase: "tablebase_asset_validation",
      completed: 0,
      total: 2,
      current_bytes_read: 3,
      current_bytes_total: 3,
    },
    {
      phase: "tablebase_asset_validation",
      completed: 1,
      total: 2,
      current_bytes_read: null,
      current_bytes_total: null,
    },
    {
      phase: "tablebase_asset_validation",
      completed: 1,
      total: 2,
      current_bytes_read: 3,
      current_bytes_total: 3,
    },
    {
      phase: "tablebase_asset_validation",
      completed: 2,
      total: 2,
      current_bytes_read: null,
      current_bytes_total: null,
    },
  ]);
  assert.equal(fixture.config.engine.uci_options.SyzygyPath, tablebasePath);
  assert.equal(fixture.config.engine.uci_options.SyzygyManifest, manifestPath);
  assert.equal(fixture.config.engine.uci_options.SyzygyProbeThreads, 4);
  assert.equal(fixture.config.engine.uci_options.SyzygyInternalProbe, true);
  assert.throws(
    () => applySingleGameProfile(fixture.config, {
      onValidationProgress: () => { throw new Error("lifecycle failure"); },
    }),
    (error) => error?.code === "EXACT_FILE_PROGRESS_FAILED",
  );

  fixture.config.engine.uci_options.SyzygyPath = path.dirname(tablebasePath);
  assert.throws(
    () => applySingleGameProfile(fixture.config),
    /Tracked config conflicts with profile-owned UCI option SyzygyPath/,
  );
  fixture.config.engine.uci_options.SyzygyPath = tablebasePath;

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
    () => loadRuntimeConfig({ templatePath, engineRoot: ROOT }),
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
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installQualifiedBookFixture(engineConfig);
  const engine = new UciEngine(engineConfig);
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
  engine.runtimeStatus = async () => ({ ...qualifiedRuntimeStatus(profile), ...bookStatus });

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
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installQualifiedBookFixture(engineConfig);
  const engine = new UciEngine(engineConfig);
  engine.advertisedOptions.add("OwnBook");
  engine.send = () => {};
  engine.newGame = async () => {};
  engine.exchange = async (command) => command.startsWith("go depth ") ? "bestmove e2e4" : "readyok";
  let statusCalls = 0;
  engine.runtimeStatus = async () => {
    statusCalls += 1;
    return statusCalls === 1
      ? qualifiedRuntimeStatus(profile)
      : {
        ...qualifiedRuntimeStatus(profile),
        ...bookStatus,
        opening_book_active: false,
        opening_book_message: "missing",
      };
  };

  await assert.rejects(() => engine.qualifyRuntime(), /Opening book failed to activate: missing/);
});

test("runtime qualification accepts the Engine-owned base Polyglot capability", async () => {
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installBaseBookFixture(engineConfig);
  const engine = new UciEngine(engineConfig);
  engine.advertisedOptions.add("OwnBook");
  engine.send = () => {};
  engine.newGame = async () => {};
  engine.exchange = async (command) => command.startsWith("go depth ") ? "bestmove e2e4" : "readyok";
  engine.runtimeStatus = async () => ({ ...qualifiedRuntimeStatus(profile), ...bookStatus });

  await engine.qualifyRuntime();
  assert.equal(engine.qualificationStatus.live_runtime_status.opening_book_active, true);
  assert.equal(
    engine.qualificationStatus.live_runtime_status.opening_book_statistics_available,
    false,
  );
});

test("runtime qualification rejects a loaded opening book with the wrong content identity", async () => {
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installQualifiedBookFixture(engineConfig);
  const engine = new UciEngine(engineConfig);
  engine.advertisedOptions.add("OwnBook");
  engine.send = () => {};
  engine.newGame = async () => {};
  engine.exchange = async (command) => command.startsWith("go depth ") ? "bestmove e2e4" : "readyok";
  engine.runtimeStatus = async () => ({
    ...qualifiedRuntimeStatus(profile),
    ...bookStatus,
    opening_book_identity: "987654321",
  });

  await assert.rejects(
    () => engine.qualifyRuntime(),
    /Opening book content identity mismatch/,
  );
});

test("runtime qualification independently binds an activated Book Forge manifest", async () => {
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installManifestBookFixture(engineConfig);
  const engine = new UciEngine(engineConfig);
  engine.advertisedOptions.add("OwnBook");
  engine.send = () => {};
  engine.newGame = async () => {};
  engine.exchange = async (command) => command.startsWith("go depth ") ? "bestmove e2e4" : "readyok";
  engine.runtimeStatus = async () => ({ ...qualifiedRuntimeStatus(profile), ...bookStatus });

  await engine.qualifyRuntime();
  assert.equal(
    engine.qualificationStatus.live_runtime_status.opening_book_snapshot_generation,
    "integration-0123456789abcdefabcd",
  );
  assert.equal(
    engine.qualificationStatus.live_runtime_status.opening_book_validation,
    "manifest_verified",
  );
});

test("runtime qualification rejects a stale activated Book Forge generation", async () => {
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installManifestBookFixture(engineConfig);
  const engine = new UciEngine(engineConfig);
  engine.advertisedOptions.add("OwnBook");
  engine.send = () => {};
  engine.newGame = async () => {};
  engine.exchange = async (command) => command.startsWith("go depth ") ? "bestmove e2e4" : "readyok";
  engine.runtimeStatus = async () => ({
    ...qualifiedRuntimeStatus(profile),
    ...bookStatus,
    opening_book_snapshot_generation: "integration-ffffffffffffffffffff",
  });

  await assert.rejects(
    () => engine.qualifyRuntime(),
    /activated snapshot mismatch for opening_book_snapshot_generation/,
  );
});

test("ucinewgame refreshes and revalidates the active Book Forge generation", async () => {
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installManifestBookFixture(engineConfig);
  const engine = new UciEngine(engineConfig);
  engine.qualificationStatus = {
    live_runtime_status: {
      ...qualifiedRuntimeStatus(profile),
      ...bookStatus,
      opening_book_snapshot_generation: "integration-ffffffffffffffffffff",
      opening_book_adapter_validation: "file_set_revalidated",
    },
  };
  engine.stopAndDrain = async () => {};
  engine.send = () => {};
  engine.exchange = async () => "readyok";
  engine.runtimeStatus = async () => ({ ...qualifiedRuntimeStatus(profile), ...bookStatus });

  await engine.newGame();
  assert.equal(
    engine.qualificationStatus.live_runtime_status.opening_book_snapshot_generation,
    "integration-0123456789abcdefabcd",
  );
  assert.equal(engine.runtimeGeneration, 1);
});

test("ucinewgame retains a previously validated generation after an invalid replacement", async () => {
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installManifestBookFixture(engineConfig);
  const previouslyValidated = {
    ...qualifiedRuntimeStatus(profile),
    ...bookStatus,
    opening_book_adapter_validation: "file_set_revalidated",
  };
  writeFileSync(bookStatus.opening_book_policy_file, "invalid-replacement=true\n");
  const engine = new UciEngine(engineConfig);
  engine.qualificationStatus = { live_runtime_status: previouslyValidated };
  engine.stopAndDrain = async () => {};
  engine.send = () => {};
  engine.exchange = async () => "readyok";
  engine.runtimeStatus = async () => ({ ...previouslyValidated });

  await engine.newGame();
  assert.equal(
    engine.qualificationStatus.live_runtime_status.opening_book_snapshot_generation,
    "integration-0123456789abcdefabcd",
  );
  assert.equal(
    engine.qualificationStatus.live_runtime_status.opening_book_adapter_validation,
    "retained_prior_valid_snapshot",
  );
});

test("runtime qualification rejects Book Forge artifact tampering", async () => {
  const { config, profile } = qualifiedFixture();
  const engineConfig = { ...config.engine, qualification_profile: profile };
  const bookStatus = installManifestBookFixture(engineConfig);
  writeFileSync(bookStatus.opening_book_policy_file, "tampered=true\n");
  const engine = new UciEngine(engineConfig);
  engine.advertisedOptions.add("OwnBook");
  engine.send = () => {};
  engine.newGame = async () => {};
  engine.exchange = async (command) => command.startsWith("go depth ") ? "bestmove e2e4" : "readyok";
  engine.runtimeStatus = async () => ({ ...qualifiedRuntimeStatus(profile), ...bookStatus });

  await assert.rejects(
    () => engine.qualifyRuntime(),
    /snapshot artifact digest mismatch: strong_rare_v1.policy/,
  );
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
        opening_book_snapshot_identity: `sha256:${"c".repeat(64)}`,
        opening_book_snapshot_generation: "integration-0123456789abcdefabcd",
        opening_book_manifest_sha256: "c".repeat(64),
        opening_book_policy_sha256: "d".repeat(64),
        opening_book_validation: "manifest_verified",
        opening_book_adapter_validation: "file_set_revalidated",
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
      timing_authority_match: true,
      engine_provenance: {
        exact: false,
        executable_match: false,
        qualified_executable_sha256: `sha256:${"a".repeat(64)}`,
        current_executable_sha256: `sha256:${"b".repeat(64)}`,
      },
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
  assert.equal(first.provenance.timing.timing_authority_match, true);
  assert.equal(first.provenance.timing.engine_provenance.exact, false);
  assert.equal(first.provenance.timing.engine_provenance.executable_match, false);
  assert.equal(first.provenance.book.observed_active, true);
  assert.equal(first.provenance.book.observed_entries, 1259);
  assert.equal(first.provenance.book.observed_identity, "123456789");
  assert.equal(
    first.provenance.book.observed_snapshot_generation,
    "integration-0123456789abcdefabcd",
  );
  assert.equal(first.provenance.book.observed_manifest_sha256, "c".repeat(64));
  assert.equal(first.provenance.book.observed_validation, "manifest_verified");
  assert.equal(first.provenance.book.observed_adapter_validation, "file_set_revalidated");
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
      BookStatsFile: "E:/books/strong_rare_v1.stats",
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
  engine.onLine("info string book_decision_v1 book_probe_result hit book_probe_hit 1 book_move_used 0 book_exit 1 book_phase_latched 1 book_completion_kind search_handoff book_miss_reason none book_lookup_us 9 book_evaluation_source completed_evaluation book_evaluation_cp -23 book_evaluation_us 4 book_decision_us 11 book_emit_us 0 book_candidate_count 4 book_candidate_games 81 book_selected_lcb 0.42 book_best_lcb 0.57 book_exit_probability 0.73 book_snapshot_identity sha256:12345 book_snapshot_generation integration-0123456789abcdefabcd book_snapshot_manifest_sha256 abc123 book_snapshot_validation manifest_verified book_record_count 363 book_evaluation_model_fingerprint 18446744073709551615");
  engine.onLine("info depth 0 nodes 0 model_provider directml model_fingerprint 9876 model_id model_v1 string opening_book");
  assert.equal(engine.latestInfo.book_probe_result, "hit");
  assert.equal(engine.latestInfo.book_probe_hit, 1);
  assert.equal(engine.latestInfo.book_move_used, 0);
  assert.equal(engine.latestInfo.book_exit, 1);
  assert.equal(engine.latestInfo.book_completion_kind, "search_handoff");
  assert.equal(engine.latestInfo.book_miss_reason, "none");
  assert.equal(engine.latestInfo.book_lookup_us, 9);
  assert.equal(engine.latestInfo.book_evaluation_cp, -23);
  assert.equal(engine.latestInfo.book_decision_us, 11);
  assert.equal(engine.latestInfo.book_candidate_count, 4);
  assert.equal(engine.latestInfo.book_selected_lcb, 0.42);
  assert.equal(engine.latestInfo.book_exit_probability, 0.73);
  assert.equal(engine.latestInfo.book_snapshot_identity, "sha256:12345");
  assert.equal(
    engine.latestInfo.book_evaluation_model_fingerprint,
    "18446744073709551615",
  );
  assert.equal(engine.latestInfo.book_record_count, 363);
  assert.equal(bookMoveWasUsed(engine.latestInfo), false);
  assert.equal(bookMoveWasUsed({ book_probe_hit: 1, book_move_used: 1 }), true);
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

test("transport profile publishes only after ten games and two hundred successful moves", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-transport-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "transport.json");
  let clock = Date.parse("2026-07-20T00:00:00Z");
  const tracker = new TransportProfileTracker({
    profilePath,
    bootstrapReserveMs: 650,
    now: () => clock,
  });
  for (let game = 0; game < 10; game += 1) {
    for (let move = 0; move < 20; move += 1) {
      const dispatchMs = 350 + ((game * 20 + move) % 100);
      tracker.record(`game-${game}`, {
        bestmove_to_ack_ms: dispatchMs + 150,
        bestmove_to_legality_ms: 25,
        move_queue_wait_ms: 125,
        post_dispatch_to_ack_ms: dispatchMs,
      });
    }
    tracker.finishGame(`game-${game}`);
    clock += 1_000;
  }
  const loaded = loadTransportProfile(profilePath, clock);
  assert.equal(loaded.qualified, true);
  assert.equal(loaded.reserveMs, 650);
  assert.equal(loaded.profile.sample_count, 200);
  assert.equal(loaded.profile.game_count, 10);
  assert.equal(loaded.coverage, "bestmove_to_ack");
  assert.equal(loaded.profile.samples[0].bestmove_to_legality_ms, 25);
  const later = loadTransportProfile(profilePath, clock + 8 * 24 * 60 * 60 * 1_000);
  assert.equal(later.status, "accepted");
  assert.ok(later.ageMs > 7 * 24 * 60 * 60 * 1_000);
});

test("incomplete games cannot enter transport evidence or touch timing authority", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-transport-pending-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "transport.json");
  const timingPath = path.join(directory, "uci_time_profile_v3.json");
  const timingAuthority = `${JSON.stringify({
    schema: "uci_time_profile_v3",
    identity_sha256: `sha256:${"a".repeat(64)}`,
  }, null, 2)}\n`;
  writeFileSync(timingPath, timingAuthority);
  const tracker = new TransportProfileTracker({ profilePath, bootstrapReserveMs: 650 });

  tracker.record("completed-1", { bestmove_to_ack_ms: 500 });
  tracker.finishGame("completed-1");
  const firstPublication = readFileSync(profilePath, "utf8");

  for (let index = 0; index < 200; index += 1) {
    tracker.record("failed", { bestmove_to_ack_ms: 1_500 });
  }
  assert.equal(tracker.samples.length, 1);
  tracker.abandonGame("failed");
  assert.equal(readFileSync(profilePath, "utf8"), firstPublication);

  tracker.record("incomplete", { bestmove_to_ack_ms: 1_500 });
  tracker.record("completed-2", { bestmove_to_ack_ms: 600 });
  tracker.finishGame("completed-2");
  const published = JSON.parse(readFileSync(profilePath, "utf8"));
  assert.equal(published.qualified, false);
  assert.equal(published.sample_count, 2);
  assert.equal(published.game_count, 2);
  assert.deepEqual(
    published.samples.map((sample) => sample.game_id),
    ["completed-1", "completed-2"],
  );
  assert.equal(tracker.effectiveReserveMs, 650);
  assert.equal(readFileSync(timingPath, "utf8"), timingAuthority);
});

test("active game stream retries beyond the former failure threshold", async () => {
  const stop = new AbortController();
  let attempts = 0;
  const client = {
    stream: async function* stream() {
      attempts += 1;
      if (attempts === 7) {
        stop.abort();
        return;
      }
      throw new Error(`stream failure ${attempts}`);
    },
  };
  const session = new GameSession({
    client,
    config: gameConfig(),
    account: "arena-bot",
    gameId: "active-game",
    signal: stop.signal,
    slot: { engine: { mode: "idle" } },
    store: mockStore(),
    waitForReconnect: async () => {},
  });

  await session.run();
  assert.equal(attempts, 7);
  assert.notEqual(session.finished, true);
});

test("replayed gameFull does not reset transport backoff and HTTP 429 keeps its full cooldown", async () => {
  const stop = new AbortController();
  const waits = [];
  let connections = 0;
  const full = gameFull(startedState("e2e4"));
  const engine = new MockGameEngine();
  const config = gameConfig();
  config.timing.opponent_turn_search = false;
  const session = new GameSession({
    client: {
      async *stream() {
        connections += 1;
        yield full;
        if (connections === 4) throw new LichessHttpError("GET", "game-stream", 429, 3_600_000);
        throw new Error("fabricated stream transport disconnect");
      },
    },
    config,
    account: "arena-bot",
    gameId: "game-transport-replay",
    signal: stop.signal,
    slot: { engine },
    store: mockStore(),
    waitForReconnect: async (milliseconds) => {
      waits.push(milliseconds);
      if (waits.length === 4) stop.abort();
    },
  });
  await session.run();
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 3_600_000]);
  assert.equal(session.engineIncident, null);
  assert.notEqual(session.finished, true);
});

test("engine new-game failure preserves canonical game completion without inventing qualified provenance", async () => {
  const stop = new AbortController();
  const engine = new MockGameEngine();
  let newGames = 0;
  engine.newGame = async () => { newGames += 1; throw new Error("fabricated child exited"); };
  const starts = [];
  const finishes = [];
  const session = new GameSession({
    client: {
      async *stream() {
        yield gameFull(startedState(""));
        await new Promise((resolve) => setImmediate(resolve));
        yield startedState("", { status: "timeout", winner: "black" });
      },
    },
    config: gameConfig(),
    account: "arena-bot",
    gameId: "game-new-game-failure",
    signal: stop.signal,
    slot: { engine, audience: "human" },
    store: { beginGame(value) { starts.push(value); }, reconcileGameLine() {}, finishGame(value) { finishes.push(value); } },
    waitForReconnect: async () => { throw new Error("local failure attempted reconnect"); },
  });
  await session.run();
  assert.equal(newGames, 1);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].runtimeProvenance, undefined);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].status, "timeout");
  assert.equal(session.engineIncident.code, "engine_process_failure");
});

test("local engine telemetry failure retains the loopback game stream and active slot until terminal authority", async () => {
  const stop = new AbortController();
  const fixtureToken = "fabricated-game-failure-token";
  const initial = startedState("");
  let searches = 0;
  let reconnects = 0;
  let session;
  const events = [];
  const originalLog = console.log;
  console.log = (line) => events.push(JSON.parse(line));
  const engine = new UciEngine({
    adapter: "standard_uci_v1",
    executable: process.execPath,
    arguments: [path.join(ROOT, "test-fixtures", "fake-standard-uci-engine.mjs")],
    working_directory: ROOT,
    uci_options: {},
    timing: { opponent_turn_search: false },
    shutdown_grace_ms: 1_000,
  });
  const send = engine.send.bind(engine);
  engine.send = (command) => {
    if (command.startsWith("go ")) searches += 1;
    send(command);
  };
  const api = await startFakeLichessApi({
    fixtureToken,
    state: { gameStreams: {
      "game-local-failure": async function* records() {
        yield gameFull(initial);
        const deadline = Date.now() + 5_000;
        while (!session?.engineIncident && reconnects === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        yield initial;
        yield startedState("", { status: "timeout", winner: "black" });
      },
    } },
  });
  const config = gameConfig();
  config.timing.opponent_turn_search = false;
  const slot = { id: "human-1", state: "active", audience: "human", engine };
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-local-engine-failure-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  session = new GameSession({
    client: new LichessClient({
      token: fixtureToken,
      baseUrl: api.origin,
      fetchImpl: (url, options) => {
        assert.equal(new URL(url).origin, new URL(api.origin).origin);
        return fetch(url, options);
      },
    }),
    config,
    account: "arena-bot",
    gameId: "game-local-failure",
    signal: stop.signal,
    slot,
    store,
    waitForReconnect: async () => {
      reconnects += 1;
      if (reconnects === 2) stop.abort();
    },
  });
  try {
    await engine.start();
    searches = 0;
    await session.run();
    assert.equal(api.requests.filter((row) => row.path.includes("/stream/")).length, 1);
    assert.equal(reconnects, 0);
    assert.equal(searches, 1);
    assert.equal(slot.state, "active");
    assert.equal(session.finished, true);
    assert.equal(store.status().games, 1);
    assert.equal(api.state.moves.length, 0);
    assert.equal(api.state.aborts.length, 0);
    assert.equal(events.filter((row) => row.event === "game_engine_incident").length, 1);
    assert.equal(events.some((row) => row.event === "game_stream_error"), false);
    assert.equal(session.engineIncident.code, "engine_contract_failure");
    const incidents = store.listProviderIncidents({ filter: "all", after_cursor: 0, limit: 10 });
    assert.equal(incidents.incidents.length, 1);
    assert.equal(incidents.incidents[0].code, "engine_contract_failure");
    assert.equal(incidents.incidents[0].state, "resolved");
    assert.equal(incidents.incidents[0].occurrence_count, 1);
  } finally {
    stop.abort();
    console.log = originalLog;
    await engine.close();
    await api.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failedOperation of ["new_game", "stop_and_drain"]) {
  test(`terminal loopback observation survives ${failedOperation} failure`, async (t) => {
    const stop = new AbortController();
    const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-terminal-engine-failure-"));
    const store = new LichessStore(path.join(directory, "matches.sqlite"));
    const engine = new MockGameEngine();
    const terminal = startedState("e2e4", { status: "resign", winner: "black" });
    let operationCalls = 0;
    let reconnects = 0;
    if (failedOperation === "new_game") {
      engine.newGame = async () => { operationCalls += 1; throw new Error("fixture startup failed"); };
    } else {
      engine.stopAndDrain = async () => { operationCalls += 1; throw new Error("fixture drain failed"); };
    }
    const fixtureToken = "fabricated-terminal-failure-token";
    const api = await startFakeLichessApi({
      fixtureToken,
      state: { gameStreams: { "game-1": failedOperation === "new_game"
        ? [gameFull(terminal)]
        : async function* records() {
          yield gameFull(startedState("e2e4"));
          const deadline = Date.now() + 5_000;
          while (!engine.active && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          yield terminal;
        } } },
    });
    t.after(async () => {
      stop.abort();
      await api.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const client = new LichessClient({
      token: fixtureToken,
      baseUrl: api.origin,
      fetchImpl: (url, options) => {
        assert.equal(new URL(url).origin, new URL(api.origin).origin);
        return fetch(url, options);
      },
    });
    const session = new GameSession({
      client, config: gameConfig(), account: "arena-bot", gameId: "game-1",
      signal: stop.signal, slot: { id: "human-1", audience: "human", state: "active", engine },
      store,
      waitForReconnect: async () => { reconnects += 1; stop.abort(); },
    });
    await session.run();
    assert.equal(session.finished, true, "the consumed terminal observation must finish the game");
    assert.equal(reconnects, 0);
    assert.equal(operationCalls > 0, true);
    assert.equal(api.requests.filter((row) => row.path.includes("/stream/")).length, 1);
    assert.equal(api.state.moves.length, 0);
    const archive = store.getProviderGame("game-1");
    assert.equal(archive.status, "resign");
    assert.equal(archive.archive_completeness, "complete");
    assert.deepEqual(archive.replay.map((ply) => ply.uci_move), ["e2e4"]);
    const incidents = store.listProviderIncidents({ filter: "all", after_cursor: 0, limit: 10 });
    assert.equal(incidents.incidents.length, 1);
    assert.equal(incidents.incidents[0].operation, failedOperation);
    assert.equal(incidents.incidents[0].state, "resolved");
  });
}

for (const peerOperation of ["pause", "resume"]) {
  test(`foreground loopback game quarantines the peer whose ${peerOperation} operation fails`, async (t) => {
    const stop = new AbortController();
    const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-peer-engine-failure-"));
    const store = new LichessStore(path.join(directory, "matches.sqlite"));
    const fixtureToken = "fabricated-peer-failure-token";
    let requestingSession;
    let reconnects = 0;
    const api = await startFakeLichessApi({
      fixtureToken,
      state: { gameStreams: { "game-a": async function* records() {
        yield { ...gameFull(startedState("")), id: "game-a" };
        const deadline = Date.now() + 5_000;
        while (!api.state.moves.length && !requestingSession.engineIncident && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        yield startedState(api.state.moves.length ? "e2e4" : "", { status: "resign", winner: "black" });
      } } },
    });
    t.after(async () => {
      stop.abort();
      await api.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const client = new LichessClient({
      token: fixtureToken, baseUrl: api.origin,
      fetchImpl: (url, options) => {
        assert.equal(new URL(url).origin, new URL(api.origin).origin);
        return fetch(url, options);
      },
    });
    const requestingEngine = new MockGameEngine([{ bestmove: "e2e4" }]);
    const peerEngine = new MockGameEngine();
    const config = gameConfig();
    config.timing.opponent_turn_search = false;
    const sessions = [];
    const coordinator = new ForegroundSearchCoordinator({ sessions: () => sessions });
    const makeSession = (gameId, engine) => new GameSession({
      client, config, account: "arena-bot", gameId, signal: stop.signal,
      slot: { id: gameId, audience: "human", state: "active", engine }, store,
      foregroundCoordinator: coordinator,
      waitForReconnect: async () => { reconnects += 1; stop.abort(); },
    });
    requestingSession = makeSession("game-a", requestingEngine);
    const peerSession = makeSession("game-b", peerEngine);
    sessions.push(requestingSession, peerSession);
    await peerSession.initialize({ ...gameFull(startedState("e2e4")), id: "game-b" }, peerEngine);
    await peerSession.onState(startedState("e2e4"), peerEngine);
    peerSession.config.timing.opponent_turn_search = true;
    if (peerOperation === "pause") {
      await peerSession.resumeOpponentSearch();
      peerEngine.stopAndDrain = async () => { throw new Error("fixture peer drain failed"); };
    } else {
      peerEngine.startOpponentTurnSearch = async () => { throw new Error("fixture peer resume failed"); };
    }
    await requestingSession.run();
    assert.equal(api.state.moves.length, 1, "the healthy requesting game must submit its legal move");
    assert.equal(requestingSession.engineIncident, null);
    assert.equal(peerSession.engineIncident?.code, "engine_process_failure");
    assert.equal(peerSession.engineIncident.operation, peerOperation === "pause" ? "stop_and_drain" : "opponent_search");
    assert.equal(reconnects, 0);
    const incidents = store.listProviderIncidents({ filter: "active", after_cursor: 0, limit: 10 });
    assert.equal(incidents.incidents.length, 1);
    assert.equal(incidents.incidents[0].game_id, "game-b");
    await peerSession.onState(startedState("e2e4", { status: "resign", winner: "black" }), peerEngine);
    assert.equal(peerSession.finished, true);
    assert.equal(store.listProviderIncidents({ filter: "active", after_cursor: 0, limit: 10 }).incidents.length, 0);
  });
}

test("qualified v1 transport profiles remain readable with legacy coverage", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-transport-v1-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "transport-v1.json");
  const generatedAt = Date.parse("2026-07-20T00:00:00Z");
  const samples = Array.from({ length: 200 }, (_, index) => ({
    game_id: `game-${Math.floor(index / 20)}`,
    post_dispatch_to_ack_ms: 500 + (index % 100),
    recorded_at_ms: generatedAt,
  }));
  writeFileSync(profilePath, JSON.stringify({
    schema: "uci_arena_lichess_transport_profile_v1",
    generated_at: new Date(generatedAt).toISOString(),
    qualified: true,
    effective_reserve_ms: 650,
    samples,
  }));
  const loaded = loadTransportProfile(profilePath, generatedAt + 1_000);
  assert.equal(loaded.qualified, true);
  assert.equal(loaded.coverage, "dispatch_to_ack_legacy");
  assert.equal(loaded.reserveMs, 650);
});

test("legacy v1 transport authority is not overwritten by v2 collection", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-transport-v1-read-only-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "transport-v1.json");
  const generatedAt = Date.parse("2026-07-20T00:00:00Z");
  const samples = Array.from({ length: 200 }, (_, index) => ({
    game_id: `game-${Math.floor(index / 20)}`,
    post_dispatch_to_ack_ms: 500 + (index % 100),
    recorded_at_ms: generatedAt,
  }));
  const original = `${JSON.stringify({
    schema: "uci_arena_lichess_transport_profile_v1",
    generated_at: new Date(generatedAt).toISOString(),
    qualified: true,
    effective_reserve_ms: 650,
    samples,
  }, null, 2)}\n`;
  writeFileSync(profilePath, original);
  const tracker = new TransportProfileTracker({ profilePath, now: () => generatedAt + 1_000 });
  tracker.record("new-game", {
    bestmove_to_ack_ms: 900,
    bestmove_to_legality_ms: 25,
    move_queue_wait_ms: 125,
    post_dispatch_to_ack_ms: 750,
  });
  assert.equal(tracker.finishGame("new-game"), 650);
  assert.equal(readFileSync(profilePath, "utf8"), original);
});

test("transport authority rejects invalid samples even when summary fields claim qualification", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-transport-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profilePath = path.join(directory, "transport-invalid.json");
  const samples = Array.from({ length: 200 }, (_, index) => ({
    game_id: `game-${Math.floor(index / 20)}`,
    bestmove_to_ack_ms: index === 100 ? null : 500,
  }));
  writeFileSync(profilePath, JSON.stringify({
    schema: "uci_arena_lichess_transport_profile_v2",
    generated_at: "2026-07-20T00:00:00.000Z",
    qualified: true,
    effective_reserve_ms: 550,
    samples,
  }));
  const loaded = loadTransportProfile(profilePath, Date.parse("2026-08-07T00:00:00Z"));
  assert.equal(loaded.status, "rejected");
  assert.match(loaded.reason, /invalid bestmove_to_ack_ms sample/);
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

test("black aborts one zero-ply game after the first-move deadline", async () => {
  const posts = [];
  const finishes = [];
  let scheduled;
  const client = {
    post: async (endpoint, _form, _signal, _priority, beforeDispatch) => {
      beforeDispatch?.();
      posts.push(endpoint);
    },
  };
  const engine = new MockGameEngine([]);
  const config = gameConfig();
  config.scheduler = { first_move_timeout_seconds: 60 };
  const session = createGameSession(engine, client, config, {
    store: {
      beginGame() {},
      reconcileGameLine() {},
      finishGame: (game) => finishes.push(game),
    },
    scheduleTimeout: (callback, milliseconds) => {
      scheduled = { callback, milliseconds };
      return { unref() {} };
    },
    cancelTimeout: () => {},
  });
  const initial = startedState("");
  const full = gameFull(initial);
  full.white = { id: "opponent" };
  full.black = { id: "arena-bot" };
  await session.initialize(full, engine);
  await session.onState(initial, engine);

  assert.equal(scheduled.milliseconds, 60_000);
  await scheduled.callback();
  await scheduled.callback();
  assert.deepEqual(posts, ["api/bot/game/game-1/abort"]);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].status, "aborted");
  assert.equal(finishes[0].plies, 0);
  assert.equal(session.finished, true);
  assert.equal(engine.stopCalls.at(-1).reason, "first_move_timeout");
});

test("first authoritative move cancels a queued zero-ply abort", async () => {
  const posts = [];
  let scheduled;
  let abortRequestCancelled = false;
  let resolveAbortQueued;
  const abortQueued = new Promise((resolve) => { resolveAbortQueued = resolve; });
  const client = {
    post: async (endpoint, _form, signal, _priority, beforeDispatch) => {
      if (endpoint.endsWith("/abort")) {
        resolveAbortQueued();
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            abortRequestCancelled = true;
            reject(signal.reason);
          }, { once: true });
        });
      }
      beforeDispatch?.();
      posts.push(endpoint);
    },
  };
  const engine = new MockGameEngine([{ bestmove: "e7e5", ponder: "g1f3" }]);
  const config = gameConfig();
  config.scheduler = { first_move_timeout_seconds: 60 };
  const session = createGameSession(engine, client, config, {
    scheduleTimeout: (callback) => {
      scheduled = callback;
      return { unref() {} };
    },
    cancelTimeout: () => {},
  });
  const initial = startedState("");
  const full = gameFull(initial);
  full.white = { id: "opponent" };
  full.black = { id: "arena-bot" };
  await session.initialize(full, engine);
  await session.onState(initial, engine);
  const expiry = scheduled();
  await abortQueued;
  await session.onState(startedState("e2e4"), engine);
  await expiry;

  assert.equal(abortRequestCancelled, true);
  assert.equal(posts.filter((endpoint) => endpoint.endsWith("/abort")).length, 0);
  assert.match(posts[0], /\/move\/e7e5$/);
});

test("first-move watchdog never arms while the bot is White", async () => {
  let schedules = 0;
  const session = createGameSession(new MockGameEngine([]), { post: async () => {} }, gameConfig(), {
    scheduleTimeout: () => {
      schedules += 1;
      return { unref() {} };
    },
  });

  await session.initialize(gameFull(startedState("")), session.slot.engine);

  assert.equal(session.color, "white");
  assert.equal(schedules, 0);
});

test("terminal zero-ply state cancels the first-move watchdog", async () => {
  const posts = [];
  let scheduled;
  let cancellations = 0;
  const engine = new MockGameEngine([]);
  const session = createGameSession(engine, { post: async (endpoint) => posts.push(endpoint) }, gameConfig(), {
    scheduleTimeout: (callback) => {
      scheduled = callback;
      return { unref() {} };
    },
    cancelTimeout: () => { cancellations += 1; },
  });
  const initial = startedState("");
  const full = gameFull(initial);
  full.white = { id: "opponent" };
  full.black = { id: "arena-bot" };
  await session.initialize(full, engine);
  await session.onState(initial, engine);

  await session.onState(startedState("", { status: "aborted" }), engine);
  await scheduled();

  assert.equal(cancellations, 1);
  assert.equal(posts.filter((endpoint) => endpoint.endsWith("/abort")).length, 0);
  assert.equal(session.finished, true);
});

test("provider shutdown prevents a pending zero-ply abort", async () => {
  const posts = [];
  let scheduled;
  const shutdown = new AbortController();
  const engine = new MockGameEngine([]);
  const session = createGameSession(engine, { post: async (endpoint) => posts.push(endpoint) }, gameConfig(), {
    signal: shutdown.signal,
    scheduleTimeout: (callback) => {
      scheduled = callback;
      return { unref() {} };
    },
  });
  const initial = startedState("");
  const full = gameFull(initial);
  full.white = { id: "opponent" };
  full.black = { id: "arena-bot" };
  await session.initialize(full, engine);
  await session.onState(initial, engine);

  shutdown.abort();
  await scheduled();

  assert.equal(posts.filter((endpoint) => endpoint.endsWith("/abort")).length, 0);
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

test("explicit legal book and exact-tablebase resolutions do not require searched timing fields", async () => {
  for (const [kind, extra] of [
    ["opening_book", { book_move_used: 1 }],
    ["exact_tablebase", {}],
  ]) {
    const posts = [];
    const config = gameConfig();
    config.timing.opponent_turn_search = false;
    if (kind === "exact_tablebase") config.engine.qualification_profile.tablebase = { loaded_cardinality: 6 };
    const move = kind === "exact_tablebase" ? "a1a2" : "e2e4";
    const engine = new MockGameEngine([{ bestmove: move, telemetry: {
      time_policy: undefined,
      time_completion_kind: kind,
      time_opponent_remaining_ms: undefined,
      time_completion_applied: undefined,
      ...extra,
    } }]);
    const session = createGameSession(engine, { post: async (endpoint) => posts.push(endpoint) }, config);
    const initial = startedState("");
    if (kind === "exact_tablebase") {
      session.initialized = true;
      session.color = "white";
      session.initialFen = "7k/8/8/8/8/2R5/8/K7 w - - 0 1";
      session.legalityState = new AuthoritativeChessState(session.initialFen);
    } else {
      await session.initialize(gameFull(initial), engine);
    }
    await session.onState(initial, engine);
    assert.deepEqual(posts, [`api/bot/game/game-1/move/${move}`]);
  }
});

test("objective no-choice resolution requires the independently replayed root to have one legal move", async () => {
  const posts = [];
  const engine = new MockGameEngine([{ bestmove: "a1b2", telemetry: {
    time_policy: undefined, time_completion_kind: "objective_no_choice",
  } }]);
  const config = gameConfig();
  config.timing.opponent_turn_search = false;
  const session = createGameSession(engine, { post: async (endpoint) => posts.push(endpoint) }, config);
  session.initialized = true;
  session.color = "white";
  session.initialFen = "k7/8/8/8/8/8/1r6/K7 w - - 0 1";
  session.legalityState = new AuthoritativeChessState(session.initialFen);
  await session.onState(startedState(""), engine);
  assert.deepEqual(posts, ["api/bot/game/game-1/move/a1b2"]);
});

test("book hints, tablebase availability, and false no-choice claims cannot bypass searched timing validation", async () => {
  for (const [kind, extra, tablebase] of [
    ["searched_decision", { book_probe_hit: 1, book_move_used: 0 }, true],
    ["opening_book", { book_probe_hit: 1, book_move_used: 0 }, false],
    ["objective_no_choice", {}, false],
    ["exact_tablebase", {}, false],
    ["nonsearch_selection", {}, true],
    ["deadline_fallback", {}, false],
  ]) {
    const posts = [];
    const config = gameConfig();
    config.timing.opponent_turn_search = false;
    if (tablebase) config.engine.qualification_profile.tablebase = { loaded_cardinality: 6 };
    const engine = new MockGameEngine([{ bestmove: "e2e4", telemetry: {
      time_policy: undefined, time_completion_kind: kind, ...extra,
    } }]);
    const session = createGameSession(engine, { post: async (endpoint) => posts.push(endpoint) }, config);
    const initial = startedState("");
    await session.initialize(gameFull(initial), engine);
    await assert.rejects(session.onState(initial, engine));
    assert.equal(posts.length, 0);
  }
});

test("loopback book resolution submits the legal move without fabricated searched timing telemetry", async () => {
  const lifetime = new AbortController();
  const fixtureToken = "fabricated-book-resolution-token";
  let session;
  let api;
  const engine = new UciEngine({
    adapter: "standard_uci_v1",
    executable: process.execPath,
    arguments: [path.join(ROOT, "test-fixtures", "fake-standard-uci-engine.mjs"), "--book-resolution"],
    working_directory: ROOT,
    uci_options: {},
    timing: { opponent_turn_search: false },
    shutdown_grace_ms: 1_000,
  });
  api = await startFakeLichessApi({
    fixtureToken,
    state: { gameStreams: {
      "game-book-resolution": async function* records() {
        yield gameFull(startedState(""));
        const deadline = Date.now() + 5_000;
        while (api.state.moves.length === 0 && !session.engineIncident && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        yield startedState(api.state.moves.length ? "e2e4" : "", { status: "timeout", winner: "black" });
      },
    } },
  });
  const config = gameConfig();
  config.timing.opponent_turn_search = false;
  session = new GameSession({
    client: new LichessClient({
      token: fixtureToken,
      baseUrl: api.origin,
      fetchImpl: (url, options) => {
        assert.equal(new URL(url).origin, new URL(api.origin).origin);
        return fetch(url, options);
      },
    }),
    config,
    account: "arena-bot",
    gameId: "game-book-resolution",
    signal: lifetime.signal,
    slot: { id: "book-game", engine, audience: "human" },
    store: mockStore(),
    waitForReconnect: async () => { throw new Error("book resolution attempted a stream reconnect"); },
  });
  try {
    await engine.start();
    await session.run();
    assert.deepEqual(api.state.moves.map((row) => row.move), ["e2e4"]);
    assert.equal(api.requests.filter((row) => row.path.includes("/stream/")).length, 1);
    assert.equal(session.engineIncident, null);
    assert.equal(engine.latestInfo.time_policy, undefined);
    assert.equal(engine.latestInfo.time_completion_kind, "opening_book");
    assert.equal(session.finished, true);
  } finally {
    lifetime.abort();
    await engine.close();
    await api.close();
  }
});

test("unknown and unpublished completions fail closed even with otherwise complete timing fields", async () => {
  for (const kind of ["unknown_completion", "unpublished", "nonsearch_selection"]) {
    const posts = [];
    const engine = new MockGameEngine([{ bestmove: "e2e4", telemetry: { time_completion_kind: kind } }]);
    const session = createGameSession(engine, { post: async (endpoint) => posts.push(endpoint) });
    const initial = startedState("");
    await session.initialize(gameFull(initial), engine);
    await assert.rejects(session.onState(initial, engine), /completion authority/);
    assert.equal(posts.length, 0);
  }
});

test("explicit nonsearch completion cannot bypass exact root, runtime, or move legality fences", async () => {
  for (const [change, expected] of [
    [{ bestmove: "e2e5" }, /illegal at the exact authoritative root/],
    [{ rootKey: "e2e4" }, /stale root or runtime generation/],
    [{ runtimeGeneration: 999 }, /stale root or runtime generation/],
  ]) {
    const posts = [];
    const engine = new MockGameEngine([{ bestmove: "e2e4", telemetry: {
      time_policy: undefined, time_completion_kind: "opening_book", book_move_used: 1,
    } }]);
    const originalResult = engine.nextResult.bind(engine);
    engine.nextResult = (moves) => ({ ...originalResult(moves), ...change });
    const session = createGameSession(engine, { post: async (endpoint) => posts.push(endpoint) });
    const initial = startedState("");
    await session.initialize(gameFull(initial), engine);
    await assert.rejects(session.onState(initial, engine), expected);
    assert.equal(posts.length, 0);
  }
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

test("Lichess transport rejects oversized JSON, NDJSON records, and finite collections", async () => {
  const oversizedRecord = new PassThrough();
  const recordResult = (async () => {
    const rows = [];
    for await (const row of parseNdjsonStream(oversizedRecord)) rows.push(row);
    return rows;
  })();
  oversizedRecord.end(`{"value":"${"x".repeat(1024 * 1024)}"}\n`);
  await assert.rejects(recordResult, /NDJSON record exceeds/);

  const oversizedJson = new PassThrough();
  const jsonClient = new LichessClient({
    token: "fixture-token",
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      body: oversizedJson,
    }),
  });
  const jsonResult = jsonClient.json("api/account");
  oversizedJson.end(`{"value":"${"x".repeat(1024 * 1024)}"}`);
  await assert.rejects(jsonResult, /response body exceeds/);

  const finite = new PassThrough();
  const finiteClient = new LichessClient({
    token: "fixture-token",
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      body: finite,
    }),
  });
  const finiteResult = finiteClient.collectNdjson("api/bot/online?nb=512");
  finite.end(`${Array.from({ length: 1025 }, (_, index) => JSON.stringify({ index })).join("\n")}\n`);
  await assert.rejects(finiteResult, /finite NDJSON response exceeds/);
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

test("historical exports use one bounded lowest-priority NDJSON request without evaluations", async () => {
  const encoder = new TextEncoder();
  let request;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"id":"game-a"}\n{"id":"game-b"}\n'));
      controller.close();
    },
  });
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return { ok: true, status: 200, body };
    },
  });
  assert.deepEqual(await client.exportGamesByIds(["game-a", "game-b"]), [
    { id: "game-a" },
    { id: "game-b" },
  ]);
  const requested = new URL(request.url);
  assert.equal(requested.pathname, "/api/games/export/_ids");
  assert.equal(requested.searchParams.get("clocks"), "true");
  assert.equal(requested.searchParams.get("evals"), "false");
  assert.equal(requested.searchParams.get("opening"), "false");
  assert.equal(requested.searchParams.get("literate"), "false");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.body, "game-a,game-b");
  assert.equal(request.options.headers.Accept, "application/x-ndjson");
  assert.equal(request.options.headers["Content-Type"], "text/plain; charset=utf-8");
  assert.throws(
    () => client.exportGamesByIds(Array.from({ length: 301 }, (_, index) => `g-${index}`)),
    /1 through 300 ids/,
  );
});

test("archive backfill excludes live sessions and reconciles each returned game independently", async () => {
  const requested = [];
  const reconciled = [];
  const failures = [];
  let candidates = ["active-game", "historical-game"];
  const controller = Object.assign(Object.create(BotController.prototype), {
    archiveBackfillRunning: false,
    activeGames: new Map([["active-game", {}]]),
    startingGames: new Map(),
    signal: new AbortController().signal,
    now: () => 1_100,
    store: {
      listProviderGameBackfillIds: () => candidates,
      reconcileHistoricalGame: (game) => {
        reconciled.push(game);
        return true;
      },
      recordProviderGameBackfillFailure: (id, reason) => failures.push({ id, reason }),
    },
    client: {
      exportGamesByIds: async (ids) => {
        requested.push(ids);
        const historical = {
          id: "historical-game",
          moves: "e4 e5",
          clocks: [6_000, 5_950],
          status: "mate",
          winner: "white",
          lastMoveAt: 1_000,
        };
        if (ids[0] === "historical-game") return [historical];
        if (ids[0] === "duplicate-game") {
          return [
            { ...historical, id: "duplicate-game" },
            { ...historical, id: "duplicate-game" },
          ];
        }
        return [];
      },
    },
  });
  assert.equal(await controller.backfillProviderGames(), 1);
  assert.deepEqual(requested, [["historical-game"]]);
  assert.deepEqual(reconciled[0].plies.map((ply) => ply.uciMove), ["e2e4", "e7e5"]);
  assert.deepEqual(failures, []);

  candidates = ["missing-game"];
  assert.equal(await controller.backfillProviderGames(), 0);
  assert.deepEqual(failures, [{
    id: "missing-game",
    reason: "historical_export_unavailable",
  }]);

  candidates = ["duplicate-game", "duplicate-companion"];
  assert.equal(await controller.backfillProviderGames(), 0);
  assert.deepEqual(failures.slice(-2), [
    { id: "duplicate-game", reason: "historical_export_malformed" },
    { id: "duplicate-companion", reason: "historical_export_unavailable" },
  ]);
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

test("API safety incidents mirror cooldown authority and resolve without interpreting it", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-api-safety-incidents-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  try {
    observeApiSafetyIncident(store, {
      event: "api_rate_limit_entered",
      cooldownUntil: 1_000,
      challengeBlockedUntil: 0,
      challengeStrikeCount: 0,
    }, 100);
    observeApiSafetyIncident(store, {
      event: "api_challenge_quarantine_entered",
      cooldownUntil: 1_000,
      challengeBlockedUntil: 2_000,
      challengeStrikeCount: 1,
    }, 110);
    assert.deepEqual(store.listProviderIncidents({ filter: "active" }).incidents.map((incident) => ({
      code: incident.code,
      retry_deadline: incident.retry_deadline,
    })), [
      { code: "api_rate_limited", retry_deadline: 1_000 },
      { code: "api_challenge_quarantined", retry_deadline: 2_000 },
    ]);
    observeApiSafetyIncident(store, { event: "api_rate_limit_cleared" }, 1_000);
    observeApiSafetyIncident(store, { event: "api_challenge_quarantine_recovered" }, 2_000);
    assert.equal(store.listProviderIncidents({ filter: "active" }).incidents.length, 0);
    assert.equal(store.listProviderIncidents({ filter: "all" }).incidents
      .every((incident) => incident.state === "resolved"), true);
  } finally {
    store.close();
  }
});

test("API client exposes only bounded sanitized Lichess error detail", async () => {
  const incidents = [];
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
    incidentSink: (incident) => incidents.push(incident),
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
  assert.deepEqual(incidents, [{
    code: "api_permanent_error",
    severity: "error",
    source: "api",
    operation: "challenge_create",
    httpStatus: 400,
    detail: "Lichess API permanently rejected a provider request",
  }]);
  assert.equal(JSON.stringify(incidents).includes("Challenge rejected"), false);
  assert.equal(JSON.stringify(incidents).includes("test-token"), false);
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
  assert.deepEqual(parseArguments(["qualification", "run", "--config", "local.json"]), {
    command: "qualification", action: "run", config: "local.json",
  });
  assert.deepEqual(parseArguments(["incidents", "list", "--filter", "all", "--limit", "10"]), {
    command: "incidents", action: "list", filter: "all", limit: "10",
  });
  assert.deepEqual(parseArguments(["games", "list", "--scope", "history", "--before", "7"]), {
    command: "games", action: "list", scope: "history", before: "7",
  });
  assert.deepEqual(parseArguments(["game", "get", "--game-id", "game-1"]), {
    command: "game", action: "get", game_id: "game-1",
  });
});

test("incident pagination rejects invalid input before creating provider storage", async () => {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "uci-arena-invalid-incident-page-"));
  await assert.rejects(
    main(["incidents", "list", "--after-cursor", "1.5", "--runtime-dir", runtimeDir]),
    /must be an integer/u,
  );
  assert.equal(existsSync(path.join(runtimeDir, "matches.sqlite")), false);
  await assert.rejects(
    main(["incidents", "list", "--filter", "recent", "--runtime-dir", runtimeDir]),
    /filter must be active or all/u,
  );
  assert.equal(existsSync(path.join(runtimeDir, "matches.sqlite")), false);
});

test("game archive input rejects invalid pages and ids before creating provider storage", async () => {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "uci-arena-invalid-game-page-"));
  await assert.rejects(
    main(["games", "list", "--scope", "all", "--runtime-dir", runtimeDir]),
    /scope must be live or history/u,
  );
  assert.equal(existsSync(path.join(runtimeDir, "matches.sqlite")), false);
  await assert.rejects(
    main(["game", "get", "--game-id", "../../private", "--runtime-dir", runtimeDir]),
    /game id is invalid/u,
  );
  assert.equal(existsSync(path.join(runtimeDir, "matches.sqlite")), false);
});

test("installed qualification failures are bounded typed and path-redacted", () => {
  const result = qualificationFailureProjection(
    new Error("Complete-game qualifier failed at C:\\private workspace\\engine.exe: contract mismatch"),
    "complete_game",
  );
  assert.deepEqual(Object.keys(result).sort(), ["failure", "schema", "status"]);
  assert.equal(result.schema, "uci_arena_lichess_qualification_result_v1");
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "qualification_complete_game_failed");
  assert.equal(result.failure.stage, "complete_game");
  assert.match(result.failure.detail, /<path>/u);
  assert.doesNotMatch(result.failure.detail, /private workspace|engine\.exe/u);
  assert.ok(result.failure.detail.length <= 1024);
  const posix = qualificationFailureProjection(
    new Error("Complete-game qualifier failed at /private/workspace/engine: mismatch"),
    "complete_game",
  );
  assert.match(posix.failure.detail, /<path>/u);
  assert.doesNotMatch(posix.failure.detail, /\/private|workspace\/engine/u);
});

test("installed qualification failure projection suppresses sensitive diagnostics", () => {
  const result = qualificationFailureProjection(
    new Error("Authorization token should never cross this boundary"),
  );
  assert.equal(result.failure.code, "qualification_preflight_failed");
  assert.equal(
    result.failure.detail,
    "Qualification failed; sensitive provider diagnostics were redacted.",
  );
  assert.doesNotMatch(JSON.stringify(result), /Authorization token/u);
});

test("qualification command emits one typed JSON failure document", { concurrency: false }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-qualification-command-"));
  const output = [];
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  t.mock.method(console, "log", (value) => output.push(value));
  const exitCode = await main([
    "qualification",
    "run",
    "--config",
    path.join(directory, "missing-config.json"),
    "--runtime-dir",
    path.join(directory, "runtime"),
  ]);
  assert.equal(exitCode, 1);
  assert.equal(output.length, 1);
  const result = JSON.parse(output[0]);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.stage, "preflight");
  assert.equal(result.failure.code, "qualification_preflight_failed");
  assert.doesNotMatch(output[0], /missing-config|uci-arena-qualification-command/u);
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
    engine: {
      adapter: "standard_uci_v1",
      executable: "fixture-engine",
      selected_bundle: "standard_uci",
      uci_options: {},
    },
    timing: { opponent_turn_search: false, initial_transport_reserve_ms: 250 },
    scheduler: { enabled: false },
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
    controller.slots.attachEngine(slot, { close: async () => {} }, slot.generation);
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

test("concurrent observations of one game coalesce into one start operation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-start-coalesce-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  const controller = new BotController({
    client: {},
    config: {
      engine: { adapter: "standard_uci_v1", uci_options: {} },
      timing: { opponent_turn_search: false },
      scheduler: { enabled: false },
      capacity: {
        total_slots: 1,
        startup_parallelism: 1,
        human: { slots: 0, allow_borrowing: false, accept_public: false },
        bot: { slots: 1, target_active: 0 },
      },
    },
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  let releaseStart;
  const gate = new Promise((resolve) => { releaseStart = resolve; });
  let starts = 0;
  controller.startGameOnce = async () => {
    starts += 1;
    await gate;
    return null;
  };
  try {
    const first = controller.startGame({ gameId: "same-game" });
    const second = controller.startGame({ gameId: "same-game" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 1);
    releaseStart();
    await Promise.all([first, second]);
    assert.equal(controller.startingGames.size, 0);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("outbound gameStart racing the create response adopts the preparing slot", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-outbound-create-race-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  const lifetime = new AbortController();
  let releaseStream;
  const streamGate = new Promise((resolve) => { releaseStream = resolve; });
  let controller;
  const client = {
    postJson: async (_endpoint, _form, _signal, _priority, beforeDispatch) => {
      beforeDispatch();
      await controller.startGame({
        gameId: "raced-game",
        opponent: { id: "raced-bot", title: "BOT" },
      });
      return { challenge: { id: "raced-challenge" } };
    },
    stream: async function* stream() {
      await streamGate;
    },
  };
  const config = {
    engine: {
      adapter: "standard_uci_v1",
      executable: "fixture-engine",
      selected_bundle: "standard_uci",
      uci_options: {},
    },
    timing: { opponent_turn_search: false, initial_transport_reserve_ms: 250 },
    scheduler: {
      enabled: false,
      timeout_cooldown_minutes: 30,
    },
    outbound_challenge: {
      rated: false,
      color: "random",
      clock_limit: 180,
      clock_increment: 2,
    },
    capacity: {
      total_slots: 1,
      startup_parallelism: 1,
      human: { slots: 0, allow_borrowing: false, accept_public: false },
      bot: { slots: 1, target_active: 0 },
    },
  };
  controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: lifetime.signal,
    store,
  });
  controller.streamConnected = true;
  let closes = 0;
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, {
      close: async () => { closes += 1; },
      mode: "idle",
      stopAndDrain: async () => ({ drained: false }),
    }, slot.generation);
    return slot;
  };
  try {
    assert.equal(await controller.createChallenge("raced-bot", "bot"), true);
    const slot = controller.slots.findGame("raced-game");
    assert.ok(slot);
    assert.equal(slot.challengeId, "raced-challenge");
    assert.equal(controller.slots.occupied("bot"), 1);
    assert.equal(store.db.prepare(`
      SELECT status FROM challenge_attempts WHERE challenge_id='raced-challenge'
    `).get().status, "accepted");
    lifetime.abort(new Error("outbound race test complete"));
    releaseStream();
    await Promise.allSettled(controller.activeGames.values());
    assert.equal(controller.slots.snapshot().byAudience.bot.empty, 1);
    assert.equal(closes, 1);
  } finally {
    releaseStream();
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
    controller.slots.attachEngine(slot, { close: async () => {} }, slot.generation);
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
    stream: async function* stream() {
      yield {
        ...gameFull(startedState("", { status: "aborted" }), "self"),
        black: { id: "usunfish", name: "BOT uSunfish", title: "BOT" },
      };
    },
  };
  const config = gameConfig();
  config.engine.adapter = "standard_uci_v1";
  delete config.engine.qualification_profile;
  config.timing.opponent_turn_search = false;
  config.scheduler = { enabled: false };
  config.capacity = {
    total_slots: 2,
    startup_parallelism: 2,
    human: { slots: 1, allow_borrowing: false, accept_public: true },
    bot: { slots: 1, target_active: 1 },
  };
  const controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  let recoveredSlot;
  controller.prepareSlot = async (slot) => {
    const engine = new MockGameEngine();
    engine.close = async () => {};
    engine.qualificationStatus = {
      engine_adapter: "standard_uci_v1",
      engine_build_fingerprint: `sha256:${"a".repeat(64)}`,
      engine_launch_identity_sha256: `sha256:${"b".repeat(64)}`,
      uci_identity_sha256: `sha256:${"c".repeat(64)}`,
      uci_id_lines: ["id name Recovery Fixture"],
    };
    engine.appliedUciOptions = {};
    controller.slots.attachEngine(slot, engine, slot.generation);
    recoveredSlot = slot;
    return slot;
  };
  try {
    await controller.recoverPlayingGames();
    assert.equal(requestedEndpoint, "api/account/playing?nb=50");
    assert.equal(recoveredSlot.opponent, "usunfish");
    assert.equal(recoveredSlot.audience, "bot");
    await Promise.allSettled(controller.activeGames.values());
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("initial reconciliation failure remains supervised and retries before stream admission", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-startup-recovery-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  const lifetime = new AbortController();
  let recoveryCalls = 0;
  let pendingObserved = false;
  let connectedAfterRecovery = false;
  const client = {
    requestQueue: { snapshot: () => ({ depth: 0 }) },
    safetySnapshot: () => ({
      state: "ready",
      cooldown_until: 0,
      cooldown_remaining_ms: 0,
      strike_count: 0,
    }),
    json: async () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) throw new Error("temporary startup API failure");
      return { nowPlaying: [] };
    },
    openStream: async () => ({
      async *[Symbol.asyncIterator]() {
        connectedAfterRecovery = true;
        lifetime.abort(new Error("startup recovery test complete"));
      },
    }),
  };
  const config = gameConfig();
  config.scheduler = { ...config.scheduler, enabled: false };
  config.capacity = {
    total_slots: 1,
    startup_parallelism: 1,
    human: { slots: 0, allow_borrowing: false, accept_public: false },
    bot: { slots: 1, target_active: 0 },
  };
  const controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: lifetime.signal,
    store,
    reconnectDelay: async () => {
      const runtime = JSON.parse(readFileSync(path.join(directory, "runtime.json"), "utf8"));
      pendingObserved = runtime.scheduler.reconciliation_pending === true;
    },
  });
  try {
    await controller.run();
    assert.equal(recoveryCalls, 2);
    assert.equal(pendingObserved, true);
    assert.equal(connectedAfterRecovery, true);
    const incidents = store.listProviderIncidents({ filter: "all" }).incidents;
    assert.equal(incidents.some((incident) => incident.code === "event_stream_disconnected"
      && incident.state === "resolved"), true);
  } finally {
    lifetime.abort();
    await controller.slots.drainAll();
    store.close();
  }
});

test("scheduler tick incidents aggregate failure and close on the next successful tick", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-scheduler-incidents-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  const lifetime = new AbortController();
  const config = gameConfig();
  config.scheduler = { ...config.scheduler, enabled: false };
  config.capacity = {
    total_slots: 1,
    startup_parallelism: 1,
    human: { slots: 0, allow_borrowing: false, accept_public: false },
    bot: { slots: 1, target_active: 0 },
  };
  const controller = new BotController({
    client: {},
    config,
    account: "self",
    runtimeDir: directory,
    signal: lifetime.signal,
    store,
    schedulerDelay: async () => {},
  });
  let ticks = 0;
  controller.schedulerTick = async () => {
    ticks += 1;
    if (ticks === 1) throw new Error("scheduler fixture failure");
    lifetime.abort(new Error("scheduler fixture complete"));
  };
  try {
    await controller.schedulerLoop();
    const incidents = store.listProviderIncidents({ filter: "all" }).incidents;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].code, "scheduler_tick_failed");
    assert.equal(incidents[0].occurrence_count, 1);
    assert.equal(incidents[0].state, "resolved");
  } finally {
    lifetime.abort();
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
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
  controller.slots.pending(slot, "late-challenge", slot.generation);
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
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
  controller.slots.pending(slot, "late-challenge", slot.generation);
  try {
    await controller.expirePending(25_001);
    assert.equal(slot.state, "cancelling");
    assert.equal(slot.challengeId, "late-challenge");
    assert.equal(slot.cancelRetryAt, Number.POSITIVE_INFINITY);
    assert.equal(controller.schedulerFault.kind, "permanent_cancel_error");
    assert.equal(closes, 0);
    assert.deepEqual(store.listProviderIncidents({ filter: "active" }).incidents.map((incident) => ({
      code: incident.code,
      source: incident.source,
      operation: incident.operation,
      http_status: incident.http_status,
      detail: incident.detail,
    })), [{
      code: "scheduler_fault",
      source: "scheduler",
      operation: "challenge_cancel",
      http_status: 400,
      detail: "Scheduler stopped after permanent challenge cancellation rejection",
    }]);
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
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
  controller.slots.pending(slot, "gone-challenge", slot.generation);
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
  controller.slots.attachEngine(slot, { close: async () => { closes += 1; } }, slot.generation);
  controller.slots.pending(slot, "accepted-challenge", slot.generation);
  controller.startGame = async (game, recoveredSlot) => {
    controller.slots.active(recoveredSlot, game.gameId, recoveredSlot.generation);
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
