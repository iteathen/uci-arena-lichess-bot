#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SCOPE = "local_live_safety";
const RELEASE_SCOPE = "release";

function sha256Buffer(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
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
    "diagnostic_evidence",
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

function validateDiagnostic(diagnostic, executableSha, checkpoint) {
  requireValue(diagnostic.schema === "uci_time_profile_attempt_v3",
    "Diagnostic evidence schema is not uci_time_profile_attempt_v3");
  requireValue(diagnostic.phase === "diagnostic"
    && diagnostic.outcome === "accepted_for_calibration",
  "Diagnostic evidence was not accepted for calibration");
  for (const gate of [
    "legal_moves",
    "provider_activity_positive",
    "provider_safety_passed",
    "p99_deadline_overshoot_passed",
    "maximum_deadline_overshoot_passed",
    "passed",
  ]) {
    requireValue(diagnostic.gates?.[gate] === true, `Diagnostic gate ${gate} did not pass`);
  }
  const identity = diagnostic.identity;
  requireValue(new Set(["v2", "mcgs"]).has(identity?.search?.search_core),
    "Diagnostic did not qualify a supported search core");
  requireValue(new Set(["directml", "cuda"]).has(identity.search.provider_effective),
    "Diagnostic did not retain a supported GPU provider");
  requireValue(identity.search.provider_requested === identity.search.provider_effective,
    "Diagnostic provider request/effective identity differs");
  requireValue(identity.search.background_search === false,
    "Diagnostic must disable background search");
  same(identity.engine.executable_sha256, executableSha, "Diagnostic executable");
  same(identity.model.model_id, checkpoint.model_id, "Diagnostic model id");
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
      requireValue(diagnostic.gates?.[gate] === true,
        `Diagnostic MCGS gate ${gate} did not pass`);
    }
    const mcgs = identity.search.mcgs;
    requireValue(mcgs?.time_policy === "RelativeClockTemporalV1",
      "Diagnostic MCGS temporal policy is not RelativeClockTemporalV1");
    requireInteger(mcgs.search_graph_mb, "Diagnostic MCGS graph size", 64, 4_096);
    requireInteger(mcgs.cpuct_permille, "Diagnostic MCGS Cpuct", 100, 10_000);
    requireInteger(mcgs.outstanding_batches, "Diagnostic MCGS outstanding batches", 1, 4);
    requireInteger(mcgs.book_prior_blend_permille,
      "Diagnostic MCGS book-prior blend", 0, 500);
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

function validateCompleteGame(completeGame, identity, executableSha, scope) {
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
  requireValue(runtime.stale_publications_delta === 0
    && runtime.bestmove_active_tickets === 0
    && runtime.bestmove_active_async_leases === 0,
  "Complete-game activation did not drain cleanly");
}

export function publishSingleGameProfile(options) {
  const engine = path.resolve(options.engine);
  const modelRoot = path.resolve(options.model_root);
  const diagnosticPath = path.resolve(options.diagnostic_evidence);
  const completeGamePath = path.resolve(options.complete_game_evidence);
  const output = path.resolve(options.output);
  const scope = options.qualification_scope ?? LOCAL_SCOPE;
  const executableSha = sha256File(engine);
  const checkpoint = readJson(path.join(modelRoot, "checkpoint_manifest.json"),
    "Checkpoint manifest");
  requireValue(/^[0-9a-f]{64}$/.test(checkpoint.checkpoint_hash ?? ""),
    "Checkpoint manifest has no lowercase SHA-256 checkpoint_hash");
  const diagnostic = readJson(diagnosticPath, "Diagnostic evidence");
  const identity = validateDiagnostic(diagnostic, executableSha, checkpoint);
  validateCompleteGame(
    readJson(completeGamePath, "Complete-game evidence"),
    identity,
    executableSha,
    scope,
  );

  const diagnosticSha = sha256File(diagnosticPath);
  const completeGameSha = sha256File(completeGamePath);
  const evidenceRoot = path.join(path.dirname(output), "evidence");
  const evidenceDirectory = path.join(
    evidenceRoot,
    `${diagnosticSha.slice("sha256:".length)}-${completeGameSha.slice("sha256:".length)}`,
  );
  const diagnosticTarget = path.join(evidenceDirectory, "time-diagnostic.json");
  const completeGameTarget = path.join(evidenceDirectory, "complete-game.json");
  const diagnosticEvidence = {
    passed: true,
    artifact: path.relative(path.dirname(output), diagnosticTarget).replaceAll("\\", "/"),
    artifact_sha256: diagnosticSha,
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
      provider_parity: diagnosticEvidence,
      deadline: diagnosticEvidence,
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
  requireValue(profile.qualification_probe.depth >= profile.split_depth,
    "Qualification probe depth must be at least split depth");
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  let createdEvidence = false;
  if (existsSync(evidenceDirectory)) {
    requireValue(existsSync(diagnosticTarget) && sha256File(diagnosticTarget) === diagnosticSha,
      "Existing immutable diagnostic evidence does not match its digest path");
    requireValue(existsSync(completeGameTarget)
      && sha256File(completeGameTarget) === completeGameSha,
    "Existing immutable complete-game evidence does not match its digest path");
  } else {
    const temporaryEvidence = `${evidenceDirectory}.tmp-${process.pid}`;
    rmSync(temporaryEvidence, { recursive: true, force: true });
    try {
      mkdirSync(temporaryEvidence);
      copyFileSync(diagnosticPath, path.join(temporaryEvidence, "time-diagnostic.json"));
      copyFileSync(completeGamePath, path.join(temporaryEvidence, "complete-game.json"));
      requireValue(
        sha256File(path.join(temporaryEvidence, "time-diagnostic.json")) === diagnosticSha,
        "Staged diagnostic evidence digest mismatch",
      );
      requireValue(
        sha256File(path.join(temporaryEvidence, "complete-game.json")) === completeGameSha,
        "Staged complete-game evidence digest mismatch",
      );
      renameSync(temporaryEvidence, evidenceDirectory);
      createdEvidence = true;
    } finally {
      rmSync(temporaryEvidence, { recursive: true, force: true });
    }
  }
  const temporary = `${output}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    renameSync(temporary, output);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (createdEvidence) rmSync(evidenceDirectory, { recursive: true, force: true });
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
