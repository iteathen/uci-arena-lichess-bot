import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as contract from "../src/index.mjs";

import {
  PROFILE_SCHEMA,
  REQUIRED_MCGS_TIME_POLICY,
  TIME_POLICY_VERSION,
  buildProfileIdentity,
  canonicalJson,
  engineCommandIdentity,
  loadTimeProfile,
  sha256Object,
  timingProfilePermissions,
  timeProfileFallbackStatus,
  validateAppliedTimeProfileReserve,
  validateProfileRuntimeSnapshot,
  validateStoredProfile,
} from "../src/index.mjs";

function searchedRegimeFixture(directory) {
  const executable = path.join(directory, "scoped-engine.exe"); writeFileSync(executable, "scoped fixture");
  const configuration = { searchCore: "mcgs", threads: 2, rootWorkers: 1, splitDepth: 2, searchGraphMb: 64, mcgsCpuctPermille: 1500, mcgsOutstandingBatches: 2, mcgsBookPriorBlendPermille: 0, mcgsTimePolicy: REQUIRED_MCGS_TIME_POLICY, batchSize: 32, batchWaitUs: 150, provider: "cpu", backgroundSearch: false, nnSpeculation: false, ownBook: false, ponderOption: true, moveOverheadMs: 300, iterativeTimeController: false, appliedTimeProfileReserveUs: 0, appliedBackupEmitReserveUs: 1000, iterationForecastScalePermille: 1000, extraEngineOptions: { ModelBackend: "onnx", SyzygyManifest: "fixture.manifest", SyzygyProbeThreads: "4" } };
  const status = { timing_contract_version: TIME_POLICY_VERSION, model_loaded: true, model_id: "scoped_model_v1", model_fingerprint: "101", adapter_id: "scoped_adapter_v1", provider_requested: "cpu", provider_effective: "cpu", provider_numeric_fingerprint: "202", hardware_driver_fingerprint: "303", onnx_runtime_version: "fixture", search_core_configured: "mcgs", threads_configured: 2, root_workers_configured: 1, split_depth_configured: 2, search_graph_mb_configured: 64, mcgs_cpuct_permille_configured: 1500, mcgs_outstanding_batches_configured: 2, mcgs_book_prior_blend_permille_configured: 0, mcgs_time_policy_configured: REQUIRED_MCGS_TIME_POLICY, batch_size_configured: 32, batch_size_effective: 32, batch_wait_us_configured: 150, batch_wait_us_effective: 150, background_search: false, opening_book_enabled: false, ponder_option_configured: true, move_overhead_ms_configured: 300, time_profile_provider_reserve_us: 0, time_profile_backup_emit_reserve_us: 1000, time_profile_iteration_forecast_scale_permille: 1000 };
  const uciIdLines = ["id name UCI Arena Engine"], uciOptionLines = ["option name OwnBook type check default true"];
  const identity = buildProfileIdentity(status, { idLines: uciIdLines, optionLines: uciOptionLines }, engineCommandIdentity({ engine: executable, engineArgs: [], cwd: directory }), configuration);
  const gates = Object.fromEntries("legal_moves nonterminal_null_moves controller_disabled provider_timing_captured provider_service_reserve_valid applied_provider_service_reserve_covered applied_backup_emit_reserve_covered p99_deadline_overshoot_passed maximum_deadline_overshoot_passed passed mcgs_root_coverage_passed mcgs_policy_only_fallback_passed mcgs_graph_population_passed mcgs_async_overlap_passed mcgs_single_owner_passed mcgs_low_budget_fallback_passed mcgs_deterministic_fallback_passed mcgs_completion_integrity_passed mcgs_temporal_policy_passed mcgs_deadline_tail_telemetry_passed".split(" ").map(key => [key, true]));
  const profile = { schema: PROFILE_SCHEMA, qualified: true, gates, predictive_controller: { enabled_by_profile: false, default_enabled: false }, identity, identity_sha256: sha256Object(identity), calibration: { provider_batch_reserve_us: 77000, backup_emit_reserve_us: 2000, iteration_forecast_scale_permille: 1000 }, applicability: { move_overhead_ms: { minimum: 250, maximum: 1500, tested_values: [250, 650, 700, 1500] } } };
  return { profile, status, executable, engineArgs: [], cwd: directory, uciIdLines, uciOptionLines, configuration };
}

test("explicit searched-regime API preserves actual book configuration and old exact rejection", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "time-scoped-regime-"));
  try {
    assert.equal(typeof contract.validateHistoricalSearchedRegimeRuntimeSnapshot, "function");
    assert.equal(typeof contract.validateAppliedSearchedRegimeTimeProfileReserve, "function");
    const input = searchedRegimeFixture(directory);
    input.status.opening_book_enabled = true; input.configuration.ownBook = true;
    input.configuration.extraEngineOptions = { ...input.configuration.extraEngineOptions, OwnBook: "true", BookFile: "actual/book.bin", BookStatsFile: "actual/book.stats", BookPolicyFile: "actual/book.policy" };
    const before = canonicalJson(input);
    assert.throws(() => validateProfileRuntimeSnapshot(input), /identity mismatch/);
    const accepted = contract.validateHistoricalSearchedRegimeRuntimeSnapshot(input);
    assert.equal(accepted.schema, "uci_time_profile_searched_regime_runtime_status_v1");
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.validation_scope, "historical_searched_regime");
    assert.equal(accepted.searched_regime_timing_authority_match, true);
    assert.equal(accepted.whole_runtime_timing_authority_match, false);
    assert.equal(accepted.configured_opening_book_enabled, true);
    assert.equal(accepted.qualified_opening_book_enabled, false);
    assert.equal("timing_authority_match" in accepted, false);
    assert.equal(canonicalJson(input), before, "caller input/profile bytes must not be mutated");
    const applied = { ...input, configuration: { ...input.configuration, appliedTimeProfileReserveUs: 77000, appliedBackupEmitReserveUs: 2000 }, status: { ...input.status, time_profile_provider_reserve_us: 77000, time_profile_backup_emit_reserve_us: 2000 } };
    assert.equal(contract.validateAppliedSearchedRegimeTimeProfileReserve(applied).applied, true);
    assert.throws(() => contract.validateAppliedSearchedRegimeTimeProfileReserve(input), /not applied/);
    for (const mutate of [x => { x.configuration.ownBook = false; }, x => { x.configuration.mcgsBookPriorBlendPermille = 1; }, x => { x.status.mcgs_book_prior_blend_permille_configured = 1; }, x => { x.configuration.extraEngineOptions.ModelBackend = "different"; }, x => { x.configuration.extraEngineOptions.SyzygyManifest = "different"; }, x => { x.status.provider_numeric_fingerprint = "999"; }, x => { x.profile.identity.search.opening_book = true; }, x => { x.configuration.extraEngineOptions.ModelLeafEvalMaxPly = "1"; }]) {
      const bad = structuredClone(input); mutate(bad);
      assert.throws(() => contract.validateHistoricalSearchedRegimeRuntimeSnapshot(bad));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("canonical JSON is order-independent", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }),
    canonicalJson({ a: { b: 3, y: 2 }, z: 1 }));
});

test("searched-regime validation binds actual Ponder and qualified transport envelope", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "time-scoped-transport-"));
  try {
    const input = searchedRegimeFixture(directory);
    input.configuration.ownBook = true; input.status.opening_book_enabled = true;
    input.configuration.moveOverheadMs = 650; input.status.move_overhead_ms_configured = 650;
    const accepted = contract.validateHistoricalSearchedRegimeRuntimeSnapshot(input);
    assert.equal(accepted.ponder_option, true);
    assert.equal(accepted.move_overhead_ms, 650);
    assert.deepEqual(accepted.move_overhead_envelope, input.profile.applicability.move_overhead_ms);
    for (const mutate of [
      x => { x.configuration.ponderOption = false; }, x => { delete x.configuration.ponderOption; },
      x => { x.status.ponder_option_configured = false; }, x => { delete x.status.ponder_option_configured; },
      x => { x.profile.identity.search.ponder_option = false; }, x => { delete x.profile.identity.search.ponder_option; },
      x => { x.status.move_overhead_ms_configured = 250; }, x => { delete x.status.move_overhead_ms_configured; },
      x => { x.configuration.moveOverheadMs = 1501; x.status.move_overhead_ms_configured = 1501; },
    ]) {
      const bad = structuredClone(input); mutate(bad);
      assert.throws(() => contract.validateHistoricalSearchedRegimeRuntimeSnapshot(bad));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("profile validation fails closed before identity use", () => {
  assert.throws(
    () => validateStoredProfile({ schema: PROFILE_SCHEMA, qualified: false }),
    /not qualified/,
  );
});

test("legacy v3 permission projection is derived only from the complete gate set", () => {
  const baseGates = {
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
  };
  const profile = {
    schema: PROFILE_SCHEMA,
    qualified: true,
    identity: { search: { search_core: "minimax" } },
    gates: baseGates,
  };
  assert.deepEqual(timingProfilePermissions(profile), {
    provider_safety_qualified: true,
    forecast_shadow_qualified: true,
    adaptive_play_qualified: false,
  });
  assert.equal(timingProfilePermissions({
    ...profile,
    permissions: { provider_safety_qualified: false },
  }).provider_safety_qualified, false);
  assert.equal(timingProfilePermissions({
    ...profile,
    gates: { ...baseGates, provider_timing_captured: false },
    permissions: { provider_safety_qualified: true },
  }).provider_safety_qualified, false);
  assert.throws(
    () => timingProfilePermissions({ ...profile, permissions: { provider_safety_qualified: 1 } }),
    /must be boolean/,
  );
});

test("consumer contract validates an exact relocated runtime without qualifier source", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-time-contract-"));
  try {
    const executable = path.join(directory, "engine.exe");
    writeFileSync(executable, "engine-contract-fixture", "utf8");
    const configuration = {
      searchCore: "mcgs",
      threads: 3,
      rootWorkers: 1,
      splitDepth: 8,
      searchGraphMb: 256,
      mcgsCpuctPermille: 1500,
      mcgsOutstandingBatches: 4,
      mcgsBookPriorBlendPermille: 250,
      mcgsTimePolicy: REQUIRED_MCGS_TIME_POLICY,
      batchSize: 32,
      batchWaitUs: 200,
      provider: "auto",
      backgroundSearch: false,
      nnSpeculation: false,
      moveOverheadMs: 650,
      iterativeTimeController: false,
      appliedTimeProfileReserveUs: 0,
      appliedBackupEmitReserveUs: 1000,
      iterationForecastScalePermille: 1000,
      extraEngineOptions: {},
    };
    const status = {
      timing_contract_version: TIME_POLICY_VERSION,
      model_loaded: true,
      model_id: "latticeknight_fixture",
      model_fingerprint: "101",
      provider_numeric_fingerprint: "202",
      hardware_driver_fingerprint: "303",
      adapter_id: "latticeknight_dense_planes_v1",
      onnx_runtime_version: "fixture-1",
      provider_effective: "cpu",
      provider_requested: "auto",
      search_core_configured: "mcgs",
      threads_configured: 3,
      root_workers_configured: 1,
      split_depth_configured: 8,
      search_graph_mb_configured: 256,
      mcgs_cpuct_permille_configured: 1500,
      mcgs_outstanding_batches_configured: 4,
      mcgs_book_prior_blend_permille_configured: 250,
      mcgs_time_policy_configured: REQUIRED_MCGS_TIME_POLICY,
      batch_size_configured: 32,
      batch_size_effective: 32,
      batch_wait_us_configured: 200,
      batch_wait_us_effective: 200,
      background_search: false,
      time_profile_provider_reserve_us: 0,
      time_profile_backup_emit_reserve_us: 1000,
      time_profile_iteration_forecast_scale_permille: 1000,
    };
    const uciIdLines = ["id name UCI Arena Engine"];
    const uciOptionLines = ["option name SearchCore type combo default mcgs"];
    const identity = buildProfileIdentity(
      status,
      { idLines: uciIdLines, optionLines: uciOptionLines },
      engineCommandIdentity({ engine: executable, engineArgs: [], cwd: directory }),
      configuration,
    );
    assert.equal(identity.time_policy_version, TIME_POLICY_VERSION);
    const profile = {
      schema: PROFILE_SCHEMA,
      qualified: true,
      gates: { passed: true },
      predictive_controller: { enabled_by_profile: false, default_enabled: false },
      identity,
      identity_sha256: sha256Object(identity),
      calibration: {
        provider_batch_reserve_us: 12_000,
        backup_emit_reserve_us: 2_000,
        iteration_forecast_scale_permille: 1_500,
      },
      applicability: {
        move_overhead_ms: {
          minimum: 250,
          maximum: 1500,
          tested_values: [250, 650, 700, 1500],
        },
      },
    };
    const profilePath = path.join(directory, "profile.json");
    writeFileSync(profilePath, JSON.stringify(profile), "utf8");
    const loaded = loadTimeProfile(profilePath, directory);
    const accepted = validateProfileRuntimeSnapshot({
      profile: loaded,
      status,
      executable,
      cwd: directory,
      uciIdLines,
      uciOptionLines,
      configuration,
    });
    assert.deepEqual(accepted.uci_options.map(({ value }) => value), [12_000, 2_000, 1_500]);
    assert.equal(accepted.engine_provenance.exact, true);

    writeFileSync(executable, "engine-contract-fixture-unrelated-rebuild", "utf8");
    const provenanceDrift = validateProfileRuntimeSnapshot({
      profile: loaded,
      status,
      executable,
      cwd: directory,
      uciIdLines,
      uciOptionLines: [...uciOptionLines, "option name BookStatsFile type string default book.stats"],
      configuration,
    });
    assert.equal(provenanceDrift.timing_authority_match, true);
    assert.equal(provenanceDrift.engine_provenance.exact, false);
    assert.equal(provenanceDrift.engine_provenance.executable_match, false);
    assert.equal(provenanceDrift.engine_provenance.uci_option_contract_match, false);

    const legacyV3Identity = structuredClone(identity);
    delete legacyV3Identity.search_contract_fingerprint;
    const legacyV3 = {
      ...profile,
      identity: legacyV3Identity,
      identity_sha256: sha256Object(legacyV3Identity),
    };
    assert.equal(validateProfileRuntimeSnapshot({
      profile: legacyV3,
      status,
      executable,
      cwd: directory,
      uciIdLines,
      uciOptionLines,
      configuration,
    }).timing_authority_match, true);
    assert.throws(
      () => validateProfileRuntimeSnapshot({
        profile: loaded,
        status: { ...status, timing_contract_version: "changed-timing-contract" },
        executable,
        cwd: directory,
        uciIdLines,
        uciOptionLines,
        configuration,
      }),
      /timing_contract_version/,
    );
    const appliedStatus = {
      ...status,
      time_profile_provider_reserve_us: 12_000,
      time_profile_backup_emit_reserve_us: 2_000,
      time_profile_iteration_forecast_scale_permille: 1_500,
    };
    assert.equal(validateAppliedTimeProfileReserve(loaded, appliedStatus).applied, true);
    assert.equal(timeProfileFallbackStatus("missing", "fixture").accepted, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
