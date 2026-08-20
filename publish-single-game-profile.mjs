#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PROFILE_SCHEMA,
  validateStoredProfile,
} from "@uci-arena/time-profile-contract";
import {
  activateExactDirectorySync,
  admitExactDirectorySync,
  classifyExactPathSync,
  createExactTemporaryDirectorySync,
  ensureExactDirectorySync,
  hashExactFileSync,
  publishExactFileSync,
  publishExactJsonSync,
  readExactJsonSync,
  removeExactDirectorySync,
  removeExactPublishedFileSync,
} from "./exact-file.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SCOPE = "local_live_safety";
const RELEASE_SCOPE = "release";

const PROFILE_FILE_LIMIT = 16 * 1024 * 1024;
const LARGE_ASSET_LIMIT = 16 * 1024 * 1024 * 1024;

function exactRegularFileExistsSync(filename, label) {
  const admission = classifyExactPathSync(filename, { label });
  if (admission.kind === "missing") return false;
  if (admission.kind !== "file") throw new Error(`${label} is not a regular non-link file`);
  return true;
}

function exactDirectoryExistsSync(filename, label) {
  const admission = classifyExactPathSync(filename, { label });
  if (admission.kind === "missing") return false;
  if (admission.kind !== "directory") throw new Error(`${label} is not a safe directory`);
  return true;
}

function sha256File(filePath, label = "Profile artifact", maximumBytes = PROFILE_FILE_LIMIT) {
  return hashExactFileSync(filePath, { maximumBytes, label }).sha256;
}

function readJson(filePath, label) {
  return readExactJsonSync(filePath, { maximumBytes: PROFILE_FILE_LIMIT, label }).value;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function same(value, expected, label) {
  requireValue(String(value) === String(expected), `${label} mismatch`);
}

function requireInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer in ${minimum}..${maximum}`);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid profile publisher argument near ${flag ?? "<end>"}`);
    }
    options[flag.slice(2).replaceAll("-", "_")] = value;
  }
  for (const name of [
    "engine",
    "model_root",
    "time_profile",
    "complete_game_evidence",
    "output",
  ]) {
    if (!options[name]) throw new Error(`--${name.replaceAll("_", "-")} is required`);
  }
  const scope = options.qualification_scope ?? LOCAL_SCOPE;
  if (!new Set([LOCAL_SCOPE, RELEASE_SCOPE]).has(scope)) {
    throw new Error("--qualification-scope must be local_live_safety or release");
  }
  const depth = Number(options.probe_depth ?? 6);
  const timeoutMs = Number(options.probe_timeout_ms ?? 240_000);
  requireValue(Number.isSafeInteger(depth) && depth >= 2 && depth <= 64,
    "--probe-depth must be an integer in 2..64");
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 600_000,
    "--probe-timeout-ms must be an integer in 1000..600000");
  return { ...options, qualification_scope: scope, probe_depth: depth, probe_timeout_ms: timeoutMs };
}

function validateTimingProfile(input, checkpoint) {
  const profile = validateStoredProfile(input);
  requireValue(profile.schema === PROFILE_SCHEMA,
    "Timing evidence schema is not uci_time_profile_v3");
  requireInteger(
    profile.qualification?.repetitions_per_case,
    "Timing-profile repetitions per case",
    30,
    100,
  );
  for (const gate of [
    "legal_moves",
    "nonterminal_null_moves",
    "controller_disabled",
    "provider_timing_captured",
    "provider_service_reserve_valid",
    "applied_provider_service_reserve_covered",
    "applied_backup_emit_reserve_covered",
    "p99_deadline_overshoot_passed",
    "maximum_deadline_overshoot_passed",
    "passed",
  ]) {
    requireValue(profile.gates?.[gate] === true, `Timing-profile gate ${gate} did not pass`);
  }
  const identity = profile.identity;
  requireValue(new Set(["v2", "mcgs"]).has(identity?.search?.search_core),
    "Timing profile did not qualify a supported search core");
  requireValue(new Set(["directml", "cuda"]).has(identity.search.provider_effective),
    "Timing profile did not retain a supported GPU provider");
  requireValue(identity.search.provider_requested === identity.search.provider_effective,
    "Timing-profile provider request/effective identity differs");
  requireValue(identity.search.background_search === false,
    "Timing profile must disable background search");
  same(identity.model.model_id, checkpoint.model_id, "Timing-profile model id");
  if (identity.search.search_core === "mcgs") {
    for (const gate of [
      "mcgs_root_coverage_passed",
      "mcgs_policy_only_fallback_passed",
      "mcgs_graph_population_passed",
      "mcgs_async_overlap_passed",
      "mcgs_single_owner_passed",
      "mcgs_low_budget_fallback_passed",
      "mcgs_deterministic_fallback_passed",
      "mcgs_completion_integrity_passed",
      "mcgs_temporal_policy_passed",
      "mcgs_deadline_tail_telemetry_passed",
    ]) {
      requireValue(profile.gates?.[gate] === true,
        `Timing-profile MCGS gate ${gate} did not pass`);
    }
    const mcgs = identity.search.mcgs;
    requireValue(mcgs?.time_policy === "RelativeClockTemporalV1",
      "Timing-profile MCGS temporal policy is not RelativeClockTemporalV1");
    requireInteger(mcgs.search_graph_mb, "Timing-profile MCGS graph size", 64, 4_096);
    requireInteger(mcgs.cpuct_permille, "Timing-profile MCGS Cpuct", 100, 10_000);
    requireInteger(mcgs.outstanding_batches, "Timing-profile MCGS outstanding batches", 1, 4);
    requireInteger(mcgs.book_prior_blend_permille,
      "Timing-profile MCGS book-prior blend", 0, 500);
  }
  return identity;
}

function validateMcgsCompleteGame(runtime) {
  for (const [value, label] of [
    [runtime.mcgs_graph_nodes, "graph nodes"],
    [runtime.mcgs_graph_edges, "graph edges"],
    [runtime.mcgs_completed_simulations, "completed simulations"],
    [runtime.mcgs_async_admissions, "asynchronous admissions"],
    [runtime.mcgs_outstanding_peak, "outstanding peak"],
  ]) requireValue(Number(value) > 0, `Complete-game MCGS ${label} is not positive`);
  requireValue(Number(runtime.mcgs_root_legal_moves) > 0
    && runtime.mcgs_root_seeded_moves === runtime.mcgs_root_legal_moves,
  "Complete-game MCGS legal-root coverage is incomplete");
  requireValue(runtime.mcgs_stale_backups_discarded === 0,
    "Complete-game MCGS stale backups were discarded");
  requireValue(runtime.mcgs_reservation_leaks === 0,
    "Complete-game MCGS reservations leaked");
  const deadlineTail = [
    runtime.mcgs_provider_admission_denials,
    runtime.mcgs_cache_completions_after_admission_close,
    runtime.mcgs_nonprovider_backups_after_admission_close,
  ];
  requireValue(deadlineTail.every((value) => Number.isSafeInteger(value) && value >= 0),
    "Complete-game MCGS deadline-tail telemetry is missing");
  requireValue(deadlineTail.every((value) => value === 0)
    || runtime.mcgs_neural_admission_closed === true,
  "Complete-game MCGS deadline-tail work lacks an admission-close observation");
}

function validateCompleteGameTablebase(tablebase, runtime) {
  if (tablebase === null || tablebase === undefined) return null;
  requireValue(tablebase && typeof tablebase === "object",
    "Complete-game tablebase contract is not an object");
  requireValue(path.isAbsolute(tablebase.path)
    && exactDirectoryExistsSync(tablebase.path, "Complete-game Syzygy directory"),
    "Complete-game Syzygy path is not an available absolute path");
  requireValue(path.isAbsolute(tablebase.manifest)
    && exactRegularFileExistsSync(tablebase.manifest, "Complete-game Syzygy manifest"),
    "Complete-game Syzygy manifest is not an available absolute path");
  admitExactDirectorySync(tablebase.path, { label: "Complete-game Syzygy directory" });
  requireValue(/^sha256:[0-9a-f]{64}$/.test(tablebase.manifest_identity ?? ""),
    "Complete-game Syzygy manifest identity is invalid");
  requireValue(/^sha256:[0-9a-f]{64}$/.test(tablebase.manifest_file_sha256 ?? ""),
    "Complete-game Syzygy manifest file SHA-256 is invalid");
  const manifestAdmission = readExactJsonSync(tablebase.manifest, {
    maximumBytes: PROFILE_FILE_LIMIT,
    label: "Complete-game Syzygy manifest",
  });
  same(manifestAdmission.sha256, tablebase.manifest_file_sha256,
    "Complete-game Syzygy manifest file");
  const manifest = manifestAdmission.value;
  requireValue(manifest.schema === "uci_arena_syzygy_manifest_v1"
    && manifest.identity_sha256 === tablebase.manifest_identity
    && manifest.cardinality === tablebase.loaded_cardinality
    && Array.isArray(manifest.files) && manifest.files.length > 0,
  "Complete-game Syzygy manifest contract mismatch");
  requireInteger(tablebase.loaded_cardinality, "Complete-game Syzygy cardinality", 3, 7);
  requireInteger(tablebase.probe_limit, "Complete-game Syzygy probe limit", 3, 7);
  requireValue(tablebase.probe_limit <= tablebase.loaded_cardinality,
    "Complete-game Syzygy probe limit exceeds loaded cardinality");
  requireInteger(tablebase.probe_threads, "Complete-game Syzygy probe threads", 2, 8);
  for (const field of ["rule50", "root_probe", "internal_probe"]) {
    requireValue(typeof tablebase[field] === "boolean",
      `Complete-game Syzygy ${field} must be boolean`);
  }
  for (const [actual, expected, label] of [
    [runtime.syzygy_active, true, "active state"],
    [runtime.syzygy_loaded_cardinality, tablebase.loaded_cardinality, "cardinality"],
    [runtime.syzygy_manifest_identity, tablebase.manifest_identity, "manifest identity"],
    [runtime.syzygy_probe_limit, tablebase.probe_limit, "probe limit"],
    [runtime.syzygy_probe_threads, tablebase.probe_threads, "probe threads"],
    [runtime.syzygy_rule50, tablebase.rule50, "rule-50 policy"],
    [runtime.syzygy_root_probe, tablebase.root_probe, "root activation"],
    [runtime.syzygy_internal_probe, tablebase.internal_probe, "internal activation"],
  ]) same(actual, expected, `Complete-game Syzygy ${label}`);
  return {
    path: tablebase.path,
    manifest: tablebase.manifest,
    manifest_identity: tablebase.manifest_identity,
    manifest_file_sha256: tablebase.manifest_file_sha256,
    loaded_cardinality: tablebase.loaded_cardinality,
    probe_limit: tablebase.probe_limit,
    probe_threads: tablebase.probe_threads,
    rule50: tablebase.rule50,
    root_probe: tablebase.root_probe,
    internal_probe: tablebase.internal_probe,
  };
}

function validateCompleteGameTimingProfile(completeGame, timeProfile, timeProfileSha) {
  const configured = completeGame.config?.timing_profile;
  const applied = completeGame.runtime_contract?.timing_profile;
  requireValue(configured && applied,
    "Complete-game timing-profile application evidence is missing");
  for (const [actual, expected, label] of [
    [configured.profile_schema, timeProfile.schema, "configured schema"],
    [configured.profile_sha256, timeProfileSha, "configured file SHA-256"],
    [configured.identity_sha256, timeProfile.identity_sha256, "configured identity"],
    [applied.profile_schema, timeProfile.schema, "applied schema"],
    [applied.profile_sha256, timeProfileSha, "applied file SHA-256"],
    [applied.identity_sha256, timeProfile.identity_sha256, "applied identity"],
    [applied.provider_service_reserve_us,
      timeProfile.calibration.provider_service_reserve_us, "provider reserve"],
    [applied.backup_emit_reserve_us,
      timeProfile.calibration.backup_emit_reserve_us, "backup/emission reserve"],
    [applied.iteration_forecast_scale_permille,
      timeProfile.calibration.iteration_forecast_scale_permille, "forecast scale"],
  ]) same(actual, expected, `Complete-game timing profile ${label}`);
  requireValue(applied.schema === "uci_arena_complete_game_time_profile_v1"
    && applied.accepted === true
    && applied.applied === true
    && applied.timing_authority_match === true
    && applied.predictive_controller_enabled === false,
  "Complete-game timing profile was not admitted and applied exactly");
  requireValue(applied.engine_provenance && typeof applied.engine_provenance === "object",
    "Complete-game timing profile has no engine provenance comparison");
}

function validateCompleteGame(
  completeGame,
  identity,
  executableSha,
  scope,
  timeProfile,
  timeProfileSha,
) {
  requireValue(completeGame.schema === "uci_arena_complete_game_matrix_v3",
    "Complete-game evidence schema is not uci_arena_complete_game_matrix_v3");
  requireValue(completeGame.completed === true
    && completeGame.summary?.all_games_complete === true
    && completeGame.summary?.runtime_qualification?.passed === true,
  "Complete-game runtime qualification is incomplete");
  requireValue(completeGame.summary.total_complete_games > 0
    && completeGame.summary.total_complete_games === completeGame.summary.expected_complete_games,
  "Complete-game evidence has missing games");
  if (scope === RELEASE_SCOPE) {
    requireValue(completeGame.summary.resource_isolated_diagnostic_qualified === true,
      "Release qualification requires resource-isolated complete-game evidence");
  } else {
    requireValue(completeGame.summary.diagnostic_qualified === true
      && (completeGame.summary.resource_isolated_diagnostic_qualified === true
        || completeGame.summary.shared_resource_diagnostic_completed === true),
    "Local live safety requires a completed shared or isolated diagnostic");
  }
  same(`sha256:${completeGame.config?.executable_sha256?.model_engine}`,
    executableSha, "Complete-game executable");
  validateCompleteGameTimingProfile(completeGame, timeProfile, timeProfileSha);
  const topology = completeGame.runtime_contract?.expected_parallel_topology;
  const runtime = completeGame.runtime_contract?.activation_probe?.runtime;
  requireValue(topology && runtime, "Complete-game activation runtime is missing");
  for (const [actual, expected, label] of [
    [topology.search_core, identity.search.search_core, "search core"],
    [topology.provider, identity.search.provider_effective, "provider"],
    [topology.threads, identity.search.threads, "threads"],
    [topology.root_workers, identity.search.root_workers, "root workers"],
    [topology.split_depth, identity.search.split_depth, "split depth"],
    [topology.batch_size, identity.search.batch_size_effective, "batch size"],
    [runtime.model_id, identity.model.model_id, "model id"],
    [runtime.model_fingerprint, identity.model.model_fingerprint, "model fingerprint"],
    [runtime.model_input_adapter_id, identity.model.adapter_id, "adapter id"],
    [runtime.provider_numeric_fingerprint,
      identity.provider.provider_numeric_fingerprint, "provider numeric fingerprint"],
    [runtime.hardware_driver_fingerprint,
      identity.provider.hardware_driver_fingerprint, "hardware/driver fingerprint"],
    [runtime.onnx_runtime_version, identity.provider.onnx_runtime_version, "ONNX Runtime version"],
  ]) same(actual, expected, `Complete-game ${label}`);
  for (const [value, label] of [
    [runtime.actual_active_workers, "active workers"],
    [runtime.provider_batches_delta, "provider batches"],
    [runtime.provider_rows_delta, "provider rows"],
  ]) requireValue(Number(value) > 0, `Complete-game ${label} is not positive`);
  if (identity.search.search_core === "mcgs") {
    const mcgs = identity.search.mcgs;
    for (const [actual, expected, label] of [
      [topology.search_graph_mb, mcgs.search_graph_mb, "MCGS graph size"],
      [topology.mcgs_cpuct_permille, mcgs.cpuct_permille, "MCGS Cpuct"],
      [topology.mcgs_outstanding_batches,
        mcgs.outstanding_batches, "MCGS outstanding batches"],
      [topology.mcgs_book_prior_blend_permille,
        mcgs.book_prior_blend_permille, "MCGS book-prior blend"],
      [runtime.search_graph_mb_configured, mcgs.search_graph_mb,
        "runtime MCGS graph size"],
      [runtime.mcgs_cpuct_permille_configured, mcgs.cpuct_permille,
        "runtime MCGS Cpuct"],
      [runtime.mcgs_outstanding_batches_configured, mcgs.outstanding_batches,
        "runtime MCGS outstanding batches"],
      [runtime.mcgs_book_prior_blend_permille_configured,
        mcgs.book_prior_blend_permille, "runtime MCGS book-prior blend"],
      [runtime.mcgs_time_policy_configured,
        mcgs.time_policy, "runtime MCGS temporal policy"],
    ]) same(actual, expected, `Complete-game ${label}`);
    validateMcgsCompleteGame(runtime);
  } else {
    for (const [value, label] of [
      [runtime.v2_cursor_admissions, "cursor admissions"],
      [runtime.v2_cursor_async_pending, "cursor asynchronous pending"],
      [runtime.v2_cursor_ready_resumes, "cursor ready resumes"],
    ]) requireValue(Number(value) > 0, `Complete-game ${label} is not positive`);
  }
  for (const [value, label] of [
    [runtime.bestmove_active_tickets, "bestmove active tickets"],
    [runtime.bestmove_active_async_leases, "bestmove active asynchronous leases"],
  ]) {
    requireValue(Number.isSafeInteger(value) && value >= 0,
      `Complete-game ${label} telemetry is invalid`);
  }
  requireValue(Number.isFinite(runtime.post_bestmove_drain_ms)
    && runtime.post_bestmove_drain_ms >= 0
    && runtime.post_bestmove_drain_ms <= 2_000,
  "Complete-game post-bestmove drain was not bounded");
  requireValue(Number.isSafeInteger(runtime.post_bestmove_status_samples)
    && runtime.post_bestmove_status_samples >= 1,
  "Complete-game post-bestmove drain sampling is invalid");
  requireValue(runtime.stale_publications_delta === 0
    && runtime.stale_publications === 0
    && runtime.active_tickets === 0
    && runtime.active_async_leases === 0,
  "Complete-game activation did not drain cleanly");
  return validateCompleteGameTablebase(topology.tablebase, runtime);
}

export function publishSingleGameProfile(options) {
  const engine = path.resolve(options.engine);
  const modelRoot = path.resolve(options.model_root);
  const timeProfilePath = path.resolve(options.time_profile);
  const completeGamePath = path.resolve(options.complete_game_evidence);
  const output = path.resolve(options.output);
  const scope = options.qualification_scope ?? LOCAL_SCOPE;
  const executableSha = sha256File(engine, "Qualified engine executable", LARGE_ASSET_LIMIT);
  const checkpoint = readJson(path.join(modelRoot, "checkpoint_manifest.json"),
    "Checkpoint manifest");
  requireValue(/^[0-9a-f]{64}$/.test(checkpoint.checkpoint_hash ?? ""),
    "Checkpoint manifest has no lowercase SHA-256 checkpoint_hash");
  const admittedTimeProfile = readExactJsonSync(timeProfilePath, {
    maximumBytes: PROFILE_FILE_LIMIT,
    label: "Timing profile",
  });
  const timeProfile = validateStoredProfile(admittedTimeProfile.value);
  const identity = validateTimingProfile(timeProfile, checkpoint);
  const timeProfileSha = admittedTimeProfile.sha256;
  const admittedCompleteGame = readExactJsonSync(completeGamePath, {
    maximumBytes: PROFILE_FILE_LIMIT,
    label: "Complete-game evidence",
  });
  const tablebase = validateCompleteGame(
    admittedCompleteGame.value,
    identity,
    executableSha,
    scope,
    timeProfile,
    timeProfileSha,
  );

  const completeGameSha = admittedCompleteGame.sha256;
  const evidenceRoot = path.join(path.dirname(output), "evidence");
  const evidenceDirectory = path.join(
    evidenceRoot,
    `${timeProfileSha.slice("sha256:".length)}-${completeGameSha.slice("sha256:".length)}`,
  );
  const timeProfileTarget = path.join(evidenceDirectory, "time-profile.json");
  const completeGameTarget = path.join(evidenceDirectory, "complete-game.json");
  const timingProfileEvidence = {
    passed: true,
    artifact: path.relative(path.dirname(output), timeProfileTarget).replaceAll("\\", "/"),
    artifact_sha256: timeProfileSha,
  };
  const completeGameEvidence = {
    passed: true,
    artifact: path.relative(path.dirname(output), completeGameTarget).replaceAll("\\", "/"),
    artifact_sha256: completeGameSha,
  };
  const profile = {
    schema: "uci_arena_single_game_profile_v1",
    qualified: true,
    qualification_scope: scope,
    published_at: new Date().toISOString(),
    model_id: identity.model.model_id,
    model_fingerprint: identity.model.model_fingerprint,
    checkpoint_hash: checkpoint.checkpoint_hash,
    adapter_id: identity.model.adapter_id,
    engine_build_fingerprint: executableSha,
    hardware_driver_fingerprint: identity.provider.hardware_driver_fingerprint,
    onnx_runtime_version: identity.provider.onnx_runtime_version,
    provider_numeric_fingerprint: identity.provider.provider_numeric_fingerprint,
    search_core: identity.search.search_core,
    provider: identity.search.provider_effective,
    threads: identity.search.threads,
    root_workers: identity.search.root_workers,
    split_depth: identity.search.split_depth,
    batch_size: identity.search.batch_size_effective,
    batch_wait_us: identity.search.batch_wait_us_effective,
    speculation: identity.search.nn_speculation,
    qualification_probe: {
      depth: options.probe_depth ?? 6,
      timeout_ms: options.probe_timeout_ms ?? 240_000,
    },
    evidence: {
      cursor_correctness: completeGameEvidence,
      provider_parity: timingProfileEvidence,
      deadline: timingProfileEvidence,
      topology: completeGameEvidence,
      complete_game: completeGameEvidence,
    },
  };
  if (identity.search.search_core === "mcgs") {
    Object.assign(profile, {
      search_graph_mb: identity.search.mcgs.search_graph_mb,
      mcgs_cpuct_permille: identity.search.mcgs.cpuct_permille,
      mcgs_outstanding_batches: identity.search.mcgs.outstanding_batches,
      mcgs_book_prior_blend_permille:
        identity.search.mcgs.book_prior_blend_permille,
    });
  }
  if (tablebase) profile.tablebase = tablebase;
  requireValue(profile.qualification_probe.depth >= profile.split_depth,
    "Qualification probe depth must be at least split depth");
  ensureExactDirectorySync(path.dirname(output), "Single-game profile directory");
  ensureExactDirectorySync(evidenceRoot, "Single-game evidence directory");
  let createdEvidence = null;
  if (exactDirectoryExistsSync(evidenceDirectory, "Immutable single-game evidence")) {
    requireValue(exactRegularFileExistsSync(timeProfileTarget, "Immutable timing-profile evidence")
      && sha256File(timeProfileTarget, "Immutable timing-profile evidence") === timeProfileSha,
      "Existing immutable timing-profile evidence does not match its digest path");
    requireValue(exactRegularFileExistsSync(completeGameTarget, "Immutable complete-game evidence")
      && sha256File(completeGameTarget, "Immutable complete-game evidence") === completeGameSha,
    "Existing immutable complete-game evidence does not match its digest path");
  } else {
    const temporary = createExactTemporaryDirectorySync(
      evidenceRoot,
      path.basename(evidenceDirectory),
      { label: "Single-game evidence staging directory" },
    );
    let stagedTimeProfile = null;
    let stagedCompleteGame = null;
    try {
      const stagedTimePath = path.join(temporary.directory, "time-profile.json");
      const stagedCompletePath = path.join(temporary.directory, "complete-game.json");
      stagedTimeProfile = publishExactFileSync(stagedTimePath, admittedTimeProfile.bytes, {
        maximumBytes: PROFILE_FILE_LIMIT,
        label: "Staged timing-profile evidence",
      });
      stagedCompleteGame = publishExactFileSync(stagedCompletePath, admittedCompleteGame.bytes, {
        maximumBytes: PROFILE_FILE_LIMIT,
        label: "Staged complete-game evidence",
      });
      requireValue(
        sha256File(stagedTimePath, "Staged timing-profile evidence") === timeProfileSha,
        "Staged timing-profile evidence digest mismatch",
      );
      requireValue(
        sha256File(stagedCompletePath, "Staged complete-game evidence") === completeGameSha,
        "Staged complete-game evidence digest mismatch",
      );
      createdEvidence = activateExactDirectorySync(
        temporary.directory,
        evidenceDirectory,
        temporary.identity,
        { label: "Immutable single-game evidence" },
      );
    } catch (error) {
      if (stagedCompleteGame) {
        removeExactPublishedFileSync(
          path.join(temporary.directory, "complete-game.json"),
          stagedCompleteGame.identity,
          { label: "Staged complete-game evidence" },
        );
      }
      if (stagedTimeProfile) {
        removeExactPublishedFileSync(
          path.join(temporary.directory, "time-profile.json"),
          stagedTimeProfile.identity,
          { label: "Staged timing-profile evidence" },
        );
      }
      removeExactDirectorySync(temporary.directory, temporary.identity, {
        label: "Single-game evidence staging directory",
      });
      throw error;
    }
  }
  try {
    publishExactJsonSync(output, profile, {
      maximumBytes: PROFILE_FILE_LIMIT,
      label: "Single-game profile",
    });
  } catch (error) {
    if (createdEvidence) {
      const activeTime = hashExactFileSync(timeProfileTarget, {
        maximumBytes: PROFILE_FILE_LIMIT,
        label: "Immutable timing-profile evidence",
      });
      const activeComplete = hashExactFileSync(completeGameTarget, {
        maximumBytes: PROFILE_FILE_LIMIT,
        label: "Immutable complete-game evidence",
      });
      removeExactPublishedFileSync(completeGameTarget, activeComplete.identity, {
        label: "Immutable complete-game evidence",
      });
      removeExactPublishedFileSync(timeProfileTarget, activeTime.identity, {
        label: "Immutable timing-profile evidence",
      });
      removeExactDirectorySync(evidenceDirectory, createdEvidence.identity, {
        label: "Immutable single-game evidence",
      });
    }
    throw error;
  }
  return { ...profile, profile_path: output };
}

export function main(argv = process.argv.slice(2)) {
  const profile = publishSingleGameProfile(parseArguments(argv));
  process.stdout.write(`${JSON.stringify({
    status: "qualified",
    profile: profile.profile_path,
    qualification_scope: profile.qualification_scope,
    engine_build_fingerprint: profile.engine_build_fingerprint,
    model_id: profile.model_id,
    provider: profile.provider,
  })}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`publish-single-game-profile: ${error.message}\n`);
    process.exitCode = 1;
  }
}
