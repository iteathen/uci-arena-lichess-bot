import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";

// Only fabricated platform responses are allowed; no native command runs.
childProcess.execFile = (file, args, options, callback) => {
  if (file === "whoami.exe") callback(null, '"fixture","S-1-5-21-1"', "");
  else if (file === "schtasks.exe" && ["/Create", "/Run", "/Query"].includes(args[0])) {
    callback(null, args[0] === "/Query"
      ? "Status: Ready\nScheduled Task State: Enabled\nLast Result: 0\n" : "", "");
  } else throw new Error(`Forbidden platform operation in inactive-install fixture: ${file}`);
};
childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] = (file, args, options) =>
  new Promise((resolve, reject) => childProcess.execFile(file, args, options,
    (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
syncBuiltinESMExports();
const { installWindowsStartup } = await import("../windows-startup.mjs");
const { providerLifecycleResult } = await import("../lichess-adapter.mjs");
const root = mkdtempSync(path.join(os.tmpdir(), "uci-arena-inactive-install-"));
try {
  const launcher = path.join(root, "fabricated-launcher.exe");
  writeFileSync(launcher, "non-executable fixture");
  const startup = await installWindowsStartup({
    expectedAccount: "fixture-bot", nativeLauncher: launcher,
    runtimeDir: path.join(root, "runtime"), config: path.join(root, "absent-config.json"),
    tokenFile: path.join(root, "absent-external-token"),
  });
  assert.equal(startup.installed, true);
  assert.equal(startup.active, false);
  assert.equal(startup.enabled, true);
  assert.equal(startup.started, true);
  assert.throws(() => providerLifecycleResult("install", "ready", null, startup),
    /installed, enabled, and active startup/);
  console.log("inactive installation cannot publish typed active success");
} finally {
  rmSync(root, { recursive: true, force: true });
}
