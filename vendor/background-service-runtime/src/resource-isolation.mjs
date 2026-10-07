#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, delimiter, resolve, win32 } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODULE_PATH = fileURLToPath(import.meta.url);
const ATTESTATION_SCHEMA = "uci_arena_gpu_resource_attestation_v1";
const REPORT_SCHEMA = "uci_arena_gpu_resource_isolation_v1";
const RUNNER_LOCK_SCHEMA = "uci_arena_gpu_runner_lock_v1";
const RUNNER_LOCK_SCOPE = "host_account_global_os_temp";
const OWNER_PACKET_TOMBSTONE_MIN_AGE_MS = 30_000;

function nowIso() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function finiteNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function strictInteger(value, label) {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) throw new Error(`${label} must be an integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function strictNumber(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    throw new Error(`${label} must be numeric`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function normalizePath(value) {
  const text = String(value);
  const absolute = win32.isAbsolute(text) ? win32.resolve(text) : resolve(text);
  return absolute.replaceAll("/", "\\").toLowerCase();
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function safeJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")), error: "" };
  } catch (error) {
    return { ok: false, value: null, error: String(error?.message ?? error) };
  }
}

export function readRestaurantOwnerPacket(path, referenceTimeMs = Date.now()) {
  try {
    const raw = readFileSync(path);
    if (raw.length > 0 && raw.every((byte) => byte === 0)) {
      const ageMs = Math.max(0, referenceTimeMs - statSync(path).mtimeMs);
      if (ageMs >= OWNER_PACKET_TOMBSTONE_MIN_AGE_MS) {
        return {
          ok: true,
          value: null,
          error: "",
          tombstone: true,
          tombstone_age_seconds: ageMs / 1_000,
        };
      }
      return {
        ok: false,
        value: null,
        error: `zero-filled owner packet is only ${Math.floor(ageMs)}ms old`,
        tombstone: false,
        tombstone_age_seconds: ageMs / 1_000,
      };
    }
    return {
      ok: true,
      value: JSON.parse(raw.toString("utf8")),
      error: "",
      tombstone: false,
      tombstone_age_seconds: null,
    };
  } catch (error) {
    return {
      ok: false,
      value: null,
      error: String(error?.message ?? error),
      tombstone: false,
      tombstone_age_seconds: null,
    };
  }
}

function unique(values) {
  return [...new Set(values)];
}

function compactProblem(problem, stage) {
  return { at: nowIso(), stage, problem };
}

function retryableBoundaryIdleEvents(events) {
  return events.length > 0 && events.every((event) => (
    event.problem.startsWith("target_gpu_not_idle:")
    || event.problem.startsWith("host_cpu_not_idle:")
    || event.problem.startsWith("host_memory_not_idle:")
  ));
}

async function nvidiaSmi(argumentsList) {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", argumentsList, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout, error: "" };
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? "", error: String(error?.message ?? error) };
  }
}

function parseGpuRows(text) {
  const rows = [];
  const malformed = [];
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length !== 13) {
      malformed.push(`gpu_row_wrong_field_count:${parts.length}`);
      continue;
    }
    const row = {
      index: integer(parts[0]),
      uuid: parts[1],
      name: parts[2],
      driver_version: parts[3],
      gpu_util_percent: finiteNumber(parts[4]),
      memory_controller_util_percent: finiteNumber(parts[5]),
      memory_used_mib: finiteNumber(parts[6]),
      memory_total_mib: finiteNumber(parts[7]),
      temperature_c: finiteNumber(parts[8]),
      graphics_clock_mhz: finiteNumber(parts[9]),
      memory_clock_mhz: finiteNumber(parts[10]),
      power_draw_watts: finiteNumber(parts[11]),
      pstate: parts[12],
    };
    if (row.index === null || !row.uuid || !row.name || !row.driver_version
        || row.gpu_util_percent === null || row.memory_controller_util_percent === null
        || row.memory_used_mib === null || row.memory_total_mib === null
        || row.temperature_c === null || row.graphics_clock_mhz === null
        || row.memory_clock_mhz === null || row.power_draw_watts === null
        || !row.pstate) {
      malformed.push(`gpu_row_invalid_required_field:${line.slice(0, 256)}`);
      continue;
    }
    rows.push(row);
  }
  if (lines.length === 0) malformed.push("gpu_query_returned_no_rows");
  return { rows, malformed };
}

export function parseComputeRows(text, externalRoots) {
  const roots = externalRoots.map(normalizePath);
  const rows = [];
  const malformed = [];
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line && !line.toLowerCase().includes("no running processes"));
  for (const line of lines) {
    const parts = line.split(",").map((value) => value.trim());
    if (parts.length !== 4) {
      malformed.push(`compute_row_wrong_field_count:${parts.length}`);
      continue;
    }
    const row = {
      pid: integer(parts[0]),
      process_name: parts[1],
      used_gpu_memory_mib: finiteNumber(parts[2]),
      gpu_uuid: parts[3],
      configured_external_owner: false,
    };
    if (row.pid === null || row.pid <= 0 || !row.process_name || !row.gpu_uuid) {
      malformed.push(`compute_row_invalid_required_field:${line.slice(0, 256)}`);
      continue;
    }
    if (!row.process_name.startsWith("[")) {
      const normalized = row.process_name.replaceAll("/", "\\").toLowerCase();
      row.configured_external_owner = roots.some(
        (root) => normalized.startsWith(`${root}\\`) || normalized === root,
      );
    }
    rows.push(row);
  }
  return {
    process_count: rows.length,
    processes: rows,
    configured_external_processes: rows.filter((row) => row.configured_external_owner),
    malformed,
  };
}

export function isAdministrativelyCoveredWddmProcess(
  processRow,
  platform = process.platform,
) {
  return platform === "win32"
    && processRow?.used_gpu_memory_mib === null
    && processRow?.configured_external_owner !== true;
}

let previousCpuTotals = null;

function hostSample() {
  const totals = os.cpus().reduce((aggregate, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    aggregate.idle += cpu.times.idle;
    aggregate.total += total;
    return aggregate;
  }, { idle: 0, total: 0 });
  let cpuUtilPercent = null;
  if (previousCpuTotals !== null) {
    const idleDelta = totals.idle - previousCpuTotals.idle;
    const totalDelta = totals.total - previousCpuTotals.total;
    if (totalDelta > 0) {
      cpuUtilPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
    }
  }
  previousCpuTotals = totals;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    cpu_util_percent: cpuUtilPercent,
    logical_cpu_count: os.cpus().length,
    memory_total_bytes: totalMemory,
    memory_available_bytes: freeMemory,
    memory_used_percent: totalMemory > 0
      ? Math.max(0, Math.min(100, ((totalMemory - freeMemory) / totalMemory) * 100))
      : null,
  };
}

async function collectGpuSample(externalRoots) {
  const [gpuResult, processResult] = await Promise.all([
    nvidiaSmi([
      "--query-gpu=index,uuid,name,driver_version,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,clocks.current.graphics,clocks.current.memory,power.draw,pstate",
      "--format=csv,noheader,nounits",
    ]),
    nvidiaSmi([
      "--query-compute-apps=pid,process_name,used_gpu_memory,gpu_uuid",
      "--format=csv,noheader,nounits",
    ]),
  ]);
  const compute = processResult.ok
    ? parseComputeRows(processResult.stdout, externalRoots)
    : { process_count: null, processes: [], configured_external_processes: [], malformed: [] };
  const gpu = gpuResult.ok
    ? parseGpuRows(gpuResult.stdout)
    : { rows: [], malformed: [] };
  return {
    at: nowIso(),
    available: gpuResult.ok && gpu.malformed.length === 0,
    provider: "nvidia_smi",
    error: gpuResult.ok
      ? gpu.malformed.join(";")
      : gpuResult.error,
    process_query_error: processResult.ok
      ? compute.malformed.join(";")
      : processResult.error,
    devices: gpu.rows,
    host: hostSample(),
    compute_process_count: compute.process_count,
    compute_processes: compute.processes,
    configured_external_compute_processes: compute.configured_external_processes,
  };
}

async function processAncestorMap(pids) {
  const targets = unique(pids.filter((pid) => Number.isInteger(pid) && pid > 0));
  if (targets.length === 0) return { ok: true, ancestors: new Map(), error: "" };
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      const parents = new Map(stdout.trim().split(/\r?\n/).map((line) => {
        const [pid, parent] = line.trim().split(/\s+/).map((value) => integer(value));
        return [pid, parent];
      }).filter(([pid, parent]) => pid && parent !== null));
      const ancestors = new Map();
      for (const target of targets) {
        const chain = [];
        const seen = new Set([target]);
        let current = parents.get(target);
        while (current && !seen.has(current)) {
          chain.push(current);
          seen.add(current);
          current = parents.get(current);
        }
        ancestors.set(target, chain);
      }
      return { ok: true, ancestors, error: "" };
    } catch (error) {
      return { ok: false, ancestors: new Map(), error: String(error?.message ?? error) };
    }
  }
  const targetList = targets.join(",");
  const script = [
    `$targets = @(${targetList})`,
    "$parents = @{}",
    "Get-CimInstance Win32_Process | ForEach-Object { $parents[[int]$_.ProcessId] = [int]$_.ParentProcessId }",
    "$rows = foreach ($target in $targets) {",
    "  $chain = @(); $seen = @{}; $current = [int]$target",
    "  while ($parents.ContainsKey($current) -and -not $seen.ContainsKey($current)) {",
    "    $seen[$current] = $true; $current = [int]$parents[$current]",
    "    if ($current -gt 0) { $chain += $current }",
    "  }",
    "  [pscustomobject]@{ pid = [int]$target; ancestors = @($chain) }",
    "}",
    "@($rows) | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
    ], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim() || "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return {
      ok: true,
      ancestors: new Map(rows.map((row) => [
        integer(row.pid),
        (Array.isArray(row.ancestors) ? row.ancestors : [row.ancestors])
          .map((value) => integer(value))
          .filter((value) => value !== null && value > 0),
      ])),
      error: "",
    };
  } catch (error) {
    return { ok: false, ancestors: new Map(), error: String(error?.message ?? error) };
  }
}

function heartbeatAgeSeconds(packet) {
  const heartbeat = finiteNumber(packet?.heartbeat_unix)
    ?? finiteNumber(packet?.service_progress?.heartbeat_unix);
  return heartbeat === null ? null : Math.max(0, Date.now() / 1000 - heartbeat);
}

function packetPids(packet) {
  return unique([
    integer(packet?.pid),
    integer(packet?.cuda_compute_owner_pid),
    integer(packet?.service_progress?.pid),
    integer(packet?.service_progress?.cuda_compute_owner_pid),
    integer(packet?.child_processes?.native_runtime_machinery_owner_pid),
    integer(packet?.worker_pid),
    integer(packet?.worker_process_pid),
    integer(packet?.native_runtime_machinery_owner_pid),
  ].filter((pid) => pid !== null && pid > 0));
}

function packetGpuCapable(packet) {
  const accelerator = String(
    packet?.accelerator_kind ?? packet?.service_progress?.accelerator_kind ?? "",
  ).toLowerCase();
  return ["cuda", "gpu", "directml"].includes(accelerator)
    || packet?.accelerator_required === true
    || packet?.service_progress?.accelerator_required === true
    || packet?.cuda_compute_owner_verified === true
    || packet?.service_progress?.cuda_compute_owner_verified === true;
}

export function compactRestaurantPacket(packet, path) {
  const pids = packetPids(packet);
  const alivePids = pids.filter(processAlive);
  const heartbeatAge = heartbeatAgeSeconds(packet);
  let packetAgeSeconds = null;
  try {
    packetAgeSeconds = Math.max(0, (Date.now() - statSync(path).mtimeMs) / 1000);
  } catch {
    // The owner observation records packet read failures separately.
  }
  const gpuCapable = packetGpuCapable(packet);
  const declaredStatus = String(
    packet?.live_service_status ?? packet?.status ?? packet?.service_progress?.status ?? "unknown",
  );
  const fresh = heartbeatAge !== null && heartbeatAge <= 30;
  return {
    path,
    schema: String(packet?.schema ?? ""),
    status: declaredStatus,
    model_id: String(packet?.active_model_id ?? ""),
    run_id: String(packet?.run_id ?? packet?.service_progress?.run_id ?? ""),
    pids,
    alive_pids: alivePids,
    heartbeat_age_seconds: heartbeatAge,
    packet_age_seconds: packetAgeSeconds,
    iteration_count: integer(packet?.iteration_count ?? packet?.service_progress?.iteration_count),
    train_ms: finiteNumber(packet?.train_ms ?? packet?.service_progress?.train_ms),
    accelerator_kind: String(
      packet?.accelerator_kind ?? packet?.service_progress?.accelerator_kind ?? "",
    ),
    gpu_capable: gpuCapable,
    pid_liveness_authoritative: heartbeatAge === null
      && packetAgeSeconds !== null
      && packetAgeSeconds <= 30,
    active: fresh || (heartbeatAge === null
      && packetAgeSeconds !== null
      && packetAgeSeconds <= 30
      && alivePids.length > 0),
  };
}

function compactRestaurantTombstone(path, ageSeconds) {
  return {
    path,
    schema: "restaurant_zero_filled_shutdown_tombstone_v1",
    status: "inactive_shutdown_tombstone",
    model_id: "",
    run_id: "",
    pids: [],
    alive_pids: [],
    heartbeat_age_seconds: null,
    iteration_count: null,
    train_ms: null,
    accelerator_kind: "",
    gpu_capable: false,
    tombstone: true,
    tombstone_age_seconds: ageSeconds,
    active: false,
  };
}

export function ownerPacketPathIsRelevant(
  path,
  activeCurrentRoot,
  referenceTimeMs = Date.now(),
) {
  if (activeCurrentRoot && resolve(dirname(path)) === resolve(activeCurrentRoot)) return true;
  try {
    return referenceTimeMs - statSync(path).mtimeMs <= OWNER_PACKET_TOMBSTONE_MIN_AGE_MS;
  } catch {
    return true;
  }
}

export function restaurantOwnerObservation(root) {
  const pointerPath = resolve(root, "runtime_state", "active_model_runtime.json");
  if (!existsSync(pointerPath)) {
    return {
      root,
      available: false,
      active: false,
      error: "active runtime pointer is missing",
      packets: [],
    };
  }
  const pointerResult = safeJson(pointerPath);
  if (!pointerResult.ok) {
    return {
      root,
      available: true,
      active: false,
      error: `active runtime pointer unreadable: ${pointerResult.error}`,
      packets: [],
    };
  }
  const runtimeRoot = String(pointerResult.value?.runtime_root ?? "").trim();
  const packetNames = [
    "native_live_runtime_service.json",
    "native_live_runtime_supervisor.json",
    "native_jit_training_live_worker_truth.json",
    "native_jit_training_runtime_owner.json",
    "native_jit_training_worker_supervisor.json",
    "native_runtime_machinery_owner_result.json",
    "native_live_runtime_service_launch.json",
  ];
  const activeCurrentRoot = runtimeRoot ? resolve(root, runtimeRoot, "current") : "";
  const currentRoots = [];
  if (activeCurrentRoot) currentRoots.push(activeCurrentRoot);
  const modelsRoot = resolve(root, "runtime_state", "models");
  if (existsSync(modelsRoot)) {
    try {
      for (const entry of readdirSync(modelsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) currentRoots.push(resolve(modelsRoot, entry.name, "current"));
      }
    } catch {
      // The unreadable models root is reported below when no packets can be verified.
    }
  }
  const packetPaths = unique(currentRoots.flatMap((currentRoot) => {
    const paths = packetNames.map((name) => resolve(currentRoot, name)).filter(existsSync);
    if (!existsSync(currentRoot)) return paths;
    try {
      for (const entry of readdirSync(currentRoot, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!/^native.*(?:runtime|training|machinery|worker|service|supervisor|owner).*\.json$/i.test(
          entry.name,
        )) continue;
        paths.push(resolve(currentRoot, entry.name));
      }
    } catch {
      // The known packet paths still provide fail-closed owner evidence below.
    }
    return paths.filter((path) => ownerPacketPathIsRelevant(path, activeCurrentRoot));
  }));
  const packets = [];
  const errors = [];
  for (const path of packetPaths) {
    const result = readRestaurantOwnerPacket(path);
    if (!result.ok) errors.push(`${path}: ${result.error}`);
    else if (result.tombstone) {
      packets.push(compactRestaurantTombstone(path, result.tombstone_age_seconds));
    }
    else packets.push(compactRestaurantPacket(result.value, path));
  }
  if (!runtimeRoot) errors.push("active runtime pointer has no runtime_root");
  if (packetPaths.length === 0) errors.push("no model runtime has a native resource-owner packet");
  return {
    root,
    available: true,
    active: packets.some((packet) => packet.active),
    error: errors.join("; "),
    active_model_id: String(pointerResult.value?.model_id ?? ""),
    active_run_id: String(pointerResult.value?.active_run_id ?? ""),
    packets,
  };
}

function loadAttestation(path, devices, referenceTimeMs = Date.now()) {
  if (!path) {
    return {
      provided: false,
      path: "",
      sha256: "",
      valid: false,
      gpu_uuid: "",
      problems: ["missing_gpu_isolation_attestation"],
    };
  }
  const absolutePath = resolve(path);
  let raw;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (error) {
    return {
      provided: true,
      path: absolutePath,
      sha256: "",
      valid: false,
      gpu_uuid: "",
      problems: [`gpu_isolation_attestation_unreadable:${error?.message ?? error}`],
    };
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return {
      provided: true,
      path: absolutePath,
      sha256,
      valid: false,
      gpu_uuid: "",
      problems: [`gpu_isolation_attestation_malformed:${error?.message ?? error}`],
    };
  }
  const problems = [];
  if (value?.schema !== ATTESTATION_SCHEMA) problems.push("wrong_attestation_schema");
  if (value?.exclusive_access !== true) problems.push("exclusive_access_not_attested");
  if (value?.exclusive_host_access !== true) problems.push("exclusive_host_access_not_attested");
  if (value?.external_gpu_owners_inactive !== true) {
    problems.push("external_gpu_owners_not_attested_inactive");
  }
  if (value?.production_resource_profile !== "dedicated_full_target_hardware") {
    problems.push("wrong_production_resource_profile");
  }
  if (!String(value?.attested_by ?? "").trim()) problems.push("missing_attested_by");
  const validFrom = Date.parse(String(value?.valid_from ?? ""));
  const expiresAt = Date.parse(String(value?.expires_at ?? ""));
  if (!Number.isFinite(validFrom) || validFrom > referenceTimeMs) {
    problems.push("attestation_not_yet_valid");
  }
  if (!Number.isFinite(expiresAt) || expiresAt < referenceTimeMs) {
    problems.push("attestation_expired");
  }
  const gpuUuid = String(value?.gpu_uuid ?? "").trim();
  if (!gpuUuid) problems.push("missing_attested_gpu_uuid");
  else if (!devices.some((device) => device.uuid === gpuUuid)) {
    problems.push("attested_gpu_uuid_not_present");
  }
  return {
    provided: true,
    path: absolutePath,
    sha256,
    valid: problems.length === 0,
    gpu_uuid: gpuUuid,
    valid_from: String(value?.valid_from ?? ""),
    expires_at: String(value?.expires_at ?? ""),
    attested_by: String(value?.attested_by ?? ""),
    production_resource_profile: String(value?.production_resource_profile ?? ""),
    problems,
  };
}

function attestationIntervalCoverageProblem(attestation, startedAt, completedAt) {
  const validFrom = Date.parse(String(attestation?.valid_from ?? ""));
  const expiresAt = Date.parse(String(attestation?.expires_at ?? ""));
  const intervalStartedAt = Date.parse(String(startedAt ?? ""));
  const intervalCompletedAt = Date.parse(String(completedAt ?? ""));
  if (!Number.isFinite(validFrom) || !Number.isFinite(expiresAt)
      || !Number.isFinite(intervalStartedAt) || !Number.isFinite(intervalCompletedAt)
      || validFrom > intervalStartedAt || expiresAt < intervalCompletedAt) {
    return "attestation_does_not_cover_resource_interval";
  }
  return "";
}

export function defaultRestaurantRoots(explicitRoots) {
  const roots = [...explicitRoots];
  const environmentRoots = String(process.env.UCI_ARENA_RESTAURANT_ROOT ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  roots.push(...environmentRoots);
  return unique(roots.map((value) => resolve(value)));
}

function sanitizeUuid(uuid) {
  return uuid.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function lockPathFor(uuid) {
  return resolve(os.tmpdir(), "uci_arena_gpu_test_locks", `${sanitizeUuid(uuid)}.lock`);
}

function acquireRunnerLock(uuid) {
  const path = lockPathFor(uuid);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; ++attempt) {
    try {
      const descriptor = openSync(path, "wx");
      const nonce = randomUUID();
      try {
        writeFileSync(descriptor, `${JSON.stringify({
          schema: RUNNER_LOCK_SCHEMA,
          scope: RUNNER_LOCK_SCOPE,
          pid: process.pid,
          gpu_uuid: uuid,
          nonce,
          acquired_at: nowIso(),
        })}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      return {
        acquired: true,
        path,
        schema: RUNNER_LOCK_SCHEMA,
        scope: RUNNER_LOCK_SCOPE,
        pid: process.pid,
        gpu_uuid: uuid,
        nonce,
        problem: "",
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return { acquired: false, path, problem: `gpu_runner_lock_error:${error?.message ?? error}` };
      }
      const existing = safeJson(path);
      if (!existing.ok
          || existing.value?.schema !== RUNNER_LOCK_SCHEMA
          || existing.value?.scope !== RUNNER_LOCK_SCOPE
          || String(existing.value?.gpu_uuid ?? "") !== uuid
          || !/^[0-9a-f-]{36}$/i.test(String(existing.value?.nonce ?? ""))) {
        return { acquired: false, path, problem: "gpu_runner_lock_identity_invalid" };
      }
      const pid = integer(existing.value?.pid);
      if (existing.ok && processAlive(pid)) {
        return { acquired: false, path, problem: `gpu_runner_lock_held_by_pid:${pid}` };
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        return {
          acquired: false,
          path,
          problem: `stale_gpu_runner_lock_not_recoverable:${unlinkError?.message ?? unlinkError}`,
        };
      }
    }
  }
  return { acquired: false, path, problem: "gpu_runner_lock_unavailable" };
}

function releaseRunnerLock(lock) {
  if (!lock?.acquired || !lock.path) return "";
  if (!existsSync(lock.path)) throw new Error("gpu runner lock disappeared before release");
  const existing = safeJson(lock.path);
  if (!existing.ok
      || existing.value?.schema !== RUNNER_LOCK_SCHEMA
      || existing.value?.scope !== RUNNER_LOCK_SCOPE
      || integer(existing.value?.pid) !== lock.pid
      || String(existing.value?.gpu_uuid ?? "") !== lock.gpu_uuid
      || String(existing.value?.nonce ?? "") !== lock.nonce) {
    throw new Error("gpu runner lock identity changed before release");
  }
  unlinkSync(lock.path);
  return "";
}

function runnerLockProblem(lock) {
  if (!lock?.acquired || !lock.path || !existsSync(lock.path)) {
    return "gpu_runner_lock_missing_during_interval";
  }
  const existing = safeJson(lock.path);
  if (!existing.ok) return `gpu_runner_lock_unreadable:${existing.error}`;
  if (existing.value?.schema !== RUNNER_LOCK_SCHEMA
      || existing.value?.scope !== RUNNER_LOCK_SCOPE
      || integer(existing.value?.pid) !== lock.pid
      || String(existing.value?.gpu_uuid ?? "") !== lock.gpu_uuid
      || String(existing.value?.nonce ?? "") !== lock.nonce) {
    return "gpu_runner_lock_identity_changed";
  }
  return "";
}

function childExitObserved(child) {
  return child?.exitCode !== null || child?.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || childExitObserved(child)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let completed = false;
    const finish = (exited) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(
      () => finish(childExitObserved(child)),
      Math.max(0, timeoutMs),
    );
    child.once("exit", onExit);
  });
}

async function forceChildProcessTree(pid, timeoutMs) {
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: Math.max(1, timeoutMs),
        windowsHide: true,
        maxBuffer: 256 * 1024,
      });
      return "taskkill_tree";
    } catch (error) {
      if (!processAlive(pid)) return "taskkill_tree_raced_with_exit";
      throw new Error(`taskkill failed for pid ${pid}: ${error?.message ?? error}`);
    }
  }
  try {
    try {
      process.kill(-pid, "SIGKILL");
      return "sigkill_process_group";
    } catch (groupError) {
      if (!new Set(["ESRCH", "EINVAL", "EPERM"]).has(groupError?.code)) throw groupError;
    }
    process.kill(pid, "SIGKILL");
    return "sigkill";
  } catch (error) {
    if (!processAlive(pid)) return "sigkill_raced_with_exit";
    throw new Error(`SIGKILL failed for pid ${pid}: ${error?.message ?? error}`);
  }
}

export async function shutdownChildProcessTree(child, options = {}) {
  const label = String(options.label ?? "child_process");
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 5_000;
  const ultimateTimeoutMs = options.ultimateTimeoutMs ?? 12_000;
  for (const [name, value] of [
    ["gracefulTimeoutMs", gracefulTimeoutMs],
    ["forceTimeoutMs", forceTimeoutMs],
    ["ultimateTimeoutMs", ultimateTimeoutMs],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > 60_000) {
      throw new Error(`${name} must be an integer in 1..60000`);
    }
  }
  if (ultimateTimeoutMs < gracefulTimeoutMs) {
    throw new Error("ultimateTimeoutMs must cover gracefulTimeoutMs");
  }
  const pid = integer(child?.pid);
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + ultimateTimeoutMs;
  const remaining = () => Math.max(0, deadlineMs - Date.now());
  if (!child) throw new Error(`${label} has no child process handle`);
  if (childExitObserved(child) || (pid !== null && !processAlive(pid))) {
    return {
      label,
      pid,
      verified: true,
      graceful: true,
      forced: false,
      force_method: "",
      elapsed_ms: Date.now() - startedAtMs,
    };
  }
  if (pid === null || pid <= 0) {
    throw new Error(`${label} has no verifiable process id`);
  }
  let gracefulSent = false;
  try {
    if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write("quit\n");
      gracefulSent = true;
    }
  } catch {
    // Force termination below; a broken stdin is not an exit observation.
  }
  const gracefulWaitMs = Math.min(gracefulTimeoutMs, remaining());
  if (gracefulWaitMs > 0 && await waitForChildExit(child, gracefulWaitMs)) {
    return {
      label,
      pid,
      verified: true,
      graceful: true,
      graceful_command_sent: gracefulSent,
      forced: false,
      force_method: "",
      elapsed_ms: Date.now() - startedAtMs,
    };
  }
  const forceBudgetMs = Math.min(forceTimeoutMs, remaining());
  if (forceBudgetMs < 1) {
    throw new Error(`${label} pid ${pid} exceeded the ultimate shutdown deadline before force`);
  }
  const forceMethod = await forceChildProcessTree(pid, forceBudgetMs);
  const finalWaitMs = remaining();
  const exitObserved = finalWaitMs > 0
    ? await waitForChildExit(child, finalWaitMs)
    : childExitObserved(child);
  if (!exitObserved && processAlive(pid)) {
    throw new Error(`${label} pid ${pid} remained alive after ${ultimateTimeoutMs}ms shutdown deadline`);
  }
  return {
    label,
    pid,
    verified: true,
    graceful: false,
    graceful_command_sent: gracefulSent,
    forced: true,
    force_method: forceMethod,
    elapsed_ms: Date.now() - startedAtMs,
  };
}

export function defaultGpuIsolationOptions() {
  return {
    attestationPath: process.env.UCI_ARENA_GPU_ISOLATION_ATTESTATION?.trim() ?? "",
    allowSharedDiagnostic: false,
    restaurantRoots: [],
    idleSamples: 20,
    idleSampleIntervalMs: 250,
    monitorIntervalMs: 5_000,
    maximumIdleUtilPercent: 5,
    maximumIdleCpuPercent: 20,
    maximumIdleMemoryPercent: 70,
  };
}

export function validateGpuIsolationOptions(options) {
  if (!Number.isInteger(options.idleSamples) || options.idleSamples < 2 || options.idleSamples > 240) {
    throw new Error("gpu-idle-samples must be in 2..240");
  }
  if (!Number.isInteger(options.idleSampleIntervalMs)
      || options.idleSampleIntervalMs < 50 || options.idleSampleIntervalMs > 10_000) {
    throw new Error("gpu-idle-sample-ms must be in 50..10000");
  }
  if (!Number.isInteger(options.monitorIntervalMs)
      || options.monitorIntervalMs < 100 || options.monitorIntervalMs > 60_000) {
    throw new Error("gpu-monitor-interval-ms must be in 100..60000");
  }
  if (!Number.isFinite(options.maximumIdleUtilPercent)
      || options.maximumIdleUtilPercent < 0 || options.maximumIdleUtilPercent > 100) {
    throw new Error("gpu-max-idle-util-percent must be in 0..100");
  }
  if (!Number.isFinite(options.maximumIdleCpuPercent)
      || options.maximumIdleCpuPercent < 0 || options.maximumIdleCpuPercent > 100) {
    throw new Error("host-max-idle-cpu-percent must be in 0..100");
  }
  if (!Number.isFinite(options.maximumIdleMemoryPercent)
      || options.maximumIdleMemoryPercent < 0 || options.maximumIdleMemoryPercent > 100) {
    throw new Error("host-max-used-memory-percent must be in 0..100");
  }
}

function authoritativeTelemetrySampleProblems(sample, gpuUuid, label) {
  const problems = [];
  if (!sample || typeof sample !== "object") return [`${label}:missing_sample`];
  if (sample.available !== true || String(sample.error ?? "") !== "") {
    problems.push(`${label}:gpu_query_unavailable`);
  }
  if (String(sample.process_query_error ?? "") !== ""
      || String(sample.process_ancestry_query_error ?? "") !== "") {
    problems.push(`${label}:process_query_unverified`);
  }
  if (typeof sample.at !== "string" || !Number.isFinite(Date.parse(sample.at))) {
    problems.push(`${label}:missing_timestamp`);
  }
  if (!Array.isArray(sample.devices) || sample.devices.length !== 1) {
    problems.push(`${label}:device_count_not_one`);
  } else {
    const device = sample.devices[0];
    if (device.uuid !== gpuUuid) problems.push(`${label}:gpu_uuid_mismatch`);
    for (const field of [
      "gpu_util_percent",
      "memory_controller_util_percent",
      "memory_used_mib",
      "memory_total_mib",
      "temperature_c",
      "graphics_clock_mhz",
      "memory_clock_mhz",
      "power_draw_watts",
    ]) {
      if (!Number.isFinite(device?.[field])) problems.push(`${label}:missing_${field}`);
    }
    if (typeof device?.pstate !== "string" || !device.pstate.trim()) {
      problems.push(`${label}:missing_pstate`);
    }
  }
  if (!sample.host || typeof sample.host !== "object") {
    problems.push(`${label}:missing_host_sample`);
  } else {
    for (const field of [
      "logical_cpu_count",
      "memory_total_bytes",
      "memory_available_bytes",
      "memory_used_percent",
    ]) {
      if (!Number.isFinite(sample.host[field])) problems.push(`${label}:missing_host_${field}`);
    }
  }
  if (!Array.isArray(sample.compute_processes)) {
    problems.push(`${label}:compute_processes_not_array`);
  } else {
    if (sample.compute_process_count !== sample.compute_processes.length) {
      problems.push(`${label}:compute_process_count_mismatch`);
    }
    for (const process of sample.compute_processes) {
      if (process?.allowed !== true || process?.gpu_uuid !== gpuUuid
          || !Number.isInteger(process?.pid) || process.pid <= 0
          || typeof process?.process_name !== "string" || !process.process_name.trim()) {
        problems.push(`${label}:unauthorized_or_malformed_compute_process`);
      }
    }
  }
  if (!Array.isArray(sample.configured_external_compute_processes)
      || sample.configured_external_compute_processes.length !== 0) {
    problems.push(`${label}:configured_external_compute_process_present`);
  }
  return problems;
}

function authoritativeOwnerObservationProblems(observation, expectedRoot, label) {
  const problems = [];
  if (!observation || typeof observation !== "object") return [`${label}:missing_owner_observation`];
  if (observation.root !== expectedRoot) problems.push(`${label}:owner_root_mismatch`);
  if (observation.available !== true || observation.active !== false
      || String(observation.error ?? "") !== "") {
    problems.push(`${label}:owner_state_unverified_or_active`);
  }
  if (!Array.isArray(observation.packets)) {
    problems.push(`${label}:owner_packets_not_array`);
  } else if (observation.packets.some((packet) => packet?.active === true)) {
    problems.push(`${label}:active_owner_packet_present`);
  }
  return problems;
}

export function finalizedGpuIsolationReportProblems(report, options = {}) {
  const requirePerformanceAuthority = options.requirePerformanceAuthority === true;
  const requireDefaultTuningAuthority = options.requireDefaultTuningAuthority === true;
  const problems = [];
  if (!report || typeof report !== "object") return ["missing_resource_isolation_report"];
  if (report.schema !== REPORT_SCHEMA) problems.push("wrong_resource_isolation_schema");
  if (typeof report.interval_id !== "string" || !report.interval_id.trim()) {
    problems.push("missing_resource_interval_id");
  }
  if (report.interval_status !== "finalized" || !report.completed_at) {
    problems.push("resource_interval_not_finalized");
  }
  if (!report.started_at) problems.push("resource_interval_missing_started_at");
  for (const field of [
    "can_run",
    "performance_authority",
    "strength_authority",
    "default_tuning_authority",
  ]) {
    if (typeof report[field] !== "boolean") problems.push(`resource_${field}_not_boolean`);
  }
  for (const field of ["sampling", "device_binding", "monitoring", "preflight", "during", "postflight"]) {
    if (!report[field] || typeof report[field] !== "object") {
      problems.push(`resource_missing_${field}`);
    }
  }
  for (const field of ["samples", "owner_observations", "problems"]) {
    if (!Array.isArray(report.preflight?.[field])) problems.push(`preflight_${field}_not_array`);
    if (!Array.isArray(report.postflight?.[field])) problems.push(`postflight_${field}_not_array`);
  }
  for (const field of ["samples", "owner_observations", "contamination_events"]) {
    if (!Array.isArray(report.during?.[field])) problems.push(`during_${field}_not_array`);
  }
  if (!Array.isArray(report.problems)) problems.push("resource_problems_not_array");
  if (!Array.isArray(report.monitoring?.gaps)) problems.push("resource_monitoring_gaps_not_array");

  if (requirePerformanceAuthority && report.performance_authority !== true) {
    problems.push("resource_performance_authority_false");
  }
  if (requireDefaultTuningAuthority && report.default_tuning_authority !== true) {
    problems.push("resource_default_tuning_authority_false");
  }
  if (requirePerformanceAuthority || requireDefaultTuningAuthority) {
    const gpuUuid = String(report.gpu_uuid ?? "").trim();
    const authorization = report.authorization;
    if (!gpuUuid) problems.push("missing_resource_gpu_uuid");
    if (!authorization || !new Set(["operator_attestation", "cooperative_lease"])
      .has(authorization.kind)) {
      problems.push("invalid_resource_authorization_kind");
    }
    if (!/^[0-9a-f]{64}$/i.test(String(authorization?.sha256 ?? ""))) {
      problems.push("invalid_resource_authorization_sha256");
    }
    if (authorization?.gpu_uuid !== gpuUuid) {
      problems.push("resource_authorization_gpu_uuid_mismatch");
    }
    if (typeof authorization?.identity !== "string" || !authorization.identity.trim()) {
      problems.push("missing_resource_authorization_identity");
    }
    const attestation = report.attestation;
    if (authorization?.kind === "operator_attestation") {
      if (!attestation || attestation.provided !== true || attestation.valid !== true
          || attestation.sha256 !== authorization.sha256
          || attestation.gpu_uuid !== gpuUuid
          || attestation.attested_by !== authorization.identity
          || attestation.production_resource_profile !== "dedicated_full_target_hardware"
          || !Array.isArray(attestation.problems) || attestation.problems.length !== 0) {
        problems.push("resource_attestation_identity_or_validity_mismatch");
      }
      const validFrom = Date.parse(String(attestation?.valid_from ?? ""));
      const expiresAt = Date.parse(String(attestation?.expires_at ?? ""));
      const startedAt = Date.parse(String(report.started_at ?? ""));
      const completedAt = Date.parse(String(report.completed_at ?? ""));
      if (!Number.isFinite(validFrom) || !Number.isFinite(expiresAt)
          || !Number.isFinite(startedAt) || !Number.isFinite(completedAt)
          || validFrom > startedAt || expiresAt < completedAt) {
        problems.push("resource_attestation_does_not_cover_interval");
      }
    } else if (authorization?.kind === "cooperative_lease") {
      const lease = report.cooperative_lease;
      if (!lease || lease.valid !== true || lease.sha256 !== authorization.sha256
          || lease.gpu_uuid !== gpuUuid || lease.identity !== authorization.identity
          || !Array.isArray(lease.problems) || lease.problems.length !== 0) {
        problems.push("resource_cooperative_lease_identity_or_validity_mismatch");
      }
    }
    if (report.runner_lock?.acquired !== true
        || report.runner_lock?.schema !== RUNNER_LOCK_SCHEMA
        || report.runner_lock?.scope !== RUNNER_LOCK_SCOPE
        || report.runner_lock?.gpu_uuid !== gpuUuid
        || String(report.runner_lock?.problem ?? "") !== "") {
      problems.push("resource_runner_lock_invalid");
    }
    if (report.production_resource_assumption !== "dedicated_full_target_hardware"
        || report.qualification_scope !== "performance_and_strength"
        || report.can_run !== true
        || report.performance_authority !== true
        || report.strength_authority !== true
        || report.default_tuning_authority !== true) {
      problems.push("resource_authority_state_inconsistent");
    }
    if (report.device_binding?.verified !== true
        || report.device_binding?.gpu_uuid !== gpuUuid) {
      problems.push("resource_device_binding_unverified");
    }
    if (report.monitoring?.healthy !== true
        || report.monitoring?.query_failures !== 0
        || report.monitoring?.gaps?.length !== 0
        || !Number.isInteger(report.monitoring?.telemetry_samples)
        || report.monitoring.telemetry_samples < 1) {
      problems.push("resource_monitoring_unhealthy");
    }
    if (report.preflight?.passed !== true) problems.push("resource_preflight_failed");
    if (report.postflight?.passed !== true) problems.push("resource_postflight_failed");
    if ((report.during?.contamination_events?.length ?? 0) !== 0) {
      problems.push("resource_contamination_events_present");
    }
    if ((report.problems?.length ?? 0) !== 0) problems.push("resource_problems_present");
    const idleSamples = report.sampling?.idle_sample_count;
    if (!Number.isInteger(report.sampling?.idle_sample_interval_ms)
        || report.sampling.idle_sample_interval_ms < 1
        || !Number.isInteger(report.sampling?.during_monitor_interval_ms)
        || report.sampling.during_monitor_interval_ms < 1
        || !Number.isFinite(report.sampling?.maximum_monitor_gap_ms)
        || report.sampling.maximum_monitor_gap_ms < 1
        || !Number.isFinite(report.monitoring?.maximum_observed_gap_ms)
        || report.monitoring.maximum_observed_gap_ms > report.sampling.maximum_monitor_gap_ms) {
      problems.push("resource_sampling_or_monitor_gap_contract_invalid");
    }
    if (!Number.isInteger(idleSamples) || idleSamples < 2
        || report.preflight?.samples?.length !== idleSamples
        || report.postflight?.samples?.length !== idleSamples) {
      problems.push("resource_boundary_sample_count_mismatch");
    }
    const telemetrySamples = [
      ...(report.preflight?.samples ?? []),
      ...(report.during?.samples ?? []),
      ...(report.postflight?.samples ?? []),
    ];
    telemetrySamples.forEach((sample, index) => {
      problems.push(...authoritativeTelemetrySampleProblems(
        sample,
        gpuUuid,
        `resource_sample_${index}`,
      ));
    });
    if (!telemetrySamples.some((sample) => Number.isFinite(sample?.host?.cpu_util_percent))) {
      problems.push("resource_host_cpu_telemetry_missing");
    }
    if (report.during?.samples?.length !== report.monitoring?.telemetry_samples) {
      problems.push("resource_during_monitor_sample_count_mismatch");
    }
    const externalOwnerRoots = report.external_owner_roots;
    if (!Array.isArray(externalOwnerRoots)
        || externalOwnerRoots.some((root) => typeof root !== "string" || !root.trim())
        || new Set(externalOwnerRoots).size !== externalOwnerRoots.length) {
      problems.push("resource_external_owner_roots_invalid");
    } else {
      for (const [phaseName, sampleCount] of [
        ["preflight", report.preflight?.samples?.length ?? 0],
        ["during", report.during?.samples?.length ?? 0],
        ["postflight", report.postflight?.samples?.length ?? 0],
      ]) {
        const observations = report[phaseName]?.owner_observations;
        if (!Array.isArray(observations)
            || observations.length !== sampleCount * externalOwnerRoots.length) {
          problems.push(`${phaseName}_owner_observation_count_mismatch`);
          continue;
        }
        for (const root of externalOwnerRoots) {
          const matching = observations.filter((observation) => observation?.root === root);
          if (matching.length !== sampleCount) {
            problems.push(`${phaseName}_owner_root_observation_count_mismatch`);
          }
          matching.forEach((observation, index) => {
            problems.push(...authoritativeOwnerObservationProblems(
              observation,
              root,
              `${phaseName}_owner_${index}`,
            ));
          });
        }
      }
    }
  }
  return unique(problems);
}

class GpuResourceIsolationGuard {
  constructor(options) {
    this.options = { ...defaultGpuIsolationOptions(), ...options };
    validateGpuIsolationOptions(this.options);
    this.restaurantRoots = defaultRestaurantRoots(this.options.restaurantRoots ?? []);
    this.allowedPids = new Map();
    this.lock = null;
    this.monitor = null;
    this.monitorPromise = null;
    this.monitorStopped = false;
    this.lastTelemetryAtMs = null;
    this.exitCleanup = null;
    this.finishedReport = null;
    this.report = {
      schema: REPORT_SCHEMA,
      interval_id: randomUUID(),
      interval_status: "open",
      started_at: nowIso(),
      completed_at: null,
      production_resource_assumption: "dedicated_full_target_hardware",
      allow_shared_gpu_diagnostic: this.options.allowSharedDiagnostic === true,
      qualification_scope: "pending",
      can_run: false,
      performance_authority: false,
      strength_authority: false,
      default_tuning_authority: false,
      gpu_uuid: "",
      attestation: null,
      authorization: null,
      runner_lock: null,
      allowed_process_lifecycle: [],
      sampling: {
        idle_sample_count: this.options.idleSamples,
        maximum_boundary_attempts: this.options.idleSamples * 6,
        idle_sample_interval_ms: this.options.idleSampleIntervalMs,
        during_monitor_interval_ms: this.options.monitorIntervalMs,
        maximum_idle_util_percent: this.options.maximumIdleUtilPercent,
        maximum_idle_cpu_percent: this.options.maximumIdleCpuPercent,
        maximum_idle_memory_percent: this.options.maximumIdleMemoryPercent,
        maximum_monitor_gap_ms: this.options.monitorIntervalMs * 2 + 1_000,
        gpu_telemetry_fields: [
          "utilization.gpu",
          "utilization.memory",
          "memory.used",
          "memory.total",
          "temperature.gpu",
          "clocks.current.graphics",
          "clocks.current.memory",
          "power.draw",
          "pstate",
        ],
      },
      host_authority: {
        admission_and_postflight_idle_gated: true,
        during_total_pressure_record_only: true,
        during_external_owner_gate: "restaurant_owner_packets_and_unregistered_gpu_processes",
        runner_lock_scope: RUNNER_LOCK_SCOPE,
        runner_lock_limit: "does_not_exclude_other_accounts_or_uncoordinated_external_owners",
      },
      exclusivity_trust_boundary: {
        administrative_authorization_required: true,
        authorization_assertions: [
          "exclusive_access",
          "exclusive_host_access",
          "external_gpu_owners_inactive",
        ],
        continuous_monitor_role: "detect_authorization_violations",
        sub_interval_owner_rule:
          "An owner wholly between telemetry samples is excluded administratively by the "
          + "operator-controlled attestation or cooperative lease; telemetry corroborates violations and "
          + "cannot alone prove absence between samples.",
        boundary_owner_checks: "filesystem_only_no_nvidia_smi_in_search_timing_path",
      },
      device_binding: {
        method: "single_nvidia_device_fail_closed",
        verified: false,
        device_count: 0,
        gpu_uuid: "",
      },
      monitoring: {
        started_at: null,
        stopped_at: null,
        telemetry_samples: 0,
        boundary_owner_checks: 0,
        maximum_observed_gap_ms: 0,
        gaps: [],
        query_failures: 0,
        healthy: false,
      },
      external_owner_roots: this.restaurantRoots,
      preflight: {
        samples: [],
        owner_observations: [],
        settling_samples: [],
        settling_owner_observations: [],
        settling_events: [],
        passed: false,
        problems: [],
      },
      during: {
        samples: [],
        owner_observations: [],
        contamination_events: [],
        last_boundary_check: null,
      },
      postflight: {
        samples: [],
        owner_observations: [],
        settling_samples: [],
        settling_owner_observations: [],
        settling_events: [],
        passed: false,
        problems: [],
      },
      problems: [],
    };
  }

  registerAllowedProcess(pid, label) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const normalizedLabel = String(label || "test_process");
    this.allowedPids.set(pid, normalizedLabel);
    this.report.allowed_process_lifecycle.push({
      at: nowIso(),
      action: "registered",
      pid,
      label: normalizedLabel,
    });
  }

  unregisterAllowedProcess(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
    const label = this.allowedPids.get(pid);
    if (label === undefined) return;
    this.allowedPids.delete(pid);
    this.report.allowed_process_lifecycle.push({
      at: nowIso(),
      action: "unregistered",
      pid,
      label,
    });
  }

  revokeAuthority(problem, stage = "runner") {
    const normalized = String(problem ?? "runner_authority_revoked").trim()
      || "runner_authority_revoked";
    this.recordEvents([compactProblem(normalized.slice(0, 2_048), stage)]);
  }

  async classifyComputeProcesses(sample) {
    for (const entry of sample.compute_processes) {
      if (this.allowedPids.has(entry.pid)) {
        entry.allowed = true;
        entry.allowed_by_pid = entry.pid;
        entry.allowed_by = this.allowedPids.get(entry.pid);
      } else {
        entry.allowed = false;
        entry.allowed_by_pid = null;
        entry.allowed_by = "";
      }
    }
    for (const entry of sample.compute_processes) {
      if (!entry.allowed && isAdministrativelyCoveredWddmProcess(entry)) {
        entry.allowed = true;
        entry.allowed_by_pid = null;
        entry.allowed_by = "operator_attested_wddm_memory_unquantified_process";
      }
    }
    const unresolved = sample.compute_processes.filter((entry) => !entry.allowed);
    if (unresolved.length === 0) {
      sample.process_ancestry_query_error = "";
      return;
    }
    const ancestry = await processAncestorMap(unresolved.map((entry) => entry.pid));
    sample.process_ancestry_query_error = ancestry.ok ? "" : ancestry.error;
    if (!ancestry.ok) return;
    for (const entry of unresolved) {
      const allowedAncestor = (ancestry.ancestors.get(entry.pid) ?? []).find(
        (pid) => this.allowedPids.has(pid) && processAlive(pid),
      );
      if (allowedAncestor !== undefined) {
        entry.allowed = true;
        entry.allowed_by_pid = allowedAncestor;
        entry.allowed_by = `${this.allowedPids.get(allowedAncestor)}_descendant`;
      }
    }
  }

  ownerObservations() {
    return this.restaurantRoots.map(restaurantOwnerObservation);
  }

  eventsForOwners(owners, stage) {
    const problems = [];
    for (const owner of owners) {
      if (owner.error) problems.push(`external_owner_state_unverified:${owner.root}:${owner.error}`);
      if (owner.active) problems.push(`external_gpu_owner_active:${owner.root}`);
    }
    const lockProblem = runnerLockProblem(this.lock);
    if (this.lock && lockProblem) problems.push(lockProblem);
    if (this.report.attestation?.provided) {
      const current = loadAttestation(
        this.options.attestationPath,
        this.report.gpu_uuid ? [{ uuid: this.report.gpu_uuid }] : [],
      );
      if (!current.valid || current.sha256 !== this.report.attestation.sha256) {
        problems.push("attestation_invalid_or_changed_during_interval");
      }
    }
    return unique(problems).map((problem) => compactProblem(problem, stage));
  }

  problemsForObservation(sample, owners, stage, checkIdle) {
    const problems = this.eventsForOwners(owners, stage).map((event) => event.problem);
    if (!sample.available) problems.push(`nvidia_smi_unavailable:${sample.error}`);
    if (sample.process_query_error) problems.push(`nvidia_process_query_failed:${sample.process_query_error}`);
    if (sample.process_ancestry_query_error) {
      problems.push(`process_ancestry_query_failed:${sample.process_ancestry_query_error}`);
    }
    const targetUuid = this.report.gpu_uuid;
    if (sample.devices.length !== 1) {
      problems.push(`gpu_device_binding_unverified:device_count_${sample.devices.length}`);
    }
    if (targetUuid && !sample.devices.some((device) => device.uuid === targetUuid)) {
      problems.push("target_gpu_missing_from_sample");
    }
    const foreignExternal = sample.compute_processes.filter(
      (entry) => entry.allowed !== true,
    );
    for (const entry of foreignExternal) {
      problems.push(`external_gpu_process_active:${entry.pid}:${entry.process_name}`);
    }
    if (checkIdle && targetUuid) {
      const device = sample.devices.find((candidate) => candidate.uuid === targetUuid);
      if (device && (device.gpu_util_percent === null
          || device.gpu_util_percent > this.options.maximumIdleUtilPercent)) {
        problems.push(
          `target_gpu_not_idle:${device.gpu_util_percent ?? "unavailable"}`,
        );
      }
      const cpuUtil = sample.host?.cpu_util_percent;
      if (cpuUtil !== null && cpuUtil !== undefined
          && cpuUtil > this.options.maximumIdleCpuPercent) {
        problems.push(`host_cpu_not_idle:${cpuUtil.toFixed(3)}`);
      }
      const memoryUsed = sample.host?.memory_used_percent;
      if (memoryUsed === null || memoryUsed === undefined) {
        problems.push("host_memory_utilization_unavailable");
      } else if (memoryUsed > this.options.maximumIdleMemoryPercent) {
        problems.push(`host_memory_not_idle:${memoryUsed.toFixed(3)}`);
      }
    }
    return unique(problems).map((problem) => compactProblem(problem, stage));
  }

  async collect(stage, checkIdle) {
    const [sample, owners] = await Promise.all([
      collectGpuSample(this.restaurantRoots),
      Promise.resolve(this.ownerObservations()),
    ]);
    await this.classifyComputeProcesses(sample);
    const events = this.problemsForObservation(sample, owners, stage, checkIdle);
    return { sample, owners, events };
  }

  async initialize() {
    const first = await this.collect("preflight", false);
    this.report.attestation = loadAttestation(
      this.options.attestationPath,
      first.sample.devices,
    );
    const admissionCoverageProblem = attestationIntervalCoverageProblem(
      this.report.attestation,
      this.report.started_at,
      this.report.started_at,
    );
    if (admissionCoverageProblem) {
      this.report.attestation.problems = unique([
        ...(this.report.attestation.problems ?? []),
        admissionCoverageProblem,
      ]);
      this.report.attestation.valid = false;
    }
    this.report.authorization = {
      kind: "operator_attestation",
      sha256: this.report.attestation.sha256,
      gpu_uuid: this.report.attestation.gpu_uuid,
      identity: this.report.attestation.attested_by ?? "",
    };
    this.report.gpu_uuid = this.report.attestation.gpu_uuid
      || first.sample.devices[0]?.uuid
      || "";
    this.report.device_binding = {
      method: "single_nvidia_device_fail_closed",
      verified: first.sample.devices.length === 1
        && first.sample.devices[0]?.uuid === this.report.gpu_uuid,
      device_count: first.sample.devices.length,
      gpu_uuid: this.report.gpu_uuid,
      device_index: first.sample.devices[0]?.index ?? null,
    };
    const preflightEvents = this.report.attestation.problems.map(
      (problem) => compactProblem(problem, "preflight"),
    );
    const maximumAttempts = this.options.idleSamples * 6;
    let observation = first;
    for (let attempt = 0; attempt < maximumAttempts && preflightEvents.length === 0; ++attempt) {
      const observationEvents = this.problemsForObservation(
        observation.sample,
        observation.owners,
        "preflight",
        true,
      );
      if (observationEvents.length === 0) {
        this.report.preflight.samples.push(observation.sample);
        this.report.preflight.owner_observations.push(...observation.owners);
        if (this.report.preflight.samples.length === this.options.idleSamples) break;
      } else if (retryableBoundaryIdleEvents(observationEvents)) {
        this.report.preflight.settling_samples.push(
          ...this.report.preflight.samples,
          observation.sample,
        );
        this.report.preflight.settling_owner_observations.push(
          ...this.report.preflight.owner_observations,
          ...observation.owners,
        );
        this.report.preflight.settling_events.push(...observationEvents);
        this.report.preflight.samples = [];
        this.report.preflight.owner_observations = [];
      } else {
        this.report.preflight.samples.push(observation.sample);
        this.report.preflight.owner_observations.push(...observation.owners);
        preflightEvents.push(...observationEvents);
        break;
      }
      if (attempt + 1 < maximumAttempts) {
        await delay(this.options.idleSampleIntervalMs);
        observation = await this.collect("preflight", true);
      }
    }
    if (preflightEvents.length === 0
        && this.report.preflight.samples.length !== this.options.idleSamples) {
      preflightEvents.push(compactProblem("preflight_idle_settle_exhausted", "preflight"));
    }
    this.report.preflight.problems = unique(preflightEvents.map((event) => event.problem));
    this.report.preflight.passed = this.report.preflight.problems.length === 0
      && this.report.preflight.samples.length === this.options.idleSamples;
    if (this.report.preflight.passed || this.options.allowSharedDiagnostic) {
      this.lock = acquireRunnerLock(this.report.gpu_uuid || "gpu_unavailable");
      this.report.runner_lock = this.lock;
      if (!this.lock.acquired) {
        const event = compactProblem(this.lock.problem, "preflight");
        preflightEvents.push(event);
        this.report.preflight.problems = unique(preflightEvents.map((item) => item.problem));
        this.report.preflight.passed = false;
      } else {
        this.exitCleanup = () => {
          try {
            releaseRunnerLock(this.lock);
          } catch {
            // The synchronous process-exit fallback cannot publish diagnostics.
          }
        };
        process.once("exit", this.exitCleanup);
      }
    }
    this.report.problems = unique(preflightEvents.map((event) => event.problem));
    const isolated = this.report.preflight.passed && this.lock?.acquired === true;
    this.report.can_run = isolated || (this.options.allowSharedDiagnostic && this.lock?.acquired === true);
    this.report.performance_authority = isolated;
    this.report.strength_authority = isolated;
    this.report.default_tuning_authority = isolated;
    this.report.qualification_scope = isolated
      ? "performance_and_strength"
      : "correctness_and_deadline_only";
    if (this.report.can_run) this.startMonitor();
    return this;
  }

  startMonitor() {
    if (this.monitor) return;
    this.monitorStopped = false;
    this.lastTelemetryAtMs = Date.now();
    this.report.monitoring.started_at = nowIso();
    const schedule = () => {
      if (this.monitorStopped) return;
      this.monitor = setTimeout(() => {
        this.monitor = null;
        this.monitorPromise = this.pollDuring("continuous_monitor")
          .catch((error) => {
            this.recordEvents([compactProblem(
              `resource_monitor_failed:${error?.message ?? error}`,
              "continuous_monitor",
            )]);
          })
          .finally(() => {
            this.monitorPromise = null;
            schedule();
          });
      }, this.options.monitorIntervalMs);
      this.monitor.unref?.();
    };
    schedule();
  }

  recordEvents(events) {
    if (events.length === 0) return;
    this.recordQueryFailures(events);
    for (const event of events) {
      const existing = this.report.during.contamination_events.find(
        (candidate) => candidate.problem === event.problem,
      );
      if (existing) {
        existing.occurrences = (existing.occurrences ?? 1) + 1;
        existing.last_at = event.at;
        existing.last_stage = event.stage;
      } else {
        this.report.during.contamination_events.push({
          ...event,
          occurrences: 1,
          last_at: event.at,
          last_stage: event.stage,
        });
      }
    }
    this.report.performance_authority = false;
    this.report.strength_authority = false;
    this.report.default_tuning_authority = false;
    this.report.qualification_scope = "correctness_and_deadline_only";
    this.report.problems = unique([
      ...this.report.problems,
      ...events.map((event) => event.problem),
    ]);
  }

  recordQueryFailures(events) {
    this.report.monitoring.query_failures += events.filter((event) => (
      event.problem.startsWith("nvidia_smi_unavailable:")
      || event.problem.startsWith("nvidia_process_query_failed:")
      || event.problem.startsWith("process_ancestry_query_failed:")
      || event.problem.startsWith("resource_monitor_failed:")
    )).length;
  }

  recordMonitorGap(atMs, stage) {
    if (this.lastTelemetryAtMs === null) {
      this.lastTelemetryAtMs = atMs;
      return;
    }
    const gapMs = Math.max(0, atMs - this.lastTelemetryAtMs);
    this.report.monitoring.maximum_observed_gap_ms = Math.max(
      this.report.monitoring.maximum_observed_gap_ms,
      gapMs,
    );
    if (gapMs > this.report.sampling.maximum_monitor_gap_ms) {
      const event = compactProblem(
        `resource_monitor_gap_ms:${gapMs}>${this.report.sampling.maximum_monitor_gap_ms}`,
        stage,
      );
      this.report.monitoring.gaps.push(event);
      this.recordEvents([event]);
    }
    this.lastTelemetryAtMs = atMs;
  }

  async pollDuring(stage) {
    const pollStartedAtMs = Date.now();
    this.recordMonitorGap(pollStartedAtMs, stage);
    const observation = await this.collect(stage, false);
    observation.sample.poll_started_at = new Date(pollStartedAtMs).toISOString();
    observation.sample.poll_duration_ms = Date.now() - pollStartedAtMs;
    this.report.during.samples.push(observation.sample);
    this.report.during.owner_observations.push(...observation.owners);
    this.report.monitoring.telemetry_samples += 1;
    this.recordEvents(observation.events);
    return observation.events;
  }

  async assertClean(stage) {
    if (!this.report.can_run) throw new Error("GPU resource isolation did not authorize execution");
    const owners = this.ownerObservations();
    const events = this.eventsForOwners(owners, stage);
    this.report.monitoring.boundary_owner_checks += 1;
    this.report.during.last_boundary_check = {
      at: nowIso(),
      stage,
      passed: events.length === 0,
    };
    if (events.length > 0) this.report.during.owner_observations.push(...owners);
    this.recordEvents(events);
    if (!this.options.allowSharedDiagnostic && this.report.performance_authority !== true) {
      const problems = events.length > 0
        ? events.map((event) => event.problem)
        : this.report.during.contamination_events.map((event) => event.problem);
      throw new Error(`GPU resource isolation lost at ${stage}: ${unique(problems).join(",")}`);
    }
    return events.length === 0;
  }

  async finish() {
    if (this.finishedReport) return this.finishedReport;
    try {
      this.monitorStopped = true;
      if (this.monitor) clearTimeout(this.monitor);
      this.monitor = null;
      if (this.monitorPromise) await this.monitorPromise;
      if (this.report.can_run) {
        await this.pollDuring("final_continuous_monitor");
        const events = [];
        const maximumAttempts = this.options.idleSamples * 6;
        for (let attempt = 0; attempt < maximumAttempts; ++attempt) {
          if (attempt > 0) await delay(this.options.idleSampleIntervalMs);
          const observation = await this.collect("postflight", true);
          if (observation.events.length === 0) {
            this.report.postflight.samples.push(observation.sample);
            this.report.postflight.owner_observations.push(...observation.owners);
            if (this.report.postflight.samples.length === this.options.idleSamples) break;
          } else if (retryableBoundaryIdleEvents(observation.events)) {
            this.report.postflight.settling_samples.push(
              ...this.report.postflight.samples,
              observation.sample,
            );
            this.report.postflight.settling_owner_observations.push(
              ...this.report.postflight.owner_observations,
              ...observation.owners,
            );
            this.report.postflight.settling_events.push(...observation.events);
            this.report.postflight.samples = [];
            this.report.postflight.owner_observations = [];
          } else {
            this.report.postflight.samples.push(observation.sample);
            this.report.postflight.owner_observations.push(...observation.owners);
            events.push(...observation.events);
            break;
          }
        }
        if (events.length === 0
            && this.report.postflight.samples.length !== this.options.idleSamples) {
          events.push(compactProblem("postflight_idle_settle_exhausted", "postflight"));
        }
        const finalBoundarySample = this.report.postflight.samples.at(-1)
          ?? this.report.postflight.settling_samples.at(-1);
        const attestation = loadAttestation(
          this.options.attestationPath,
          finalBoundarySample?.devices ?? [],
        );
        if (!attestation.valid || attestation.sha256 !== this.report.attestation?.sha256) {
          events.push(compactProblem("attestation_invalid_or_changed_at_postflight", "postflight"));
        }
        this.recordQueryFailures(events);
        this.report.postflight.problems = unique(events.map((event) => event.problem));
        this.report.postflight.passed = events.length === 0
          && this.report.postflight.samples.length === this.options.idleSamples;
        if (!this.report.postflight.passed || this.report.during.contamination_events.length > 0) {
          this.report.performance_authority = false;
          this.report.strength_authority = false;
          this.report.default_tuning_authority = false;
          this.report.qualification_scope = "correctness_and_deadline_only";
          this.report.problems = unique([
            ...this.report.problems,
            ...this.report.postflight.problems,
            ...this.report.during.contamination_events.map((event) => event.problem),
          ]);
        }
      }
    } catch (error) {
      this.recordEvents([compactProblem(
        `resource_finalization_failed:${error?.message ?? error}`,
        "postflight",
      )]);
    } finally {
      try {
        releaseRunnerLock(this.lock);
      } catch (error) {
        this.recordEvents([compactProblem(
          `gpu_runner_lock_release_failed:${error?.message ?? error}`,
          "postflight",
        )]);
      }
      if (this.exitCleanup) process.removeListener("exit", this.exitCleanup);
      this.exitCleanup = null;
      this.report.monitoring.stopped_at = nowIso();
      this.report.completed_at = nowIso();
      if (this.report.can_run && this.report.attestation?.provided) {
        const finalAttestation = loadAttestation(
          this.options.attestationPath,
          this.report.postflight.samples.at(-1)?.devices ?? [],
          Date.parse(this.report.completed_at),
        );
        const coverageProblem = attestationIntervalCoverageProblem(
          finalAttestation,
          this.report.started_at,
          this.report.completed_at,
        );
        if (!finalAttestation.valid
            || finalAttestation.sha256 !== this.report.attestation.sha256
            || coverageProblem) {
          this.recordEvents([compactProblem(
            coverageProblem || "attestation_invalid_or_changed_at_interval_completion",
            "postflight",
          )]);
        }
      }
      this.report.monitoring.healthy = this.report.monitoring.telemetry_samples > 0
        && this.report.monitoring.gaps.length === 0
        && this.report.monitoring.query_failures === 0;
      if (!this.report.monitoring.healthy && this.report.can_run) {
        this.report.performance_authority = false;
        this.report.strength_authority = false;
        this.report.default_tuning_authority = false;
        this.report.qualification_scope = "correctness_and_deadline_only";
        this.report.problems = unique([
          ...this.report.problems,
          "resource_monitor_health_unqualified",
        ]);
      }
      this.report.interval_status = "finalized";
      this.finishedReport = JSON.parse(JSON.stringify(this.report));
    }
    return this.finishedReport;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.report));
  }
}

export async function acquireGpuResourceIsolation(options = {}) {
  const guard = new GpuResourceIsolationGuard(options);
  return guard.initialize();
}

function parseProbeArgs(argv) {
  const options = defaultGpuIsolationOptions();
  for (let index = 0; index < argv.length; ++index) {
    const flag = argv[index];
    if (flag === "--allow-shared-gpu-diagnostic") options.allowSharedDiagnostic = true;
    else if (flag === "--gpu-isolation-attestation" && argv[index + 1]) {
      options.attestationPath = argv[++index];
    } else if (flag === "--restaurant-root" && argv[index + 1]) {
      options.restaurantRoots.push(argv[++index]);
    } else if (flag === "--gpu-idle-samples" && argv[index + 1]) {
      options.idleSamples = strictInteger(argv[++index], "gpu-idle-samples");
    } else if (flag === "--gpu-idle-sample-ms" && argv[index + 1]) {
      options.idleSampleIntervalMs = strictInteger(argv[++index], "gpu-idle-sample-ms");
    } else if (flag === "--gpu-monitor-interval-ms" && argv[index + 1]) {
      options.monitorIntervalMs = strictInteger(argv[++index], "gpu-monitor-interval-ms");
    } else if (flag === "--gpu-max-idle-util-percent" && argv[index + 1]) {
      options.maximumIdleUtilPercent = strictNumber(argv[++index], "gpu-max-idle-util-percent");
    } else if (flag === "--host-max-idle-cpu-percent" && argv[index + 1]) {
      options.maximumIdleCpuPercent = strictNumber(argv[++index], "host-max-idle-cpu-percent");
    } else if (flag === "--host-max-used-memory-percent" && argv[index + 1]) {
      options.maximumIdleMemoryPercent = strictNumber(
        argv[++index],
        "host-max-used-memory-percent",
      );
    } else if (flag === "--help") {
      process.stdout.write(
        "Usage: node packages/background-service-runtime/src/resource-isolation.mjs "
        + "[--gpu-isolation-attestation PATH] [--restaurant-root PATH] "
        + "[--gpu-idle-samples N] [--gpu-idle-sample-ms N] "
        + "[--gpu-monitor-interval-ms N] [--gpu-max-idle-util-percent N] "
        + "[--host-max-idle-cpu-percent N] "
        + "[--host-max-used-memory-percent N] "
        + "[--allow-shared-gpu-diagnostic]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) {
  const guard = await acquireGpuResourceIsolation(parseProbeArgs(process.argv.slice(2)));
  const report = await guard.finish();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.performance_authority) process.exitCode = 1;
}
