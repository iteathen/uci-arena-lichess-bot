import { createHash } from 'node:crypto';
import path from 'node:path';
import { currentProcessIdentity, probeProcessInstance, sameProcessInstance, validProcessIdentity } from './process-instance-identity.mjs';
import { classifyExactPathSync, ensureExactDirectorySync, publishExactJsonSync, readExactJsonSync } from './exact-file.mjs';

const LEGACY_SCHEMA = 'uci_arena_lichess_startup_replacement_intent_v1';
const SCHEMA = 'uci_arena_lichess_startup_replacement_intent_v2';
const MAXIMUM_BYTES = 1048576;
const phases = new Set(['preparing', 'prepared', 'completed']);
const filename = (runtimeDir) => path.join(path.resolve(runtimeDir), 'startup-replacement-intent.json');
const fail = () => { const error = new Error('Invalid provider replacement state');
  error.code = 'LICHESS_STARTUP_REPLACEMENT_STATE_INVALID'; throw error; };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value, maximum = 32767) => typeof value === 'string' && value.length <= maximum
  && value.isWellFormed() && !/[\0\r\n]/u.test(value);
const root = (value) => text(value) && value.length > 0 && path.isAbsolute(value);
const sameRoot = (left, right) => root(left) && root(right)
  && (process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right));

function validateAction(value) {
  if (!exact(value, ['command', 'arguments', 'working_directory'])
      || !root(value.command) || !root(value.working_directory) || !text(value.arguments)) fail();
  return Object.freeze({ ...value });
}
const equalAction = (left, right) => left === null || right === null ? left === right
  : sameRoot(left.command, right.command) && sameRoot(left.working_directory, right.working_directory)
    && left.arguments === right.arguments;
const equalPlatform = (left, right) => left.platform === right.platform && left.registered === right.registered
  && left.enabled === right.enabled && left.active === right.active && left.definition_sha256 === right.definition_sha256
  && left.definition_text === right.definition_text && equalAction(left.action, right.action);

function validateObservation(value) {
  if (!exact(value, ['platform', 'registered', 'enabled', 'active', 'definition_text', 'definition_sha256', 'action', 'instances'])
      || !new Set(['win32', 'linux']).has(value.platform)
      || ['registered', 'enabled', 'active'].some((key) => typeof value[key] !== 'boolean')
      || !Array.isArray(value.instances) || value.instances.length > 16
      || value.instances.some((id) => !text(id, 64) || !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\})$/iu.test(id))
      || new Set(value.instances).size !== value.instances.length) fail();
  if (!value.registered) {
    if (value.enabled || value.active || value.definition_text !== null || value.definition_sha256 !== null
        || value.action !== null || value.instances.length) fail();
  } else if (typeof value.definition_text !== 'string' || !value.definition_text.isWellFormed()
      || Buffer.byteLength(value.definition_text, 'utf8') > MAXIMUM_BYTES
      || /\0|<!DOCTYPE|<!ENTITY/iu.test(value.definition_text)
      || !/^[0-9a-f]{64}$/u.test(value.definition_sha256 ?? '')
      || createHash('sha256').update(value.definition_text, 'utf8').digest('hex') !== value.definition_sha256
      || !exact(value.action, ['command', 'arguments', 'working_directory'])
      || !root(value.action.command) || !root(value.action.working_directory) || !text(value.action.arguments)) fail();
  return Object.freeze({ ...value, action: value.action ? validateAction(value.action) : null,
    instances: Object.freeze([...value.instances]) });
}

function validateControl(value) {
  if (!exact(value, ['admission_blocked', 'owner_id', 'active_work', 'updated_at'])
      || ![0, 1].includes(value.admission_blocked) || !text(value.owner_id, 256)
      || !Number.isSafeInteger(value.active_work) || value.active_work < 0
      || !Number.isSafeInteger(value.updated_at) || value.updated_at < 0) fail();
  return Object.freeze({ ...value });
}

function validateLeaseAuthority(value, owner) {
  if (value === null) return null;
  if (!exact(value, ['owner_id', 'process']) || value.owner_id !== owner || !owner
      || !validProcessIdentity(value.process, value.process?.pid)) fail();
  return Object.freeze({ owner_id: value.owner_id, process: Object.freeze({ ...value.process }) });
}

function claimController(state, controller, probe) {
  if (!validProcessIdentity(controller) || typeof probe !== 'function') fail();
  if (state && state.phase !== 'completed'
      && !sameProcessInstance(state.controller, controller)) {
    const current = probe(state.controller.pid);
    if (current?.state !== 'absent' && !(current?.state === 'present' && validProcessIdentity(current.identity, state.controller.pid)
        && !sameProcessInstance(current.identity, state.controller))) {
      const error = new Error('Another replacement controller is live or unverifiable');
      error.code = 'LICHESS_STARTUP_REPLACEMENT_BUSY'; throw error;
    }
  }
  return Object.freeze({ ...controller });
}

export function validateReplacementState(value) {
  const common = ['schema', 'schema_version', 'previous_root', 'replacement_root', 'preserve_inactive', 'registration_present', 'phase'];
  const legacy = value?.schema === LEGACY_SCHEMA && value.schema_version === 1;
  if (!exact(value, legacy ? common : [...common, 'before', 'interlock_before', 'interlock_closed', 'lease_authority', 'controller', 'terminal_root', 'request_authority', 'completed_observation'])
      || (!legacy && (value.schema !== SCHEMA || value.schema_version !== 2))
      || !root(value.previous_root) || !root(value.replacement_root)
      || typeof value.preserve_inactive !== 'boolean' || typeof value.registration_present !== 'boolean'
      || !phases.has(value.phase)) fail();
  if (legacy) return Object.freeze({ ...value });
  if (!validProcessIdentity(value.controller)) fail();
  const before = validateObservation(value.before);
  const interlockBefore = validateControl(value.interlock_before);
  const interlockClosed = validateControl(value.interlock_closed);
  const leaseAuthority = validateLeaseAuthority(value.lease_authority, interlockBefore.owner_id);
  const requestAuthority = validateAction(value.request_authority);
  const completed = value.completed_observation === null ? null : validateObservation(value.completed_observation);
  if (before.registered !== value.registration_present
      || value.preserve_inactive !== (!before.registered || (!before.enabled && !before.active))
      || interlockBefore.admission_blocked !== 0 || interlockBefore.active_work !== 0
      || interlockClosed.admission_blocked !== 1 || interlockClosed.active_work !== 0
      || ![interlockBefore.owner_id, ''].includes(interlockClosed.owner_id)
      || (value.phase === 'completed' ? !sameRoot(value.terminal_root, value.previous_root)
        && !sameRoot(value.terminal_root, value.replacement_root) : value.terminal_root !== null)
      || (value.phase === 'completed' && completed === null)
      || (completed && (completed.platform !== before.platform || completed.registered !== before.registered))) fail();
  return Object.freeze({ ...value, before, interlock_before: interlockBefore, interlock_closed: interlockClosed,
    controller: Object.freeze({ ...value.controller }), lease_authority: leaseAuthority,
    request_authority: requestAuthority, completed_observation: completed });
}

export function readReplacementState(runtimeDir) {
  const target = filename(runtimeDir);
  if (classifyExactPathSync(target, { label: 'Lichess startup replacement intent' }).kind === 'missing') return null;
  return validateReplacementState(readExactJsonSync(target,
    { maximumBytes: MAXIMUM_BYTES, label: 'Lichess startup replacement intent' }).value);
}

function publish(runtimeDir, state) {
  const admitted = validateReplacementState(state);
  ensureExactDirectorySync(runtimeDir, 'Lichess runtime directory');
  publishExactJsonSync(filename(runtimeDir), admitted,
    { maximumBytes: MAXIMUM_BYTES, label: 'Lichess startup replacement intent' });
  return admitted;
}

export function captureReplacementState({ runtimeDir, previousRoot, replacementRoot, observation, control, authority,
  closedControl = { ...control, admission_blocked: 1 }, leaseAuthority = null,
  controller = currentProcessIdentity(), probe = probeProcessInstance }) {
  if (!root(previousRoot) || !root(replacementRoot)) fail();
  const before = validateObservation(observation);
  if (before.active && !before.enabled) {
    throw new Error('Disabled but running startup replacement is unsupported');
  }
  const currentControl = validateControl(control);
  const requestAuthority = validateAction(authority);
  const ownedClosed = validateControl(closedControl);
  const capturedLease = validateLeaseAuthority(leaseAuthority, currentControl.owner_id);
  if (currentControl.active_work !== 0 || ownedClosed.active_work !== 0 || ownedClosed.admission_blocked !== 1
      || ownedClosed.owner_id !== currentControl.owner_id) fail();
  const retained = readReplacementState(runtimeDir);
  const claimed = claimController(retained?.schema_version === 2 ? retained : null, controller, probe);
  const matching = retained && sameRoot(retained.previous_root, previousRoot) && sameRoot(retained.replacement_root, replacementRoot);
  if (retained && retained.phase !== 'completed' && !matching) fail();
  if (matching && retained.schema_version === 2) {
    const sameAuthority = equalAction(retained.request_authority, requestAuthority);
    if (retained.phase !== 'completed' && !sameAuthority) fail();
    if (retained.phase !== 'completed' && JSON.stringify(currentControl) !== JSON.stringify(retained.interlock_before)
        && JSON.stringify(currentControl) !== JSON.stringify(retained.interlock_closed)) fail();
    if (retained.phase !== 'completed' || (sameAuthority && sameRoot(retained.terminal_root, replacementRoot)
        && equalPlatform(before, retained.completed_observation))) {
      return publish(runtimeDir, { ...retained, phase: 'preparing', terminal_root: null, interlock_closed: ownedClosed,
        interlock_before: retained.phase === 'completed' ? currentControl : retained.interlock_before,
        lease_authority: retained.phase === 'completed' ? capturedLease : retained.lease_authority, controller: claimed });
    }
  }
  if (currentControl.admission_blocked) fail();
  return publish(runtimeDir, { schema: SCHEMA, schema_version: 2,
    previous_root: path.resolve(previousRoot), replacement_root: path.resolve(replacementRoot),
    preserve_inactive: !before.registered || (!before.enabled && !before.active),
    registration_present: before.registered, phase: 'preparing', terminal_root: null,
    before, interlock_before: currentControl, interlock_closed: ownedClosed,
    lease_authority: capturedLease, controller: claimed, request_authority: requestAuthority, completed_observation: null });
}

export function publishReplacementPhase(runtimeDir, state, phase, terminalRoot = null, completedObservation = undefined) {
  const current = readReplacementState(runtimeDir);
  if (!current || current.schema_version !== 2 || !sameRoot(current.previous_root, state.previous_root)
      || !sameRoot(current.replacement_root, state.replacement_root)
      || JSON.stringify(current.before) !== JSON.stringify(state.before)
      || JSON.stringify(current.interlock_before) !== JSON.stringify(state.interlock_before)
      || JSON.stringify(current.interlock_closed) !== JSON.stringify(state.interlock_closed)
      || JSON.stringify(current.lease_authority) !== JSON.stringify(state.lease_authority)
      || !sameProcessInstance(current.controller, state.controller)
      || !equalAction(current.request_authority, state.request_authority)) fail();
  return publish(runtimeDir, { ...current, phase, terminal_root: terminalRoot,
    completed_observation: completedObservation === undefined ? current.completed_observation : completedObservation });
}

export function captureReplacementConvergence({ runtimeDir, state, control, closedControl, leaseAuthority = null,
  controller = currentProcessIdentity(), probe = probeProcessInstance }) {
  const current = readReplacementState(runtimeDir);
  const admitted = validateReplacementState(state);
  if (!current || current.schema_version !== 2 || admitted.schema_version !== 2) fail();
  const beforeControl = validateControl(control); const ownedClosed = validateControl(closedControl);
  const capturedLease = validateLeaseAuthority(leaseAuthority, beforeControl.owner_id);
  const claimed = claimController(current, controller, probe);
  if (!current || admitted.schema_version !== 2 || JSON.stringify(current) !== JSON.stringify(admitted)
      || beforeControl.active_work !== 0 || ownedClosed.active_work !== 0 || ownedClosed.admission_blocked !== 1
      || ownedClosed.owner_id !== beforeControl.owner_id
      || (beforeControl.admission_blocked && JSON.stringify(beforeControl) !== JSON.stringify(current.interlock_closed))) fail();
  return publish(runtimeDir, { ...current,
    phase: current.phase === 'completed' ? 'prepared' : current.phase, terminal_root: null,
    interlock_before: beforeControl.admission_blocked ? current.interlock_before : beforeControl,
    interlock_closed: ownedClosed, lease_authority: beforeControl.admission_blocked ? current.lease_authority : capturedLease,
    controller: claimed });
}

export function recordReplacementGateRelease(runtimeDir, state, released) {
  const current = readReplacementState(runtimeDir);
  const admitted = validateReplacementState(state); const control = validateControl(released);
  if (!current || current.schema_version !== 2 || JSON.stringify(current) !== JSON.stringify(admitted)
      || !admitted.lease_authority || !admitted.interlock_closed.owner_id
      || admitted.lease_authority.owner_id !== admitted.interlock_closed.owner_id
      || control.admission_blocked !== 1 || control.owner_id !== '' || control.active_work !== 0
      || control.updated_at < admitted.interlock_closed.updated_at) fail();
  return publish(runtimeDir, { ...current, interlock_closed: control });
}

export function selectReplacementTarget(state, previousRoot, targetRoot, requestedAction = undefined) {
  const admitted = validateReplacementState(state);
  if (!root(previousRoot) || !root(targetRoot)) fail();
  if (admitted.schema_version === 2 && sameRoot(admitted.previous_root, admitted.replacement_root)
      && sameRoot(previousRoot, admitted.previous_root) && sameRoot(targetRoot, admitted.replacement_root)) {
    // The requesting controller must establish its complete target launch tuple.
    // Root equality cannot distinguish inverse dependency restoration from completion.
    if (requestedAction === undefined) fail();
    if (requestedAction !== null) validateAction(requestedAction);
    return equalAction(requestedAction, admitted.before.action) ? 'before' : 'desired';
  }
  if (sameRoot(previousRoot, admitted.previous_root) && sameRoot(targetRoot, admitted.replacement_root)) {
    return 'desired';
  }
  if (admitted.schema_version === 2 && sameRoot(targetRoot, admitted.previous_root)
      && (sameRoot(previousRoot, admitted.previous_root) || sameRoot(previousRoot, admitted.replacement_root))) return 'before';
  if (admitted.schema_version === 1 && admitted.phase === 'completed' && admitted.preserve_inactive
      && sameRoot(targetRoot, admitted.replacement_root) && sameRoot(previousRoot, targetRoot)) return 'unchanged_legacy';
  fail();
}

export function matchesCompletedReplacement(state, targetRoot, observation, requestedAction) {
  const admitted = validateReplacementState(state);
  const observed = validateObservation(observation);
  return admitted.schema_version === 2 && admitted.phase === 'completed' && sameRoot(admitted.terminal_root, targetRoot)
    && equalPlatform(observed, admitted.completed_observation) && equalAction(requestedAction, observed.action);
}
