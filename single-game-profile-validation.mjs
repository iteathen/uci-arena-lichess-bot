import { PROFILE_SCHEMA, validateStoredProfile } from "@uci-arena/time-profile-contract";
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function same(value, expected, label) { requireValue(String(value) === String(expected), `${label} mismatch`); }
function requireInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer in ${minimum}..${maximum}`);
}

export function validateTimingProfile(input, checkpoint) {
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
