import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  sha256Object,
  TIME_POLICY_VERSION,
} from "@uci-arena/time-profile-contract";

import { sameProcessInstance } from "./process-instance-identity.mjs";

import { continuousDiagnosticFixture } from "./test-fixtures/continuous-game-diagnostic.mjs";

import { loadSingleGameProfile, applySingleGameProfile, UciEngine, publishCapacityProfile, loadCapacityProfile, gameRuntimeProvenance,
  updateManagerOptions, loadRuntimeConfig, loadManagerConfig, managerOptionsProjection, DEFAULT_TEMPLATE, main } from "./lichess-adapter.mjs";
import { publishSingleGameProfile } from "./publish-single-game-profile.mjs";
import { validateContinuousGameDiagnostic, safePublicPath, validateModelAssetDeclaration } from "./continuous-game-qualification.mjs";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(searchCore = "v2", timePolicyVersion = TIME_POLICY_VERSION) {
  const root = mkdtempSync(path.join(os.tmpdir(), "uci-single-game-profile-"));
  const engine = path.join(root, "uci_arena_engine.exe");
  const modelRoot = path.join(root, "models", "default");
  const output = path.join(root, "qualification", "profile.json");
  const timeProfilePath = path.join(root, "time-profile.json");
  const completeGamePath = path.join(root, "complete-game.json");
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(engine, "exact-engine");
  writeFileSync(path.join(modelRoot, "checkpoint_manifest.json"), JSON.stringify({
    model_id: "model-a",
    checkpoint_hash: "a".repeat(64),
  }));
  const engineSha = sha256("exact-engine");
  const identity = {
    time_policy_version: timePolicyVersion,
    engine: { executable_sha256: engineSha },
    model: {
      model_id: "model-a",
      model_fingerprint: "123",
      adapter_id: "adapter-a",
    },
    provider: {
      provider_numeric_fingerprint: "456",
      hardware_driver_fingerprint: "789",
      onnx_runtime_version: "1.2.3",
    },
    search: {
      search_core: searchCore,
      threads: searchCore === "mcgs" ? 3 : 6,
      root_workers: searchCore === "mcgs" ? 1 : 6,
      split_depth: 2,
      batch_size_configured: 64,
      batch_size_effective: 64,
      batch_wait_us_configured: 0,
      batch_wait_us_effective: 0,
      provider_requested: "directml",
      provider_effective: "directml",
      background_search: false,
      nn_speculation: false,
      opening_book: false,
      ponder_option: true,
      iterative_time_controller: false,
      extra_engine_options: {},
    },
  };
  if (searchCore === "mcgs") {
    identity.search.mcgs = {
      time_policy: "RelativeClockTemporalV1",
      search_graph_mb: 64,
      cpuct_permille: 1500,
      outstanding_batches: 2,
      book_prior_blend_permille: 0,
    };
  }
  const timeProfile = {
    schema: "uci_time_profile_v3",
    qualified: true,
    identity,
    identity_sha256: sha256Object(identity),
    qualification: { repetitions_per_case: 30 },
    applicability: {
      move_overhead_ms: {
        minimum: 250,
        maximum: 1500,
        tested_values: [250, 650, 700, 1500],
      },
    },
    predictive_controller: {
      default_enabled: false,
      enabled_by_profile: false,
    },
    calibration: {
      provider_batch_reserve_us: 2000,
      backup_emit_reserve_us: 1000,
      iteration_forecast_scale_permille: 1000,
    },
    gates: {
      legal_moves: true,
      nonterminal_null_moves: true,
      controller_disabled: true,
      provider_timing_captured: true,
      provider_service_reserve_valid: true,
      applied_provider_service_reserve_covered: true,
      applied_backup_emit_reserve_covered: true,
      p99_deadline_overshoot_passed: true,
      maximum_deadline_overshoot_passed: true,
      passed: true,
    },
  };
  if (searchCore === "mcgs") {
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
    ]) timeProfile.gates[gate] = true;
  }
  writeFileSync(timeProfilePath, JSON.stringify(timeProfile));
  const timeProfileSha = sha256(readFileSync(timeProfilePath));
  writeFileSync(completeGamePath, JSON.stringify({
    schema: "uci_arena_complete_game_matrix_v3",
    completed: true,
    config: {
      executable_sha256: { model_engine: engineSha.slice("sha256:".length) },
      timing_profile: {
        profile_schema: timeProfile.schema,
        profile_sha256: timeProfileSha,
        identity_sha256: timeProfile.identity_sha256,
      },
    },
    runtime_contract: {
      timing_profile: {
        schema: "uci_arena_complete_game_time_profile_v1",
        profile_schema: timeProfile.schema,
        profile_sha256: timeProfileSha,
        identity_sha256: timeProfile.identity_sha256,
        accepted: true,
        applied: true,
        timing_authority_match: true,
        provider_service_reserve_us: 2000,
        backup_emit_reserve_us: 1000,
        iteration_forecast_scale_permille: 1000,
        predictive_controller_enabled: false,
        engine_provenance: { exact: true },
      },
      expected_parallel_topology: {
        search_core: searchCore,
        provider: "directml",
        threads: searchCore === "mcgs" ? 3 : 6,
        root_workers: searchCore === "mcgs" ? 1 : 6,
        split_depth: 2,
        batch_size: 64,
        ...(searchCore === "mcgs" ? {
          search_graph_mb: 64,
          mcgs_cpuct_permille: 1500,
          mcgs_outstanding_batches: 2,
          mcgs_book_prior_blend_permille: 0,
        } : {}),
      },
      activation_probe: {
        runtime: {
          model_provider: "directml",
          model_id: "model-a",
          model_fingerprint: "123",
          model_input_adapter_id: "adapter-a",
          provider_numeric_fingerprint: "456",
          hardware_driver_fingerprint: "789",
          onnx_runtime_version: "1.2.3",
          actual_active_workers: searchCore === "mcgs" ? 3 : 6,
          ...(searchCore === "mcgs" ? {
            search_graph_mb_configured: 64,
            mcgs_cpuct_permille_configured: 1500,
            mcgs_outstanding_batches_configured: 2,
            mcgs_book_prior_blend_permille_configured: 0,
            mcgs_time_policy_configured: "RelativeClockTemporalV1",
            mcgs_graph_nodes: 64,
            mcgs_graph_edges: 128,
            mcgs_completed_simulations: 96,
            mcgs_async_admissions: 32,
            mcgs_outstanding_peak: 2,
            mcgs_root_legal_moves: 20,
            mcgs_root_seeded_moves: 20,
            mcgs_stale_backups_discarded: 0,
            mcgs_reservation_leaks: 0,
            mcgs_provider_admission_denials: 0,
            mcgs_cache_completions_after_admission_close: 0,
            mcgs_nonprovider_backups_after_admission_close: 0,
            mcgs_neural_admission_closed: false,
          } : {
            v2_cursor_admissions: 4,
            v2_cursor_async_pending: 2,
            v2_cursor_ready_resumes: 2,
          }),
          provider_batches_delta: 3,
          provider_rows_delta: 8,
          stale_publications_delta: 0,
          stale_publications: 0,
          bestmove_active_tickets: 4,
          bestmove_active_async_leases: 0,
          post_bestmove_drain_ms: 15.25,
          post_bestmove_status_samples: 2,
          active_tickets: 0,
          active_async_leases: 0,
        },
      },
    },
    summary: {
      all_games_complete: true,
      total_complete_games: 2,
      expected_complete_games: 2,
      runtime_qualification: { passed: true },
      diagnostic_qualified: true,
      resource_isolated_diagnostic_qualified: false,
      shared_resource_diagnostic_completed: true,
    },
  }));
  return {
    engine,
    model_root: modelRoot,
    time_profile: timeProfilePath,
    complete_game_evidence: completeGamePath,
    output,
    probe_depth: 6,
    probe_timeout_ms: 240_000,
  };
}

function rebindCompleteGameTimingProfile(options, engineProvenanceExact = true) {
  const timeProfile = JSON.parse(readFileSync(options.time_profile, "utf8"));
  const timeProfileSha = sha256(readFileSync(options.time_profile));
  const completeGame = JSON.parse(readFileSync(options.complete_game_evidence, "utf8"));
  Object.assign(completeGame.config.timing_profile, {
    profile_schema: timeProfile.schema,
    profile_sha256: timeProfileSha,
    identity_sha256: timeProfile.identity_sha256,
  });
  Object.assign(completeGame.runtime_contract.timing_profile, {
    profile_schema: timeProfile.schema,
    profile_sha256: timeProfileSha,
    identity_sha256: timeProfile.identity_sha256,
    provider_service_reserve_us: timeProfile.calibration.provider_batch_reserve_us,
    backup_emit_reserve_us: timeProfile.calibration.backup_emit_reserve_us,
    iteration_forecast_scale_permille:
      timeProfile.calibration.iteration_forecast_scale_permille,
    engine_provenance: { exact: engineProvenanceExact },
  });
  writeFileSync(options.complete_game_evidence, JSON.stringify(completeGame));
}

function attachTablebase(options) {
  const tablebasePath = path.join(path.dirname(options.complete_game_evidence), "syzygy");
  mkdirSync(tablebasePath);
  const wdl = Buffer.from("qualified-wdl");
  const dtz = Buffer.from("qualified-dtz");
  writeFileSync(path.join(tablebasePath, "KQvK.rtbw"), wdl);
  writeFileSync(path.join(tablebasePath, "KQvK.rtbz"), dtz);
  const manifest = {
    schema: "uci_arena_syzygy_manifest_v1",
    identity_sha256: `sha256:${"c".repeat(64)}`,
    cardinality: 3,
    files: [
      {
        name: "KQvK.rtbw",
        directory: "3-wdl",
        bytes: wdl.length,
        sha256: sha256(wdl).slice("sha256:".length),
      },
      {
        name: "KQvK.rtbz",
        directory: "3-dtz",
        bytes: dtz.length,
        sha256: sha256(dtz).slice("sha256:".length),
      },
    ],
  };
  const manifestPath = path.join(tablebasePath, "syzygy_manifest_v1.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const tablebase = {
    path: tablebasePath,
    manifest: manifestPath,
    manifest_identity: manifest.identity_sha256,
    manifest_file_sha256: sha256(readFileSync(manifestPath)),
    loaded_cardinality: 3,
    probe_limit: 3,
    probe_threads: 2,
    rule50: true,
    root_probe: true,
    internal_probe: true,
  };
  const completeGame = JSON.parse(readFileSync(options.complete_game_evidence, "utf8"));
  completeGame.runtime_contract.expected_parallel_topology.tablebase = tablebase;
  Object.assign(completeGame.runtime_contract.activation_probe.runtime, {
    syzygy_active: true,
    syzygy_loaded_cardinality: 3,
    syzygy_manifest_identity: manifest.identity_sha256,
    syzygy_probe_limit: 3,
    syzygy_probe_threads: 2,
    syzygy_rule50: true,
    syzygy_root_probe: true,
    syzygy_internal_probe: true,
  });
  writeFileSync(options.complete_game_evidence, JSON.stringify(completeGame));
  return tablebase;
}

test("publishes a self-contained exact local-live-safety profile", () => {
  const options = fixture();
  const result = publishSingleGameProfile({
    ...options,
    qualification_scope: "local_live_safety",
  });
  assert.equal(result.qualified, true);
  assert.equal(result.engine_build_fingerprint, sha256("exact-engine"));
  assert.equal(result.qualification_scope, "local_live_safety");
  const loaded = loadSingleGameProfile(options.output);
  assert.equal(loaded.model_id, "model-a");
  const completeGameArtifact = JSON.parse(
    readFileSync(options.output, "utf8"),
  ).evidence.complete_game.artifact;
  assert.match(
    completeGameArtifact,
    /^evidence\/[0-9a-f]{64}-[0-9a-f]{64}\/complete-game\.json$/,
  );
  assert.equal(
    existsSync(path.resolve(path.dirname(options.output), completeGameArtifact)),
    true,
  );
});

test("accepts bestmove-boundary work only after a clean bounded drain", () => {
  const accepted = fixture("mcgs");
  const result = publishSingleGameProfile({
    ...accepted,
    qualification_scope: "local_live_safety",
  });
  assert.equal(result.qualified, true);

  const leaked = fixture("mcgs");
  const leakedEvidence = JSON.parse(readFileSync(leaked.complete_game_evidence, "utf8"));
  leakedEvidence.runtime_contract.activation_probe.runtime.active_tickets = 1;
  writeFileSync(leaked.complete_game_evidence, JSON.stringify(leakedEvidence));
  assert.throws(
    () => publishSingleGameProfile({
      ...leaked,
      qualification_scope: "local_live_safety",
    }),
    /did not drain cleanly/,
  );

  const unbounded = fixture("mcgs");
  const unboundedEvidence = JSON.parse(readFileSync(unbounded.complete_game_evidence, "utf8"));
  unboundedEvidence.runtime_contract.activation_probe.runtime.post_bestmove_drain_ms = 2_001;
  writeFileSync(unbounded.complete_game_evidence, JSON.stringify(unboundedEvidence));
  assert.throws(
    () => publishSingleGameProfile({
      ...unbounded,
      qualification_scope: "local_live_safety",
    }),
    /drain was not bounded/,
  );
});

test("does not promote shared-resource evidence to release authority", () => {
  const options = fixture();
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      qualification_scope: "release",
    }),
    /resource-isolated/,
  );
});

test("rejects complete-game evidence that omitted timing-profile application", () => {
  const options = fixture("mcgs");
  const completeGame = JSON.parse(readFileSync(options.complete_game_evidence, "utf8"));
  delete completeGame.runtime_contract.timing_profile;
  writeFileSync(options.complete_game_evidence, JSON.stringify(completeGame));
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      qualification_scope: "local_live_safety",
    }),
    /timing-profile application evidence is missing/,
  );
});

test("publishes MCGS profile fields from search-core-specific evidence", () => {
  const options = fixture("mcgs");
  const result = publishSingleGameProfile({
    ...options,
    qualification_scope: "local_live_safety",
  });
  assert.equal(result.search_core, "mcgs");
  assert.equal(result.threads, 3);
  assert.equal(result.search_graph_mb, 64);
  assert.equal(result.mcgs_cpuct_permille, 1500);
  assert.equal(result.mcgs_outstanding_batches, 2);
  assert.equal(result.mcgs_book_prior_blend_permille, 0);
  assert.equal(loadSingleGameProfile(options.output).search_core, "mcgs");
});

test("retains timing authority across provenance-only engine rebuilds", () => {
  const options = fixture("mcgs");
  const timeProfile = JSON.parse(readFileSync(options.time_profile, "utf8"));
  timeProfile.identity.engine.executable_sha256 = `sha256:${"f".repeat(64)}`;
  timeProfile.identity_sha256 = sha256Object(timeProfile.identity);
  writeFileSync(options.time_profile, JSON.stringify(timeProfile));
  rebindCompleteGameTimingProfile(options, false);

  const result = publishSingleGameProfile({
    ...options,
    qualification_scope: "local_live_safety",
  });
  assert.equal(result.qualified, true);
  assert.equal(result.engine_build_fingerprint, sha256("exact-engine"));
});

test("publishes and reloads the exact tablebase contract from complete-game evidence", () => {
  const options = fixture("mcgs");
  const tablebase = attachTablebase(options);
  const result = publishSingleGameProfile({
    ...options,
    qualification_scope: "local_live_safety",
  });
  assert.deepEqual(result.tablebase, tablebase);
  assert.deepEqual(loadSingleGameProfile(options.output).tablebase, tablebase);
});

test("rejects tablebase runtime identity drift without replacing prior authority", () => {
  const options = fixture("mcgs");
  attachTablebase(options);
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, "prior-authority\n");
  const completeGame = JSON.parse(readFileSync(options.complete_game_evidence, "utf8"));
  completeGame.runtime_contract.activation_probe.runtime.syzygy_rule50 = false;
  writeFileSync(options.complete_game_evidence, JSON.stringify(completeGame));
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      qualification_scope: "local_live_safety",
    }),
    /Syzygy rule-50 policy mismatch/,
  );
  assert.equal(readFileSync(options.output, "utf8"), "prior-authority\n");
});

test("rejects V2 cursor evidence presented as MCGS authority", () => {
  const options = fixture("mcgs");
  const completeGame = JSON.parse(readFileSync(options.complete_game_evidence, "utf8"));
  delete completeGame.runtime_contract.activation_probe.runtime.mcgs_async_admissions;
  Object.assign(completeGame.runtime_contract.activation_probe.runtime, {
    v2_cursor_admissions: 4,
    v2_cursor_async_pending: 2,
    v2_cursor_ready_resumes: 2,
  });
  writeFileSync(options.complete_game_evidence, JSON.stringify(completeGame));
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      qualification_scope: "local_live_safety",
    }),
    /MCGS asynchronous admissions/,
  );
});

test("rejects an intermediate timing attempt without replacing prior authority", () => {
  const options = fixture("mcgs");
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, "prior-authoritative-profile\n");
  writeFileSync(options.time_profile, JSON.stringify({
    schema: "uci_time_profile_attempt_v3",
    phase: "diagnostic",
    outcome: "accepted_for_calibration",
  }));
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      qualification_scope: "local_live_safety",
    }),
    /profile schema|uci_time_profile_v3/i,
  );
  assert.equal(readFileSync(options.output, "utf8"), "prior-authoritative-profile\n");
  assert.equal(existsSync(path.join(path.dirname(options.output), "evidence")), false);
});

test("rejects a smoke-sized timing profile without replacing prior authority", () => {
  const options = fixture("mcgs");
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, "prior-authoritative-profile\n");
  const timeProfile = JSON.parse(readFileSync(options.time_profile, "utf8"));
  timeProfile.qualification.repetitions_per_case = 2;
  writeFileSync(options.time_profile, JSON.stringify(timeProfile));
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      qualification_scope: "local_live_safety",
    }),
    /repetitions per case/,
  );
  assert.equal(readFileSync(options.output, "utf8"), "prior-authoritative-profile\n");
  assert.equal(existsSync(path.join(path.dirname(options.output), "evidence")), false);
});

test("rejected publication preserves the prior profile and creates no evidence", () => {
  const options = fixture("mcgs");
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, "prior-authoritative-profile\n");
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      probe_depth: 1,
      qualification_scope: "local_live_safety",
    }),
    /probe depth/,
  );
  assert.equal(readFileSync(options.output, "utf8"), "prior-authoritative-profile\n");
  assert.equal(existsSync(path.join(path.dirname(options.output), "evidence")), false);
});


test("all-NUL complete-game evidence rejects without replacing profile authority", () => {
  const options = fixture("mcgs");
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, "prior-authoritative-profile\n");
  writeFileSync(options.complete_game_evidence, Buffer.alloc(256));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }),
    (error) => error.code === "EXACT_FILE_JSON_INVALID");
  assert.equal(readFileSync(options.output, "utf8"), "prior-authoritative-profile\n");
  assert.equal(existsSync(path.join(path.dirname(options.output), "evidence")), false);
});

test("all-NUL stored profile rejects before startup authority", () => {
  const options = fixture("mcgs");
  mkdirSync(path.dirname(options.output), { recursive: true });
  writeFileSync(options.output, Buffer.alloc(256));
  assert.throws(() => loadSingleGameProfile(options.output),
    (error) => error.code === "EXACT_FILE_JSON_INVALID");
});


test("continuous local-live v2 accepts complete candidate eligibility with partial seeds and bounded ongoing work", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  const profile = publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" });
  assert.equal(profile.schema, "uci_arena_single_game_profile_v2");
  assert.equal(profile.qualification_scope, "local_live_safety");
  assert.equal(loadSingleGameProfile(options.output).schema, "uci_arena_single_game_profile_v2");
});


const continuousFailures = [
  ["unfinalized owning resource report", (d) => { d.resource_isolation.finalized = false; }],
  ["denied owning resource report", (d) => { d.resource_isolation.can_run = false; }],
  ["invented whole-runtime timing authority", (d) => { d.binding.timing_profile.validation_scope = "historical_searched_regime";
    d.binding.timing_profile.validation_schema = "uci_time_profile_searched_regime_runtime_status_v1";
    d.binding.timing_profile.configured_opening_book_enabled = true; }],
  ["contradictory fixed-container owners", (d) => { for (const game of d.games) {
    for (const o of [game.startup_probe.observation, ...game.transitions.map((t) => t.observation)]) {
      o.evaluation.lifetime_identity = "7"; o.evaluation.queue_owner_lifetime_identity = "8";
      o.cache.owner_lifetime_identity = "9";
    }
  } }],
  ["legal model movetime overspend", (d) => { d.games[1].publications[0].elapsed_ms = 29000; }],
  ["legal opponent movetime overspend", (d) => { d.games[0].transitions[1].publication_elapsed_ms = 29000; }],
  ["startup movetime overspend", (d) => { d.games[1].startup_probe.publication.elapsed_ms = 29000; }],
  ["dirty tool source", (d) => { d.producer.source_clean = false; }],
  ["wrong opponent bytes", (d) => { d.binding.opponent.sha256 = `sha256:${"f".repeat(64)}`; }],
  ["wrong referee bytes", (d) => { d.binding.referee.sha256 = `sha256:${"f".repeat(64)}`; }],
  ["undeclared arbitrary model metadata", (d) => { d.binding.model.files.push({ path: path.join(d.binding.model.root, "undeclared-public.json"), sha256: `sha256:${"f".repeat(64)}` }); }],
  ["missing model checkpoint closure", (d) => { d.binding.model.files = d.binding.model.files.filter((file) => path.basename(file.path) !== "checkpoint_manifest.json"); }],
  ["missing runtime fingerprint closure", (d) => { d.binding.model.files = d.binding.model.files.filter((file) => path.basename(file.path) !== "deployment_source_fingerprint.json"); }],
  ["missing ONNX closure", (d) => { d.binding.model.files = d.binding.model.files.filter((file) => !file.path.endsWith(".onnx")); }],
  ["mutated public tool closure", (d) => { writeFileSync(d.producer.entrypoint.path, "changed after qualification"); }],
  ["forbidden secret closure path", (d) => { d.producer.source_files.push({ path: "secrets/lichess_bot_token.txt", sha256: `sha256:${"f".repeat(64)}` }); }],
  ["outside source closure path", (d) => { d.producer.source_files.push({ path: "../outside.mjs", sha256: `sha256:${"f".repeat(64)}` }); }],
  ["invented active final residue", (d) => { const s = d.games[0].startup_probe.observation.search;
    s.final_residue_available = true; s.final_residue = 0; }],
  ["changed reservation capacity", (d) => { d.games[0].transitions[0].observation.search.reservation_capacity = 128; }],
  ["changed ticket capacity", (d) => { d.games[0].transitions[0].observation.evaluation.ticket_capacity = 64; }],
  ["changed cache capacity", (d) => { d.games[0].transitions[0].observation.cache.capacity = 256; }],
  ["changed payload budget", (d) => { d.games[0].transitions[0].observation.cache.policy_payload_budget_bytes = 1024; }],
  ["unconsumed white startup move", (d) => { d.games[0].startup_probe.publication.move = "e2e4"; }],
  ["omitted initial repetition prefix", (d) => { for (const game of d.games) {
    game.startup_probe.observation.history_length -= 1;
    for (const transition of game.transitions) transition.observation.history_length -= 1;
  } }],
  ["out-of-domain focus sequence", (d) => { const visit = (value) => {
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "transition_sequence")) value.transition_sequence = "4294967296";
      for (const item of Object.values(value)) visit(item);
    }
  }; visit(d); }],
  ["wrong native focus", (d) => { d.games[0].publications[0].native_focus.position_key = "999"; }],
  ["omitted candidate", (d) => { d.games[0].publications[0].candidates.candidate_count -= 1; }],
  ["wrong candidate digest", (d) => { d.games[0].publications[0].candidates.candidate_moves_sha256 = `sha256:${"f".repeat(64)}`; }],
  ["queue owner replacement", (d) => { d.games[0].transitions[0].observation.evaluation.queue_owner_lifetime_identity = "2"; }],
  ["generation invalidation", (d) => { d.games[0].transitions[0].observation.evaluation.generation = "2"; }],
  ["missing receipt", (d) => { d.games[0].shutdown.completion = null; }],
  ["failed receipt", (d) => { d.games[0].shutdown.completion.execution_failed = true; }],
  ["configured inactive tablebase", (d) => { d.binding.knowledge.syzygy_path = path.dirname(d.binding.engine.path); d.binding.effective_options.model.SyzygyPath = d.binding.knowledge.syzygy_path; }],
  ["resource overflow", (d) => { d.games[0].startup_probe.observation.evaluation.active_tickets = 33; }],
  ["forced child close", (d) => { d.games[0].shutdown.forced = true; }],
  ["unclosed stdio", (d) => { d.games[0].shutdown.stdio_closed = false; }],
  ["hardware drift", (d) => { d.binding.model.hardware_driver_fingerprint = "7890"; }],
  ["unapplied timing", (d) => { d.binding.timing_profile.applied = false; }],
  ["unqualified book resolution", (d) => { d.games[0].publications[0].completion_source = "opening_book";
    d.games[0].publications[0].timing_applicability = "non_search_resolved"; }],
  ["incomplete color pair", (d) => { d.games.pop(); }],
  ["invented native field", (d) => { d.games[0].startup_probe.observation.invented = 1; }],
  ["promotion of diagnostic authority", (d) => { d.authority.release = true; }],
  ["wrong accepted history", (d) => { d.games[0].transitions[1].observation.accepted_position_command_sha256 = `sha256:${"f".repeat(64)}`; }],
  ["wrong raw en-passant", (d) => { d.games[0].transitions[1].observation.admitted_fen = d.games[0].transitions[1].observation.admitted_fen.replace(" e6 ", " - "); }],
];

test("continuous forbidden tablebase manifest rejects before any declared file is hashed or read", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  diagnostic.binding.knowledge.syzygy_active = true;
  diagnostic.binding.knowledge.syzygy_manifest = path.join(path.dirname(options.engine), "secrets", "synthetic-private.key");
  const calls = [];
  assert.throws(() => validateContinuousGameDiagnostic(diagnostic, { fileAuthority: {
    hashExactFileSync: (...args) => { calls.push(args); throw new Error("must not hash"); },
    readExactJsonSync: (...args) => { calls.push(args); throw new Error("must not read"); },
  } }), /forbidden/);
  assert.deepEqual(calls, []);
});

for (const alias of ["secrets.", "credentials "]) {
  test(`continuous private Windows path alias ${JSON.stringify(alias)} rejects before IO`, () => {
    const options = fixture("mcgs");
    const diagnostic = continuousDiagnosticFixture(options);
    diagnostic.producer.source_files.push({ path: `tools/${alias}/synthetic-private.json`, sha256: `sha256:${"f".repeat(64)}` });
    const calls = [];
    assert.throws(() => validateContinuousGameDiagnostic(diagnostic, { fileAuthority: {
      hashExactFileSync: (...args) => { calls.push(args); throw new Error("must not hash"); },
      readExactJsonSync: (...args) => { calls.push(args); throw new Error("must not read"); },
    } }), /ambiguous|forbidden/);
    assert.deepEqual(calls, []);
  });
}

test("applying continuous profile rejects a changed literal launch argument without substituting context", () => {
  const options = fixture("mcgs");
  writeFileSync(options.complete_game_evidence, JSON.stringify(continuousDiagnosticFixture(options)));
  publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" });
  const config = { engine: { executable: options.engine, single_game_profile: options.output,
    working_directory: path.dirname(options.engine), arguments: ["--changed-context"],
    uci_options: { ModelRoot: options.model_root, McgsTemporalWeightProfile: "EarlyCurrent", OwnBook: false } } };
  assert.throws(() => applySingleGameProfile(config), /literal argument vector/);
});

function continuousCapacityFixture(scoped = true, continuousTiming = false) {
  const options = fixture("mcgs");
  if (continuousTiming) {
    const timing = JSON.parse(readFileSync(options.time_profile, "utf8"));
    continuousTimingProfileFixture(timing);
    writeFileSync(options.time_profile, JSON.stringify(timing));
  }
  const diagnostic = continuousDiagnosticFixture(options);
  if (scoped) Object.assign(diagnostic.binding.timing_profile, {
    validation_scope: continuousTiming ? "continuous_searched_regime" : "historical_searched_regime",
    validation_schema: continuousTiming ? "uci_time_profile_continuous_searched_regime_runtime_status_v1"
      : "uci_time_profile_searched_regime_runtime_status_v1" });
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" });
  const single = loadSingleGameProfile(options.output);
  const processIdentity = { schema: "uci_arena_process_instance_identity_v1", platform: "linux", pid: 123,
    start_token: "12345", executable_path: options.engine, boot_id: "explicit-synthetic-fixture" };
  const observed = diagnostic.games[0].startup_probe.observation;
  const status = { qualified: true, engine_process_identity: processIdentity,
    continuous_observation: observed, bestmove: "e2e4", go_to_bestmove_ms: 500,
    continuous_candidates: { count: 20, moves_sha256: diagnostic.games[0].startup_probe.publication.candidates.canonical_moves_sha256,
      focus: observed.focus }, model_asset_observation: { model_asset_declaration_supported: true,
      model_selected_artifact: "model.onnx", model_required_artifacts: [...diagnostic.binding.model.asset_declaration.required_relative_files] },
    time_profile: { ...diagnostic.binding.timing_profile, schema: diagnostic.binding.timing_profile.validation_schema, status: "qualified" },
    qualification_cleanup: { clean_exit: true, exit_observed: true, close_observed: true,
      exit_code: 0, exit_signal: null, forced_termination: false, cleanup_diagnostics: [],
      engine_process_identity: processIdentity, execution_completion: diagnostic.games[0].shutdown } };
  if (scoped) delete status.time_profile.timing_authority_match;
  const config = { engine: { executable: options.engine, time_profile: options.time_profile,
    time_profile_status: { ...status.time_profile, profile_path: options.time_profile } }, capacity: { total_slots: 1 } };
  return { options, single, status, config, diagnostic, target: path.join(path.dirname(options.output), "capacity.json") };
}

const oneBotCapacity = { total_slots: 1, startup_parallelism: 1,
  human: { slots: 0, allow_borrowing: false, accept_public: false }, bot: { slots: 1, target_active: 1 } };

function evidenceAdoptionFixture(totalSlots = 2) {
  const item = continuousCapacityFixture();
  publishCapacityProfile(item.target, 1, item.config, item.single, [item.status]);
  const raw = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  raw.engine.executable = item.options.engine;
  raw.engine.working_directory = path.dirname(item.options.engine);
  raw.engine.component_manifest = null;
  raw.engine.uci_options.ModelRoot = item.options.model_root;
  raw.engine.uci_options.OwnBook = false;
  if (totalSlots === 1) Object.assign(raw.capacity, oneBotCapacity);
  raw.engine.single_game_profile = path.join(path.dirname(item.options.output), "obsolete-single.json");
  raw.engine.time_profile = path.join(path.dirname(item.options.output), "obsolete-time.json");
  raw.capacity.capacity_profile = path.join(path.dirname(item.options.output), "obsolete-capacity.json");
  for (const file of [raw.engine.single_game_profile, raw.engine.time_profile, raw.capacity.capacity_profile]) writeFileSync(file, "obsolete-evidence");
  const configPath = path.join(path.dirname(item.options.output), "operator-config.json");
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
  const valid = structuredClone(raw);
  Object.assign(valid.capacity, oneBotCapacity, { capacity_profile: item.target });
  valid.engine.single_game_profile = item.options.output;
  valid.engine.time_profile = item.options.time_profile;
  const controlPath = path.join(path.dirname(item.options.output), "qualified-fixture-control.json");
  writeFileSync(controlPath, JSON.stringify(valid));
  assert.equal(managerOptionsProjection(loadManagerConfig({ templatePath: controlPath })).capacity.evidence.qualified, true,
    "synthetic replacement evidence must pass the current complete owner validator before testing adoption");
  return { ...item, raw, configPath, adoption: { templatePath: configPath,
    profilePath: item.options.output, timeProfilePath: item.options.time_profile, capacityProfilePath: item.target,
    settings: { capacity: oneBotCapacity } } };
}

test("operator evidence adoption recovers obsolete bindings atomically with one-slot policy", () => {
  const item = evidenceAdoptionFixture();
  const updated = updateManagerOptions(item.adoption);
  assert.equal(updated.capacity.total_slots, 1);
  assert.equal(updated.capacity.evidence.qualified, true);
  const persisted = JSON.parse(readFileSync(item.configPath, "utf8"));
  assert.equal(persisted.engine.single_game_profile, path.resolve(item.options.output));
  assert.equal(persisted.engine.time_profile, path.resolve(item.options.time_profile));
  assert.equal(persisted.capacity.capacity_profile, path.resolve(item.target));
  assert.equal(persisted.engine.executable, item.raw.engine.executable);
  assert.equal(persisted.engine.component_manifest, item.raw.engine.component_manifest);
  assert.deepEqual(persisted.engine.uci_options, item.raw.engine.uci_options);
  assert.deepEqual(persisted.challenges, item.raw.challenges);
  const loaded = loadRuntimeConfig({ templatePath: item.configPath, environment: {} });
  assert.equal(loaded.engine.single_game_profile, path.resolve(item.options.output));
  const later = updateManagerOptions({ templatePath: item.configPath, settings: { opponent_selection: { rating_target: 2100 } } });
  assert.equal(later.capacity.evidence.qualified, true);
  assert.equal(JSON.parse(readFileSync(item.configPath, "utf8")).engine.time_profile, path.resolve(item.options.time_profile));
});

test("operator evidence adoption validates a fresh bundle even when capacity shape stays unchanged", () => {
  const item = evidenceAdoptionFixture(1);
  const updated = updateManagerOptions({ ...item.adoption, settings: { scheduler: { discovery_interval_seconds: 75 } } });
  assert.equal(updated.capacity.evidence.qualified, true);
  assert.equal(JSON.parse(readFileSync(item.configPath, "utf8")).engine.single_game_profile, path.resolve(item.options.output));
});

test("operator config CLI forwards explicit evidence adoption into the atomic owner", async () => {
  const item = evidenceAdoptionFixture();
  const output = [], previous = console.log;
  console.log = value => output.push(value);
  try {
    assert.equal(await main(["config", "update", "--config", item.configPath,
      "--settings", JSON.stringify(item.adoption.settings), "--profile", item.options.output,
      "--time-profile", item.options.time_profile, "--capacity-profile", item.target]), 0);
  } finally { console.log = previous; }
  assert.equal(JSON.parse(output[0]).capacity.evidence.qualified, true);
  assert.equal(JSON.parse(readFileSync(item.configPath, "utf8")).capacity.capacity_profile, path.resolve(item.target));
});

for (const [label, mutate] of [
  ["missing profile flag", item => { delete item.adoption.profilePath; }],
  ["missing timing flag", item => { delete item.adoption.timeProfilePath; }],
  ["missing capacity flag", item => { delete item.adoption.capacityProfilePath; }],
  ["empty reference", item => { item.adoption.profilePath = ""; }],
  ["private reference", item => { item.adoption.profilePath = path.join(path.dirname(item.configPath), "client-key.json"); }],
  ["ADS reference", item => { item.adoption.profilePath = "C:/public/synthetic-profile.json:auth.json"; }],
  ["unknown timing gates", item => {
    const timing = JSON.parse(readFileSync(item.options.time_profile, "utf8"));
    timing.gates.mcgs_single_owner_passed = false; writeFileSync(item.options.time_profile, JSON.stringify(timing));
  }],
  ["invalid child close", item => {
    const capacity = JSON.parse(readFileSync(item.target, "utf8"));
    capacity.evidence[0].qualification_cleanup.forced_termination = true;
    writeFileSync(item.target, JSON.stringify(capacity));
  }],
  ["global slots exceed actual qualification", item => {
    item.adoption.settings = { capacity: { ...oneBotCapacity, total_slots: 2, startup_parallelism: 2,
      human: { slots: 1, allow_borrowing: false, accept_public: true } } };
  }],
]) {
  test(`operator evidence adoption rejects ${label} without activating config`, () => {
    const item = evidenceAdoptionFixture(1);
    mutate(item);
    const original = readFileSync(item.configPath, "utf8");
    assert.throws(() => updateManagerOptions(item.adoption),
      label === "private reference" || label === "ADS reference" ? /forbidden/ : undefined);
    assert.equal(readFileSync(item.configPath, "utf8"), original);
  });
}

test("operator evidence adoption rejects actual selected engine/model/manifest drift", () => {
  for (const field of ["executable", "model", "component_manifest"]) {
    const item = evidenceAdoptionFixture(1);
    const original = JSON.parse(readFileSync(item.configPath, "utf8"));
    if (field === "model") original.engine.uci_options.ModelRoot = path.join(path.dirname(item.configPath), "different-model");
    else original.engine[field] = path.join(path.dirname(item.configPath), `${field}-different.json`);
    writeFileSync(item.configPath, JSON.stringify(original));
    const retained = readFileSync(item.configPath, "utf8");
    assert.throws(() => updateManagerOptions(item.adoption));
    assert.equal(readFileSync(item.configPath, "utf8"), retained);
  }
});

test("operator evidence adoption cannot replace legacy shared authority with unchecked file paths", () => {
  const item = evidenceAdoptionFixture(1);
  const original = JSON.parse(readFileSync(item.configPath, "utf8"));
  original.capacity.legacy_shared = true;
  writeFileSync(item.configPath, JSON.stringify(original));
  const retained = readFileSync(item.configPath, "utf8");
  assert.throws(() => updateManagerOptions(item.adoption), /legacy shared/);
  assert.equal(readFileSync(item.configPath, "utf8"), retained);
});

test("operator evidence adoption preserves an actual concurrent target edit", () => {
  const item = evidenceAdoptionFixture();
  const concurrent = structuredClone(item.raw); concurrent.scheduler.rating_target = 2345;
  const concurrentBytes = JSON.stringify(concurrent);
  let edited = false;
  const settings = {};
  Object.defineProperty(settings, "capacity", { enumerable: true, get() {
    if (!edited) { edited = true; writeFileSync(item.configPath, concurrentBytes); }
    return oneBotCapacity;
  } });
  assert.throws(() => updateManagerOptions({ ...item.adoption, settings }), /changed/);
  assert.equal(edited, true);
  assert.equal(readFileSync(item.configPath, "utf8"), concurrentBytes);
});

test("operator evidence adoption rejects evidence invalidated before staged validation", () => {
  const item = evidenceAdoptionFixture(1), original = readFileSync(item.configPath, "utf8");
  const settings = {};
  Object.defineProperty(settings, "scheduler", { enumerable: true, get() {
    writeFileSync(item.target, "invalidated-during-update");
    return { discovery_interval_seconds: 75 };
  } });
  assert.throws(() => updateManagerOptions({ ...item.adoption, settings }), /qualified capacity/);
  assert.equal(readFileSync(item.configPath, "utf8"), original);
});

test("continuous capacity v2 round trip binds profile and actual per-child native/model/timing proof", () => {
  const { target, config, single, status } = continuousCapacityFixture();
  publishCapacityProfile(target, 1, config, single, [status]);
  const loaded = loadCapacityProfile(target, config, single);
  assert.equal(loaded.schema, "uci_arena_lichess_capacity_profile_v2");
  assert.equal(loaded.evidence[0].schema, "uci_arena_continuous_runtime_qualification_v1");
  assert.equal(loaded.evidence[0].model_asset_observation.model_selected_artifact, "model.onnx");
});

test("continuous capacity rejects the same Windows child under case/separator aliases before replacement and on load", () => {
  const { target, config, single, status } = continuousCapacityFixture();
  const identity = { schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: 123,
    start_token: "638000000000000000", executable_path: "C:/Public Engine/engine.exe", boot_id: "" };
  status.engine_process_identity = identity;
  status.qualification_cleanup.engine_process_identity = identity;
  publishCapacityProfile(target, 1, config, single, [status]);
  const prior = readFileSync(target);
  const alias = structuredClone(status);
  alias.engine_process_identity.executable_path = identity.executable_path.replaceAll("/", "\\").toUpperCase();
  alias.qualification_cleanup.engine_process_identity = alias.engine_process_identity;
  assert.equal(sameProcessInstance(identity, alias.engine_process_identity), true);
  assert.throws(() => publishCapacityProfile(target, 2, config, single, [status, alias]), /repeats one child/);
  assert.deepEqual(readFileSync(target), prior);
  const retained = JSON.parse(prior);
  retained.maximum_concurrency = 2;
  retained.evidence.push({ ...structuredClone(alias), schema: "uci_arena_continuous_runtime_qualification_v1", child: 2 });
  writeFileSync(target, JSON.stringify(retained));
  assert.throws(() => loadCapacityProfile(target, config, single), /repeats one child/);
  alias.engine_process_identity.start_token = "638000000000000001";
  alias.qualification_cleanup.engine_process_identity = alias.engine_process_identity;
  assert.equal(sameProcessInstance(identity, alias.engine_process_identity), false);
  publishCapacityProfile(target, 2, config, single, [status, alias]);
  assert.equal(loadCapacityProfile(target, config, single).maximum_concurrency, 2);
});

test("continuous capacity retains the exact-runtime public timing branch", () => {
  const { target, config, single, status } = continuousCapacityFixture(false);
  publishCapacityProfile(target, 1, config, single, [status]);
  assert.equal(loadCapacityProfile(target, config, single).evidence[0].time_profile.timing_authority_match, true);
});

for (const [label, mutate] of [
  ["out-of-envelope applied overhead", (status) => { status.time_profile.move_overhead_ms = 99999; }],
  ["wrong Ponder compatibility", (status) => { status.time_profile.ponder_option = false; }],
  ["wrong scoped prior", (status) => { status.time_profile.book_prior_blend_permille = 1; }],
  ["missing native model declaration", (status) => { delete status.model_asset_observation; }],
  ["missing applied timing", (status) => { status.time_profile.applied = false; }],
  ["wrong provider reserve", (status) => { status.time_profile.provider_service_reserve_us -= 1; }],
  ["wrong ended lineage", (status) => { status.qualification_cleanup.execution_completion.completion.execution_lineage = "2"; }],
  ["wrong canonical candidates", (status) => { status.continuous_candidates.count -= 1; }],
]) {
  test(`continuous capacity rejects ${label} before replacing authority and after stored evidence drift`, () => {
    const { target, config, single, status } = continuousCapacityFixture();
    publishCapacityProfile(target, 1, config, single, [status]);
    const prior = readFileSync(target);
    mutate(status);
    assert.throws(() => publishCapacityProfile(target, 1, config, single, [status]));
    assert.deepEqual(readFileSync(target), prior);
    const stored = JSON.parse(prior);
    mutate(stored.evidence[0]);
    writeFileSync(target, JSON.stringify(stored));
    assert.throws(() => loadCapacityProfile(target, config, single));
  });
}

test("continuous DirectML binding retains available FP16 as extra while native selection remains model.onnx", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  const fp16 = path.join(options.model_root, "model.fp16.onnx");
  writeFileSync(fp16, "explicit-synthetic-available-fp16-extra");
  diagnostic.binding.model.files.push({ path: fp16, sha256: sha256(readFileSync(fp16)) });
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  const profile = publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" });
  assert.equal(profile.provider, "directml");
  assert.equal(profile.runtime_binding.model.asset_declaration.selected_relative_file, "model.onnx");
  assert.equal(profile.runtime_binding.model.asset_declaration.required_relative_files.includes("model.fp16.onnx"), false);
});

test("continuous model closure admits only native-declared public binary inputs", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  const relative = "runtime_adapters/chess_v1_dense_planes_symbols.bin";
  const symbols = path.join(options.model_root, relative);
  mkdirSync(path.dirname(symbols), { recursive: true });
  writeFileSync(symbols, "explicit-synthetic-public-adapter-symbols");
  diagnostic.binding.model.files.push({ path: symbols, sha256: sha256(readFileSync(symbols)) });
  diagnostic.binding.model.asset_declaration.required_relative_files.push(relative);
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.equal(publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }).schema, "uci_arena_single_game_profile_v2");
  diagnostic.binding.model.asset_declaration.required_relative_files.pop();
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }), /forbidden type/);
});

for (const relative of ["secrets/synthetic-private.json", "runtime_adapters/credentials /synthetic-private.json", "../outside.json"]) {
  test(`continuous declared model input ${JSON.stringify(relative)} rejects before IO`, () => {
    const options = fixture("mcgs");
    const diagnostic = continuousDiagnosticFixture(options);
    diagnostic.binding.model.asset_declaration.required_relative_files.push(relative);
    const calls = [];
    assert.throws(() => validateContinuousGameDiagnostic(diagnostic, { fileAuthority: {
      hashExactFileSync: (...args) => { calls.push(args); throw new Error("must not hash"); },
      readExactJsonSync: (...args) => { calls.push(args); throw new Error("must not read"); },
    } }), /ambiguous|forbidden|safe public/);
    assert.deepEqual(calls, []);
  });
}

for (const relative of ["client-key.json", "signing-key.json", "private_key.json", "token.json",
  "nested/password-data.json", "nested/credentials-data.json", "keys/service-client-key.json",
  "keys/service-secret.json", ".env.json", "nested/private/assets.json", "model.onnx:auth.json"]) {
  test(`continuous protected required model path ${JSON.stringify(relative)} rejects before any IO`, () => {
    const options = fixture("mcgs");
    const diagnostic = continuousDiagnosticFixture(options);
    diagnostic.binding.model.asset_declaration.required_relative_files.push(relative);
    diagnostic.binding.model.files.push({ path: path.join(options.model_root, relative), sha256: `sha256:${"f".repeat(64)}` });
    const calls = [];
    assert.throws(() => validateContinuousGameDiagnostic(diagnostic, { fileAuthority: {
      hashExactFileSync: (...args) => { calls.push(args); throw new Error("must not hash"); },
      readExactJsonSync: (...args) => { calls.push(args); throw new Error("must not read"); },
    } }), /forbidden|protected|safe public/);
    assert.deepEqual(calls, []);
  });
}

for (const [role, mutate] of [
  ["producer runtime", (diagnostic, alias) => { diagnostic.producer.node_runtime.path = alias; }],
  ["engine executable", (diagnostic, alias) => { diagnostic.binding.engine.path = alias; }],
  ["configured book", (diagnostic, alias) => { diagnostic.binding.knowledge.opening_book_file = alias; }],
]) {
  test(`continuous absolute ADS-shaped ${role} path rejects before any IO`, () => {
    const options = fixture("mcgs");
    const diagnostic = continuousDiagnosticFixture(options);
    mutate(diagnostic, "C:/public/model.onnx:auth.json");
    const calls = [];
    assert.throws(() => validateContinuousGameDiagnostic(diagnostic, { fileAuthority: {
      hashExactFileSync: (...args) => { calls.push(args); throw new Error("must not hash"); },
      readExactJsonSync: (...args) => { calls.push(args); throw new Error("must not read"); },
    } }), /colon|alternate.stream/);
    assert.deepEqual(calls, []);
  });
}

test("continuous public path admission preserves absolute Windows drive context and ordinary model inputs", () => {
  safePublicPath("C:/Public Models/runtime_adapters/contract.json", "public absolute drive context");
  assert.deepEqual(validateModelAssetDeclaration({ supported: true, selected_relative_file: "model.onnx",
    required_relative_files: ["model.onnx", "runtime_adapters/chess_v1_dense_planes_contract.json"] }),
  ["model.onnx", "runtime_adapters/chess_v1_dense_planes_contract.json"]);
});

test("continuous model closure rejects an omitted declared native input", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  diagnostic.binding.model.files = diagnostic.binding.model.files.filter((item) => !item.path.endsWith("model_io_contract.yaml"));
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }), /declared model input/);
});

test("continuous source closure rejects omitted non-entrypoint consumed module", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  diagnostic.producer.source_files = diagnostic.producer.source_files.filter((item) => item.path !== "arena/continuous_complete_game_diagnostic.mjs");
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }), /public source closure membership/);
});

test("continuous historical searched regime preserves actual enabled book and keeps whole-runtime authority false", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  const book = path.join(path.dirname(options.engine), "public-book.bin");
  writeFileSync(book, Buffer.alloc(16));
  Object.assign(diagnostic.binding.knowledge, { opening_book_enabled: true, opening_book_active: true,
    opening_book_file: book, opening_book_identity: "1", files: [{ path: book, sha256: sha256(readFileSync(book)) }] });
  Object.assign(diagnostic.binding.effective_options.model, { OwnBook: "true", BookFile: book, BookStatsFile: "", BookPolicyFile: "" });
  Object.assign(diagnostic.binding.timing_profile, { validation_schema: "uci_time_profile_searched_regime_runtime_status_v1",
    validation_scope: "historical_searched_regime", configured_opening_book_enabled: true,
    timing_authority_match: false, whole_runtime_timing_authority_match: false });
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  const result = publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" });
  assert.equal(result.runtime_binding.effective_options.model.OwnBook, "true");
  assert.equal(loadSingleGameProfile(options.output).runtime_binding.timing_profile.whole_runtime_timing_authority_match, false);
});

async function scopedRuntimeFixture({ profileVersion = TIME_POLICY_VERSION, runtimeVersion = TIME_POLICY_VERSION,
  validationScope = "historical_searched_regime", transformTimingProfile = null, configuredOptions = {} } = {}) {
  const baselineOptions = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(baselineOptions);
  const options = profileVersion === TIME_POLICY_VERSION ? baselineOptions : fixture("mcgs", profileVersion);
  if (transformTimingProfile) {
    const timing = JSON.parse(readFileSync(options.time_profile, "utf8"));
    transformTimingProfile(timing);
    writeFileSync(options.time_profile, `${JSON.stringify(timing, null, 2)}\n`);
  }
  const selected = { ...diagnostic.binding.effective_options.model, OwnBook: "true", "Move Overhead": "650" };
  delete selected.McgsTemporalWeightProfile;
  Object.assign(selected, configuredOptions);
  const engine = new UciEngine({ executable: options.engine, arguments: [], working_directory: path.dirname(options.engine),
    time_profile: options.time_profile, uci_options: selected, timing: { initial_transport_reserve_ms: 650 },
    qualification_profile: { schema: "uci_arena_single_game_profile_v2",
      runtime_binding: { timing_profile: { validation_scope: validationScope,
        schema: JSON.parse(readFileSync(options.time_profile, "utf8")).schema } } } });
  engine.uciIdLines = ["id name explicit synthetic Engine"];
  engine.uciOptionLines = Object.entries(selected).map(([name, value]) => `option name ${name} type string default ${value}`);
  engine.send = () => {};
  engine.exchange = async () => "readyok";
  engine.appliedUciOptions = { Ponder: "true", "Move Overhead": "650" };
  engine.runtimeStatus = async () => ({ schema: "uci_runtime_status_v1", timing_contract_version: runtimeVersion,
    model_loaded: true, model_id: "model-a", model_fingerprint: "123", adapter_id: "adapter-a",
    provider_requested: "directml", provider_effective: "directml", provider_numeric_fingerprint: "456",
    hardware_driver_fingerprint: "789", onnx_runtime_version: "1.2.3", search_core_configured: "mcgs",
    threads_configured: 3, root_workers_configured: 1, split_depth_configured: 2,
    batch_size_configured: 64, batch_size_effective: 64, batch_wait_us_configured: 0, batch_wait_us_effective: 0,
    background_search: false, mcgs_time_policy_configured: "RelativeClockTemporalV1", search_graph_mb_configured: 64,
    mcgs_cpuct_permille_configured: 1500, mcgs_outstanding_batches_configured: 2,
    mcgs_book_prior_blend_permille_configured: 0, opening_book_enabled: true,
    ponder_option_configured: true, move_overhead_ms_configured: 650,
    time_profile_provider_reserve_us: Number(engine.appliedUciOptions.TimeProfileProviderReserveUs ?? 0),
    time_profile_backup_emit_reserve_us: Number(engine.appliedUciOptions.TimeProfileBackupEmitReserveUs ?? 1000),
    time_profile_iteration_forecast_scale_permille: Number(engine.appliedUciOptions.TimeProfileIterationForecastScalePermille ?? 1000) });
  const result = await engine.configureTimeProfile();
  return { engine, diagnostic, options, result };
}

function continuousTimingProfileFixture(profile) {
  // Synthetic conformance data for the draft public owner v4 fixture, not real qualification.
  const cases = ["startpos", "complex_kiwipete", "forced_response", "low_budget_startpos", "relative_clock_surplus"];
  profile.schema = "uci_time_profile_v4";
  profile.qualification_regime = "continuous_mcgs_provider_deadline_v1";
  profile.qualification = { repetitions_per_case: 30, cases, authority: {
    predictive_controller_promotion: false, provider_default_tuning: false, strength_promotion: false,
    allocation_strategy: false, minimum_useful_blocks: false, adaptive_timing: false,
  } };
  profile.permissions = { provider_safety_qualified: true, forecast_shadow_qualified: true, adaptive_play_qualified: false };
  profile.samples = cases.flatMap(case_id => [250, 650, 700, 1500].flatMap(move_overhead_ms =>
    Array.from({ length: 30 }, (_, index) => ({ case_id, move_overhead_ms, repetition: index,
      temperature: index === 0 ? "cold_process" : "warm_process",
      timing_applicability: case_id === "forced_response" ? "non_search_resolved" : "search_derived" }))));
  for (const gate of ["continuous_case_population_passed", "continuous_focus_candidates_passed", "continuous_publication_fence_passed",
    "continuous_live_resource_bounds_passed", "continuous_joined_completion_passed", "continuous_normal_close_passed",
    "continuous_search_work_passed", "continuous_async_provider_work_passed", "continuous_temporal_compatibility_passed"]) profile.gates[gate] = true;
  for (const gate of ["mcgs_policy_only_fallback_passed", "mcgs_single_owner_passed",
    "mcgs_low_budget_fallback_passed", "mcgs_deterministic_fallback_passed"]) profile.gates[gate] = false;
}

test("Bot applies explicit continuous v4 timing through its actual runtime boundary", async () => {
  const { result, options } = await scopedRuntimeFixture({
    validationScope: "continuous_searched_regime", transformTimingProfile: continuousTimingProfileFixture,
  });
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.applied, true);
  assert.equal(result.schema, "uci_time_profile_continuous_searched_regime_runtime_status_v1");
  assert.equal(result.validation_scope, "continuous_searched_regime");
  assert.equal(result.provider_service_reserve_us, 2000);
  assert.equal(result.whole_runtime_timing_authority_match, false);
  assert.equal(result.searched_regime_timing_authority_match, true);
  const retained = JSON.parse(readFileSync(options.time_profile, "utf8"));
  assert.equal(retained.schema, "uci_time_profile_v4");
  assert.equal(retained.gates.mcgs_single_owner_passed, false);
  assert.equal(retained.permissions.adaptive_play_qualified, false);
});

const configuredV4TablebaseOptions = {
  BehaviorProfile: "balanced", McgsTemporalWeightProfile: "EarlyCurrent", ModelBackend: "onnx",
  Syzygy50MoveRule: true, SyzygyInternalProbe: true,
  SyzygyManifest: "E:/syzygy/standard/6/syzygy_manifest_v1.json", SyzygyPath: "E:/syzygy/standard/6",
  SyzygyProbeLimit: 6, SyzygyProbeThreads: 4, SyzygyRootProbe: true,
};

function tablebaseTimingProfileFixture(profile) {
  continuousTimingProfileFixture(profile);
  // Literal immutable qualification shape, independently specified from configured values.
  profile.identity.search.extra_engine_options = {
    BehaviorProfile: "balanced", McgsTemporalWeightProfile: "EarlyCurrent", ModelBackend: "onnx",
    Syzygy50MoveRule: "true", SyzygyInternalProbe: "true",
    SyzygyManifest: "E:/syzygy/standard/6/syzygy_manifest_v1.json", SyzygyPath: "E:/syzygy/standard/6",
    SyzygyProbeLimit: "6", SyzygyProbeThreads: "4", SyzygyRootProbe: "true",
  };
  profile.identity_sha256 = sha256Object(profile.identity);
}

test("V4 timing retains every configured tablebase material input through initial and applied validation", async () => {
  const { result, engine, options } = await scopedRuntimeFixture({ validationScope: "continuous_searched_regime",
    transformTimingProfile: tablebaseTimingProfileFixture, configuredOptions: configuredV4TablebaseOptions });
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.applied, true);
  assert.deepEqual(engine.timeProfileConfiguration().extraEngineOptions, {
    BehaviorProfile: "balanced", McgsTemporalWeightProfile: "EarlyCurrent", ModelBackend: "onnx",
    Syzygy50MoveRule: "true", SyzygyInternalProbe: "true",
    SyzygyManifest: "E:/syzygy/standard/6/syzygy_manifest_v1.json", SyzygyPath: "E:/syzygy/standard/6",
    SyzygyProbeLimit: "6", SyzygyProbeThreads: "4", SyzygyRootProbe: "true",
  });
  assert.equal(JSON.parse(readFileSync(options.time_profile)).identity.search.extra_engine_options.SyzygyProbeLimit, "6");
});

for (const [name, wrong] of [["Syzygy50MoveRule", false], ["SyzygyInternalProbe", false],
  ["SyzygyManifest", "E:/other-manifest.json"], ["SyzygyPath", "E:/other-tablebase"],
  ["SyzygyProbeLimit", 5], ["SyzygyProbeThreads", 2], ["SyzygyRootProbe", false], ["SyzygyProbeDepth", 1]]) {
  test(`V4 timing rejects configured ${name} drift against unchanged qualification`, async () => {
    const { result, options } = await scopedRuntimeFixture({ validationScope: "continuous_searched_regime",
      transformTimingProfile: tablebaseTimingProfileFixture, configuredOptions: { ...configuredV4TablebaseOptions, [name]: wrong } });
    assert.equal(result.accepted, false);
    assert.equal(result.applied, false);
    assert.equal(result.provider_service_reserve_us, 0);
    assert.match(result.reason, /extra_engine_options/);
    const retained = JSON.parse(readFileSync(options.time_profile));
    assert.equal(retained.identity.search.extra_engine_options.SyzygyProbeLimit, "6");
  });
}

test("historical V3 timing keeps the existing reserved tablebase projection", async () => {
  const { result, engine } = await scopedRuntimeFixture({ configuredOptions: {
    SyzygyPath: "E:/syzygy/standard/6", SyzygyProbeLimit: 6, SyzygyProbeDepth: 1,
    Syzygy50MoveRule: true, SyzygyRootProbe: true, SyzygyInternalProbe: true,
  } });
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.applied, true);
  assert.deepEqual(engine.timeProfileConfiguration().extraEngineOptions, {});
});

test("V2 profile application retains qualified portable tablebase paths over equivalent raw configuration aliases", () => {
  const options = fixture("mcgs");
  const tablebase = attachTablebase(options);
  const portablePath = tablebase.path.replaceAll("\\", "/");
  const portableManifest = tablebase.manifest.replaceAll("\\", "/");
  const timing = JSON.parse(readFileSync(options.time_profile));
  continuousTimingProfileFixture(timing);
  timing.identity.search.extra_engine_options = {
    McgsTemporalWeightProfile: "EarlyCurrent", Syzygy50MoveRule: "true", SyzygyInternalProbe: "true",
    SyzygyManifest: portableManifest, SyzygyPath: portablePath,
    SyzygyProbeLimit: "3", SyzygyProbeThreads: "2", SyzygyRootProbe: "true",
  };
  timing.identity_sha256 = sha256Object(timing.identity);
  writeFileSync(options.time_profile, JSON.stringify(timing));
  const diagnostic = continuousDiagnosticFixture(options);
  Object.assign(diagnostic.binding.knowledge, {
    syzygy_path: portablePath, syzygy_manifest: portableManifest,
    syzygy_manifest_identity: tablebase.manifest_identity, syzygy_manifest_file_sha256: tablebase.manifest_file_sha256,
    syzygy_active: true, syzygy_loaded_cardinality: 3, syzygy_probe_limit: 3, syzygy_probe_threads: 2,
    syzygy_rule50: true, syzygy_root_probe: true, syzygy_internal_probe: true,
  });
  Object.assign(diagnostic.binding.effective_options.model, {
    SyzygyPath: portablePath, SyzygyManifest: portableManifest,
    SyzygyProbeLimit: "3", SyzygyProbeThreads: "2", Syzygy50MoveRule: "true",
    SyzygyRootProbe: "true", SyzygyInternalProbe: "true",
  });
  Object.assign(diagnostic.binding.timing_profile, { validation_scope: "continuous_searched_regime",
    validation_schema: "uci_time_profile_continuous_searched_regime_runtime_status_v1" });
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  const published = publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" });
  assert.equal(published.tablebase.path, portablePath);
  assert.equal(loadSingleGameProfile(options.output).tablebase.manifest, portableManifest);
  const config = { engine: { executable: options.engine, arguments: [], working_directory: path.dirname(options.engine),
    single_game_profile: options.output, uci_options: { ModelRoot: options.model_root,
      McgsTemporalWeightProfile: "EarlyCurrent", OwnBook: false,
      SyzygyPath: `${tablebase.path}${path.sep}.${path.sep}`,
      SyzygyManifest: `${tablebase.path}${path.sep}.${path.sep}${path.basename(tablebase.manifest)}` } } };
  applySingleGameProfile(config);
  assert.equal(config.engine.uci_options.SyzygyPath, portablePath);
  assert.equal(config.engine.uci_options.SyzygyManifest, portableManifest);
  assert.deepEqual(new UciEngine(config.engine).timeProfileConfiguration(0, 1000, "uci_time_profile_v4").extraEngineOptions,
    timing.identity.search.extra_engine_options);
});

for (const scoped of [false, true]) {
  test(`continuous v4 publisher loader capacity retain their exact ${scoped ? "searched" : "whole"} scope`, () => {
    const { target, config, single, status, options } = continuousCapacityFixture(scoped, true);
    assert.equal(single.schema, "uci_arena_single_game_profile_v2");
    assert.equal(single.runtime_binding.timing_profile.schema, "uci_time_profile_v4");
    assert.equal(single.runtime_binding.timing_profile.validation_scope, scoped ? "continuous_searched_regime" : "exact_runtime");
    assert.equal(JSON.parse(readFileSync(options.time_profile, "utf8")).gates.mcgs_single_owner_passed, false);
    publishCapacityProfile(target, 1, config, single, [status]);
    const accepted = loadCapacityProfile(target, config, single);
    assert.equal(accepted.evidence[0].time_profile.schema, scoped
      ? "uci_time_profile_continuous_searched_regime_runtime_status_v1" : "uci_time_profile_runtime_status_v1");
    assert.equal(accepted.maximum_concurrency, 1);
    const retained = readFileSync(target, "utf8");
    status.time_profile.schema = "uci_time_profile_searched_regime_runtime_status_v1";
    assert.throws(() => publishCapacityProfile(target, 1, config, single, [status]), /scope/);
    assert.equal(readFileSync(target, "utf8"), retained);
  });
}

test("legacy single-game-v1 publisher cannot infer qualification from new v4 timing", () => {
  const options = fixture("mcgs");
  const timing = JSON.parse(readFileSync(options.time_profile, "utf8"));
  continuousTimingProfileFixture(timing); writeFileSync(options.time_profile, JSON.stringify(timing));
  assert.throws(() => publishSingleGameProfile(options), /uci_time_profile_v3/);
});

test("continuous v4 public artifact rejects a mixed timing schema/scope tuple before publication", () => {
  const options = fixture("mcgs"), timing = JSON.parse(readFileSync(options.time_profile, "utf8"));
  continuousTimingProfileFixture(timing); writeFileSync(options.time_profile, JSON.stringify(timing));
  const diagnostic = continuousDiagnosticFixture(options);
  diagnostic.binding.timing_profile.validation_scope = "historical_searched_regime";
  diagnostic.binding.timing_profile.validation_schema = "uci_time_profile_searched_regime_runtime_status_v1";
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  mkdirSync(path.dirname(options.output), { recursive: true }); writeFileSync(options.output, "prior-authority");
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }), /public contract/);
  assert.equal(readFileSync(options.output, "utf8"), "prior-authority");
});

test("Bot retains historical v3 gate failures as rejection instead of inferring continuous permission", async () => {
  const { result } = await scopedRuntimeFixture({ transformTimingProfile(profile) {
    profile.gates.mcgs_single_owner_passed = false;
  } });
  assert.equal(result.accepted, false);
  assert.equal(result.applied, false);
  assert.equal(result.provider_service_reserve_us, 0);
});

test("Bot rejects historical v3 timing labelled as the continuous v4 regime", async () => {
  const { result } = await scopedRuntimeFixture({ validationScope: "continuous_searched_regime" });
  assert.equal(result.accepted, false);
  assert.equal(result.applied, false);
  assert.equal(result.provider_service_reserve_us, 0);
  assert.match(result.reason, /v3 binding and scope/);
});

for (const [label, mutate] of [
  ["false continuous gate", profile => { profile.gates.continuous_normal_close_passed = false; }],
  ["missing continuous gate", profile => { delete profile.gates.continuous_focus_candidates_passed; }],
  ["duplicate sample repetition", profile => { profile.samples[1].repetition = 0; }],
  ["incomplete case population", profile => { profile.samples.pop(); }],
  ["wrong cold process repetition", profile => { profile.samples[0].temperature = "warm_process"; }],
  ["unsupported tuning authority", profile => { profile.qualification.authority.provider_default_tuning = true; }],
  ["unsupported adaptive authority", profile => { profile.permissions.adaptive_play_qualified = true; }],
]) {
  test(`Bot rejects continuous v4 ${label} without applying reserves`, async () => {
    const { result } = await scopedRuntimeFixture({ validationScope: "continuous_searched_regime",
      transformTimingProfile(profile) { continuousTimingProfileFixture(profile); mutate(profile); } });
    assert.equal(result.accepted, false);
    assert.equal(result.applied, false);
    assert.equal(result.provider_service_reserve_us, 0);
    assert.doesNotMatch(result.reason, /unexpected profile schema/,
      "the accepted SDK must reject the v4 defect specifically, not reject every v4 profile as unsupported");
  });
}

test("Bot applies actual reserves through the public scoped operation with book enabled and overhead650", async () => {
  const { result } = await scopedRuntimeFixture();
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.applied, true);
  assert.equal(result.schema, "uci_time_profile_searched_regime_runtime_status_v1");
  assert.equal(result.searched_regime_timing_authority_match, true);
  assert.equal(result.whole_runtime_timing_authority_match, false);
  assert.equal(result.configured_opening_book_enabled, true);
  assert.equal(result.provider_service_reserve_us, 2000);
  assert.equal(Object.hasOwn(result, "timing_authority_match"), false);
});

for (const [profileVersion, runtimeVersion, accepted] of [
  ["persistent_mcgs_relative_clock_temporal_v5", "persistent_mcgs_relative_clock_temporal_v5", true],
  ["persistent_mcgs_relative_clock_temporal_v4", "persistent_mcgs_relative_clock_temporal_v4", true],
  ["persistent_mcgs_relative_clock_temporal_v4", "persistent_mcgs_relative_clock_temporal_v5", false],
  ["persistent_mcgs_relative_clock_temporal_v5", "persistent_mcgs_relative_clock_temporal_v4", false],
  ["persistent_mcgs_relative_clock_temporal_v5", "persistent_mcgs_relative_clock_temporal_v999", false],
  ["persistent_mcgs_relative_clock_temporal_v5", undefined, false],
]) {
  test(`Bot native timing compatibility ${profileVersion}/${runtimeVersion} accepts=${accepted}`, async () => {
    // Null makes the missing runtime fact explicit rather than selecting the default fixture version.
    const { result, engine, options } = await scopedRuntimeFixture({ profileVersion, runtimeVersion: runtimeVersion ?? null });
    assert.equal(result.accepted, accepted, result.reason);
    assert.equal(result.applied, accepted);
    const retained = JSON.parse(readFileSync(options.time_profile, "utf8"));
    assert.equal(retained.identity.time_policy_version, profileVersion);
    if (accepted) {
      assert.equal(result.provider_service_reserve_us, 2000);
      assert.equal(result.searched_regime_timing_authority_match, true);
      assert.equal(result.whole_runtime_timing_authority_match, false);
      assert.equal(engine.config.uci_options.OwnBook, "true");
    } else {
      assert.equal(result.provider_service_reserve_us, 0);
      assert.match(result.reason, /timing_contract_version|time policy|identity mismatch/);
    }
  });
}

test("Bot rejects an unknown stored timing policy before applying reserves", async () => {
  const { result } = await scopedRuntimeFixture({
    profileVersion: "persistent_mcgs_relative_clock_temporal_v999",
    runtimeVersion: "persistent_mcgs_relative_clock_temporal_v999",
  });
  assert.equal(result.accepted, false);
  assert.equal(result.applied, false);
  assert.equal(result.provider_service_reserve_us, 0);
  assert.match(result.reason, /time policy is stale/);
});


async function completeRuntimeContextFixture(continuousTiming = false, timingOverrides = {}) {
  const { engine, diagnostic, options, result } = await scopedRuntimeFixture(continuousTiming ? {
    validationScope: "continuous_searched_regime", transformTimingProfile: continuousTimingProfileFixture, ...timingOverrides,
  } : {});
  assert.equal(result.accepted, true, result.reason);
  const binding = diagnostic.binding;
  Object.assign(binding.timing_profile, { schema: engine.appliedTimeProfile.schema, sha256: sha256(readFileSync(options.time_profile)),
    identity_sha256: engine.appliedTimeProfile.identity_sha256,
    validation_scope: continuousTiming ? "continuous_searched_regime" : "historical_searched_regime",
    validation_schema: result.schema, configured_opening_book_enabled: true,
    timing_authority_match: false, whole_runtime_timing_authority_match: false, move_overhead_ms: 650 });
  binding.engine.uci_id_lines = [...engine.uciIdLines];
  binding.engine.uci_option_declarations_sha256 = sha256(JSON.stringify(engine.uciOptionLines));
  binding.effective_options.model = engine.effectiveOptionValues();
  const book = path.join(path.dirname(options.engine), "public-book.bin");
  writeFileSync(book, Buffer.alloc(16));
  Object.assign(binding.knowledge, { opening_book_enabled: true, opening_book_active: true,
    opening_book_identity: "1", opening_book_file: book, files: [{ path: book, sha256: sha256(readFileSync(book)) }] });
  engine.config.qualification_profile.runtime_binding = binding;
  const status = { ...await engine.runtimeStatus(), ...binding.knowledge,
    model_asset_declaration_supported: true, model_selected_artifact: binding.model.asset_declaration.selected_relative_file,
    model_required_artifacts: [...binding.model.asset_declaration.required_relative_files] };
  return { engine, binding, status };
}

test("continuous game provenance retains actual Ponder and separate applied timing scope", async () => {
  const { engine } = await completeRuntimeContextFixture();
  engine.config.adapter = "uci_arena_extended_v1";
  const config = { engine: engine.config, timing: { opponent_turn_search: false, initial_transport_reserve_ms: 650 } };
  const { provenance } = gameRuntimeProvenance(config, engine);
  assert.equal(provenance.search.applied_uci_options.Ponder, "true");
  assert.equal(provenance.timing.timing_authority_match, false);
  assert.equal(provenance.timing.validation_scope, "historical_searched_regime");
  assert.equal(provenance.timing.searched_regime_timing_authority_match, true);
  assert.equal(provenance.timing.whole_runtime_timing_authority_match, false);
});

test("continuous context validates actual complete declarations, knowledge and applied scoped timing", async () => {
  const { engine, status } = await completeRuntimeContextFixture();
  const result = engine.validateContinuousRuntimeContext(status);
  assert.equal(result.accepted, true);
  assert.equal(result.applied, true);
  assert.equal(result.whole_runtime_timing_authority_match, false);
});

test("continuous v4 actual publication context revalidates applied scope and rejects native reserve drift", async () => {
  const { engine, status } = await completeRuntimeContextFixture(true);
  const accepted = engine.validateContinuousRuntimeContext(status);
  assert.equal(accepted.schema, "uci_time_profile_continuous_searched_regime_runtime_status_v1");
  assert.equal(accepted.validation_scope, "continuous_searched_regime");
  assert.equal(accepted.applied, true);
  status.time_profile_provider_reserve_us += 1;
  assert.throws(() => engine.validateContinuousRuntimeContext(status), /reserve|not applied/);
});

test("continuous V4 runtime context revalidates actual tablebase configuration after reserve application", async () => {
  const { engine, status } = await completeRuntimeContextFixture(true, {
    transformTimingProfile: tablebaseTimingProfileFixture, configuredOptions: configuredV4TablebaseOptions,
  });
  assert.equal(engine.validateContinuousRuntimeContext(status).applied, true);
  engine.config.uci_options.SyzygyRootProbe = false;
  assert.throws(() => engine.validateContinuousRuntimeContext(status), /extra_engine_options.SyzygyRootProbe/);
});

for (const [label, mutate, expected] of [
  ["native selected model drift", (_engine, status) => { status.model_selected_artifact = "model_fp16.onnx"; }, /selected model input/],
  ["native required model input drift", (_engine, status) => { status.model_required_artifacts = status.model_required_artifacts.filter((name) => name !== "model_io_contract.yaml"); }, /required inputs differ/],
  ["additional stateful option", (engine) => engine.uciOptionLines.push("option name NewState type string default extra"), /option set/],
  ["actual option value drift", (engine) => { engine.appliedUciOptions.IterativeTimeController = "true"; }, /option IterativeTimeController/],
  ["declaration byte drift", (engine) => { engine.uciOptionLines = engine.uciOptionLines.map((line) => line.replace("default false", "default false ")); }, /identity\/declarations/],
  ["book activation mismatch", (_engine, status) => { status.opening_book_active = false; }, /knowledge opening_book_active/],
  ["tablebase activation mismatch", (_engine, status) => { status.syzygy_active = true; }, /knowledge syzygy_active/],
  ["native reserve rejection", (_engine, status) => { status.time_profile_provider_reserve_us = 1999; }, /time_profile_provider_reserve_us/],
  ["native current timing rejection", (_engine, status) => { status.mcgs_time_policy_configured = "LegacyFixed"; }, /mcgs_time_policy_configured/],
]) {
  test(`continuous context rejects ${label}`, async () => {
    const { engine, status } = await completeRuntimeContextFixture();
    mutate(engine, status);
    assert.throws(() => engine.validateContinuousRuntimeContext(status), expected);
  });
}

function publicationSequenceFixture(options, { advance = true, source = "search", bookFence = false } = {}) {
  const diagnostic = continuousDiagnosticFixture(options);
  for (const game of diagnostic.games) {
    for (const [index, transition] of game.transitions.entries()) {
      transition.observation.focus.transition_sequence = String(game.model_color === "white" ? 2 * (index + 1) : 3 + 2 * index);
    }
    for (const publication of game.publications) {
      const startupMove = game.model_color === "white" && publication.ply === 1;
      const previous = startupMove ? game.startup_probe.observation : game.transitions[publication.ply - 2].observation;
      const sequence = BigInt(previous.focus.transition_sequence) + (advance && !startupMove ? 1n : 0n);
      publication.current_focus = { ...publication.current_focus, transition_sequence: String(sequence) };
      publication.candidates.focus = { ...publication.current_focus };
      publication.native_focus = { ...publication.current_focus };
      if (!startupMove) {
        publication.completion_source = source;
        if (source === "opening_book") {
          publication.timing_applicability = "non_search_resolved";
          publication.native_focus = bookFence ? { ...publication.current_focus } : null;
          publication.publication_allowed_count = null; publication.policy_moves = null; publication.seeded_moves = null;
        }
      }
    }
    if (game.model_color === "white") game.startup_probe.publication = structuredClone(game.publications[0]);
  }
  if (source === "opening_book") {
    const book = path.join(path.dirname(options.engine), "public-book.bin");
    writeFileSync(book, Buffer.alloc(16));
    Object.assign(diagnostic.binding.knowledge, { opening_book_enabled: true, opening_book_active: true,
      opening_book_file: book, opening_book_identity: "1", files: [{ path: book, sha256: sha256(readFileSync(book)) }] });
    Object.assign(diagnostic.binding.effective_options.model, { OwnBook: "true", BookFile: book, BookStatsFile: "", BookPolicyFile: "" });
    Object.assign(diagnostic.binding.timing_profile, { validation_schema: "uci_time_profile_searched_regime_runtime_status_v1",
      validation_scope: "historical_searched_regime", configured_opening_book_enabled: true,
      timing_authority_match: false, whole_runtime_timing_authority_match: false });
  }
  return diagnostic;
}

for (const optionsShape of [{ advance: true, source: "search" }, { advance: true, source: "fallback" },
  { advance: true, source: "opening_book" }, { advance: true, source: "opening_book", bookFence: true },
  { advance: false, source: "search" }]) {
  test(`same-node publication sequence accepts ${JSON.stringify(optionsShape)}`, () => {
    const options = fixture("mcgs");
    const diagnostic = publicationSequenceFixture(options, optionsShape);
    writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
    assert.equal(publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }).schema,
      "uci_arena_single_game_profile_v2");
  });
}

for (const [label, mutate] of [
  ["backward sequence", (publication) => { publication.current_focus.transition_sequence = "3"; }],
  ["zero sequence", (publication) => { publication.current_focus.transition_sequence = "0"; }],
  ["nondecimal sequence", (publication) => { publication.current_focus.transition_sequence = "not-a-sequence"; }],
  ["UInt32 overflow", (publication) => { publication.current_focus.transition_sequence = "4294967296"; }],
  ["changed node", (publication) => { publication.current_focus.subject_identity = "99"; }],
  ["changed epoch", (publication) => { publication.current_focus.graph_epoch = "2"; }],
  ["changed canonical key", (publication) => { publication.current_focus.position_key = "999"; }],
  ["stale candidate tuple", (publication) => { publication.candidates.focus.transition_sequence = "4"; }],
  ["future candidate tuple", (publication) => { publication.candidates.focus.transition_sequence = "6"; }],
  ["stale native tuple", (publication) => { publication.native_focus.transition_sequence = "4"; }],
  ["future native tuple", (publication) => { publication.native_focus.transition_sequence = "6"; }],
  ["publication at next transition", (publication) => { for (const focus of [publication.current_focus, publication.candidates.focus, publication.native_focus]) focus.transition_sequence = "6"; }],
  ["publication beyond next transition", (publication) => { for (const focus of [publication.current_focus, publication.candidates.focus, publication.native_focus]) focus.transition_sequence = "7"; }],
  ["nonadvancing opponent transition", (_publication, diagnostic) => { diagnostic.games[0].transitions[1].observation.focus.transition_sequence = "2"; }],
]) {
  test(`publication chronology rejects ${label} without replacing prior authority`, () => {
    const options = fixture("mcgs");
    const diagnostic = publicationSequenceFixture(options);
    mutate(diagnostic.games[0].publications[1], diagnostic);
    writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
    mkdirSync(path.dirname(options.output), { recursive: true }); writeFileSync(options.output, "prior-authority");
    assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }));
    assert.equal(readFileSync(options.output, "utf8"), "prior-authority");
  });
}

test("startup publication remains exactly bound to its captured observation", () => {
  const options = fixture("mcgs");
  const diagnostic = publicationSequenceFixture(options);
  const startup = diagnostic.games[1].startup_probe.publication;
  for (const focus of [startup.current_focus, startup.candidates.focus, startup.native_focus]) focus.transition_sequence = "2";
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }), /startup publication focus/);
});

test("non-search publication rejects contradictory optional native fence", () => {
  const options = fixture("mcgs");
  const diagnostic = publicationSequenceFixture(options, { source: "opening_book", bookFence: true });
  diagnostic.games[0].publications[1].native_focus.transition_sequence = "4";
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }));
});

test("continuous pair rejects legal moves after first canonical threefold terminal", () => {
  const options = fixture("mcgs");
  const repeatedPrefix = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];
  const diagnostic = continuousDiagnosticFixture(options, [...repeatedPrefix, "f2f3", "e7e5", "g2g4", "d8h4"]);
  assert.equal(diagnostic.games[0].transitions[7].terminal, true);
  assert.equal(diagnostic.games[0].transitions.at(-1).terminal, true);
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }), /terminal/);
});

for (const field of ["evidence", "model"]) {
  test(`continuous loader rejects forbidden ${field} path before filesystem admission`, () => {
    const options = fixture("mcgs");
    writeFileSync(options.complete_game_evidence, JSON.stringify(continuousDiagnosticFixture(options)));
    publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" });
    const profile = JSON.parse(readFileSync(options.output, "utf8"));
    const forbidden = path.join(path.dirname(options.engine), "secrets", "synthetic-private.json");
    if (field === "evidence") profile.evidence.continuous_game.artifact = forbidden;
    else profile.runtime_binding.model.root = forbidden;
    writeFileSync(options.output, JSON.stringify(profile));
    // The path has no backing file. The public path rejection must precede missing-file/hash/read failure.
    assert.throws(() => loadSingleGameProfile(options.output), /forbidden credential or private path/);
  });
}
for (const [label, mutate] of continuousFailures) {
  test(`continuous v2 rejects ${label} before replacing prior authority`, () => {
    const options = fixture("mcgs");
    const diagnostic = continuousDiagnosticFixture(options);
    mutate(diagnostic);
    writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, "prior-authoritative-profile\n");
    assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }));
    assert.equal(readFileSync(options.output, "utf8"), "prior-authoritative-profile\n");
    assert.equal(existsSync(path.join(path.dirname(options.output), "evidence")), false);
  });
}

test("continuous v2 rejects release scope without replacing prior authority", () => {
  const options = fixture("mcgs");
  writeFileSync(options.complete_game_evidence, JSON.stringify(continuousDiagnosticFixture(options)));
  assert.throws(() => publishSingleGameProfile({ ...options, qualification_scope: "release" }), /local_live_safety only/);
  assert.equal(existsSync(options.output), false);
});


test("continuous v2 retains known individual cancellation and abandon counts without inventing broad cancellation", () => {
  const options = fixture("mcgs");
  const diagnostic = continuousDiagnosticFixture(options);
  for (const game of diagnostic.games) {
    for (const observed of [game.startup_probe.observation, ...game.transitions.map((t) => t.observation)]) {
      observed.evaluation.cancellations = 1;
      observed.evaluation.lease_abandons = 1;
    }
  }
  writeFileSync(options.complete_game_evidence, JSON.stringify(diagnostic));
  assert.equal(publishSingleGameProfile({ ...options, qualification_scope: "local_live_safety" }).schema,
    "uci_arena_single_game_profile_v2");
});
