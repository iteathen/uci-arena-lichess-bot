import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const PROCESS_INSTANCE_IDENTITY_SCHEMA = "uci_arena_process_instance_identity_v1";
let cachedCurrentIdentity = null;

const WINDOWS_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $process = [System.Diagnostics.Process]::GetProcessById(
    [int]$env:UCI_ARENA_PROCESS_PROBE_PID)
} catch [System.ArgumentException] {
  [Console]::Out.Write('{"state":"absent"}')
  exit 0
}
$payload = [ordered]@{
  state = 'present'
  identity = [ordered]@{
    schema = 'uci_arena_process_instance_identity_v1'
    platform = 'win32'
    pid = [int]$process.Id
    start_token = $process.StartTime.ToUniversalTime().Ticks.ToString(
      [System.Globalization.CultureInfo]::InvariantCulture)
    executable_path = $process.MainModule.FileName
    boot_id = ''
  }
}
[Console]::Out.Write(($payload | ConvertTo-Json -Compress -Depth 3))
`;

function normalizedExecutable(identity) {
  const value = String(identity?.executable_path ?? "");
  return identity?.platform === "win32"
    ? path.win32.normalize(value).toLocaleLowerCase("en-US")
    : path.normalize(value);
}

export function validProcessIdentity(value, expectedPid = null) {
  return value?.schema === PROCESS_INSTANCE_IDENTITY_SCHEMA
    && (value.platform === "win32" || value.platform === "linux")
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && (expectedPid === null || value.pid === expectedPid)
    && /^[0-9]{1,32}$/.test(String(value.start_token ?? ""))
    && typeof value.executable_path === "string"
    && value.executable_path.length > 0
    && value.executable_path.length <= 4096
    && typeof value.boot_id === "string"
    && value.boot_id.length <= 128;
}

export function sameProcessInstance(left, right) {
  return validProcessIdentity(left)
    && validProcessIdentity(right)
    && left.platform === right.platform
    && left.pid === right.pid
    && String(left.start_token) === String(right.start_token)
    && String(left.boot_id) === String(right.boot_id)
    && normalizedExecutable(left) === normalizedExecutable(right);
}

function linuxProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return { state: "unverifiable" };
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const identity = {
      schema: PROCESS_INSTANCE_IDENTITY_SCHEMA,
      platform: "linux",
      pid,
      start_token: fields[19],
      executable_path: realpathSync(`/proc/${pid}/exe`),
      boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
    return validProcessIdentity(identity, pid)
      ? { state: "present", identity }
      : { state: "unverifiable" };
  } catch (error) {
    return ["ENOENT", "ESRCH"].includes(error?.code)
      ? { state: "absent" }
      : { state: "unverifiable" };
  }
}

function windowsProcessIdentity(pid) {
  try {
    const stdout = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2_000,
        maxBuffer: 16_384,
        env: { ...process.env, UCI_ARENA_PROCESS_PROBE_PID: String(pid) },
      },
    );
    const result = JSON.parse(stdout);
    if (result?.state === "absent") return { state: "absent" };
    return result?.state === "present" && validProcessIdentity(result.identity, pid)
      ? result
      : { state: "unverifiable" };
  } catch {
    return { state: "unverifiable" };
  }
}

export function probeProcessInstance(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    return { state: "absent" };
  }
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform === "win32") return windowsProcessIdentity(pid);
  return { state: "unverifiable" };
}

export function currentProcessIdentity() {
  if (cachedCurrentIdentity) return cachedCurrentIdentity;
  const result = probeProcessInstance(process.pid);
  if (result.state !== "present") {
    throw new Error("current process instance identity is unavailable");
  }
  cachedCurrentIdentity = Object.freeze(result.identity);
  return cachedCurrentIdentity;
}

export function processIdentityFromJson(value, expectedPid = null) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return validProcessIdentity(parsed, expectedPid) ? parsed : null;
  } catch {
    return null;
  }
}

export function processInstanceIsCurrent(value, probe = probeProcessInstance) {
  const identity = processIdentityFromJson(value);
  if (!identity) return false;
  const current = identity.pid === process.pid
    ? { state: "present", identity: currentProcessIdentity() }
    : probe(identity.pid);
  return current?.state === "present" && sameProcessInstance(identity, current.identity);
}
