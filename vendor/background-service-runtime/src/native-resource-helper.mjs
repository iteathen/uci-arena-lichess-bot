import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify, TextDecoder } from 'node:util';
import path from 'node:path';
import processQueryContract from './process-instance-query-contract.json' with { type: 'json' };

const execFileAsync = promisify(execFile);

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function fullyQualifiedWindowsPath(value) {
  const root = path.win32.parse(value).root;
  return /^[a-z]:[\\/]/iu.test(root) || root.startsWith('\\\\');
}

function validProcessQuery(value, processId) {
  if (value?.schema !== processQueryContract.response_schema) return false;
  if (value.state === 'absent' || value.state === 'unverifiable') return exactFields(value, ['schema', 'state']);
  if (value.state !== 'present' || !exactFields(value, ['schema', 'state', 'identity'])) return false;
  const identity = value.identity;
  if (!exactFields(identity, processQueryContract.identity_fields)
      || identity.schema !== processQueryContract.identity_schema || identity.platform !== 'win32'
      || identity.pid !== processId || identity.boot_id !== ''
      || typeof identity.start_token !== 'string' || !/^[0-9]{1,19}$/u.test(identity.start_token)
      || typeof identity.executable_path !== 'string' || !identity.executable_path.isWellFormed()
      || identity.executable_path.length === 0
      || identity.executable_path.length > processQueryContract.maximum_executable_path_utf16_units
      || /[\u0000\r\n]/u.test(identity.executable_path) || !fullyQualifiedWindowsPath(identity.executable_path)) return false;
  const ticks = BigInt(identity.start_token);
  return ticks >= BigInt(processQueryContract.creation_tick_minimum) && ticks <= BigInt(processQueryContract.creation_tick_maximum);
}

export class NativeResourceHelper {
  constructor(config) {
    this.config = config;
    this.supervisor = null;
  }

  start() {
    if (!this.config.nativeHelperAvailable || this.supervisor) return false;
    this.supervisor = spawn(this.config.nativeHelper, [
      '--supervise', String(process.pid), '--heartbeat', this.config.daemonHeartbeatFile, '--stale-seconds', '300',
    ], {
      stdio: 'ignore', windowsHide: true,
    });
    this.supervisor.once('exit', () => { this.supervisor = null; });
    this.supervisor.unref();
    return true;
  }

  async probe() {
    if (!this.config.nativeHelperAvailable) return null;
    try {
      const { stdout } = await execFileAsync(this.config.nativeHelper, ['--probe'], { windowsHide: true, timeout: 1_000 });
      const value = JSON.parse(stdout);
      return value.schema === 'uci_arena_background_service_native_probe_v1' ? value : null;
    } catch {
      return null;
    }
  }

  queryProcessInstanceSync(processId, { timeoutMs = processQueryContract.timeout_ms } = {}) {
    if (!Number.isSafeInteger(processId) || processId < processQueryContract.pid_minimum
        || processId > processQueryContract.pid_maximum) throw new TypeError('Invalid process instance query PID');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > processQueryContract.timeout_ms) {
      throw new TypeError('Invalid process instance query timeout');
    }
    const unavailable = { schema: processQueryContract.response_schema, state: 'unverifiable' };
    if (!this.config.nativeHelperAvailable || typeof this.config.nativeHelper !== 'string'
        || /[\u0000\r\n]/u.test(this.config.nativeHelper)
        || !fullyQualifiedWindowsPath(this.config.nativeHelper)) return unavailable;
    try {
      const stdout = execFileSync(this.config.nativeHelper, [processQueryContract.operation, String(processId)], {
        windowsHide: true, timeout: timeoutMs,
        maxBuffer: processQueryContract.maximum_response_bytes,
      });
      if (!Buffer.isBuffer(stdout) || stdout.length > processQueryContract.maximum_response_bytes) return unavailable;
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout));
      return validProcessQuery(value, processId) ? value : unavailable;
    } catch {
      return unavailable;
    }
  }

  async applyProcessProfile(processId, { efficiencyCoreLimit = 0 } = {}) {
    if (!this.config.nativeHelperAvailable) {
      return {
        schema: 'uci_arena_background_service_process_profile_v1', applied: false,
        eco_qos: false, cpu_set_applied: false, reason: 'native helper unavailable',
      };
    }
    if (!Number.isInteger(processId) || processId <= 0 ||
        !Number.isInteger(efficiencyCoreLimit) || efficiencyCoreLimit < 0 || efficiencyCoreLimit > 2) {
      throw new TypeError('Invalid UCI Arena service process profile request');
    }
    try {
      const { stdout } = await execFileAsync(this.config.nativeHelper, [
        '--apply-process-profile', String(processId), '--efficiency-cores', String(efficiencyCoreLimit),
      ], { windowsHide: true, timeout: 2_000 });
      const value = JSON.parse(stdout);
      if (value.schema !== 'uci_arena_background_service_process_profile_v1') throw new Error('unexpected helper response');
      return value;
    } catch (error) {
      return {
        schema: 'uci_arena_background_service_process_profile_v1', applied: false,
        eco_qos: false, cpu_set_applied: false,
        reason: String(error?.message ?? error).slice(0, 256),
      };
    }
  }

  close() {
    this.supervisor?.unref();
    this.supervisor = null;
  }
}
