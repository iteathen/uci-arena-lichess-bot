import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  NATIVE_LAUNCHER,
  STARTUP_TASK_NAME,
  buildTaskXml,
  completeWindowsStartupReplacement,
  prepareWindowsStartupReplacement,
  retargetWindowsTaskXml,
  stopAndDeleteWindowsTask,
  startupAction,
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
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
});

test("native launcher is a Windows GUI process that creates a no-console child", async (t) => {
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
  });
});

test("two-phase replacement stops, retargets, and resumes the existing task", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows Task Scheduler contract");
  const previousRoot = path.dirname(path.dirname(NATIVE_LAUNCHER));
  const replacementRoot = path.join(path.dirname(previousRoot), "lichess.adapter", "1.0.10");
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "lichess-startup-replace-"));
  const commands = [];
  const execute = async (_file, argumentsList) => {
    commands.push(argumentsList[0]);
    return { stdout: argumentsList[0] === "/Query" ? buildTaskXml(options(), "S-1-5-21-1") : "" };
  };
  const prepareStates = [
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: true, taskStatus: "Running" },
    { installed: true, active: false, taskStatus: "Ready" },
    { installed: true, active: false, taskStatus: "Disabled" },
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
    ];
    const completed = await completeWindowsStartupReplacement({
      execute,
      query: async () => completeStates.shift(),
      delay: async () => {},
      pollMilliseconds: 10,
      timeoutMilliseconds: 100,
    });
    assert.equal(completed.active, true);
    assert.deepEqual(commands, ["/Query", "/End", "/Delete", "/Create", "/Change", "/Run"]);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
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
  assert.match(updated, /<LogonTrigger><Enabled>true<\/Enabled>/u);
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
  assert.deepEqual(commands, ["/End", "/Delete"]);
  assert.equal(delays, 2);
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
  assert.deepEqual(commands, ["/End"]);
});

test("startup teardown never hides an unknown scheduler state", async () => {
  await assert.rejects(stopAndDeleteWindowsTask({
    query: async () => ({ installed: true, taskStatus: "unknown" }),
  }), /Could not prove the Lichess startup task state/);
});
