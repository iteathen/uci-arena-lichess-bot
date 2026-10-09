import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import {
  classifyExactPathSync,
  ensureExactDirectorySync,
  publishExactFileSync,
  publishExactJsonSync,
  readExactTextSync,
} from "./exact-file.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const ADAPTER = path.join(HERE, "lichess-adapter.mjs");

export const SYSTEMD_UNIT_NAME = "uci-arena-lichess.service";
const STARTUP_FILE_LIMIT = 1024 * 1024;

function exactRegularFileExistsSync(filename, label) {
  const admission = classifyExactPathSync(filename, { label });
  if (admission.kind === "missing") return false;
  if (admission.kind !== "file") throw new Error(`${label} is not a regular non-link file`);
  return true;
}

function requireLinux() {
  if (process.platform !== "linux") {
    throw new Error("Lichess systemd user supervision is supported only on Linux");
  }
}

export function systemdEscapeArgument(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error("systemd arguments may not contain control characters");
  return `"${text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", () => "$$")
    .replaceAll("%", "%%")}"`;
}

export function parseSystemdArguments(commandLine) {
  const result = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/u.test(commandLine[index] ?? "")) index += 1;
    if (index >= commandLine.length) break;
    if (commandLine[index] !== '"') {
      throw new Error("Existing Lichess systemd action is not canonically quoted");
    }
    index += 1;
    let value = "";
    let closed = false;
    while (index < commandLine.length) {
      const character = commandLine[index];
      if (character === '"') {
        index += 1;
        closed = true;
        break;
      }
      if (character === "\\") {
        const escaped = commandLine[index + 1];
        if (escaped !== "\\" && escaped !== '"') {
          throw new Error("Existing Lichess systemd action has an unsupported escape");
        }
        value += escaped;
        index += 2;
        continue;
      }
      if ((character === "$" || character === "%")
          && commandLine[index + 1] === character) {
        value += character;
        index += 2;
        continue;
      }
      value += character;
      index += 1;
    }
    if (!closed || (index < commandLine.length && !/\s/u.test(commandLine[index]))) {
      throw new Error("Existing Lichess systemd action has invalid quoting");
    }
    result.push(value);
  }
  return result;
}

function existingCredentialProjection(values, componentRoot = ROOT) {
  if (values.length < 11 || values[2] !== "run"
      || path.resolve(values[1]) !== path.join(path.resolve(componentRoot), 'lichess-adapter.mjs')
      || !path.isAbsolute(values[0])) {
    throw new Error("Existing Lichess systemd action is not the owned adapter command");
  }
  const permitted = new Set([
    "--config", "--token-file", "--expected-account", "--runtime-dir", "--profile",
    "--time-profile", "--temporal-curve-profile", "--capacity-profile", "--model-root",
  ]);
  const bindings = new Map();
  for (let index = 3; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!permitted.has(flag) || value === undefined || bindings.has(flag)) {
      throw new Error("Existing Lichess systemd action has an unsupported argument shape");
    }
    bindings.set(flag, value);
  }
  for (const flag of ["--config", "--token-file", "--expected-account", "--runtime-dir"]) {
    if (!bindings.get(flag)) throw new Error(`Existing Lichess systemd action omits ${flag}`);
  }
  const tokenFile = path.resolve(bindings.get("--token-file"));
  const relativeToken = path.relative(componentRoot, tokenFile);
  if (relativeToken === "" || (!relativeToken.startsWith("..") && !path.isAbsolute(relativeToken))) {
    throw new Error("Existing Lichess startup token path is inside the component root");
  }
  const expectedAccount = bindings.get("--expected-account");
  if (expectedAccount.length > 64 || /[\0\r\n]/u.test(expectedAccount)) {
    throw new Error("Existing Lichess startup account identity is invalid");
  }
  return { tokenFile, expectedAccount };
}

export function startupUnitPath({
  environment = process.env,
  homeDirectory = os.homedir(),
} = {}) {
  const configRoot = environment.XDG_CONFIG_HOME
    ? path.resolve(environment.XDG_CONFIG_HOME)
    : path.join(path.resolve(homeDirectory), ".config");
  return path.join(configRoot, "systemd", "user", SYSTEMD_UNIT_NAME);
}

export function startupAction(options) {
  const componentRoot = path.resolve(options.componentRoot ?? ROOT);
  const argumentsList = [
    path.join(componentRoot, 'lichess-adapter.mjs'),
    "run",
    "--config",
    path.resolve(options.config),
    "--token-file",
    path.resolve(options.tokenFile),
    "--expected-account",
    options.expectedAccount,
    "--runtime-dir",
    path.resolve(options.runtimeDir),
  ];
  for (const [flag, value] of [
    ["--profile", options.profile],
    ["--time-profile", options.timeProfile],
    ["--temporal-curve-profile", options.temporalCurve],
    ["--capacity-profile", options.capacityProfile],
    ["--model-root", options.modelRoot],
  ]) {
    if (value) argumentsList.push(flag, path.resolve(value));
  }
  return {
    command: path.resolve(options.nodePath ?? process.execPath),
    arguments: argumentsList,
    workingDirectory: componentRoot,
  };
}

export function buildSystemdUnit(options) {
  if (!options.expectedAccount) throw new Error("startup install requires --expected-account");
  const action = startupAction(options);
  const command = [action.command, ...action.arguments]
    .map(systemdEscapeArgument)
    .join(" ");
  return `[Unit]
Description=UCI Arena Lichess Bot API adapter
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdEscapeArgument(action.workingDirectory)}
ExecStart=${command}
Restart=on-failure
RestartSec=60
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

export function reconcileSystemdUnit(unit, options) {
  const workingMatches = [...unit.matchAll(/^WorkingDirectory=(.*)$/gmu)];
  const execMatches = [...unit.matchAll(/^ExecStart=(.*)$/gmu)];
  if (workingMatches.length !== 1 || execMatches.length !== 1
      || parseSystemdArguments(workingMatches[0][1]).length !== 1
      || path.resolve(parseSystemdArguments(workingMatches[0][1])[0]) !== path.resolve(ROOT)) {
    throw new Error("Existing Lichess systemd unit is not owned by this component root");
  }
  const existing = parseSystemdArguments(execMatches[0][1]);
  const credentials = existingCredentialProjection(existing);
  const action = startupAction({ ...options, ...credentials });
  const command = [action.command, ...action.arguments].map(systemdEscapeArgument).join(" ");
  return unit
    .replace(workingMatches[0][0], `WorkingDirectory=${systemdEscapeArgument(action.workingDirectory)}`)
    .replace(execMatches[0][0], `ExecStart=${command}`);
}

async function systemctl(argumentsList) {
  return execFileAsync("systemctl", ["--user", ...argumentsList], {
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
}

async function systemctlState(action) {
  try {
    const { stdout } = await systemctl([action, SYSTEMD_UNIT_NAME]);
    return stdout.trim();
  } catch (error) {
    if (Number(error.code) === 1 || Number(error.code) === 3 || Number(error.code) === 4) {
      return action === "is-active" ? "inactive" : "disabled";
    }
    throw new Error(
      `Could not query ${SYSTEMD_UNIT_NAME}: ${error.stderr?.trim() || error.message}`,
    );
  }
}

export async function queryLinuxStartup(options = {}) {
  requireLinux();
  const unitPath = startupUnitPath(options);
  if (!exactRegularFileExistsSync(unitPath, "Lichess systemd unit")) {
    return classifyLinuxStartup({ installed: false, unitName: SYSTEMD_UNIT_NAME, unitPath });
  }
  if (options.replacementRoot) {
    retargetSystemdUnit(readExactTextSync(unitPath, {
      maximumBytes: STARTUP_FILE_LIMIT, label: "Lichess systemd unit",
    }).text, options.replacementRoot, options.replacementRoot);
  }
  const [enabled, active] = await Promise.all([
    systemctlState("is-enabled"),
    systemctlState("is-active"),
  ]);
  return classifyLinuxStartup({
    installed: true,
    unitName: SYSTEMD_UNIT_NAME,
    unitPath,
    enabled,
    active,
  });
}

export function classifyLinuxStartup(startup) {
  const supervisionState = !startup.installed
    ? "unregistered"
    : startup.enabled !== "enabled"
      ? "disabled"
      : startup.active === "active"
        ? "active"
        : new Set(["activating", "reloading"]).has(startup.active)
          ? "restart_pending"
          : "inactive";
  return {
    ...startup,
    supervisionState,
    restartPending: supervisionState === "restart_pending",
  };
}

export async function recoverLinuxStartup({
  query = queryLinuxStartup,
  systemctlImpl = systemctl,
  platform = process.platform,
} = {}) {
  if (platform !== "linux") {
    throw new Error("Lichess systemd user supervision is supported only on Linux");
  }
  const registered = await query();
  if (!registered.installed) throw new Error(`${SYSTEMD_UNIT_NAME} is not registered`);
  if (registered.enabled !== "enabled") {
    throw new Error(`${SYSTEMD_UNIT_NAME} is disabled or its state is unknown`);
  }
  if (registered.active !== "active") await systemctlImpl(["start", SYSTEMD_UNIT_NAME]);
  return {
    ...(await query()),
    recoveryRequested: true,
    registrationMutated: false,
  };
}

export async function installLinuxStartup(options) {
  requireLinux();
  if (!options.expectedAccount) throw new Error("startup install requires --expected-account");
  if (!exactRegularFileExistsSync(ADAPTER, "Lichess adapter")) {
    throw new Error("Lichess adapter is unavailable");
  }
  const unitPath = startupUnitPath();
  ensureExactDirectorySync(path.dirname(unitPath), "Systemd user unit directory");
  ensureExactDirectorySync(path.resolve(options.runtimeDir), "Lichess runtime directory");
  publishExactFileSync(unitPath, buildSystemdUnit(options), {
    maximumBytes: STARTUP_FILE_LIMIT,
    label: "Lichess systemd unit",
  });
  try {
    await systemctl(["daemon-reload"]);
    await systemctl(["enable", "--now", SYSTEMD_UNIT_NAME]);
  } catch (error) {
    throw new Error(
      `Could not install ${SYSTEMD_UNIT_NAME}: ${error.stderr?.trim() || error.message}`,
    );
  }
  const evidence = {
    schema: "uci_arena_lichess_startup_v1",
    unitName: SYSTEMD_UNIT_NAME,
    installedAt: new Date().toISOString(),
    scope: "user",
    runtimeDir: path.resolve(options.runtimeDir),
  };
  publishExactJsonSync(
    path.join(path.resolve(options.runtimeDir), "startup-systemd.json"),
    evidence,
    { maximumBytes: STARTUP_FILE_LIMIT, label: "Lichess systemd startup evidence" },
  );
  return queryLinuxStartup();
}

export async function uninstallLinuxStartup(runtimeDir) {
  requireLinux();
  const unitPath = startupUnitPath();
  try {
    await systemctl(["disable", "--now", SYSTEMD_UNIT_NAME]);
  } catch (error) {
    if (Number(error.code) !== 1 && Number(error.code) !== 4) {
      throw new Error(
        `Could not disable ${SYSTEMD_UNIT_NAME}: ${error.stderr?.trim() || error.message}`,
      );
    }
  }
  await rm(unitPath, { force: true });
  await systemctl(["daemon-reload"]);
  try {
    await systemctl(["reset-failed", SYSTEMD_UNIT_NAME]);
  } catch {}
  await rm(path.join(path.resolve(runtimeDir), "startup-systemd.json"), { force: true });
  return { installed: false, unitName: SYSTEMD_UNIT_NAME, unitPath };
}

export function retargetSystemdUnit(unit, previousRoot, replacementRoot) {
  const previous = path.resolve(previousRoot);
  const replacement = path.resolve(replacementRoot);
  const working = [...unit.matchAll(/^WorkingDirectory=(.*)$/gmu)];
  const commands = [...unit.matchAll(/^ExecStart=(.*)$/gmu)];
  const argumentsList = commands.length === 1 ? parseSystemdArguments(commands[0][1]) : [];
  if (working.length !== 1 || parseSystemdArguments(working[0][1]).length !== 1
      || path.resolve(parseSystemdArguments(working[0][1])[0]) !== previous
      || argumentsList.length < 2
      || path.resolve(argumentsList[1]) !== path.join(previous, "lichess-adapter.mjs")) {
    throw new Error("Existing Lichess systemd unit does not match the receipt-owned component root");
  }
  const retarget = (value) => {
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(previous, path.resolve(value));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
      ? path.join(replacement, relative) : value;
  };
  return unit.replace(working[0][0], `WorkingDirectory=${systemdEscapeArgument(replacement)}`)
    .replace(commands[0][0], `ExecStart=${argumentsList.map(retarget).map(systemdEscapeArgument).join(" ")}`);
}

export async function prepareLinuxStartupReplacement({
  previousRoot,
  replacementRoot,
} = {}) {
  requireLinux();
  if (!previousRoot || !replacementRoot) {
    throw new Error("startup replacement requires previous and replacement roots");
  }
  const unitPath = startupUnitPath();
  if (!exactRegularFileExistsSync(unitPath, "Lichess systemd unit")) {
    throw new Error(`${SYSTEMD_UNIT_NAME} is unavailable for replacement`);
  }
  const admittedUnit = readExactTextSync(unitPath, {
    maximumBytes: STARTUP_FILE_LIMIT,
    label: "Lichess systemd unit",
  });
  let updated;
  try {
    updated = retargetSystemdUnit(
      admittedUnit.text,
      previousRoot,
      replacementRoot,
    );
  } catch (error) {
    try {
      updated = retargetSystemdUnit(
        admittedUnit.text,
        replacementRoot,
        replacementRoot,
      );
    } catch {
      throw error;
    }
    const before = await queryLinuxStartup();
    if (before.enabled !== "disabled" || before.active !== "inactive") {
      throw new Error("Retargeted Lichess systemd unit is not disabled and inactive for retry");
    }
  }
  await systemctl(["disable", "--now", SYSTEMD_UNIT_NAME]);
  if (await systemctlState("is-active") === "active") {
    throw new Error(`${SYSTEMD_UNIT_NAME} did not stop for replacement`);
  }
  publishExactFileSync(unitPath, updated, {
    maximumBytes: STARTUP_FILE_LIMIT,
    label: "Lichess replacement systemd unit",
    expectedTargetIdentity: admittedUnit.identity,
  });
  await systemctl(["daemon-reload"]);
  const state = await queryLinuxStartup();
  if (state.enabled !== "disabled" || state.active !== "inactive") {
    throw new Error(`${SYSTEMD_UNIT_NAME} did not enter replacement-ready state`);
  }
  return {
    ...state,
    installed: true,
    active: false,
    replacementReady: true,
  };
}

export async function reconcileLinuxStartupReplacement({ startupOptions } = {}) {
  requireLinux();
  if (!startupOptions?.runtimeDir) {
    throw new Error("startup replacement reconciliation requires current runtime bindings");
  }
  const before = await queryLinuxStartup();
  if (!before.installed || before.enabled !== "disabled" || before.active !== "inactive") {
    throw new Error(`${SYSTEMD_UNIT_NAME} is not disabled and inactive for reconciliation`);
  }
  const unitPath = startupUnitPath();
  const admittedUnit = readExactTextSync(unitPath, {
    maximumBytes: STARTUP_FILE_LIMIT,
    label: "Lichess systemd unit",
  });
  const updated = reconcileSystemdUnit(admittedUnit.text, startupOptions);
  publishExactFileSync(unitPath, updated, {
    maximumBytes: STARTUP_FILE_LIMIT,
    label: "Reconciled Lichess systemd unit",
    expectedTargetIdentity: admittedUnit.identity,
  });
  await systemctl(["daemon-reload"]);
  const state = await queryLinuxStartup();
  if (state.enabled !== "disabled" || state.active !== "inactive") {
    throw new Error(`${SYSTEMD_UNIT_NAME} did not remain replacement-ready after reconciliation`);
  }
  return { ...state, installed: true, active: false, replacementReady: true };
}

export async function completeLinuxStartupReplacement() {
  requireLinux();
  await systemctl(["enable", "--now", SYSTEMD_UNIT_NAME]);
  const state = await queryLinuxStartup();
  if (state.active !== "active") {
    throw new Error(`${SYSTEMD_UNIT_NAME} did not resume after replacement`);
  }
  return { ...state, installed: true, active: true, replacementReady: false };
}

function linuxDefinitionAction(unit) {
  const working = [...unit.matchAll(/^WorkingDirectory=(.*)$/gmu)];
  const commands = [...unit.matchAll(/^ExecStart=(.*)$/gmu)];
  if (working.length !== 1 || commands.length !== 1) throw new Error('Linux startup unit action is unavailable');
  const dirs = parseSystemdArguments(working[0][1]); const values = parseSystemdArguments(commands[0][1]);
  if (dirs.length !== 1 || values.length < 3 || !path.isAbsolute(values[0]) || !path.isAbsolute(dirs[0])) {
    throw new Error('Linux startup unit action is invalid');
  }
  return { command: values[0], arguments: values.slice(1).map(systemdEscapeArgument).join(' '), working_directory: dirs[0] };
}

function validateLinuxReplacementAction(action, { componentRoot, runtimeDir, configPath }) {
  const values = [action.command, ...parseSystemdArguments(action.arguments)];
  existingCredentialProjection(values, componentRoot);
  const bindings = new Map(); for (let index = 3; index < values.length; index += 2) bindings.set(values[index], values[index + 1]);
  if (path.resolve(action.working_directory) !== path.resolve(componentRoot)
      || path.resolve(bindings.get('--runtime-dir')) !== path.resolve(runtimeDir)
      || (configPath && path.resolve(bindings.get('--config')) !== path.resolve(configPath))) {
    throw new Error('Linux startup action does not match provider authority');
  }
  return Object.freeze({ ...action });
}

async function executeLinuxReplacement(execute, args) {
  try { return await execute('systemctl', ['--user', ...args], { timeout: 20000, maxBuffer: STARTUP_FILE_LIMIT }); }
  catch (error) {
    const code = error?.code; const stdout = error?.stdout;
    if (args[0] === 'is-active' && code === 3 && stdout === 'inactive\n'
        || args[0] === 'is-enabled' && code === 1 && stdout === 'disabled\n') return { stdout };
    throw new Error('Linux startup platform operation was not confirmed');
  }
}

export async function inspectLinuxReplacement({ componentRoot, allowedRoots = [componentRoot], runtimeDir, configPath,
  unitPath = startupUnitPath(), execute = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'linux') throw new Error('Unsupported Linux startup platform');
  const admission = classifyExactPathSync(unitPath, { label: 'Lichess systemd unit' });
  if (admission.kind === 'missing') {
    // A deleted on-disk unit may still be loaded by systemd. Absence requires
    // the platform's own read-only loaded-unit observation as well.
    const { stdout } = await executeLinuxReplacement(execute,
      ['show', '--property=LoadState', '--value', SYSTEMD_UNIT_NAME]);
    if (stdout.trim() !== 'not-found') throw new Error('Linux startup absence was not confirmed');
    return Object.freeze({ platform: 'linux', registered: false, enabled: false, active: false,
      definition_text: null, definition_sha256: null, action: null, instances: Object.freeze([]) });
  }
  const unit = readExactTextSync(unitPath, { maximumBytes: STARTUP_FILE_LIMIT, label: 'Lichess systemd unit' }).text;
  const typedAction = linuxDefinitionAction(unit);
  let action;
  for (const root of allowedRoots) {
    try { action = validateLinuxReplacementAction(typedAction, { componentRoot: root, runtimeDir, configPath }); break; }
    catch {}
  }
  if (!action) throw new Error('Linux startup unit has no admitted owner action');
  const { stdout: enabled } = await executeLinuxReplacement(execute, ['is-enabled', SYSTEMD_UNIT_NAME]);
  const { stdout: active } = await executeLinuxReplacement(execute, ['is-active', SYSTEMD_UNIT_NAME]);
  if (!['enabled', 'disabled'].includes(enabled.trim()) || !['active', 'inactive'].includes(active.trim())) {
    throw new Error('Linux startup state is unavailable');
  }
  return Object.freeze({ platform: 'linux', registered: true, enabled: enabled.trim() === 'enabled', active: active.trim() === 'active',
    definition_text: unit, definition_sha256: createHash('sha256').update(unit).digest('hex'), action, instances: Object.freeze([]) });
}

export function deriveLinuxReplacementAction({ state, targetRoot, runtimeDir, configPath,
  nodePath = process.execPath, startupOptions = null } = {}) {
  if (!state.before.registered) return null;
  validateLinuxReplacementAction(state.before.action, { componentRoot: state.previous_root, runtimeDir });
  const original = parseSystemdArguments(state.before.action.arguments);
  const values = [...original]; values[0] = path.join(path.resolve(targetRoot), 'lichess-adapter.mjs');
  const updates = new Map([['--runtime-dir', path.resolve(runtimeDir)], ['--config', path.resolve(configPath)]]);
  if (startupOptions) for (const [flag, field] of [['--profile', 'profile'], ['--time-profile', 'timeProfile'],
    ['--temporal-curve-profile', 'temporalCurve'], ['--capacity-profile', 'capacityProfile'], ['--model-root', 'modelRoot']]) {
    updates.set(flag, startupOptions[field] ? path.resolve(startupOptions[field]) : null);
  }
  const rebuilt = values.slice(0, 2);
  for (let index = 2; index < values.length; index += 2) {
    const flag = values[index]; const value = updates.has(flag) ? updates.get(flag) : values[index + 1];
    if (value !== null) rebuilt.push(flag, value); updates.delete(flag);
  }
  for (const [flag, value] of updates) if (value !== null) rebuilt.push(flag, value);
  return validateLinuxReplacementAction({ command: path.resolve(nodePath), arguments: rebuilt.map(systemdEscapeArgument).join(' '),
    working_directory: path.resolve(targetRoot) }, { componentRoot: targetRoot, runtimeDir, configPath });
}

export async function convergeLinuxReplacement({ state, target, requestedAction, runtimeDir, configPath,
  unitPath = startupUnitPath(), execute = execFileAsync, platform = process.platform } = {}) {
  if (!['before', 'desired'].includes(target)) throw new Error('Invalid Linux replacement target');
  const targetRoot = target === 'before' ? state.previous_root : state.replacement_root;
  const options = { componentRoot: targetRoot, allowedRoots: [state.previous_root, state.replacement_root], runtimeDir, configPath, unitPath, execute, platform };
  const observed = await inspectLinuxReplacement(options);
  if (!state.before.registered) {
    if (observed.registered || requestedAction !== null) throw new Error('Linux startup absence changed');
    return { installed: false, active: false, enabled: false, observation: observed };
  }
  if (!observed.registered || (!state.before.enabled && !state.before.active && (observed.enabled || observed.active))) {
    throw new Error('Linux startup activity changed after before-state capture');
  }
  validateLinuxReplacementAction(requestedAction, { componentRoot: targetRoot, runtimeDir, configPath });
  if (target === 'before' && JSON.stringify(requestedAction) !== JSON.stringify(state.before.action)) {
    throw new Error('Requested Linux before authority does not match capture');
  }
  const retargeted = retargetSystemdUnit(state.before.definition_text, state.previous_root, state.replacement_root);
  const desired = target === 'before' ? state.before.definition_text : retargeted
    .replace(/^ExecStart=.*$/mu, `ExecStart=${[requestedAction.command, ...parseSystemdArguments(requestedAction.arguments)].map(systemdEscapeArgument).join(' ')}`);
  const candidates = [state.before.definition_text, retargeted, state.completed_observation?.definition_text, desired];
  if (!candidates.includes(observed.definition_text)) throw new Error('Linux startup unit changed after capture');
  const admitted = readExactTextSync(unitPath, { maximumBytes: STARTUP_FILE_LIMIT, label: 'Lichess systemd unit' });
  if (admitted.text !== observed.definition_text) throw new Error('Linux startup unit changed before quiescence');
  await executeLinuxReplacement(execute, ['disable', '--now', SYSTEMD_UNIT_NAME]);
  const stopped = await inspectLinuxReplacement(options);
  if (stopped.active || stopped.enabled || stopped.definition_text !== admitted.text) throw new Error('Linux startup did not quiesce');
  publishExactFileSync(unitPath, desired, { maximumBytes: STARTUP_FILE_LIMIT,
    label: 'Lichess replacement systemd unit', expectedTargetIdentity: admitted.identity });
  await executeLinuxReplacement(execute, ['daemon-reload']);
  const completed = await inspectLinuxReplacement({ ...options, allowedRoots: [targetRoot] });
  if (!completed.registered || completed.active || completed.enabled || completed.definition_text !== desired) {
    throw new Error('Linux startup replacement was not confirmed');
  }
  return { installed: true, active: false, enabled: false, observation: completed };
}

export async function quiesceLinuxReplacement({ state, runtimeDir, configPath, ...options } = {}) {
  const unit = state.before.registered ? retargetSystemdUnit(state.before.definition_text, state.previous_root, state.replacement_root) : null;
  return convergeLinuxReplacement({ ...options, state, runtimeDir, configPath, target: 'desired',
    requestedAction: unit ? linuxDefinitionAction(unit) : null });
}

export async function activateLinuxReplacement({ observation, componentRoot, runtimeDir, configPath,
  unitPath = startupUnitPath(), execute = execFileAsync, platform = process.platform,
  ready, delay = wait, pollMilliseconds = 100, timeoutMilliseconds = 20000, stabilityMilliseconds = 3000 } = {}) {
  if (typeof ready !== 'function' || ![pollMilliseconds, timeoutMilliseconds, stabilityMilliseconds].every(Number.isSafeInteger)
      || pollMilliseconds < 10 || timeoutMilliseconds < pollMilliseconds || timeoutMilliseconds > 30000
      || stabilityMilliseconds < pollMilliseconds || stabilityMilliseconds > timeoutMilliseconds) throw new Error('Invalid Linux activation policy');
  const options = { componentRoot, runtimeDir, configPath, unitPath, execute, platform };
  const before = await inspectLinuxReplacement(options);
  if (before.definition_text !== observation.definition_text) throw new Error('Linux startup changed before activation');
  await executeLinuxReplacement(execute, ['enable', '--now', SYSTEMD_UNIT_NAME]);
  let stable = 0;
  for (let attempt = 0; attempt <= Math.ceil(timeoutMilliseconds / pollMilliseconds); attempt += 1) {
    const current = await inspectLinuxReplacement(options);
    if (current.definition_text !== observation.definition_text) throw new Error('Linux startup changed during activation');
    stable = current.enabled && current.active && await ready() ? stable + 1 : 0;
    if (stable >= Math.ceil(stabilityMilliseconds / pollMilliseconds)) return { installed: true, enabled: true, active: true };
    await delay(pollMilliseconds);
  }
  throw new Error('Linux provider readiness was not confirmed');
}
