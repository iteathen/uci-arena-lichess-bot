import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const ADAPTER = path.join(HERE, "lichess-adapter.mjs");
export const STARTUP_TASK_NAME = "UCI Arena Lichess Adapter";
export const NATIVE_LAUNCHER = path.join(HERE, "native", "lichess_adapter_launcher.exe");

function requireWindows() {
  if (process.platform !== "win32") throw new Error("Lichess startup supervision is supported only on Windows");
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function quoteWindowsArgument(value) {
  const text = String(value);
  if (!text.length) return '""';
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

export function startupAction(options) {
  const argumentsList = [
    path.resolve(process.execPath),
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
    command: path.resolve(options.nativeLauncher ?? NATIVE_LAUNCHER),
    arguments: argumentsList.map(quoteWindowsArgument).join(" "),
    workingDirectory: ROOT,
  };
}

export function buildTaskXml(options, userSid) {
  if (!/^S-\d(?:-\d+)+$/.test(userSid)) throw new Error(`Invalid Windows user SID: ${userSid}`);
  const action = startupAction(options);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs the capacity-qualified UCI Arena Lichess Bot API adapter without a console.</Description>
    <URI>\\${STARTUP_TASK_NAME}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><Delay>PT15S</Delay><UserId>${xmlEscape(userSid)}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>${xmlEscape(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>4</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${xmlEscape(action.command)}</Command><Arguments>${xmlEscape(action.arguments)}</Arguments><WorkingDirectory>${xmlEscape(action.workingDirectory)}</WorkingDirectory></Exec>
  </Actions>
</Task>
`;
}

async function currentUserSid() {
  const { stdout } = await execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    timeout: 5_000,
  });
  const match = /"[^"]+","(S-\d(?:-\d+)+)"/.exec(stdout.trim());
  if (!match) throw new Error("Could not determine the current Windows user SID");
  return match[1];
}

function missingTaskError(error) {
  const detail = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
  return /cannot find|not found|does not exist|specified task name does not exist/iu.test(detail);
}

async function queryStartupTask(execute = execFileAsync) {
  try {
    const { stdout } = await execute("schtasks.exe", ["/Query", "/TN", STARTUP_TASK_NAME, "/FO", "LIST", "/V"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const status = /Status:\s*([^\r\n]+)/i.exec(stdout)?.[1]?.trim() ?? "unknown";
    const lastResult = /Last Result:\s*([^\r\n]+)/i.exec(stdout)?.[1]?.trim() ?? "unknown";
    return {
      installed: true,
      active: /^running$/iu.test(status),
      taskName: STARTUP_TASK_NAME,
      taskStatus: status,
      lastResult,
    };
  } catch (error) {
    if (missingTaskError(error)) return { installed: false, taskName: STARTUP_TASK_NAME };
    throw new Error(`Could not query Lichess startup task: ${error.stderr?.trim() || error.message}`);
  }
}

export async function queryWindowsStartup() {
  requireWindows();
  return queryStartupTask();
}

async function stopWindowsTask({
  execute = execFileAsync,
  query = () => queryStartupTask(execute),
  delay = wait,
  pollMilliseconds = 100,
  timeoutMilliseconds = 20_000,
} = {}) {
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 10
      || !Number.isSafeInteger(timeoutMilliseconds)
      || timeoutMilliseconds < pollMilliseconds || timeoutMilliseconds > 60_000) {
    throw new Error("Lichess startup teardown timing policy is invalid");
  }
  let state = await query();
  if (!state.installed) return { installed: false, taskName: STARTUP_TASK_NAME };
  if (typeof state.taskStatus !== "string" || state.taskStatus === "unknown") {
    throw new Error("Could not prove the Lichess startup task state before teardown");
  }
  if (/^running$/iu.test(state.taskStatus)) {
    try {
      await execute("schtasks.exe", ["/End", "/TN", STARTUP_TASK_NAME], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      state = await query();
      if (state.installed && /^running$/iu.test(state.taskStatus ?? "")) {
        throw new Error(`Could not stop Lichess startup task: ${error.stderr?.trim() || error.message}`);
      }
    }
  }

  const attempts = Math.ceil(timeoutMilliseconds / pollMilliseconds);
  for (let attempt = 0; state.installed && /^running$/iu.test(state.taskStatus); attempt += 1) {
    if (attempt >= attempts) {
      throw new Error("Timed out waiting for the Lichess startup launcher to exit");
    }
    await delay(pollMilliseconds);
    state = await query();
  }
  if (state.installed
      && (typeof state.taskStatus !== "string" || state.taskStatus === "unknown")) {
    throw new Error("Could not prove the Lichess startup launcher exited");
  }
  return { ...state, active: false };
}

export async function stopAndDeleteWindowsTask(options = {}) {
  const {
    execute = execFileAsync,
    query = () => queryStartupTask(execute),
    delay = wait,
    pollMilliseconds = 100,
    timeoutMilliseconds = 20_000,
  } = options;
  let state = await stopWindowsTask({
    execute, query, delay, pollMilliseconds, timeoutMilliseconds,
  });
  if (!state.installed) return state;
  const attempts = Math.ceil(timeoutMilliseconds / pollMilliseconds);
  if (state.installed) {
    try {
      await execute("schtasks.exe", ["/Delete", "/TN", STARTUP_TASK_NAME, "/F"], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      state = await query();
      if (state.installed) {
        throw new Error(`Could not uninstall Lichess startup task: ${error.stderr?.trim() || error.message}`);
      }
    }
  }
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    state = await query();
    if (!state.installed) {
      return { installed: false, taskName: STARTUP_TASK_NAME, teardownComplete: true };
    }
    if (attempt === attempts) {
      throw new Error("Timed out waiting for Lichess startup task deletion");
    }
    await delay(pollMilliseconds);
  }
  throw new Error("Lichess startup task teardown did not complete");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function retargetWindowsTaskXml(taskXml, previousRoot, replacementRoot) {
  const previous = xmlEscape(path.resolve(previousRoot));
  const replacement = xmlEscape(path.resolve(replacementRoot));
  const rootPattern = new RegExp(escapeRegExp(previous), "giu");
  const matches = taskXml.match(rootPattern) ?? [];
  if (matches.length < 2) {
    throw new Error("Existing Lichess startup task does not match the receipt-owned component root");
  }
  let updated = taskXml.replace(rootPattern, () => replacement);
  const settingsPattern = /(<Settings>[\s\S]*?<Enabled>)true(<\/Enabled>)/iu;
  if (!settingsPattern.test(updated)) {
    throw new Error("Existing Lichess startup task has no controllable enabled setting");
  }
  updated = updated.replace(settingsPattern, "$1false$2");
  return updated;
}

export async function prepareWindowsStartupReplacement({
  previousRoot,
  replacementRoot,
  runtimeDir,
  execute = execFileAsync,
  query = () => queryStartupTask(execute),
  delay = wait,
  pollMilliseconds = 100,
  timeoutMilliseconds = 20_000,
} = {}) {
  requireWindows();
  if (!previousRoot || !replacementRoot || !runtimeDir) {
    throw new Error("startup replacement requires previous, replacement, and runtime roots");
  }
  const before = await query();
  if (!before.installed) throw new Error("Lichess startup task is unavailable for replacement");
  const { stdout } = await execute(
    "schtasks.exe", ["/Query", "/TN", STARTUP_TASK_NAME, "/XML"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const updatedXml = retargetWindowsTaskXml(stdout, previousRoot, replacementRoot);
  await stopWindowsTask({ execute, query, delay, pollMilliseconds, timeoutMilliseconds });
  const resolvedRuntime = path.resolve(runtimeDir);
  await mkdir(resolvedRuntime, { recursive: true });
  const temporaryXml = path.join(resolvedRuntime, `startup-replacement-${process.pid}.xml`);
  await writeFile(
    temporaryXml,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(updatedXml, "utf16le")]),
  );
  try {
    await execute("schtasks.exe", ["/Delete", "/TN", STARTUP_TASK_NAME, "/F"], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    await execute("schtasks.exe", ["/Create", "/TN", STARTUP_TASK_NAME, "/XML", temporaryXml, "/F"], {
      windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
  } finally {
    await rm(temporaryXml, { force: true });
  }
  const state = await query();
  if (!state.installed || state.active) {
    throw new Error("Lichess startup task did not enter replacement-ready state");
  }
  return { ...state, installed: true, active: false, replacementReady: true };
}

export async function completeWindowsStartupReplacement({
  execute = execFileAsync,
  query = () => queryStartupTask(execute),
  delay = wait,
  pollMilliseconds = 100,
  timeoutMilliseconds = 20_000,
} = {}) {
  requireWindows();
  let state = await query();
  if (!state.installed) throw new Error("Lichess startup task is unavailable after replacement");
  await execute("schtasks.exe", ["/Change", "/TN", STARTUP_TASK_NAME, "/ENABLE"], {
    windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  await execute("schtasks.exe", ["/Run", "/TN", STARTUP_TASK_NAME], {
    windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const attempts = Math.ceil(timeoutMilliseconds / pollMilliseconds);
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    state = await query();
    if (state.installed && state.active) {
      return { ...state, installed: true, active: true, replacementReady: false };
    }
    if (attempt === attempts) break;
    await delay(pollMilliseconds);
  }
  throw new Error("Timed out waiting for the replacement Lichess startup launcher");
}

export async function installWindowsStartup(options) {
  requireWindows();
  if (!options.expectedAccount) throw new Error("startup install requires --expected-account");
  const launcher = path.resolve(options.nativeLauncher ?? NATIVE_LAUNCHER);
  if (!existsSync(launcher)) throw new Error(`Lichess windowless launcher is unavailable: ${launcher}`);
  const runtimeDir = path.resolve(options.runtimeDir);
  await mkdir(runtimeDir, { recursive: true });
  const userSid = await currentUserSid();
  const taskXml = buildTaskXml({ ...options, nativeLauncher: launcher }, userSid);
  const temporaryXml = path.join(runtimeDir, `startup-task-${process.pid}.xml`);
  await writeFile(temporaryXml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml, "utf16le")]));
  try {
    await execFileAsync("schtasks.exe", ["/Create", "/TN", STARTUP_TASK_NAME, "/XML", temporaryXml, "/F"], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Could not install Lichess startup task: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  } finally {
    await rm(temporaryXml, { force: true });
  }
  const evidence = {
    schema: "uci_arena_lichess_startup_v1",
    taskName: STARTUP_TASK_NAME,
    installedAt: new Date().toISOString(),
    windowless: true,
    runtimeDir,
  };
  await writeFile(path.join(runtimeDir, "startup-task.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await execFileAsync("schtasks.exe", ["/Run", "/TN", STARTUP_TASK_NAME], {
    windowsHide: true,
    timeout: 10_000,
  });
  return { ...(await queryWindowsStartup()), started: true, launcher };
}

export async function uninstallWindowsStartup(runtimeDir) {
  requireWindows();
  const teardown = await stopAndDeleteWindowsTask();
  await rm(path.join(path.resolve(runtimeDir), "startup-task.json"), { force: true });
  return teardown;
}
