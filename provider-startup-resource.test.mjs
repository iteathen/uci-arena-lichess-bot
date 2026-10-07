import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { DEFAULT_TEMPLATE, main, ROOT } from "./lichess-adapter.mjs";
import { LichessStore } from "./lichess-store.mjs";

for (const [command, failure] of [["probe", "identity"], ["run", "identity"], ["run", "storage"]]) {
  test(`${command} ${failure} initialization failure releases acquired startup resources`, async (t) => {
    if (process.platform !== "win32") return t.skip("Windows exact-process probe injection");
    const root = mkdtempSync(path.join(os.tmpdir(), "uci-arena-startup-resource-"));
    const configPath = path.join(root, "config.json");
    const config = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
    config.url = "http://127.0.0.1:1/";
    config.engine = {
      adapter: "standard_uci_v1", executable: process.execPath,
      arguments: [path.join(ROOT, "test-fixtures", "fake-standard-uci-engine.mjs")],
      working_directory: ROOT, uci_options: {},
    };
    config.timing.opponent_turn_search = false;
    config.capacity = {
      total_slots: 1, startup_parallelism: 1, capacity_profile: null,
      human: { slots: 0, allow_borrowing: false, accept_public: false },
      bot: { slots: 1, target_active: 0 },
    };
    config.scheduler.enabled = false;
    writeFileSync(configPath, JSON.stringify(config));
    const tokenFile = path.join(root, "fabricated-token");
    writeFileSync(tokenFile, "fabricated-unused-startup-token");
    const before = Object.fromEntries(["SIGINT", "SIGTERM"].map((signal) => [signal, process.listeners(signal)]));
    const inputBefore = process.stdin.listeners("data");
    const inputWasFlowing = process.stdin.readableFlowing === true;
    const stores = [];
    const originalControl = LichessStore.prototype.readControlProjection;
    t.mock.method(LichessStore.prototype, "readControlProjection", function (...args) {
      if (!stores.includes(this)) stores.push(this);
      return originalControl.apply(this, args);
    });
    const originalExec = childProcess.execFileSync;
    t.mock.method(childProcess, "execFileSync", function (executable, args, options) {
      if (failure === "identity" && executable === "powershell.exe" && options?.env?.UCI_ARENA_PROCESS_PROBE_PID) {
        throw Object.assign(new Error("injected exact-process probe timeout"), { code: "ETIMEDOUT" });
      }
      return originalExec(executable, args, options);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const store of stores) { try { store.close(); } catch {} }
      for (const signal of Object.keys(before)) {
        for (const handler of process.listeners(signal)) {
          if (!before[signal].includes(handler)) process.off(signal, handler);
        }
      }
      for (const handler of process.stdin.listeners("data")) {
        if (!inputBefore.includes(handler)) process.stdin.off("data", handler);
      }
      if (!inputWasFlowing) process.stdin.pause();
      rmSync(root, { recursive: true, force: true });
    });
    const options = [
      command, "--config", configPath, "--runtime-dir", path.join(root, "runtime"),
      "--token-file", tokenFile, "--expected-account", "fixturearenabot",
    ];
    if (failure === "storage") options.push("--store", root);
    await assert.rejects(main(options), failure === "identity"
      ? /current process instance identity is unavailable/
      : (error) => error.code === "LICHESS_STORAGE_PATH_TYPE_INVALID");
    assert.equal(stores.length, failure === "identity" ? 1 : 0);
    if (stores.length) assert.throws(() => stores[0].db.prepare("SELECT 1"), /not open|closed/iu);
    assert.deepEqual(process.listeners("SIGINT"), before.SIGINT);
    assert.deepEqual(process.listeners("SIGTERM"), before.SIGTERM);
    assert.deepEqual(process.stdin.listeners("data"), inputBefore);
    assert.equal(process.stdin.readableFlowing === true, inputWasFlowing);
    if (failure === "identity") {
      const database = path.join(root, "runtime", "matches.sqlite");
      renameSync(database, `${database}.closed`);
    }
  });
}

test("loopback fixtures terminate owned children and servers even when workspace removal fails", { timeout: 25_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "uci-arena-fixture-disposal-"));
  const journal = path.join(root, "owned-roots.json");
  t.after(() => {
    const ownedRoots = JSON.parse(readFileSync(journal, "utf8"));
    for (const owned of ownedRoots) {
      assert.equal(path.dirname(owned), os.tmpdir());
      assert.match(path.basename(owned), /^uci-arena-/u);
      rmSync(owned, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  });
  const execute = promisify(childProcess.execFile);
  const fixtureEnvironment = { ...process.env, UCI_ARENA_FIXTURE_ROOT_JOURNAL: journal };
  delete fixtureEnvironment.NODE_TEST_CONTEXT;
  await assert.rejects(execute(process.execPath, [
    "--import", pathToFileURL(path.join(ROOT, "test-fixtures", "fail-provider-workspace-removal.mjs")).href,
    "--test", "--test-isolation=none", "--test-reporter=tap",
    "--test-name-pattern=provider probe reaches the account API without a configured engine|supervised startup publishes restored cooldown before its account probe waits",
    path.join(ROOT, "fake-api-server.test.mjs"),
  ], {
    windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
    env: fixtureEnvironment,
  }), (error) => {
    assert.equal(error.killed, false, "fixture cleanup must exit without the outer process kill");
    assert.equal(error.signal, null);
    assert.equal(error.code, 1, "the cleanup failure must remain a failed test");
    assert.match(error.stdout, /injected provider workspace removal failure/u);
    return true;
  });
});
