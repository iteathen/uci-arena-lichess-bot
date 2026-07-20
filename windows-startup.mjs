import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ADAPTER = path.join(HERE, "lichess-adapter.mjs");
export const STARTUP_TASK_NAME = "UCI Arena Lichess Adapter";
export const NATIVE_LAUNCHER = path.join(HERE, "native", "build", "Release", "lichess_adapter_launcher.exe");

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

export async function queryWindowsStartup() {
  requireWindows();
  try {
    const { stdout } = await execFileAsync("schtasks.exe", ["/Query", "/TN", STARTUP_TASK_NAME, "/FO", "LIST", "/V"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const status = /Status:\s*([^\r\n]+)/i.exec(stdout)?.[1]?.trim() ?? "unknown";
    const lastResult = /Last Result:\s*([^\r\n]+)/i.exec(stdout)?.[1]?.trim() ?? "unknown";
    return { installed: true, taskName: STARTUP_TASK_NAME, taskStatus: status, lastResult };
  } catch (error) {
    if (error.code === 1) return { installed: false, taskName: STARTUP_TASK_NAME };
    throw new Error(`Could not query Lichess startup task: ${error.stderr?.trim() || error.message}`);
  }
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
  try {
    await execFileAsync("schtasks.exe", ["/End", "/TN", STARTUP_TASK_NAME], { windowsHide: true, timeout: 10_000 });
  } catch {}
  try {
    await execFileAsync("schtasks.exe", ["/Delete", "/TN", STARTUP_TASK_NAME, "/F"], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    if (error.code !== 1) throw new Error(`Could not uninstall Lichess startup task: ${error.stderr?.trim() || error.message}`);
  }
  await rm(path.join(path.resolve(runtimeDir), "startup-task.json"), { force: true });
  return { installed: false, taskName: STARTUP_TASK_NAME };
}
