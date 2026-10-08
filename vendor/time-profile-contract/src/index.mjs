import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const PROFILE_SCHEMA = "uci_time_profile_v3";
export const CONTINUOUS_TIME_PROFILE_SCHEMA = "uci_time_profile_v4";
export const CONTINUOUS_QUALIFICATION_REGIME = "continuous_mcgs_provider_deadline_v1";
export const CONTINUOUS_QUALIFICATION_CASES = Object.freeze([
  "startpos", "complex_kiwipete", "forced_response", "low_budget_startpos", "relative_clock_surplus",
]);
export const CONTINUOUS_TIMING_GATES = Object.freeze([
  "continuous_case_population_passed", "continuous_focus_candidates_passed", "continuous_publication_fence_passed",
  "continuous_live_resource_bounds_passed", "continuous_joined_completion_passed", "continuous_normal_close_passed",
  "continuous_search_work_passed", "continuous_async_provider_work_passed", "continuous_temporal_compatibility_passed",
]);
export const PREVIOUS_PROFILE_SCHEMA = "uci_time_profile_v2";
export const LEGACY_PROFILE_SCHEMA = "uci_time_profile_v1";
export const TIME_POLICY_VERSION = "persistent_mcgs_relative_clock_temporal_v5";
export const SUPPORTED_TIME_POLICY_VERSIONS = Object.freeze([
  "persistent_mcgs_relative_clock_temporal_v4",
  TIME_POLICY_VERSION,
]);
export const REQUIRED_MCGS_TIME_POLICY = "RelativeClockTemporalV1";

const BASE_TIMING_GATES = Object.freeze([
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
]);

const MCGS_TIMING_GATES = Object.freeze([
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
]);

function modernTimingProfile(profile) {
  return profile?.schema === PROFILE_SCHEMA || profile?.schema === CONTINUOUS_TIME_PROFILE_SCHEMA;
}

export function continuousProfilePopulationPassed(samples, repetitions = 30) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 30 || repetitions > 100 || !Array.isArray(samples)) return false;
  const cells = new Map(CONTINUOUS_QUALIFICATION_CASES.flatMap(caseId => [250, 650, 700, 1500]
    .map(overhead => [`${caseId}:${overhead}`, { cold: 0, warm: 0, indices: new Set() }])));
  for (const sample of samples) {
    const cell = cells.get(`${sample?.case_id}:${sample?.move_overhead_ms}`);
    if (!cell || !["search_derived", "non_search_resolved"].includes(sample?.timing_applicability)) return false;
    if (!Number.isSafeInteger(sample.repetition) || sample.repetition < 0 || sample.repetition >= repetitions
        || cell.indices.has(sample.repetition) || sample.temperature !== (sample.repetition === 0 ? "cold_process" : "warm_process")) return false;
    cell.indices.add(sample.repetition);
    if (sample.temperature === "cold_process") ++cell.cold;
    else if (sample.temperature === "warm_process") ++cell.warm;
    else return false;
  }
  return [...cells.values()].every(cell => cell.cold === 1 && cell.warm === repetitions - 1);
}

function continuousRegimeValid(profile) {
  const qualification = profile?.qualification;
  return profile?.qualification_regime === CONTINUOUS_QUALIFICATION_REGIME
    && profile.identity?.time_policy_version === TIME_POLICY_VERSION
    && profile.identity?.search?.search_core === "mcgs"
    && Array.isArray(qualification?.cases)
    && canonicalJson([...qualification.cases].sort()) === canonicalJson([...CONTINUOUS_QUALIFICATION_CASES].sort())
    && continuousProfilePopulationPassed(profile.samples, qualification.repetitions_per_case)
    && ["predictive_controller_promotion", "provider_default_tuning", "strength_promotion", "allocation_strategy", "minimum_useful_blocks", "adaptive_timing"]
      .every(name => qualification.authority?.[name] === false)
    && typeof profile.permissions?.provider_safety_qualified === "boolean"
    && typeof profile.permissions?.forecast_shadow_qualified === "boolean"
    && profile.permissions?.adaptive_play_qualified === false;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Object(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

export function searchContractFingerprint(identity) {
  if (typeof identity?.time_policy_version !== "string"
      || identity.time_policy_version.length === 0
      || identity?.search === null
      || typeof identity?.search !== "object"
      || Array.isArray(identity.search)) {
    throw new Error("timing profile search contract is incomplete");
  }
  return sha256Object({
    timing_contract_version: identity.time_policy_version,
    search: identity.search,
  });
}

export function timingAuthorityIdentity(identity) {
  const derivedSearchContract = searchContractFingerprint(identity);
  if (identity.search_contract_fingerprint !== undefined
      && identity.search_contract_fingerprint !== derivedSearchContract) {
    throw new Error(
      `timing profile search contract fingerprint mismatch: expected ${derivedSearchContract}`
      + ` got ${identity.search_contract_fingerprint}`,
    );
  }
  return {
    time_policy_version: identity.time_policy_version,
    search_contract_fingerprint: derivedSearchContract,
    model: identity.model,
    provider: identity.provider,
    search: identity.search,
  };
}

function explicitPermission(value, name) {
  if (value === undefined || value === null || !Object.hasOwn(value, name)) return null;
  if (typeof value[name] !== "boolean") {
    throw new Error(`timing profile permission ${name} must be boolean`);
  }
  return value[name];
}

export function timingProfileGatesPassed(profile) {
  if (!modernTimingProfile(profile) || profile.qualified !== true) return false;
  if (profile.schema === CONTINUOUS_TIME_PROFILE_SCHEMA) {
    return continuousRegimeValid(profile)
      && [...BASE_TIMING_GATES, ...CONTINUOUS_TIMING_GATES].every(gate => profile.gates?.[gate] === true);
  }
  const required = profile.identity?.search?.search_core === "mcgs"
    ? [...BASE_TIMING_GATES, ...MCGS_TIMING_GATES]
    : BASE_TIMING_GATES;
  return required.every((gate) => profile.gates?.[gate] === true);
}

export function timingProfilePermissions(profile) {
  const gatesPassed = timingProfileGatesPassed(profile);
  const declared = profile?.permissions;
  if (declared !== undefined
      && (declared === null || typeof declared !== "object" || Array.isArray(declared))) {
    throw new Error("timing profile permissions must be an object");
  }
  const provider = explicitPermission(declared, "provider_safety_qualified");
  const forecast = explicitPermission(declared, "forecast_shadow_qualified");
  const adaptive = explicitPermission(declared, "adaptive_play_qualified");
  return {
    provider_safety_qualified: gatesPassed && provider !== false,
    forecast_shadow_qualified: gatesPassed && forecast !== false,
    adaptive_play_qualified: profile?.schema === CONTINUOUS_TIME_PROFILE_SCHEMA ? false : adaptive === true,
  };
}

export function validateStoredProfile(profile) {
  if (![PROFILE_SCHEMA, CONTINUOUS_TIME_PROFILE_SCHEMA, PREVIOUS_PROFILE_SCHEMA, LEGACY_PROFILE_SCHEMA]
    .includes(profile?.schema)) {
    throw new Error(`unexpected profile schema: ${profile?.schema}`);
  }
  if (profile.qualified !== true || profile.gates?.passed !== true) {
    throw new Error("timing profile is not qualified");
  }
  if (profile.predictive_controller?.enabled_by_profile !== false
      || profile.predictive_controller?.default_enabled !== false) {
    throw new Error("timing profile attempts to enable the predictive controller");
  }
  if (profile.schema === CONTINUOUS_TIME_PROFILE_SCHEMA && !timingProfileGatesPassed(profile)) {
    throw new Error("continuous timing profile regime, population or authority is invalid");
  }
  const providerReserveUs = modernTimingProfile(profile)
    ? profile.calibration?.provider_batch_reserve_us
    : profile.schema === PREVIOUS_PROFILE_SCHEMA
      ? profile.calibration?.provider_service_reserve_us
      : profile.calibration?.provider_runtime_status?.conservative_provider_service_reserve_us;
  if (!Number.isSafeInteger(providerReserveUs)
      || providerReserveUs < 1
      || providerReserveUs > 5_000_000) {
    throw new Error("timing profile provider-service reserve is missing or invalid");
  }
  const backupEmitReserveUs = modernTimingProfile(profile)
    ? profile.calibration?.backup_emit_reserve_us
    : 1000;
  if (!Number.isSafeInteger(backupEmitReserveUs)
      || backupEmitReserveUs < 0
      || backupEmitReserveUs > 5_000_000) {
    throw new Error("timing profile backup/emission reserve is missing or invalid");
  }
  if (modernTimingProfile(profile)) {
    if (!SUPPORTED_TIME_POLICY_VERSIONS.includes(profile.identity?.time_policy_version)) {
      throw new Error(
        `timing profile time policy is stale: ${profile.identity?.time_policy_version ?? "missing"}`,
      );
    }
    if (profile.identity?.search?.search_core === "mcgs"
        && profile.identity?.search?.mcgs?.time_policy
          !== REQUIRED_MCGS_TIME_POLICY) {
      throw new Error("timing profile does not bind RelativeClockTemporalV1");
    }
    timingAuthorityIdentity(profile.identity);
    const overhead = profile.applicability?.move_overhead_ms;
    if (overhead?.minimum !== 250
        || overhead?.maximum !== 1500
        || JSON.stringify(overhead?.tested_values)
          !== JSON.stringify([250, 650, 700, 1500])) {
      throw new Error("timing profile Move Overhead applicability is incomplete");
    }
  }
  const iterationForecastScalePermille = profile.schema === LEGACY_PROFILE_SCHEMA
    ? 1000
    : profile.calibration?.iteration_forecast_scale_permille;
  if (!Number.isSafeInteger(iterationForecastScalePermille)
      || iterationForecastScalePermille < 1000
      || iterationForecastScalePermille > 8000) {
    throw new Error("timing profile iteration forecast scale is missing or invalid");
  }
  const expectedDigest = sha256Object(profile.identity);
  if (profile.identity_sha256 !== expectedDigest) {
    throw new Error(
      `timing profile identity digest mismatch: expected ${expectedDigest} got ${profile.identity_sha256}`,
    );
  }
  return {
    ...profile,
    permissions: timingProfilePermissions(profile),
    calibration: {
      ...profile.calibration,
      provider_service_reserve_us: providerReserveUs,
      provider_batch_reserve_us: providerReserveUs,
      backup_emit_reserve_us: backupEmitReserveUs,
      iteration_forecast_scale_permille: iterationForecastScalePermille,
    },
  };
}

function absolute(filename, cwd = process.cwd()) {
  return isAbsolute(filename) ? filename : resolve(cwd, filename);
}

export function safeModelId(modelId) {
  return typeof modelId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId)
    && modelId !== "."
    && modelId !== "..";
}

export function sha256File(filename) {
  return sha256Bytes(readFileSync(filename));
}

function argumentFingerprint(argument, cwd) {
  const candidate = absolute(argument, cwd);
  try {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { kind: "file", sha256: sha256File(candidate) };
    }
  } catch {
    // Literal arguments remain part of the command identity.
  }
  return { kind: "literal", value: argument };
}

export function engineCommandIdentity(options) {
  const executable = absolute(options.engine, options.cwd);
  if (!existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`engine executable not found: ${executable}`);
  }
  return {
    executable_sha256: sha256File(executable),
    argument_fingerprints: (options.engineArgs ?? []).map(
      (argument) => argumentFingerprint(argument, options.cwd),
    ),
  };
}

function requireDecimalFingerprint(value, label) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || value === "0") {
    throw new Error(`${label} must be a nonzero lossless decimal string`);
  }
}

export function validateRuntimeIdentity(status, options, label = "runtime_status") {
  if (status.model_loaded !== true) throw new Error(`${label}: model_loaded is not true`);
  if (!safeModelId(status.model_id)) throw new Error(`${label}: invalid model_id`);
  requireDecimalFingerprint(status.model_fingerprint, `${label}.model_fingerprint`);
  requireDecimalFingerprint(
    status.provider_numeric_fingerprint,
    `${label}.provider_numeric_fingerprint`,
  );
  requireDecimalFingerprint(
    status.hardware_driver_fingerprint,
    `${label}.hardware_driver_fingerprint`,
  );
  if (typeof status.adapter_id !== "string" || status.adapter_id.length === 0) {
    throw new Error(`${label}: adapter_id is empty`);
  }
  if (typeof status.onnx_runtime_version !== "string" || status.onnx_runtime_version.length === 0) {
    throw new Error(`${label}: onnx_runtime_version is empty`);
  }
  if (typeof status.provider_effective !== "string" || status.provider_effective.length === 0) {
    throw new Error(`${label}: provider_effective is empty`);
  }
  if (!SUPPORTED_TIME_POLICY_VERSIONS.includes(status.timing_contract_version)) {
    throw new Error(
      `${label}.timing_contract_version expected one of ${SUPPORTED_TIME_POLICY_VERSIONS.join(", ")}`
      + ` got ${JSON.stringify(status.timing_contract_version)}`,
    );
  }
  const expectedProfileReserveUs = options.appliedTimeProfileReserveUs ?? 0;
  if (status.time_profile_provider_reserve_us !== expectedProfileReserveUs) {
    throw new Error(
      `${label}.time_profile_provider_reserve_us expected ${expectedProfileReserveUs} got ${status.time_profile_provider_reserve_us}`,
    );
  }
  const expectedForecastScalePermille = options.iterationForecastScalePermille ?? 1000;
  if (status.time_profile_iteration_forecast_scale_permille !== expectedForecastScalePermille) {
    throw new Error(
      `${label}.time_profile_iteration_forecast_scale_permille expected ${expectedForecastScalePermille} got ${status.time_profile_iteration_forecast_scale_permille}`,
    );
  }
  const expected = [
    ["search_core_configured", status.search_core_configured, options.searchCore],
    ["threads_configured", status.threads_configured, options.threads],
    ["root_workers_configured", status.root_workers_configured, options.rootWorkers],
    ["split_depth_configured", status.split_depth_configured, options.splitDepth],
    ["batch_size_configured", status.batch_size_configured, options.batchSize],
    ["batch_wait_us_configured", status.batch_wait_us_configured, options.batchWaitUs],
    ["provider_requested", status.provider_requested, options.provider],
    ["background_search", status.background_search, options.backgroundSearch],
  ];
  for (const [field, actual, wanted] of expected) {
    if (actual !== wanted) {
      throw new Error(`${label}.${field} expected ${JSON.stringify(wanted)} got ${JSON.stringify(actual)}`);
    }
  }
  const expectedBackupEmitReserveUs = options.appliedBackupEmitReserveUs ?? 1000;
  if (status.time_profile_backup_emit_reserve_us !== expectedBackupEmitReserveUs) {
    throw new Error(
      `${label}.time_profile_backup_emit_reserve_us expected ${expectedBackupEmitReserveUs} got ${status.time_profile_backup_emit_reserve_us}`,
    );
  }
  if (options.searchCore === "mcgs") {
    if (status.mcgs_time_policy_configured !== options.mcgsTimePolicy) {
      throw new Error(
        `${label}.mcgs_time_policy_configured expected ${JSON.stringify(options.mcgsTimePolicy)}`
        + ` got ${JSON.stringify(status.mcgs_time_policy_configured)}`,
      );
    }
    for (const [field, actual, wanted] of [
      ["search_graph_mb_configured", status.search_graph_mb_configured, options.searchGraphMb],
      [
        "mcgs_cpuct_permille_configured",
        status.mcgs_cpuct_permille_configured,
        options.mcgsCpuctPermille,
      ],
      [
        "mcgs_outstanding_batches_configured",
        status.mcgs_outstanding_batches_configured,
        options.mcgsOutstandingBatches,
      ],
      [
        "mcgs_book_prior_blend_permille_configured",
        status.mcgs_book_prior_blend_permille_configured,
        options.mcgsBookPriorBlendPermille,
      ],
    ]) {
      if (actual !== wanted) {
        throw new Error(`${label}.${field} expected ${JSON.stringify(wanted)} got ${JSON.stringify(actual)}`);
      }
    }
  }
  if (!Number.isInteger(status.batch_size_effective) || status.batch_size_effective < 1) {
    throw new Error(`${label}.batch_size_effective is invalid`);
  }
  if (!Number.isInteger(status.batch_wait_us_effective) || status.batch_wait_us_effective < 0) {
    throw new Error(`${label}.batch_wait_us_effective is invalid`);
  }
  if (options.expectedModelId && status.model_id !== options.expectedModelId) {
    throw new Error(`${label}.model_id expected ${options.expectedModelId} got ${status.model_id}`);
  }
  if (options.expectedModelFingerprint
      && status.model_fingerprint !== options.expectedModelFingerprint) {
    throw new Error(
      `${label}.model_fingerprint expected ${options.expectedModelFingerprint} got ${status.model_fingerprint}`,
    );
  }
  return status;
}

function materialSearchConfiguration(status, options) {
  const configuration = {
    search_core: status.search_core_configured,
    threads: status.threads_configured,
    root_workers: status.root_workers_configured,
    split_depth: status.split_depth_configured,
    batch_size_configured: status.batch_size_configured,
    batch_size_effective: status.batch_size_effective,
    batch_wait_us_configured: status.batch_wait_us_configured,
    batch_wait_us_effective: status.batch_wait_us_effective,
    provider_requested: status.provider_requested,
    provider_effective: status.provider_effective,
    background_search: status.background_search,
    nn_speculation: options.nnSpeculation,
    opening_book: Boolean(options.ownBook ?? false),
    ponder_option: true,
    iterative_time_controller: false,
    extra_engine_options: canonicalize(options.extraEngineOptions ?? {}),
  };
  if (options.includeMoveOverheadIdentity === true) {
    configuration.move_overhead_ms = options.moveOverheadMs;
  }
  if (options.searchCore === "mcgs") {
    configuration.mcgs = {
      time_policy: status.mcgs_time_policy_configured,
      search_graph_mb: status.search_graph_mb_configured,
      cpuct_permille: status.mcgs_cpuct_permille_configured,
      outstanding_batches: status.mcgs_outstanding_batches_configured,
      book_prior_blend_permille: status.mcgs_book_prior_blend_permille_configured,
    };
  }
  return configuration;
}

export function buildProfileIdentity(status, engine, commandIdentity, options) {
  validateRuntimeIdentity(status, options);
  const uciIdentityLines = [...new Set(engine.idLines)].sort();
  const optionContract = [...new Set(engine.optionLines)].sort();
  const buildEvidence = {
    ...commandIdentity,
    uci_identity_lines: uciIdentityLines,
    uci_option_contract_sha256: sha256Object(optionContract),
  };
  const search = materialSearchConfiguration(status, options);
  return {
    time_policy_version: status.timing_contract_version,
    search_contract_fingerprint: searchContractFingerprint({
      time_policy_version: status.timing_contract_version,
      search,
    }),
    engine: {
      ...buildEvidence,
      engine_build_fingerprint: sha256Object(buildEvidence),
    },
    model: {
      model_id: status.model_id,
      model_fingerprint: status.model_fingerprint,
      adapter_id: status.adapter_id,
    },
    provider: {
      provider_numeric_fingerprint: status.provider_numeric_fingerprint,
      hardware_driver_fingerprint: status.hardware_driver_fingerprint,
      onnx_runtime_version: status.onnx_runtime_version,
    },
    search,
  };
}

function firstDifference(left, right, prefix = "identity") {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return prefix;
    if (left.length !== right.length) return `${prefix}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${prefix}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return `${prefix}.${key}`;
      const difference = firstDifference(left[key], right[key], `${prefix}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return prefix;
}

export function assertMatchingIdentity(expected, actual, label = "timing profile") {
  const difference = firstDifference(expected, actual);
  if (difference) {
    throw new Error(
      `${label} identity mismatch at ${difference}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
    );
  }
}

function engineProvenanceComparison(expected, actual) {
  const executableMatch = expected?.executable_sha256 === actual?.executable_sha256;
  const argumentsMatch = !firstDifference(
    expected?.argument_fingerprints,
    actual?.argument_fingerprints,
    "provenance.argument_fingerprints",
  );
  const identityLinesMatch = !firstDifference(
    expected?.uci_identity_lines,
    actual?.uci_identity_lines,
    "provenance.uci_identity_lines",
  );
  const optionContractMatch =
    expected?.uci_option_contract_sha256 === actual?.uci_option_contract_sha256;
  return {
    exact: executableMatch && argumentsMatch && identityLinesMatch && optionContractMatch,
    executable_match: executableMatch,
    arguments_match: argumentsMatch,
    uci_identity_lines_match: identityLinesMatch,
    uci_option_contract_match: optionContractMatch,
    qualified_executable_sha256: expected?.executable_sha256 ?? null,
    current_executable_sha256: actual?.executable_sha256 ?? null,
    qualified_engine_build_fingerprint: expected?.engine_build_fingerprint ?? null,
    current_engine_build_fingerprint: actual?.engine_build_fingerprint ?? null,
  };
}

export function loadTimeProfile(filename, cwd = process.cwd()) {
  const resolvedPath = absolute(filename, cwd);
  const profile = validateStoredProfile(JSON.parse(readFileSync(resolvedPath, "utf8")));
  return { ...profile, profile_path: resolvedPath };
}

export function validateAppliedTimeProfileReserve(profileValue, status) {
  const profile = validateStoredProfile(profileValue);
  if (modernTimingProfile(profile)
      && status?.timing_contract_version !== profile.identity.time_policy_version) {
    throw new Error(
      `Timing-profile timing_contract_version expected ${profile.identity.time_policy_version}`
      + ` got ${JSON.stringify(status?.timing_contract_version)}`,
    );
  }
  const expectedProviderReserveUs = profile.calibration.provider_service_reserve_us;
  const expectedForecastScalePermille = profile.calibration.iteration_forecast_scale_permille;
  const expectedBackupEmitReserveUs = profile.calibration.backup_emit_reserve_us;
  if (status?.time_profile_provider_reserve_us !== expectedProviderReserveUs) {
    throw new Error(
      `Timing-profile provider reserve was not applied: expected ${expectedProviderReserveUs}, got ${status?.time_profile_provider_reserve_us}`,
    );
  }
  if (status?.time_profile_backup_emit_reserve_us !== expectedBackupEmitReserveUs) {
    throw new Error(
      `Timing-profile backup/emission reserve was not applied: expected ${expectedBackupEmitReserveUs}, got ${status?.time_profile_backup_emit_reserve_us}`,
    );
  }
  if (status?.time_profile_iteration_forecast_scale_permille
      !== expectedForecastScalePermille) {
    throw new Error(
      `Timing-profile iteration forecast scale was not applied: expected ${expectedForecastScalePermille}, got ${status?.time_profile_iteration_forecast_scale_permille}`,
    );
  }
  return {
    schema: "uci_time_profile_runtime_status_v1",
    status: "accepted",
    accepted: true,
    applied: true,
    identity_sha256: profile.identity_sha256,
    provider_service_reserve_us: expectedProviderReserveUs,
    backup_emit_reserve_us: expectedBackupEmitReserveUs,
    iteration_forecast_scale_permille: expectedForecastScalePermille,
    predictive_controller_enabled: false,
    reason: "exact_timing_authority_match_and_provider_reserve_applied",
  };
}

export function timeProfileFallbackStatus(status, reason) {
  if (!new Set(["missing", "rejected"]).has(status)) {
    throw new Error("Timing-profile fallback status must be missing or rejected");
  }
  const message = String(reason ?? "").trim();
  if (!message) throw new Error("Timing-profile fallback reason is required");
  return {
    schema: "uci_time_profile_runtime_status_v1",
    status,
    accepted: false,
    applied: false,
    provider_service_reserve_us: 0,
    backup_emit_reserve_us: 1000,
    iteration_forecast_scale_permille: 1000,
    predictive_controller_enabled: false,
    fallback_policy: "onnx_warmup_seeded_conservative_static",
    reason: message,
  };
}

export function validateProfileRuntimeSnapshot({
  profile: profileValue,
  status,
  executable,
  engineArgs = [],
  cwd = process.cwd(),
  uciIdLines,
  uciOptionLines,
  configuration,
}) {
  const profile = validateStoredProfile(profileValue);
  if (configuration?.iterativeTimeController !== false) {
    throw new Error("Timing-profile consumption requires IterativeTimeController to remain false");
  }
  if (!Array.isArray(uciIdLines) || uciIdLines.length === 0) {
    throw new Error("Timing-profile consumption requires captured UCI id lines");
  }
  if (!Array.isArray(uciOptionLines) || uciOptionLines.length === 0) {
    throw new Error("Timing-profile consumption requires captured UCI option lines");
  }
  const options = {
    ...configuration,
    engine: executable,
    engineArgs,
    cwd,
    iterativeTimeController: false,
    expectedModelId: profile.identity.model.model_id,
    expectedModelFingerprint: profile.identity.model.model_fingerprint,
    includeMoveOverheadIdentity: !modernTimingProfile(profile),
  };
  if (modernTimingProfile(profile)) {
    const overhead = Number(configuration?.moveOverheadMs);
    const envelope = profile.applicability.move_overhead_ms;
    if (!Number.isFinite(overhead) || overhead < envelope.minimum || overhead > envelope.maximum) {
      throw new Error(
        `Move Overhead ${overhead} is outside qualified envelope ${envelope.minimum}..${envelope.maximum}`,
      );
    }
  }
  const currentIdentity = buildProfileIdentity(
    status,
    { idLines: uciIdLines, optionLines: uciOptionLines },
    engineCommandIdentity(options),
    options,
  );
  const provenance = engineProvenanceComparison(profile.identity.engine, currentIdentity.engine);
  if (modernTimingProfile(profile)) {
    assertMatchingIdentity(
      timingAuthorityIdentity(profile.identity),
      timingAuthorityIdentity(currentIdentity),
      "timing profile authority",
    );
  } else {
    const legacyCurrentIdentity = { ...currentIdentity };
    delete legacyCurrentIdentity.search_contract_fingerprint;
    assertMatchingIdentity(profile.identity, legacyCurrentIdentity);
  }
  return {
    schema: "uci_time_profile_runtime_status_v1",
    status: "accepted",
    accepted: true,
    profile_schema: profile.schema,
    profile_path: profile.profile_path ?? null,
    model_id: currentIdentity.model.model_id,
    identity_sha256: profile.identity_sha256,
    timing_authority_match: true,
    engine_provenance: provenance,
    provider_service_reserve_us: profile.calibration.provider_service_reserve_us,
    backup_emit_reserve_us: profile.calibration.backup_emit_reserve_us,
    iteration_forecast_scale_permille:
      profile.calibration.iteration_forecast_scale_permille,
    uci_options: [
      {
        name: "TimeProfileProviderReserveUs",
        value: profile.calibration.provider_service_reserve_us,
      },
      {
        name: "TimeProfileBackupEmitReserveUs",
        value: profile.calibration.backup_emit_reserve_us,
      },
      {
        name: "TimeProfileIterationForecastScalePermille",
        value: profile.calibration.iteration_forecast_scale_permille,
      },
    ],
    predictive_controller_enabled: false,
    reason: "exact_runtime_identity_match",
  };
}

const SEARCHED_REGIME_SCHEMA = "uci_time_profile_searched_regime_runtime_status_v1";
const DOWNSTREAM_BOOK_OPTIONS = new Set([
  "ownbook", "bookfile", "bookstatsfile", "bookpolicyfile", "bookseed", "bookmaxply",
]);

// This is an explicit applicability composition, not a change to v3 identity.
// With zero configured AND native applied prior blend, book resolution cannot
// contribute priors to the qualified searched regime. Resolved publications are
// separately classified by the native publication owner. Everything else stays
// exact, including tablebase, model, provider and material extra options.
function validateSearchedRegimeRuntimeSnapshot(input, expectedSchema, resultSchema, scope) {
  const profile = validateStoredProfile(input?.profile);
  const configuration = input?.configuration;
  const status = input?.status;
  if (profile.schema !== expectedSchema || profile.identity?.search?.search_core !== "mcgs"
      || profile.identity.search.opening_book !== false
      || configuration?.searchCore !== "mcgs") {
    throw new Error(`Searched regime requires ${expectedSchema === PROFILE_SCHEMA ? "v3" : "v4"} MCGS qualification with opening_book=false`);
  }
  const permissions = timingProfilePermissions(profile);
  if (!permissions.provider_safety_qualified || !permissions.forecast_shadow_qualified) throw new Error("Historical searched regime lacks declared provider/forecast qualification");
  if (typeof configuration.ownBook !== "boolean" || status?.opening_book_enabled !== configuration.ownBook) throw new Error("Actual opening-book configuration differs from native applied state");
  if (configuration.mcgsBookPriorBlendPermille !== 0 || status?.mcgs_book_prior_blend_permille_configured !== 0
      || profile.identity.search.mcgs?.book_prior_blend_permille !== 0) throw new Error("Historical searched regime requires zero actual and qualified book prior blend");
  if (configuration.ponderOption !== true || status?.ponder_option_configured !== true
      || profile.identity.search.ponder_option !== true) throw new Error("Historical searched regime requires exact Ponder publication compatibility=true");
  if (status?.move_overhead_ms_configured !== configuration.moveOverheadMs) throw new Error("Actual Move Overhead differs from native applied state");
  const actualExtras = configuration.extraEngineOptions ?? {};
  const projectedExtras = {};
  for (const [name, value] of Object.entries(actualExtras)) {
    if (DOWNSTREAM_BOOK_OPTIONS.has(name.toLowerCase())) {
      if (name.toLowerCase() === "ownbook" && String(value).toLowerCase() !== String(configuration.ownBook)) throw new Error("Actual OwnBook option contradicts its configuration");
    } else projectedExtras[name] = value;
  }
  // A profile with different historical recipe fields is not reinterpreted.
  if (Object.keys(profile.identity.search.extra_engine_options ?? {}).some(name => DOWNSTREAM_BOOK_OPTIONS.has(name.toLowerCase()))) throw new Error("Historical searched regime profile declares unsupported book-resolution extras");
  const qualifiedConfiguration = { ...configuration, ownBook: false, extraEngineOptions: projectedExtras };
  const accepted = validateProfileRuntimeSnapshot({ ...input, profile, configuration: qualifiedConfiguration });
  const actualIdentity = buildProfileIdentity(status, { idLines: input.uciIdLines, optionLines: input.uciOptionLines }, engineCommandIdentity({ engine: input.executable, engineArgs: input.engineArgs ?? [], cwd: input.cwd ?? process.cwd() }), configuration);
  const wholeMatch = canonicalJson(timingAuthorityIdentity(actualIdentity)) === canonicalJson(timingAuthorityIdentity(profile.identity));
  const { timing_authority_match: ignoredWholeLabel, schema: ignoredSchema, reason: ignoredReason, ...facts } = accepted;
  return {
    ...facts,
    permissions,
    schema: resultSchema,
    validation_scope: scope,
    searched_regime_timing_authority_match: true,
    whole_runtime_timing_authority_match: wholeMatch,
    configured_opening_book_enabled: status.opening_book_enabled,
    qualified_opening_book_enabled: false,
    book_prior_blend_permille: 0,
    ponder_option: status.ponder_option_configured,
    move_overhead_ms: status.move_overhead_ms_configured,
    move_overhead_envelope: { minimum: profile.applicability.move_overhead_ms.minimum, maximum: profile.applicability.move_overhead_ms.maximum, tested_values: [...profile.applicability.move_overhead_ms.tested_values] },
    actual_search_contract_fingerprint: actualIdentity.search_contract_fingerprint,
    qualified_search_contract_fingerprint: searchContractFingerprint(profile.identity),
    actual_configuration_sha256: sha256Object(configuration),
    reason: scope === "historical_searched_regime" ? "explicit_historical_searched_regime_applicability" : "explicit_continuous_searched_regime_applicability",
  };
}

export function validateHistoricalSearchedRegimeRuntimeSnapshot(input) {
  return validateSearchedRegimeRuntimeSnapshot(input, PROFILE_SCHEMA, SEARCHED_REGIME_SCHEMA, "historical_searched_regime");
}

export function validateContinuousSearchedRegimeRuntimeSnapshot(input) {
  return validateSearchedRegimeRuntimeSnapshot(input, CONTINUOUS_TIME_PROFILE_SCHEMA,
    "uci_time_profile_continuous_searched_regime_runtime_status_v1", "continuous_searched_regime");
}

export function validateAppliedContinuousSearchedRegimeTimeProfileReserve(input) {
  const acceptance = validateContinuousSearchedRegimeRuntimeSnapshot(input);
  const applied = validateAppliedTimeProfileReserve(input.profile, input.status);
  return { ...acceptance, applied: applied.applied, provider_service_reserve_us: applied.provider_service_reserve_us,
    backup_emit_reserve_us: applied.backup_emit_reserve_us, iteration_forecast_scale_permille: applied.iteration_forecast_scale_permille,
    reason: "continuous_searched_regime_validated_and_reserve_applied" };
}

export function validateAppliedSearchedRegimeTimeProfileReserve(input) {
  const acceptance = validateHistoricalSearchedRegimeRuntimeSnapshot(input);
  const applied = validateAppliedTimeProfileReserve(input.profile, input.status);
  return {
    ...acceptance,
    applied: applied.applied,
    provider_service_reserve_us: applied.provider_service_reserve_us,
    backup_emit_reserve_us: applied.backup_emit_reserve_us,
    iteration_forecast_scale_permille: applied.iteration_forecast_scale_permille,
    reason: "historical_searched_regime_validated_and_reserves_applied",
  };
}
