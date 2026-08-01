import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const PROFILE_SCHEMA = "uci_time_profile_v3";
export const PREVIOUS_PROFILE_SCHEMA = "uci_time_profile_v2";
export const LEGACY_PROFILE_SCHEMA = "uci_time_profile_v1";
export const TIME_POLICY_VERSION = "persistent_mcgs_relative_clock_temporal_v4";
export const REQUIRED_MCGS_TIME_POLICY = "RelativeClockTemporalV1";

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

export function validateStoredProfile(profile) {
  if (![PROFILE_SCHEMA, PREVIOUS_PROFILE_SCHEMA, LEGACY_PROFILE_SCHEMA]
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
  const providerReserveUs = profile.schema === PROFILE_SCHEMA
    ? profile.calibration?.provider_batch_reserve_us
    : profile.schema === PREVIOUS_PROFILE_SCHEMA
      ? profile.calibration?.provider_service_reserve_us
      : profile.calibration?.provider_runtime_status?.conservative_provider_service_reserve_us;
  if (!Number.isSafeInteger(providerReserveUs)
      || providerReserveUs < 1
      || providerReserveUs > 5_000_000) {
    throw new Error("timing profile provider-service reserve is missing or invalid");
  }
  const backupEmitReserveUs = profile.schema === PROFILE_SCHEMA
    ? profile.calibration?.backup_emit_reserve_us
    : 1000;
  if (!Number.isSafeInteger(backupEmitReserveUs)
      || backupEmitReserveUs < 0
      || backupEmitReserveUs > 5_000_000) {
    throw new Error("timing profile backup/emission reserve is missing or invalid");
  }
  if (profile.schema === PROFILE_SCHEMA) {
    if (profile.identity?.time_policy_version !== TIME_POLICY_VERSION) {
      throw new Error(
        `timing profile time policy is stale: ${profile.identity?.time_policy_version ?? "missing"}`,
      );
    }
    if (profile.identity?.search?.search_core === "mcgs"
        && profile.identity?.search?.mcgs?.time_policy
          !== REQUIRED_MCGS_TIME_POLICY) {
      throw new Error("timing profile does not bind RelativeClockTemporalV1");
    }
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
  return {
    time_policy_version: TIME_POLICY_VERSION,
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
    search: materialSearchConfiguration(status, options),
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

function reconcileRelocatedUciDefaults(expected, actual) {
  const expectedEngine = expected?.engine;
  const actualEngine = actual?.engine;
  if (!expectedEngine || !actualEngine
      || expectedEngine.executable_sha256 !== actualEngine.executable_sha256
      || firstDifference(
        expectedEngine.argument_fingerprints,
        actualEngine.argument_fingerprints,
        "identity.engine.argument_fingerprints",
      )
      || firstDifference(
        expectedEngine.uci_identity_lines,
        actualEngine.uci_identity_lines,
        "identity.engine.uci_identity_lines",
      )) {
    return actual;
  }
  return {
    ...actual,
    engine: {
      ...actualEngine,
      uci_option_contract_sha256: expectedEngine.uci_option_contract_sha256,
      engine_build_fingerprint: expectedEngine.engine_build_fingerprint,
    },
  };
}

export function loadTimeProfile(filename, cwd = process.cwd()) {
  const resolvedPath = absolute(filename, cwd);
  const profile = validateStoredProfile(JSON.parse(readFileSync(resolvedPath, "utf8")));
  return { ...profile, profile_path: resolvedPath };
}

export function validateAppliedTimeProfileReserve(profileValue, status) {
  const profile = validateStoredProfile(profileValue);
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
    reason: "exact_runtime_identity_match_and_provider_reserve_applied",
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
    includeMoveOverheadIdentity: profile.schema !== PROFILE_SCHEMA,
  };
  if (profile.schema === PROFILE_SCHEMA) {
    const overhead = Number(configuration?.moveOverheadMs);
    const envelope = profile.applicability.move_overhead_ms;
    if (!Number.isFinite(overhead) || overhead < envelope.minimum || overhead > envelope.maximum) {
      throw new Error(
        `Move Overhead ${overhead} is outside qualified envelope ${envelope.minimum}..${envelope.maximum}`,
      );
    }
  }
  const currentIdentity = reconcileRelocatedUciDefaults(
    profile.identity,
    buildProfileIdentity(
      status,
      { idLines: uciIdLines, optionLines: uciOptionLines },
      engineCommandIdentity(options),
      options,
    ),
  );
  assertMatchingIdentity(profile.identity, currentIdentity);
  return {
    schema: "uci_time_profile_runtime_status_v1",
    status: "accepted",
    accepted: true,
    profile_schema: profile.schema,
    profile_path: profile.profile_path ?? null,
    model_id: currentIdentity.model.model_id,
    identity_sha256: profile.identity_sha256,
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
