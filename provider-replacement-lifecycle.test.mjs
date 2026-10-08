import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LichessStore } from "./lichess-store.mjs";
import { providerLifecycleResult } from "./lichess-adapter.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

test("successful Windows launch request with inactive task cannot publish typed install ready", (t) => {
  if (process.platform !== "win32") return t.skip("Windows mocked-platform install fixture");
  const result = spawnSync(process.execPath, [path.join(root, "test-fixtures", "inactive-install-platform.mjs")],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /inactive installation cannot publish typed active success/);
});

for (const [platform, active, enabled] of [["win32", true, true], ["linux", "active", "enabled"]]) {
  test(`typed ${platform} install reports ready only from observed installed enabled activity`, () => {
    const startup = { installed: true, active, enabled };
    const result = providerLifecycleResult("install", "ready", null, startup, platform);
    assert.equal(result.observed.activity, "active");
    for (const invalid of [
      { ...startup, installed: false },
      { ...startup, installed: undefined },
      { ...startup, active: platform === "win32" ? false : "inactive", started: true },
      { ...startup, active: "unknown", started: true },
      { ...startup, enabled: platform === "win32" ? false : "disabled" },
      { ...startup, enabled: "unknown" },
      null,
    ]) {
      assert.throws(() => providerLifecycleResult("install", "ready", null, invalid, platform),
        /installed, enabled, and active startup/);
    }
  });
}

function fixture(t) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "uci-arena-inactive-replacement-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const previousRoot = path.join(runtimeDir, "previous");
  const replacementRoot = path.join(runtimeDir, "replacement");
  const run = (action, replacement = replacementRoot, state = "") => spawnSync(process.execPath, [
    "--import", pathToFileURL(path.join(root, "test-fixtures", "absent-startup-platform.mjs")).href,
    path.join(root, "lichess-adapter.mjs"), "startup", action,
    "--lifecycle-result", "typed_v1", "--runtime-dir", runtimeDir,
    "--previous-root", previousRoot, "--replacement-root", replacement,
    "--config", path.join(runtimeDir, "nonexistent-config.json"),
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, UCI_ARENA_FIXTURE_TASK_STATE: state } });
  const snapshot = () => {
    const store = new LichessStore(path.join(runtimeDir, "matches.sqlite"));
    try { return store.providerLifecycleSnapshot(); } finally { store.close(); }
  };
  return { runtimeDir, replacementRoot, run, snapshot };
}

test("absent startup replacement preserves inactivity, closes admission, and resumes idempotently", (t) => {
  if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
  const { runtimeDir, run, snapshot } = fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = run("prepare_replace");
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = JSON.parse(prepared.stdout);
    assert.equal(result.schema, "arena_provider_lifecycle_result_v1");
    assert.equal(result.operation, "pre_replace");
    assert.deepEqual(result.observed, {
      installation: "installed", activity: "inactive", configuration: "matches", replacement: "safe",
    });
    assert.equal(snapshot().admissionBlocked, true);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const completed = run("complete_replace");
    assert.equal(completed.status, 0, completed.stderr);
    const result = JSON.parse(completed.stdout);
    assert.equal(result.operation, "post_replace");
    assert.equal(result.disposition, "safe_inactive");
    assert.equal(result.reason.id, "startup.explicitly_inactive");
    assert.equal(result.observed.activity, "inactive");
    assert.equal(snapshot().admissionBlocked, false);
  }
  const intent = JSON.parse(readFileSync(path.join(runtimeDir, "startup-replacement-intent.json")));
  assert.equal(intent.phase, "completed");
  assert.equal(intent.registration_present, false);
});

for (const state of ["active", "disabled"]) {
  test(`absent replacement intent rejects a new ${state} registration before admission resumes`, (t) => {
    if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
    const { replacementRoot, run, snapshot } = fixture(t);
    const prepared = run("prepare_replace");
    assert.equal(prepared.status, 0, prepared.stderr);
    const completed = run("complete_replace", replacementRoot, state);
    assert.equal(completed.status, 1);
    assert.equal(snapshot().admissionBlocked, true);
  });
}

for (const corrupt of ["preparing", "unknown_field"]) {
  test(`completion rejects ${corrupt} intent before admission resumes`, (t) => {
    if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
    const { runtimeDir, run, snapshot } = fixture(t);
    assert.equal(run("prepare_replace").status, 0);
    const filename = path.join(runtimeDir, "startup-replacement-intent.json");
    const intent = JSON.parse(readFileSync(filename));
    if (corrupt === "preparing") intent.phase = "preparing";
    else intent.unrecognized_authority = true;
    writeFileSync(filename, JSON.stringify(intent));
    assert.equal(run("complete_replace").status, 1);
    assert.equal(snapshot().admissionBlocked, true);
  });
}

test("absent startup does not let replacement bypass unresolved provider work", (t) => {
  if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
  const { runtimeDir, run, snapshot } = fixture(t);
  const store = new LichessStore(path.join(runtimeDir, "matches.sqlite"));
  const now = Date.now();
  store.acquireApiLease("https://lichess.org|fixture", "fixture-owner", 101, now, 60_000,
    null, { schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: 101,
      start_token: "504911232000000101", executable_path: "C:\\UCI Arena\\node.exe", boot_id: "" });
  store.claimProviderLifecycle("fixture-owner", now);
  store.beginProviderWork("fixture-owner", Date.now());
  store.close();
  const prepared = run("prepare_replace");
  assert.equal(prepared.status, 1);
  assert.match(prepared.stderr, /provider_owned_work_active/);
  assert.equal(snapshot().activeWork, 1);
  assert.equal(snapshot().admissionBlocked, false);
});

test("inactive completion cannot consume intent for a different replacement root", (t) => {
  if (process.platform !== "win32") return t.skip("Windows absent-task boundary fixture");
  const { runtimeDir, run, snapshot } = fixture(t);
  const prepared = run("prepare_replace");
  assert.equal(prepared.status, 0, prepared.stderr);
  const completed = run("complete_replace", path.join(runtimeDir, "unrelated"));
  assert.equal(completed.status, 1);
  assert.equal(snapshot().admissionBlocked, true);
});
