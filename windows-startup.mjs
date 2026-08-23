import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import {
  classifyExactPathSync,
  createExactTemporaryFileSync,
  ensureExactDirectorySync,
  publishExactJsonSync,
  readExactJsonSync,
  removeExactPublishedFileSync,
} from "./exact-file.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;
const ADAPTER = path.join(HERE, "lichess-adapter.mjs");
export const STARTUP_TASK_NAME = "UCI Arena Lichess Adapter";
export const NATIVE_LAUNCHER = path.join(HERE, "native", "lichess_adapter_launcher.exe");
const STARTUP_FILE_LIMIT = 1024 * 1024;
const EXIT_RECEIPT_FILE = "launcher-exit.json";
const EXIT_RECEIPT_LIMIT = 16 * 1024;
const EXIT_RECEIPT_WRITE_FAILURE = 71;

function exactRegularFileExistsSync(filename, label) {
  const admission = classifyExactPathSync(filename, { label });
  if (admission.kind === "missing") return false;
  if (admission.kind !== "file") throw new Error(`${label} is not a regular non-link file`);
  return true;
}

function stageTaskXml(runtimeDirectory, prefix, xml) {
  const runtime = ensureExactDirectorySync(runtimeDirectory, "Lichess runtime directory");
  return createExactTemporaryFileSync(
    runtime,
    prefix,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]),
    { maximumBytes: STARTUP_FILE_LIMIT, label: "Lichess startup task XML" },
  );
}

function removeStagedTaskXml(staged) {
  removeExactPublishedFileSync(staged.filename, staged.identity, {
    label: "Lichess startup task XML",
  });
}

function requireWindows() {
  if (process.platform !== "win32") throw new Error("Lichess startup supervision is supported only on Windows");
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function xmlUnescape(value) {
  return String(value).replace(/&(quot|apos|lt|gt|amp);/gu, (_, entity) => ({
    quot: '"', apos: "'", lt: "<", gt: ">", amp: "&",
  })[entity]);
}

export function parseWindowsArguments(commandLine) {
  const result = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/u.test(commandLine[index] ?? "")) index += 1;
    if (index >= commandLine.length) break;
    let value = "";
    let quoted = false;
    while (index < commandLine.length) {
      let backslashes = 0;
      while (commandLine[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        value += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) value += '"';
        else quoted = !quoted;
        index += 1;
        continue;
      }
      value += "\\".repeat(backslashes);
      if (index >= commandLine.length || (!quoted && /\s/u.test(commandLine[index]))) break;
      value += commandLine[index];
      index += 1;
    }
    if (quoted) throw new Error("Existing Lichess startup arguments have an unterminated quote");
    result.push(value);
    while (/\s/u.test(commandLine[index] ?? "")) index += 1;
  }
  return result;
}

function existingCredentialProjection(argumentsText, adapterPath) {
  const values = parseWindowsArguments(argumentsText);
  if (values.length < 11 || values[2] !== "run"
      || path.resolve(values[1]) !== path.resolve(adapterPath)
      || !path.isAbsolute(values[0])) {
    throw new Error("Existing Lichess startup action is not the owned adapter command");
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
      throw new Error("Existing Lichess startup action has an unsupported argument shape");
    }
    bindings.set(flag, value);
  }
  for (const flag of ["--config", "--token-file", "--expected-account", "--runtime-dir"]) {
    if (!bindings.get(flag)) {
      throw new Error(`Existing Lichess startup action omits ${flag}`);
    }
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

function exactXmlElement(block, name) {
  const matches = [...block.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "giu"))];
  if (matches.length !== 1) throw new Error(`Existing Lichess startup task has invalid ${name}`);
  return xmlUnescape(matches[0][1]);
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
    <LogonTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><Delay>PT15S</Delay><UserId>${xmlEscape(userSid)}</UserId></LogonTrigger>
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

function replaceOrInsertSingleton(block, name, replacement, insertAtEnd = false) {
  const matches = [...block.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, "giu"))];
  if (matches.length > 1) {
    throw new Error(`Existing Lichess startup task has duplicate ${name} policy`);
  }
  if (matches.length === 1) return block.replace(matches[0][0], replacement);
  return insertAtEnd
    ? block.replace(/<\/[^>]+>$/u, `${replacement}$&`)
    : block.replace(/^(<[^>]+>)/u, `$1${replacement}`);
}

export function ensureWindowsSupervisionXml(taskXml) {
  const triggerMatches = [...taskXml.matchAll(/<LogonTrigger(?:\s[^>]*)?>[\s\S]*?<\/LogonTrigger>/giu)];
  const settingsMatches = [...taskXml.matchAll(/<Settings(?:\s[^>]*)?>[\s\S]*?<\/Settings>/giu)];
  if (triggerMatches.length !== 1 || settingsMatches.length !== 1) {
    throw new Error("Existing Lichess startup task must contain one LogonTrigger and Settings block");
  }
  const repetition = "<Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>";
  const instances = "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>";
  const restart = "<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>";
  const trigger = replaceOrInsertSingleton(triggerMatches[0][0], "Repetition", repetition);
  let settings = replaceOrInsertSingleton(settingsMatches[0][0], "MultipleInstancesPolicy", instances);
  settings = replaceOrInsertSingleton(settings, "RestartOnFailure", restart, true);
  return taskXml
    .replace(triggerMatches[0][0], trigger)
    .replace(settingsMatches[0][0], settings);
}

export function reconcileWindowsTaskXml(taskXml, options) {
  const execMatches = [...taskXml.matchAll(/<Exec>[\s\S]*?<\/Exec>/giu)];
  if (execMatches.length !== 1) {
    throw new Error("Existing Lichess startup task must contain one owned Exec action");
  }
  const existingExec = execMatches[0][0];
  const existingCommand = exactXmlElement(existingExec, "Command");
  const existingWorkingDirectory = exactXmlElement(existingExec, "WorkingDirectory");
  const expectedLauncher = path.resolve(options.nativeLauncher ?? NATIVE_LAUNCHER);
  if (path.resolve(existingCommand) !== expectedLauncher
      || path.resolve(existingWorkingDirectory) !== path.resolve(ROOT)) {
    throw new Error("Existing Lichess startup task action is not owned by this component root");
  }
  const credentials = existingCredentialProjection(
    exactXmlElement(existingExec, "Arguments"),
    ADAPTER,
  );
  const action = startupAction({
    ...options,
    ...credentials,
    nativeLauncher: expectedLauncher,
  });
  const replacementExec = `<Exec><Command>${xmlEscape(action.command)}</Command><Arguments>${xmlEscape(action.arguments)}</Arguments><WorkingDirectory>${xmlEscape(action.workingDirectory)}</WorkingDirectory></Exec>`;
  return ensureWindowsSupervisionXml(taskXml.replace(existingExec, replacementExec));
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

export function parseWindowsTaskResult(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0x[0-9a-f]+|-?\d+)$/iu.test(text)) return null;
  try {
    let parsed = BigInt(text);
    if (parsed < 0n) parsed += 0x1_0000_0000n;
    return parsed >= 0n && parsed <= 0xffff_ffffn ? Number(parsed) : null;
  } catch {
    return null;
  }
}

function requireExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid shape`);
  }
}

export function validateWindowsExitReceipt(value) {
  const keys = [
    "schema", "process_instance", "started_at", "exited_at", "child_exit_code",
    "clean", "expected", "disposition", "restart_eligible",
  ];
  requireExactKeys(value, keys, "Lichess launcher exit receipt");
  if (value.schema !== "uci_arena_lichess_exit_receipt_v1") {
    throw new Error("Lichess launcher exit receipt schema is incompatible");
  }
  requireExactKeys(
    value.process_instance,
    ["schema", "platform", "pid", "creation_time_100ns"],
    "Lichess launcher process instance",
  );
  const identity = value.process_instance;
  if (identity.schema !== "uci_arena_process_instance_receipt_v1"
      || identity.platform !== "win32"
      || !Number.isSafeInteger(identity.pid) || identity.pid < 1 || identity.pid > 0xffff_ffff
      || !/^[1-9]\d{0,19}$/u.test(identity.creation_time_100ns)) {
    throw new Error("Lichess launcher process instance is invalid");
  }
  for (const [field, timestamp] of [["started_at", value.started_at], ["exited_at", value.exited_at]]) {
    if (typeof timestamp !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)
        || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error(`Lichess launcher exit receipt ${field} is invalid`);
    }
  }
  if (Date.parse(value.exited_at) < Date.parse(value.started_at)
      || !Number.isSafeInteger(value.child_exit_code)
      || value.child_exit_code < 0 || value.child_exit_code > 0xffff_ffff) {
    throw new Error("Lichess launcher exit receipt chronology or code is invalid");
  }
  const clean = value.child_exit_code === 0;
  if (typeof value.clean !== "boolean" || typeof value.expected !== "boolean"
      || typeof value.restart_eligible !== "boolean"
      || value.clean !== clean || value.expected !== clean
      || value.restart_eligible !== !clean
      || value.disposition !== (clean ? "clean_exit" : "unexpected_exit")) {
    throw new Error("Lichess launcher exit receipt disposition is inconsistent");
  }
  return Object.freeze({
    ...value,
    process_instance: Object.freeze({ ...identity }),
  });
}

export function loadWindowsExitReceipt(runtimeDir) {
  if (!runtimeDir) return { state: "unavailable", receipt: null, error: null };
  const target = path.join(path.resolve(runtimeDir), EXIT_RECEIPT_FILE);
  try {
    const admission = classifyExactPathSync(target, { label: "Lichess launcher exit receipt" });
    if (admission.kind === "missing") {
      return { state: "unavailable", receipt: null, error: null };
    }
    if (admission.kind !== "file") throw new Error("exit receipt is not an exact file");
    const { value } = readExactJsonSync(target, {
      maximumBytes: EXIT_RECEIPT_LIMIT,
      label: "Lichess launcher exit receipt",
    });
    return { state: "ready", receipt: validateWindowsExitReceipt(value), error: null };
  } catch (error) {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
      ? error.code.toLowerCase()
      : "exit_receipt_invalid";
    return { state: "failed", receipt: null, error: code };
  }
}

export function classifyWindowsStartup(task, exitReceipt = {
  state: "unavailable", receipt: null, error: null,
}) {
  if (!task.installed) {
    return {
      ...task,
      supervisionState: "unregistered",
      restartPending: false,
      exitReceiptState: exitReceipt.state,
      exitReceiptError: exitReceipt.error,
      lastExit: exitReceipt.receipt,
      lastUnexpectedExit: exitReceipt.receipt?.disposition === "unexpected_exit"
        ? exitReceipt.receipt
        : null,
    };
  }
  const lastResultCode = parseWindowsTaskResult(task.lastResult);
  const receiptWriteFailed = lastResultCode === EXIT_RECEIPT_WRITE_FAILURE;
  const lastUnexpectedExit = exitReceipt.receipt?.disposition === "unexpected_exit"
    ? exitReceipt.receipt
    : null;
  const restartPending = task.enabled === true && !task.active
    && (lastUnexpectedExit !== null || receiptWriteFailed);
  const supervisionState = task.enabled === false
    ? "disabled"
    : task.active
      ? "active"
      : restartPending
        ? "restart_pending"
        : exitReceipt.receipt?.disposition === "clean_exit"
          ? "clean_stopped"
          : "inactive";
  return {
    ...task,
    lastResultCode,
    supervisionState,
    restartPending,
    exitReceiptState: receiptWriteFailed ? "failed" : exitReceipt.state,
    exitReceiptError: receiptWriteFailed ? "exit_receipt_write_failed" : exitReceipt.error,
    lastExit: exitReceipt.receipt,
    lastUnexpectedExit,
  };
}

async function queryStartupTask(execute = execFileAsync, runtimeDir) {
  try {
    const { stdout } = await execute("schtasks.exe", ["/Query", "/TN", STARTUP_TASK_NAME, "/FO", "LIST", "/V"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const status = /Status:\s*([^\r\n]+)/i.exec(stdout)?.[1]?.trim() ?? "unknown";
    const scheduledState = /Scheduled Task State:\s*([^\r\n]+)/i
      .exec(stdout)?.[1]?.trim() ?? "unknown";
    const lastResult = /Last Result:\s*([^\r\n]+)/i.exec(stdout)?.[1]?.trim() ?? "unknown";
    return classifyWindowsStartup({
      installed: true,
      active: /^running$/iu.test(status),
      enabled: /^enabled$/iu.test(scheduledState)
        ? true
        : /^disabled$/iu.test(scheduledState)
          ? false
          : null,
      taskName: STARTUP_TASK_NAME,
      taskStatus: status,
      lastResult,
    }, loadWindowsExitReceipt(runtimeDir));
  } catch (error) {
    if (missingTaskError(error)) {
      return classifyWindowsStartup(
        { installed: false, taskName: STARTUP_TASK_NAME },
        loadWindowsExitReceipt(runtimeDir),
      );
    }
    throw new Error(`Could not query Lichess startup task: ${error.stderr?.trim() || error.message}`);
  }
}

export async function queryWindowsStartup({ runtimeDir, execute = execFileAsync } = {}) {
  requireWindows();
  return queryStartupTask(execute, runtimeDir);
}

export async function recoverWindowsStartup({
  execute = execFileAsync,
  query = () => queryStartupTask(execute),
  platform = process.platform,
} = {}) {
  if (platform !== "win32") {
    throw new Error("Lichess startup supervision is supported only on Windows");
  }
  const registered = await query();
  if (!registered.installed) throw new Error(`Lichess startup task is not registered: ${STARTUP_TASK_NAME}`);
  if (registered.enabled !== true) throw new Error("Lichess startup task is disabled or its state is unknown");
  if (!registered.active) {
    await execute("schtasks.exe", ["/Run", "/TN", STARTUP_TASK_NAME], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  }
  return {
    ...(await query()),
    recoveryRequested: true,
    registrationMutated: false,
  };
}

async function stopWindowsTask({
  execute = execFileAsync,
  query = () => queryStartupTask(execute),
  delay = wait,
  pollMilliseconds = 100,
  timeoutMilliseconds = 20_000,
  controlLauncher = NATIVE_LAUNCHER,
  ownedLauncher = NATIVE_LAUNCHER,
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
  try {
    await execute("schtasks.exe", ["/Change", "/TN", STARTUP_TASK_NAME, "/DISABLE"], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    await execute(path.resolve(controlLauncher), [
      "--terminate-owned-tree",
      path.resolve(ownedLauncher),
      "--timeout-ms",
      String(timeoutMilliseconds),
    ], {
      windowsHide: true,
      timeout: timeoutMilliseconds + 5_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Could not terminate the Lichess startup process tree: ${error.stderr?.trim() || error.message}`);
  }
  state = await query();

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
    controlLauncher = NATIVE_LAUNCHER,
    ownedLauncher = NATIVE_LAUNCHER,
  } = options;
  let state = await stopWindowsTask({
    execute, query, delay, pollMilliseconds, timeoutMilliseconds, controlLauncher, ownedLauncher,
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
  if (settingsPattern.test(updated)) {
    updated = updated.replace(settingsPattern, "$1false$2");
  }
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
  await stopWindowsTask({
    execute,
    query,
    delay,
    pollMilliseconds,
    timeoutMilliseconds,
    controlLauncher: NATIVE_LAUNCHER,
    ownedLauncher: path.join(path.resolve(previousRoot), "native", "lichess_adapter_launcher.exe"),
  });
  const stagedXml = stageTaskXml(path.resolve(runtimeDir), "startup-replacement", updatedXml);
  try {
    await execute("schtasks.exe", ["/Delete", "/TN", STARTUP_TASK_NAME, "/F"], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    await execute("schtasks.exe", ["/Create", "/TN", STARTUP_TASK_NAME, "/XML", stagedXml.filename, "/F"], {
      windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    await execute("schtasks.exe", ["/Change", "/TN", STARTUP_TASK_NAME, "/DISABLE"], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
  } finally {
    removeStagedTaskXml(stagedXml);
  }
  const state = await query();
  if (!state.installed || state.active || state.enabled !== false) {
    throw new Error("Lichess startup task did not enter replacement-ready state");
  }
  return { ...state, installed: true, active: false, replacementReady: true };
}

export async function reconcileWindowsStartupReplacement({
  startupOptions,
  execute = execFileAsync,
  query = () => queryStartupTask(execute),
} = {}) {
  requireWindows();
  if (!startupOptions?.runtimeDir) {
    throw new Error("startup replacement reconciliation requires current runtime bindings");
  }
  const before = await query();
  if (!before.installed || before.active || before.enabled !== false) {
    throw new Error("Lichess startup task is not disabled and inactive for reconciliation");
  }
  const { stdout } = await execute(
    "schtasks.exe", ["/Query", "/TN", STARTUP_TASK_NAME, "/XML"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  const updatedXml = reconcileWindowsTaskXml(stdout, startupOptions);
  const stagedXml = stageTaskXml(
    path.resolve(startupOptions.runtimeDir),
    "startup-reconcile",
    updatedXml,
  );
  try {
    await execute("schtasks.exe", ["/Delete", "/TN", STARTUP_TASK_NAME, "/F"], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    await execute("schtasks.exe", ["/Create", "/TN", STARTUP_TASK_NAME, "/XML", stagedXml.filename, "/F"], {
      windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    await execute("schtasks.exe", ["/Change", "/TN", STARTUP_TASK_NAME, "/DISABLE"], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
  } finally {
    removeStagedTaskXml(stagedXml);
  }
  const state = await query();
  if (!state.installed || state.active || state.enabled !== false) {
    throw new Error("Lichess startup task did not remain replacement-ready after reconciliation");
  }
  return { ...state, installed: true, active: false, replacementReady: true };
}

export async function completeWindowsStartupReplacement({
  execute = execFileAsync,
  query = () => queryStartupTask(execute),
  ready = async () => true,
  delay = wait,
  pollMilliseconds = 100,
  timeoutMilliseconds = 20_000,
  stabilityMilliseconds = 3_000,
  launchGraceMilliseconds = 2_000,
  maximumLaunchAttempts = 3,
} = {}) {
  requireWindows();
  for (const [name, value, minimum, maximum] of [
    ["pollMilliseconds", pollMilliseconds, 10, 1_000],
    ["timeoutMilliseconds", timeoutMilliseconds, pollMilliseconds, 60_000],
    ["stabilityMilliseconds", stabilityMilliseconds, pollMilliseconds, timeoutMilliseconds],
    ["launchGraceMilliseconds", launchGraceMilliseconds, pollMilliseconds, timeoutMilliseconds],
    ["maximumLaunchAttempts", maximumLaunchAttempts, 1, 5],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Lichess replacement ${name} policy is invalid`);
    }
  }
  if (typeof ready !== "function") {
    throw new Error("Lichess replacement readiness probe is invalid");
  }
  let state = await query();
  if (!state.installed) throw new Error("Lichess startup task is unavailable after replacement");
  await execute("schtasks.exe", ["/Change", "/TN", STARTUP_TASK_NAME, "/ENABLE"], {
    windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  let launchAttempts = 0;
  let pollsSinceLaunch = 0;
  let observedActiveForLaunch = false;
  const launch = async () => {
    await execute("schtasks.exe", ["/Run", "/TN", STARTUP_TASK_NAME], {
      windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    launchAttempts += 1;
    pollsSinceLaunch = 0;
    observedActiveForLaunch = false;
  };
  await launch();
  const attempts = Math.ceil(timeoutMilliseconds / pollMilliseconds);
  const stablePollsRequired = Math.ceil(stabilityMilliseconds / pollMilliseconds);
  const launchGracePolls = Math.ceil(launchGraceMilliseconds / pollMilliseconds);
  let consecutiveReadyPolls = 0;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    state = await query();
    if (!state.installed) {
      throw new Error("Lichess startup task disappeared during replacement completion");
    }
    if (state.active) {
      observedActiveForLaunch = true;
      if (await ready()) {
        consecutiveReadyPolls += 1;
        if (consecutiveReadyPolls >= stablePollsRequired) {
          return {
            ...state,
            installed: true,
            active: true,
            providerReady: true,
            replacementReady: false,
            launchAttempts,
            stabilityMilliseconds,
          };
        }
      } else {
        consecutiveReadyPolls = 0;
      }
    } else {
      consecutiveReadyPolls = 0;
      const launchFailed = observedActiveForLaunch || pollsSinceLaunch >= launchGracePolls;
      if (launchFailed && launchAttempts < maximumLaunchAttempts) await launch();
    }
    if (attempt === attempts) break;
    await delay(pollMilliseconds);
    pollsSinceLaunch += 1;
  }
  throw new Error("Timed out waiting for stable replacement Lichess provider readiness");
}

export async function installWindowsStartup(options) {
  requireWindows();
  if (!options.expectedAccount) throw new Error("startup install requires --expected-account");
  const launcher = path.resolve(options.nativeLauncher ?? NATIVE_LAUNCHER);
  if (!exactRegularFileExistsSync(launcher, "Lichess windowless launcher")) {
    throw new Error("Lichess windowless launcher is unavailable");
  }
  const runtimeDir = path.resolve(options.runtimeDir);
  ensureExactDirectorySync(runtimeDir, "Lichess runtime directory");
  const userSid = await currentUserSid();
  const taskXml = buildTaskXml({ ...options, nativeLauncher: launcher }, userSid);
  const stagedXml = stageTaskXml(runtimeDir, "startup-task", taskXml);
  try {
    await execFileAsync("schtasks.exe", ["/Create", "/TN", STARTUP_TASK_NAME, "/XML", stagedXml.filename, "/F"], {
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Could not install Lichess startup task: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  } finally {
    removeStagedTaskXml(stagedXml);
  }
  const evidence = {
    schema: "uci_arena_lichess_startup_v1",
    taskName: STARTUP_TASK_NAME,
    installedAt: new Date().toISOString(),
    windowless: true,
    runtimeDir,
  };
  publishExactJsonSync(path.join(runtimeDir, "startup-task.json"), evidence, {
    maximumBytes: STARTUP_FILE_LIMIT,
    label: "Lichess startup task evidence",
  });
  await execFileAsync("schtasks.exe", ["/Run", "/TN", STARTUP_TASK_NAME], {
    windowsHide: true,
    timeout: 10_000,
  });
  return { ...(await queryWindowsStartup({ runtimeDir })), started: true, launcher };
}

export async function uninstallWindowsStartup(runtimeDir) {
  requireWindows();
  const teardown = await stopAndDeleteWindowsTask();
  await rm(path.join(path.resolve(runtimeDir), "startup-task.json"), { force: true });
  return teardown;
}
