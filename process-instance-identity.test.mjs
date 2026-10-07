import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { NativeResourceHelper } from "@uci-arena/background-service-runtime/native-resource-helper";
import processContract from "@uci-arena/background-service-runtime/process-instance-query-contract" with { type: "json" };
import { probeProcessInstance, processIdentityFromJson, processInstanceIsCurrent, sameProcessInstance } from "./process-instance-identity.mjs";
import { LichessStore } from "./lichess-store.mjs";

const identity = {
  schema: "uci_arena_process_instance_identity_v1", platform: "win32", pid: 123,
  start_token: "639111234567890123", executable_path: "C:\\runtime\\provider.exe", boot_id: "",
};

test("Windows identity probes consume the configured public native query with unchanged default and shrinking budgets", (t) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", original));
  const calls = [];
  t.mock.method(NativeResourceHelper.prototype, "queryProcessInstanceSync", function(pid, options) {
    calls.push({ pid, options, helperPath: this.config.nativeHelper });
    return { schema: processContract.response_schema, state: "present", identity };
  });
  assert.deepEqual(probeProcessInstance(123), { state: "present", identity });
  assert.deepEqual(probeProcessInstance(123, { timeoutMs: 137 }), { state: "present", identity });
  assert.deepEqual(calls.map(({ pid, options }) => ({ pid, options })), [
    { pid: 123, options: { timeoutMs: 2000 } }, { pid: 123, options: { timeoutMs: 137 } },
  ]);
  assert.ok(calls.every(({ helperPath }) => path.isAbsolute(helperPath)));
});

test("Windows query absence and unknown observations keep distinct provider classifications", (t) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", original));
  let state = "absent";
  t.mock.method(NativeResourceHelper.prototype, "queryProcessInstanceSync", () => ({ schema: processContract.response_schema, state }));
  assert.deepEqual(probeProcessInstance(123), { state: "absent" });
  state = "unverifiable";
  assert.deepEqual(probeProcessInstance(123), { state: "unverifiable" });
});

test("persisted Windows identity admits the complete Unicode path domain without losing decimal ticks", () => {
  const components = [...Array(127).fill("界".repeat(255)), `${"界".repeat(248)}.exe`];
  const maximum = { ...identity, executable_path: `C:\\${components.join("\\")}` };
  assert.equal(maximum.executable_path.length, processContract.maximum_executable_path_utf16_units);
  const encoded = JSON.stringify(maximum);
  assert.ok(Buffer.byteLength(encoded) < processContract.maximum_response_bytes);
  const decoded = processIdentityFromJson(encoded, 123);
  assert.ok(decoded !== null);
  assert.equal(decoded.executable_path === maximum.executable_path, true);
  assert.equal(decoded.start_token, maximum.start_token);
  assert.equal(sameProcessInstance(maximum, { ...maximum }), true);
});

test("oversized and malformed persisted identity never falls back to a PID-only probe", () => {
  assert.equal(processIdentityFromJson(" ".repeat(processContract.maximum_response_bytes + 1) + JSON.stringify(identity)), null);
  for (const malformed of [
    { ...identity, start_token: Number(identity.start_token) },
    { ...identity, start_token: "3155378976000000000" },
    { ...identity, executable_path: "relative.exe" },
    { ...identity, executable_path: "C:\\bad\u0000.exe" },
    { ...identity, unowned_field: true },
  ]) {
    let probes = 0;
    assert.equal(processIdentityFromJson(JSON.stringify(malformed)), null);
    assert.equal(processInstanceIsCurrent(malformed, () => { probes += 1; return { state: "absent" }; }), false);
    assert.equal(probes, 0);
  }
});

test("lease persistence preserves a complete Windows identity and oversized stored records cannot prove PID reuse", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "uci-arena-identity-record-"));
  const store = new LichessStore(path.join(root, "matches.sqlite"));
  t.after(() => { try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  const components = [...Array(127).fill("界".repeat(255)), `${"界".repeat(248)}.exe`];
  const maximum = { ...identity, executable_path: `C:\\${components.join("\\")}` };
  const authority = "https://127.0.0.1|fixture";
  store.acquireApiLease(authority, "first-owner", identity.pid, 1000, 60000, null, maximum);
  const record = store.db.prepare("SELECT process_identity_json FROM api_client_leases WHERE authority_key=?").get(authority);
  assert.equal(processIdentityFromJson(record.process_identity_json).executable_path === maximum.executable_path, true);
  store.db.prepare("UPDATE api_client_leases SET process_identity_json=? WHERE authority_key=?")
    .run(" ".repeat(processContract.maximum_response_bytes + 1) + JSON.stringify(identity), authority);
  assert.throws(() => store.acquireApiLease(authority, "second-owner", identity.pid, 1001, 60000,
    () => ({ state: "present", identity: { ...identity, start_token: "639111234567890124" } }), identity),
  (error) => error.code === "LICHESS_API_LEASE_HELD");
});
