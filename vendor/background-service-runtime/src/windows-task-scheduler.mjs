import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProxy } from 'node:util/types';
import contract from './windows-task-scheduler-contract.json' with { type: 'json' };

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const sha = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const sid = value => typeof value === 'string' && /^S-\d(?:-\d+)+$/u.test(value);
const guid = value => typeof value === 'string' && /^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/u.test(value);
const script = fileURLToPath(new URL('./windows-task-scheduler.ps1', import.meta.url));
const expectedFields = ['expected_definition_xml', 'expected_xml_sha256'];
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addEvent = EventTarget.prototype.addEventListener;
const removeEvent = EventTarget.prototype.removeEventListener;
const aborted = signal => signal !== undefined && abortGetter.call(signal);
function validateSignal(signal) {
  if (signal === undefined) return;
  try {
    if (isProxy(signal) || !(signal instanceof AbortSignal) || typeof aborted(signal) !== 'boolean') throw new TypeError();
  } catch { throw new TypeError('Invalid task cancellation signal'); }
}
const operationFields = {
  inspect: [], set_enabled: [...expectedFields, 'enabled'],
  stop_instances: [...expectedFields, 'instance_guids'],
  register: [...expectedFields, 'definition_xml'], delete: expectedFields, run: expectedFields,
};
function exact(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
function definition(value) {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() &&
    Buffer.byteLength(value) <= contract.bounds.definition_utf8_bytes &&
    !/<!\s*(?:DOCTYPE|ENTITY)/iu.test(value);
}
function ownCopy(value) {
  try {
    if (value === null || typeof value !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch { throw new TypeError('Invalid task request data'); }
}
function copiedGuids(value) {
  if (!Array.isArray(value) || value.length > contract.bounds.maximum_instances) throw new TypeError('Invalid task instances');
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !guid(descriptor.value)) throw new TypeError('Invalid task instances');
    result.push(descriptor.value);
  }
  if (new Set(result).size !== result.length) throw new TypeError('Invalid task instances');
  return Object.freeze(result);
}
function requestSnapshot(input) {
  const value = ownCopy(input);
  const fields = operationFields[value.operation];
  if (!fields || !exact(value, ['operation', 'task_path', ...fields]) ||
      typeof value.task_path !== 'string' || !value.task_path.isWellFormed() ||
      value.task_path.length > contract.bounds.task_path_utf16_units ||
      !/^\\[^\\/\u0000-\u001f]+$/u.test(value.task_path)) throw new TypeError('Invalid task request');
  if (fields.includes('expected_xml_sha256')) {
    const absent = ['register', 'delete'].includes(value.operation) &&
      value.expected_definition_xml === null && value.expected_xml_sha256 === null;
    if (!absent && (!definition(value.expected_definition_xml) || !sha(value.expected_xml_sha256) ||
        digest(value.expected_definition_xml) !== value.expected_xml_sha256)) throw new TypeError('Invalid task before-image');
  }
  if (value.operation === 'register' && !definition(value.definition_xml)) throw new TypeError('Invalid task definition');
  if (value.operation === 'set_enabled' && typeof value.enabled !== 'boolean') throw new TypeError('Invalid task enablement');
  const result = { ...value };
  if (value.operation === 'stop_instances') result.instance_guids = copiedGuids(value.instance_guids);
  const wire = { schema: contract.request_schema, schema_version: 1, ...result };
  if (Buffer.byteLength(JSON.stringify(wire)) > contract.bounds.request_bytes) throw new TypeError('Task request exceeds bound');
  return Object.freeze(wire);
}
function validObservation(value) {
  if (!exact(value, contract.observation_fields) || typeof value.registered !== 'boolean' ||
      !Array.isArray(value.instance_guids) || value.instance_guids.length > contract.bounds.maximum_instances ||
      !value.instance_guids.every(guid) || new Set(value.instance_guids).size !== value.instance_guids.length) return false;
  if (!value.registered) return value.enabled === null && value.definition_xml === null &&
    value.definition_sha256 === null && value.instance_guids.length === 0 && value.principal === null && value.action === null;
  return typeof value.enabled === 'boolean' && definition(value.definition_xml) &&
    sha(value.definition_sha256) && digest(value.definition_xml) === value.definition_sha256 &&
    exact(value.principal, contract.principal_fields) && sid(value.principal.current_user_sid) &&
    value.principal.current_user_sid === value.principal.user_sid &&
    value.principal.logon_type === 3 && value.principal.run_level === 0 &&
    exact(value.action, contract.action_fields) &&
    contract.action_fields.every(field => typeof value.action[field] === 'string' &&
      value.action[field].isWellFormed() && value.action[field].length <= contract.bounds.action_field_utf16_units) &&
    value.action.command.length > 0;
}
function failed(request, category, hresult = null) {
  return { schema: contract.result_schema, schema_version: 1,
    operation: request.operation, task_path: request.task_path, outcome: 'failed',
    observation: null, failure: { category, hresult } };
}
function response(request, transport) {
  if (transport?.transportFailure) return failed(request, 'transport_failure');
  if (transport?.timedOut) return failed(request, 'transport_timeout');
  if (transport?.cancelled) return failed(request, 'cancelled');
  if (transport?.outputLimit) return failed(request, 'output_limit');
  if (!Buffer.isBuffer(transport?.stdout)) return failed(request, 'invalid_response');
  if (transport.stdout.length > contract.bounds.response_bytes) return failed(request, 'output_limit');
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(transport.stdout));
    if (!exact(result, ['schema', 'schema_version', 'operation', 'task_path', 'outcome', 'observation', 'failure']) ||
        result.schema !== contract.result_schema || result.schema_version !== 1 ||
        result.operation !== request.operation || result.task_path !== request.task_path) return failed(request, 'invalid_response');
    if (result.outcome === 'completed') {
      if (result.failure !== null || !validObservation(result.observation) ||
          transport.exitCode !== 0 || transport.signal !== null) return failed(request, 'invalid_response');
      if (request.operation === 'set_enabled' && (!result.observation.registered ||
          result.observation.enabled !== request.enabled)) return failed(request, 'invalid_response');
      if (request.operation === 'delete' && result.observation.registered) return failed(request, 'invalid_response');
      if (['register', 'run'].includes(request.operation) && !result.observation.registered) return failed(request, 'invalid_response');
      if (request.operation === 'run' && (!result.observation.enabled ||
          result.observation.definition_sha256 !== request.expected_xml_sha256)) return failed(request, 'invalid_response');
      if (request.operation === 'stop_instances' && result.observation.instance_guids.some(
        id => request.instance_guids.includes(id))) return failed(request, 'invalid_response');
    } else if (result.outcome === 'failed') {
      if (result.observation !== null || !exact(result.failure, ['category', 'hresult']) ||
          !contract.failure_categories.includes(result.failure.category) ||
          !(result.failure.hresult === null || (Number.isSafeInteger(result.failure.hresult) &&
            result.failure.hresult >= 0 && result.failure.hresult <= 4294967295))) return failed(request, 'invalid_response');
    } else return failed(request, 'invalid_response');
    return result;
  } catch { return failed(request, 'invalid_response'); }
}
function nativeInvocation(executable, request, { timeoutMs, signal }) {
  return new Promise(resolve => {
    let child;
    try {
      if (!path.win32.isAbsolute(executable) || !lstatSync(executable).isFile() ||
          lstatSync(executable).isSymbolicLink() || !lstatSync(script).isFile() || lstatSync(script).isSymbolicLink()) throw new Error();
      child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve({ transportFailure: true }); return; }
    const chunks = [];
    let bytes = 0, timedOut = false, cancelled = false, outputLimit = false, transportFailure = false;
    const stop = () => { try { child.kill(); } catch {} };
    const cancel = () => { cancelled = true; stop(); };
    let timer;
    // Install the join before setup that could fail. Post-spawn setup failures
    // stop this held child and resolve only after its close, never early.
    child.on('error', () => { transportFailure = true; });
    child.on('close', (exitCode, closeSignal) => {
      clearTimeout(timer);
      try { if (signal !== undefined) removeEvent.call(signal, 'abort', cancel); }
      catch { transportFailure = true; }
      resolve({ stdout: Buffer.concat(chunks), exitCode, signal: closeSignal,
        timedOut, cancelled, outputLimit, transportFailure });
    });
    try {
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > contract.bounds.response_bytes) { outputLimit = true; stop(); }
        else chunks.push(chunk);
      });
      child.stdin.on('error', () => {});
      timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      if (signal !== undefined) addEvent.call(signal, 'abort', cancel, { once: true });
      if (aborted(signal)) cancel();
      child.stdin.end(JSON.stringify(request));
    } catch { transportFailure = true; stop(); }
  });
}

export class WindowsTaskScheduler {
  constructor({ platform = process.platform, powershellExecutable = path.win32.join(
    process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), invoke } = {}) {
    this.platform = platform;
    this.invoke = invoke ?? ((request, options) => nativeInvocation(powershellExecutable, request, options));
  }
  async perform(input, options = {}) {
    const request = requestSnapshot(input);
    const selected = ownCopy(options);
    if (Object.keys(selected).some(key => !['timeoutMs', 'signal'].includes(key))) throw new TypeError('Invalid task options');
    const { timeoutMs = contract.bounds.timeout_ms, signal } = selected;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > contract.bounds.timeout_ms) throw new TypeError('Invalid task deadline');
    validateSignal(signal);
    if (this.platform !== 'win32') return failed(request, 'unsupported_platform');
    if (aborted(signal)) return failed(request, 'cancelled');
    try { return response(request, await this.invoke(request, { timeoutMs, signal })); }
    catch { return failed(request, 'transport_failure'); }
  }
}
