import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  NATIVE_LAUNCHER,
  STARTUP_TASK_NAME,
  buildTaskXml,
  startupAction,
} from "./windows-startup.mjs";

const execFileAsync = promisify(execFile);

function options() {
  return {
    config: "deploy/lichess/config.uci_arena.template.yml",
    tokenFile: "secrets/lichess_bot_token.txt",
    expectedAccount: "account",
    runtimeDir: "runtime_state/lichess",
    profile: "runtime_state/model/single.json",
    timeProfile: "runtime_state/model/time.json",
    capacityProfile: "runtime_state/model/capacity.json",
    modelRoot: "engine/runtime/models/model/engine",
    nativeLauncher: NATIVE_LAUNCHER,
  };
}

test("startup task is hidden, supervised, and invokes the foreground adapter through a GUI launcher", () => {
  const action = startupAction(options());
  assert.equal(action.command, path.resolve(NATIVE_LAUNCHER));
  assert.match(action.arguments, /lichess-adapter\.mjs run/);
  assert.match(action.arguments, /--token-file/);
  assert.match(action.arguments, /--time-profile/);
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
