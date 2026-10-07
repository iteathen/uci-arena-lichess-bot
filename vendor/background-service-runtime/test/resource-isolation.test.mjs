import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compactRestaurantPacket,
  isAdministrativelyCoveredWddmProcess,
  ownerPacketPathIsRelevant,
  parseComputeRows,
  readRestaurantOwnerPacket,
} from "../src/resource-isolation.mjs";

test("owner sampling keeps the active model and only recent inactive packets", () => {
  const directory = mkdtempSync(join(tmpdir(), "uci-arena-owner-path-"));
  try {
    const activeRoot = join(directory, "active", "current");
    const inactiveRoot = join(directory, "inactive", "current");
    const activePath = join(activeRoot, "owner.json");
    const inactivePath = join(inactiveRoot, "owner.json");
    mkdirSync(activeRoot, { recursive: true });
    mkdirSync(inactiveRoot, { recursive: true });
    writeFileSync(activePath, "{}\n");
    writeFileSync(inactivePath, "{}\n");
    const referenceTimeMs = Date.now();
    assert.equal(ownerPacketPathIsRelevant(activePath, activeRoot, referenceTimeMs), true);
    assert.equal(ownerPacketPathIsRelevant(inactivePath, activeRoot, referenceTimeMs), true);
    const staleTime = new Date(referenceTimeMs - 60_000);
    utimesSync(activePath, staleTime, staleTime);
    utimesSync(inactivePath, staleTime, staleTime);
    assert.equal(ownerPacketPathIsRelevant(activePath, activeRoot, referenceTimeMs), true);
    assert.equal(ownerPacketPathIsRelevant(inactivePath, activeRoot, referenceTimeMs), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale heartbeat packets cannot claim a PID reused by another process", () => {
  const directory = mkdtempSync(join(tmpdir(), "uci-arena-owner-packet-"));
  try {
    const path = join(directory, "owner.json");
    writeFileSync(path, "{}\n");
    const stale = compactRestaurantPacket({
      pid: process.pid,
      heartbeat_unix: Date.now() / 1000 - 60,
      accelerator_kind: "cuda",
    }, path);
    assert.deepEqual(stale.alive_pids, [process.pid]);
    assert.equal(stale.pid_liveness_authoritative, false);
    assert.equal(stale.active, false);

    const heartbeatless = compactRestaurantPacket({
      pid: process.pid,
      accelerator_kind: "cuda",
    }, path);
    assert.equal(heartbeatless.pid_liveness_authoritative, true);
    assert.equal(heartbeatless.active, true);

    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(path, staleTime, staleTime);
    const staleHeartbeatless = compactRestaurantPacket({
      pid: process.pid,
      accelerator_kind: "cuda",
    }, path);
    assert.equal(staleHeartbeatless.pid_liveness_authoritative, false);
    assert.equal(staleHeartbeatless.active, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale zero-filled Restaurant owner packets are inactive shutdown tombstones", () => {
  const directory = mkdtempSync(join(tmpdir(), "uci-arena-owner-packet-"));
  try {
    const path = join(directory, "owner.json");
    writeFileSync(path, Buffer.alloc(256));
    const referenceTimeMs = Date.now();
    const staleTime = new Date(referenceTimeMs - 60_000);
    utimesSync(path, staleTime, staleTime);
    const result = readRestaurantOwnerPacket(path, referenceTimeMs);
    assert.equal(result.ok, true);
    assert.equal(result.tombstone, true);
    assert.equal(result.value, null);
    assert.ok(result.tombstone_age_seconds >= 60);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recent zero-filled Restaurant owner packets remain fail-closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "uci-arena-owner-packet-"));
  try {
    const path = join(directory, "owner.json");
    writeFileSync(path, Buffer.alloc(64));
    const result = readRestaurantOwnerPacket(path, Date.now());
    assert.equal(result.ok, false);
    assert.equal(result.tombstone, false);
    assert.match(result.error, /zero-filled owner packet is only/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("WDDM memory-unquantified display rows are covered only outside configured owner roots", () => {
  const text = [
    "101, C:\\Windows\\explorer.exe, [N/A], GPU-test",
    "202, C:\\chess_engine\\the_restaurant\\trainer.exe, [N/A], GPU-test",
    "303, C:\\tools\\compute.exe, 512, GPU-test",
  ].join("\n");
  const parsed = parseComputeRows(text, ["C:\\chess_engine\\the_restaurant"]);
  assert.deepEqual(parsed.malformed, []);
  assert.equal(parsed.processes.length, 3);
  assert.equal(isAdministrativelyCoveredWddmProcess(parsed.processes[0], "win32"), true);
  assert.equal(isAdministrativelyCoveredWddmProcess(parsed.processes[0], "linux"), false);
  assert.equal(parsed.processes[1].configured_external_owner, true);
  assert.equal(isAdministrativelyCoveredWddmProcess(parsed.processes[1], "win32"), false);
  assert.equal(isAdministrativelyCoveredWddmProcess(parsed.processes[2], "win32"), false);
  assert.deepEqual(parsed.configured_external_processes.map((row) => row.pid), [202]);
});
