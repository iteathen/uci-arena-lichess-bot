#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
  requireValue(identity?.search?.search_core === "v2", "Diagnostic did not qualify SearchCore v2");
  requireValue(new Set(["directml", "cuda"]).has(identity.search.provider_effective),
    "Diagnostic did not retain a supported GPU provider");
  requireValue(identity.search.provider_requested === identity.search.provider_effective,
    "Diagnostic provider request/effective identity differs");
  requireValue(identity.search.background_search === false,
    "Diagnostic must disable background search");
  same(identity.engine.executable_sha256, executableSha, "Diagnostic executable");
  same(identity.model.model_id, checkpoint.model_id, "Diagnostic model id");
  return identity;
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
    [runtime.v2_cursor_admissions, "cursor admissions"],
    [runtime.v2_cursor_async_pending, "cursor asynchronous pending"],
    [runtime.v2_cursor_ready_resumes, "cursor ready resumes"],
    [runtime.provider_batches_delta, "provider batches"],
    [runtime.provider_rows_delta, "provider rows"],
  ]) requireValue(Number(value) > 0, `Complete-game ${label} is not positive`);
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

  const evidenceDirectory = path.join(path.dirname(output), "evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  const diagnosticTarget = path.join(evidenceDirectory, "time-diagnostic.json");
  const completeGameTarget = path.join(evidenceDirectory, "complete-game.json");
  copyFileSync(diagnosticPath, diagnosticTarget);
  copyFileSync(completeGamePath, completeGameTarget);
  const diagnosticEvidence = {
    passed: true,
    artifact: path.relative(path.dirname(output), diagnosticTarget).replaceAll("\\", "/"),
    artifact_sha256: sha256File(diagnosticTarget),
  };
  const completeGameEvidence = {
    passed: true,
    artifact: path.relative(path.dirname(output), completeGameTarget).replaceAll("\\", "/"),
    artifact_sha256: sha256File(completeGameTarget),
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
  requireValue(profile.qualification_probe.depth >= profile.split_depth,
    "Qualification probe depth must be at least split depth");
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  renameSync(temporary, output);
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
