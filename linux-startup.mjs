import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const ADAPTER = path.join(HERE, "lichess-adapter.mjs");

export const SYSTEMD_UNIT_NAME = "uci-arena-lichess.service";

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

function existingCredentialProjection(values) {
  if (values.length < 11 || values[2] !== "run"
      || path.resolve(values[1]) !== path.resolve(ADAPTER)
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
  const relativeToken = path.relative(ROOT, tokenFile);
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
  const argumentsList = [
    ADAPTER,
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
    command: path.resolve(process.execPath),
    arguments: argumentsList,
    workingDirectory: ROOT,
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
  if (!existsSync(unitPath)) {
    return { installed: false, unitName: SYSTEMD_UNIT_NAME, unitPath };
  }
  const [enabled, active] = await Promise.all([
    systemctlState("is-enabled"),
    systemctlState("is-active"),
  ]);
  return {
    installed: true,
    unitName: SYSTEMD_UNIT_NAME,
    unitPath,
    enabled,
    active,
  };
}

export async function installLinuxStartup(options) {
  requireLinux();
  if (!options.expectedAccount) throw new Error("startup install requires --expected-account");
  if (!existsSync(ADAPTER)) throw new Error(`Lichess adapter is unavailable: ${ADAPTER}`);
  const unitPath = startupUnitPath();
  const temporaryUnitPath = `${unitPath}.tmp-${process.pid}`;
  await mkdir(path.dirname(unitPath), { recursive: true });
  await mkdir(path.resolve(options.runtimeDir), { recursive: true });
  await writeFile(temporaryUnitPath, buildSystemdUnit(options), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryUnitPath, unitPath);
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
  await writeFile(
    path.join(path.resolve(options.runtimeDir), "startup-systemd.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
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
  const occurrences = unit.split(previous).length - 1;
  if (occurrences < 2) {
    throw new Error("Existing Lichess systemd unit does not match the receipt-owned component root");
  }
  return unit.split(previous).join(replacement);
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
  if (!existsSync(unitPath)) throw new Error(`${SYSTEMD_UNIT_NAME} is unavailable for replacement`);
  const updated = retargetSystemdUnit(
    await readFile(unitPath, "utf8"), previousRoot, replacementRoot,
  );
  await systemctl(["disable", "--now", SYSTEMD_UNIT_NAME]);
  if (await systemctlState("is-active") === "active") {
    throw new Error(`${SYSTEMD_UNIT_NAME} did not stop for replacement`);
  }
  const temporaryUnitPath = `${unitPath}.replacement-${process.pid}`;
  await writeFile(temporaryUnitPath, updated, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryUnitPath, unitPath);
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
  const updated = reconcileSystemdUnit(await readFile(unitPath, "utf8"), startupOptions);
  const temporaryUnitPath = `${unitPath}.reconcile-${process.pid}`;
  await writeFile(temporaryUnitPath, updated, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryUnitPath, unitPath);
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
