import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  NATIVE_LAUNCHER,
  STARTUP_TASK_NAME,
  buildTaskXml,
  completeWindowsStartupReplacement,
  classifyWindowsStartup,
  ensureWindowsSupervisionXml,
  parseWindowsArguments,
  parseWindowsTaskResult,
  prepareWindowsStartupReplacement,
  quoteWindowsArgument,
  recoverWindowsStartup,
  reconcileWindowsTaskXml,
  retargetWindowsTaskXml,
  stopAndDeleteWindowsTask,
  startupAction,
  validateWindowsExitReceipt,
} from "./windows-startup.mjs";

const execFileAsync = promisify(execFile);

function options() {
  return {
    config: "config.uci_arena.template.yml",
    tokenFile: path.join(path.parse(path.resolve(".")).root, "operator-secrets", "lichess-bot.token"),
    expectedAccount: "account",
    runtimeDir: "runtime_state/lichess",
    profile: "runtime_state/model/single.json",
    timeProfile: "runtime_state/model/time.json",
    temporalCurve: "runtime_state/model/curve.json",
    capacityProfile: "runtime_state/model/capacity.json",
    modelRoot: "engine/runtime/models/model/engine",
    nativeLauncher: NATIVE_LAUNCHER,
  };
}

test("Windows startup recovery starts only the existing enabled task", async () => {
  const calls = [];
  let active = false;
  const recovered = await recoverWindowsStartup({
    platform: "win32",
    query: async () => ({ installed: true, enabled: true, active }),
    execute: async (executable, argumentsList) => {
      calls.push({ executable, argumentsList });
      active = true;
    },
  });
  assert.deepEqual(calls, [{
    executable: "schtasks.exe",
    argumentsList: ["/Run", "/TN", STARTUP_TASK_NAME],
  }]);
  assert.equal(recovered.active, true);
  assert.equal(recovered.registrationMutated, false);
  await assert.rejects(recoverWindowsStartup({
    platform: "win32",
    query: async () => ({ installed: true, enabled: false, active: false }),
    execute: async () => calls.push("unexpected"),
  }), /disabled/);
  assert.equal(calls.length, 1);
});

test("startup task is hidden, supervised, and invokes the foreground adapter through a GUI launcher", () => {
  assert.match(NATIVE_LAUNCHER.replaceAll("\\", "/"), /\/native\/lichess_adapter_launcher\.exe$/);
  assert.doesNotMatch(NATIVE_LAUNCHER.replaceAll("\\", "/"), /\/build\//);
  const action = startupAction(options());
  assert.equal(action.command, path.resolve(NATIVE_LAUNCHER));
  assert.match(action.arguments, /lichess-adapter\.mjs run/);
  assert.match(action.arguments, /--token-file/);
  assert.match(action.arguments, /--time-profile/);
  assert.match(action.arguments, /--temporal-curve-profile/);
  const xml = buildTaskXml(options(), "S-1-5-21-1");
  assert.match(xml, new RegExp(STARTUP_TASK_NAME));
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /<LogonTrigger><Repetition><Interval>PT1M<\/Interval><StopAtDurationEnd>false<\/StopAtDurationEnd><\/Repetition>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
});

test("native launcher creates a no-console child and publishes its exact exit receipt", async (t) => {
  if (process.platform !== "win32" || !existsSync(NATIVE_LAUNCHER)) {
    return t.skip("native Windows launcher is not built");
  }
  const { stdout } = await execFileAsync(NATIVE_LAUNCHER, ["--probe"], {
    windowsHide: true,
    timeout: 5_000,
  });
  assert.deepEqual(JSON.parse(stdout), {
    schema: "uci_arena_lichess_launcher_probe_v1",
    windows_gui_subsystem: true,
    create_no_window: true,
    atomic_exit_receipt: true,
    exit_receipt_schema: "uci_arena_lichess_exit_receipt_v1",
  });
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "lichess-launcher-receipt-"));
  try {
    await assert.rejects(
      execFileAsync(NATIVE_LAUNCHER, [
        process.execPath,
        "-e",
        "process.exit(23)",
        "--",
        "--runtime-dir",
        runtimeDir,
      ], { windowsHide: true, timeout: 5_000 }),
      (error) => Number(error.code) === 23,
    );
    const receipt = validateWindowsExitReceipt(JSON.parse(
      readFileSync(path.join(runtimeDir, "launcher-exit.json"), "utf8"),
    ));
    assert.equal(receipt.child_exit_code, 23);
    assert.equal(receipt.disposition, "unexpected_exit");
    assert.equal(receipt.restart_eligible, true);
    assert.doesNotMatch(
      JSON.stringify(receipt),
      /command|argument|environment|credential|authorization|bearer|output|path/iu,
    );
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("legacy Windows registration is upgraded to indefinite bounded retry without duplicates", () => {
  const legacy = buildTaskXml(options(), "S-1-5-21-1")
    .replace(/<Repetition>[\s\S]*?<\/Repetition>/u, "")
    .replace(/<RestartOnFailure>[\s\S]*?<\/RestartOnFailure>/u, "")
    .replace(/<MultipleInstancesPolicy>[\s\S]*?<\/MultipleInstancesPolicy>/u, "");
  const upgraded = ensureWindowsSupervisionXml(legacy);
  assert.equal((upgraded.match(/<Repetition>/gu) ?? []).length, 1);
  assert.equal((upgraded.match(/<RestartOnFailure>/gu) ?? []).length, 1);
  assert.equal((upgraded.match(/<MultipleInstancesPolicy>/gu) ?? []).length, 1);
  assert.match(upgraded, /<Repetition><Interval>PT1M<\/Interval><StopAtDurationEnd>false<\/StopAtDurationEnd><\/Repetition>/u);
  assert.match(upgraded, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/u);
  assert.match(upgraded, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/u);
  assert.ok(upgraded.indexOf("<MultipleInstancesPolicy>") < upgraded.indexOf("<DisallowStartIfOnBatteries>"));
  assert.ok(upgraded.indexOf("<RestartOnFailure>") > upgraded.indexOf("<Priority>"));
  assert.equal(ensureWindowsSupervisionXml(upgraded), upgraded);
});

function exitReceipt(childExitCode = 0xc0000409) {
  const clean = childExitCode === 0;
  return {
    schema: "uci_arena_lichess_exit_receipt_v1",
    process_instance: {
      schema: "uci_arena_process_instance_receipt_v1",
      platform: "win32",
      pid: 4242,
      creation_time_100ns: "134157312000000000",
    },
    started_at: "2026-08-23T01:00:00.000Z",
    exited_at: "2026-08-23T01:01:00.000Z",
    child_exit_code: childExitCode,
    clean,
    expected: clean,
    disposition: clean ? "clean_exit" : "unexpected_exit",
    restart_eligible: !clean,
  };
}

test("Windows exit receipt preserves high-bit exit evidence and rejects undeclared detail", () => {
  const receipt = validateWindowsExitReceipt(exitReceipt());
  assert.equal(receipt.child_exit_code, 3221226505);
  assert.equal(receipt.restart_eligible, true);
  assert.equal(parseWindowsTaskResult("0xC0000409"), 3221226505);
  assert.equal(parseWindowsTaskResult("-1073740791"), 3221226505);
  assert.equal(parseWindowsTaskResult("unknown"), null);
  assert.throws(
    () => validateWindowsExitReceipt({ ...exitReceipt(), command_line: "forbidden" }),
    /invalid shape/,
  );
  assert.throws(
    () => validateWindowsExitReceipt({ ...exitReceipt(), restart_eligible: false }),
    /inconsistent/,
  );
});

test("Windows startup projection distinguishes recovery, clean stop, and receipt failure", () => {
  const unexpected = validateWindowsExitReceipt(exitReceipt());
  const pending = classifyWindowsStartup(
    { installed: true, enabled: true, active: false, lastResult: "0xC0000409" },
    { state: "ready", receipt: unexpected, error: null },
  );
  assert.equal(pending.supervisionState, "restart_pending");
  assert.equal(pending.restartPending, true);
  assert.equal(pending.lastUnexpectedExit.child_exit_code, 3221226505);

  const active = classifyWindowsStartup(
    { installed: true, enabled: true, active: true, lastResult: "267009" },
    { state: "ready", receipt: unexpected, error: null },
  );
  assert.equal(active.supervisionState, "active");
  assert.equal(active.restartPending, false);
  assert.equal(active.lastUnexpectedExit.child_exit_code, 3221226505);

  const clean = validateWindowsExitReceipt(exitReceipt(0));
  assert.equal(classifyWindowsStartup(
    { installed: true, enabled: true, active: false, lastResult: "0" },
    { state: "ready", receipt: clean, error: null },
  ).supervisionState, "clean_stopped");

  const failed = classifyWindowsStartup(
    { installed: true, enabled: true, active: false, lastResult: "71" },
  );
  assert.equal(failed.exitReceiptState, "failed");
  assert.equal(failed.exitReceiptError, "exit_receipt_write_failed");
  assert.equal(failed.restartPending, true);
});

test("two-phase replacement stops, retargets, and resumes the existing task", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows Task Scheduler contract");
  const previousRoot = path.dirname(path.dirname(NATIVE_LAUNCHER));
  const replacementRoot = path.join(path.dirname(previousRoot), "lichess.adapter", "1.0.10");
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "lichess-startup-replace-"));
  const commands = [];
  const execute = async (_file, argumentsList) => {
    commands.push(argumentsList);
    const taskXml = buildTaskXml(options(), "S-1-5-21-1")
      .replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1");
    return { stdout: argumentsList[0] === "/Query" ? taskXml : "" };
  };
  const prepareStates = [
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: false, taskStatus: "Ready" },
    { installed: true, active: false, enabled: false, taskStatus: "Disabled" },
  ];
  try {
    const prepared = await prepareWindowsStartupReplacement({
      previousRoot,
      replacementRoot,
      runtimeDir,
      execute,
      query: async () => prepareStates.shift(),
      delay: async () => {},
      pollMilliseconds: 10,
      timeoutMilliseconds: 100,
    });
    assert.equal(prepared.replacementReady, true);
    const completeStates = [
      { installed: true, active: false, taskStatus: "Disabled" },
      { installed: true, active: true, taskStatus: "Running" },
      { installed: true, active: true, taskStatus: "Running" },
    ];
    const completed = await completeWindowsStartupReplacement({
      execute,
      query: async () => completeStates.shift(),
      delay: async () => {},
      pollMilliseconds: 10,
      timeoutMilliseconds: 100,
      stabilityMilliseconds: 20,
      launchGraceMilliseconds: 20,
    });
    assert.equal(completed.active, true);
    assert.equal(completed.providerReady, true);
    assert.equal(completed.launchAttempts, 1);
    assert.deepEqual(commands.map(([operation]) => operation), [
      "/Query", "/Change", "--terminate-owned-tree", "/Delete", "/Create", "/Change", "/Change", "/Run",
    ]);
    assert.deepEqual(commands[5], ["/Change", "/TN", STARTUP_TASK_NAME, "/DISABLE"]);
    assert.deepEqual(commands[6], ["/Change", "/TN", STARTUP_TASK_NAME, "/ENABLE"]);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("replacement immediately retries a child that exits during readiness stabilization", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows Task Scheduler contract");
  const commands = [];
  const execute = async (_file, argumentsList) => {
    commands.push(argumentsList);
    return { stdout: "" };
  };
  const states = [
    { installed: true, active: false, taskStatus: "Disabled" },
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: false, taskStatus: "Ready", lastResult: "1" },
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: true, taskStatus: "Running" },
  ];

  const completed = await completeWindowsStartupReplacement({
    execute,
    query: async () => states.shift(),
    ready: async () => true,
    delay: async () => {},
    pollMilliseconds: 10,
    timeoutMilliseconds: 100,
    stabilityMilliseconds: 20,
    launchGraceMilliseconds: 20,
  });

  assert.equal(completed.active, true);
  assert.equal(completed.providerReady, true);
  assert.equal(completed.launchAttempts, 2);
  assert.equal(commands.filter(([operation]) => operation === "/Run").length, 2);
});

test("replacement does not accept Task Scheduler Running before provider readiness", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows Task Scheduler contract");
  const states = [
    { installed: true, active: false, taskStatus: "Disabled" },
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: true, taskStatus: "Running" },
  ];
  const readiness = [false, true, true];

  const completed = await completeWindowsStartupReplacement({
    execute: async () => ({ stdout: "" }),
    query: async () => states.shift(),
    ready: async () => readiness.shift(),
    delay: async () => {},
    pollMilliseconds: 10,
    timeoutMilliseconds: 100,
    stabilityMilliseconds: 20,
    launchGraceMilliseconds: 20,
  });

  assert.equal(completed.providerReady, true);
  assert.equal(readiness.length, 0);
});

test("startup replacement retargets the owned task paths while preserving credentials", () => {
  const previousRoot = path.dirname(path.dirname(NATIVE_LAUNCHER));
  const replacementRoot = path.join(path.dirname(previousRoot), "lichess.adapter", "1.0.10");
  const original = buildTaskXml(options(), "S-1-5-21-1");
  const tokenFile = path.resolve(options().tokenFile);
  const updated = retargetWindowsTaskXml(original, previousRoot, replacementRoot);
  assert.doesNotMatch(updated, new RegExp(previousRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  assert.match(updated, new RegExp(replacementRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  assert.match(updated, new RegExp(tokenFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  assert.match(updated, /<Settings>[\s\S]*?<Enabled>false<\/Enabled>/u);
  assert.match(updated, /<LogonTrigger>[\s\S]*?<Enabled>true<\/Enabled>/u);
  assert.equal(
    retargetWindowsTaskXml(updated, replacementRoot, replacementRoot),
    updated,
  );
});

test("startup replacement accepts the Task Scheduler default when task enablement is omitted", () => {
  const previousRoot = path.dirname(path.dirname(NATIVE_LAUNCHER));
  const replacementRoot = path.join(path.dirname(previousRoot), "lichess.adapter", "1.0.10");
  const original = buildTaskXml(options(), "S-1-5-21-1")
    .replace(/(<Settings>[\s\S]*?)<Enabled>true<\/Enabled>/u, "$1");
  const updated = retargetWindowsTaskXml(original, previousRoot, replacementRoot);
  assert.doesNotMatch(updated, new RegExp(previousRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  assert.match(updated, new RegExp(replacementRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  assert.doesNotMatch(updated, /<Settings>[\s\S]*?<Enabled>false<\/Enabled>/u);
  assert.match(updated, /<LogonTrigger>[\s\S]*?<Enabled>true<\/Enabled>/u);
});

test("post-requalification reconciliation replaces stale runtime bindings and preserves credentials", () => {
  const stale = {
    ...options(),
    profile: "runtime_state/model/stale-single.json",
    capacityProfile: "runtime_state/model/stale-capacity.json",
    modelRoot: "engine/runtime/models/stale/engine",
  };
  const current = {
    ...options(),
    profile: "runtime_state/model/current-single.json",
    capacityProfile: "runtime_state/model/current-capacity.json",
    modelRoot: "engine/runtime/models/current/engine",
  };
  delete current.tokenFile;
  delete current.expectedAccount;
  const tokenFile = path.resolve(stale.tokenFile);
  const reconciled = reconcileWindowsTaskXml(buildTaskXml(stale, "S-1-5-21-1"), current);
  assert.doesNotMatch(reconciled, /stale-(single|capacity)|models\\stale/iu);
  assert.match(reconciled, /current-single\.json/iu);
  assert.match(reconciled, /current-capacity\.json/iu);
  assert.match(reconciled, /models\\current\\engine/iu);
  assert.match(
    reconciled,
    new RegExp(tokenFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
  );
  assert.match(reconciled, /--expected-account account/iu);
});

test("Windows startup argument parser is the inverse of canonical quoting", () => {
  const values = ["plain", "path with spaces\\", 'embedded"quote', ""];
  assert.deepEqual(parseWindowsArguments(values.map(quoteWindowsArgument).join(" ")), values);
});

test("startup teardown waits for launcher exit before deleting the task", async () => {
  const states = [
    { installed: true, taskStatus: "Running" },
    { installed: true, taskStatus: "Running" },
    { installed: true, taskStatus: "Ready" },
    { installed: false },
  ];
  const commands = [];
  let delays = 0;
  const result = await stopAndDeleteWindowsTask({
    execute: async (_file, argumentsList) => {
      commands.push(argumentsList[0]);
      return { stdout: "" };
    },
    query: async () => states.shift(),
    delay: async () => { delays += 1; },
    pollMilliseconds: 10,
    timeoutMilliseconds: 100,
  });
  assert.deepEqual(commands, ["/Change", "--terminate-owned-tree", "/Delete"]);
  assert.equal(delays, 1);
  assert.equal(result.installed, false);
  assert.equal(result.teardownComplete, true);
});

test("startup teardown fails closed while the launcher remains running", async () => {
  const commands = [];
  await assert.rejects(stopAndDeleteWindowsTask({
    execute: async (_file, argumentsList) => {
      commands.push(argumentsList[0]);
      return { stdout: "" };
    },
    query: async () => ({ installed: true, taskStatus: "Running" }),
    delay: async () => {},
    pollMilliseconds: 10,
    timeoutMilliseconds: 20,
  }), /Timed out waiting for the Lichess startup launcher to exit/);
  assert.deepEqual(commands, ["/Change", "--terminate-owned-tree"]);
});

test("startup teardown fails closed when exact process-tree termination fails", async () => {
  const commands = [];
  await assert.rejects(stopAndDeleteWindowsTask({
    execute: async (file, argumentsList) => {
      commands.push(argumentsList[0]);
      if (file !== "schtasks.exe") throw new Error("owned tree remained active");
      return { stdout: "" };
    },
    query: async () => ({ installed: true, taskStatus: "Running" }),
    delay: async () => {},
    pollMilliseconds: 10,
    timeoutMilliseconds: 20,
  }), /Could not terminate the Lichess startup process tree/);
  assert.deepEqual(commands, ["/Change", "--terminate-owned-tree"]);
});

test("startup teardown proves the owned tree even when Task Scheduler already reports ready", async () => {
  const states = [
    { installed: true, taskStatus: "Ready" },
    { installed: true, taskStatus: "Ready" },
    { installed: false },
  ];
  const commands = [];
  const result = await stopAndDeleteWindowsTask({
    execute: async (_file, argumentsList) => {
      commands.push(argumentsList[0]);
      return { stdout: "" };
    },
    query: async () => states.shift(),
    delay: async () => {},
    pollMilliseconds: 10,
    timeoutMilliseconds: 20,
  });
  assert.equal(result.teardownComplete, true);
  assert.deepEqual(commands, ["/Change", "--terminate-owned-tree", "/Delete"]);
});

test("startup teardown never hides an unknown scheduler state", async () => {
  await assert.rejects(stopAndDeleteWindowsTask({
    query: async () => ({ installed: true, taskStatus: "unknown" }),
  }), /Could not prove the Lichess startup task state/);
});
