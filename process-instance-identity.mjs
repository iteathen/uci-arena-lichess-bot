import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeResourceHelper } from "@uci-arena/background-service-runtime/native-resource-helper";
import processContract from "@uci-arena/background-service-runtime/process-instance-query-contract" with { type: "json" };

export const PROCESS_INSTANCE_IDENTITY_SCHEMA = processContract.identity_schema;
let cachedCurrentIdentity = null;
const nativeProcessQuery = new NativeResourceHelper({
  nativeHelperAvailable: true,
  nativeHelper: fileURLToPath(new URL("./native/uci_arena_background_guard.exe", import.meta.url)),
});

function normalizedExecutable(identity) {
  const value = String(identity?.executable_path ?? "");
  return identity?.platform === "win32"
    ? path.win32.normalize(value).toLocaleLowerCase("en-US")
    : path.normalize(value);
}

export function validProcessIdentity(value, expectedPid = null) {
  const common = value !== null && typeof value === "object" && !Array.isArray(value)
    && value.schema === PROCESS_INSTANCE_IDENTITY_SCHEMA
    && Object.keys(value).length === processContract.identity_fields.length
    && processContract.identity_fields.every((field) => Object.hasOwn(value, field))
    && (value.platform === "win32" || value.platform === "linux")
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && value.pid <= processContract.pid_maximum
    && (expectedPid === null || value.pid === expectedPid)
    && typeof value.start_token === "string"
    && /^[0-9]{1,32}$/.test(value.start_token)
    && typeof value.executable_path === "string"
    && value.executable_path.length > 0
    && value.executable_path.length <= (value.platform === "win32" ? processContract.maximum_executable_path_utf16_units : 4096)
    && value.executable_path.isWellFormed()
    && !/[\u0000\r\n]/u.test(value.executable_path)
    && typeof value.boot_id === "string"
    && value.boot_id.length <= 128;
  if (!common || value.platform !== "win32") return common;
  const root = path.win32.parse(value.executable_path).root;
  return (root.startsWith("\\\\") || /^[a-z]:[\\/]/iu.test(root))
    && value.boot_id === ""
    && value.start_token.length <= 19
    && BigInt(value.start_token) >= BigInt(processContract.creation_tick_minimum)
    && BigInt(value.start_token) <= BigInt(processContract.creation_tick_maximum);
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

function windowsProcessIdentity(pid, timeoutMs) {
  const result = nativeProcessQuery.queryProcessInstanceSync(pid, { timeoutMs });
  if (result.state === "present") return { state: "present", identity: result.identity };
  return { state: result.state === "absent" ? "absent" : "unverifiable" };
}

export function probeProcessInstance(pid, { timeoutMs = processContract.timeout_ms } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    return { state: "absent" };
  }
  if (process.platform === "linux") return linuxProcessIdentity(pid);
  if (process.platform === "win32") return windowsProcessIdentity(pid, timeoutMs);
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
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > processContract.maximum_response_bytes) return null;
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
