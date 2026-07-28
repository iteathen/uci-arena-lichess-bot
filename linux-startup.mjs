import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
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
