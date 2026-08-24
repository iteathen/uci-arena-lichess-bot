import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RuntimeStatusPublisher,
  SerializedStatusPublisher,
} from "./runtime-status-publisher.mjs";

test("serialized status publication coalesces pending generations without overlap", async () => {
  const calls = [];
  const releases = [];
  let active = 0;
  let maximumActive = 0;
  const publisher = new SerializedStatusPublisher({
    write: async (_snapshot, generation) => {
      calls.push(generation);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return { byteLength: generation, activatedAt: generation * 10 };
    },
  });
  const first = publisher.schedule({ value: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  publisher.schedule({ value: 2 });
  const latest = publisher.schedule({ value: 3 });
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  await publisher.flush(latest);
  assert.deepEqual(calls, [first, latest]);
  assert.equal(maximumActive, 1);
  assert.equal(publisher.health().coalesced_generations, 1);
  await publisher.close();
});

test("status publication failure is bounded and a later generation recovers", async () => {
  const outcomes = [];
  const publisher = new SerializedStatusPublisher({
    write: async (_snapshot, generation) => {
      if (generation === 1) {
        const error = new Error(`failed\n${"x".repeat(1_000)}`);
        error.code = "WRITE_FAILED";
        throw error;
      }
      return { byteLength: 10, activatedAt: 20 };
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const failed = publisher.schedule({ value: 1 });
  await assert.rejects(publisher.flush(failed), { code: "WRITE_FAILED" });
  assert.equal(publisher.health().state, "failed");
  assert.ok(publisher.health().last_failure.detail.length <= 512);
  assert.equal(publisher.health().last_failure.detail.includes("\n"), false);
  const recovered = publisher.schedule({ value: 2 });
  await publisher.flush(recovered);
  assert.equal(publisher.health().state, "ready");
  assert.equal(publisher.health().failures, 1);
  assert.deepEqual(outcomes.map((outcome) => outcome.state), ["failed", "recovered"]);
  assert.equal(outcomes[0].failure.code, "WRITE_FAILED");
  await publisher.close();
});

test("worker status publication atomically activates bounded JSON and drains on close", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-runtime-status-"));
  const publisher = new RuntimeStatusPublisher(directory);
  const generation = publisher.schedule({ schema: "fixture", generation: 1 });
  await publisher.flush(generation);
  assert.ok(publisher.health().last_write_duration_ms >= 0);
  await publisher.close();
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(directory, "runtime.json"), "utf8")),
    { schema: "fixture", generation: 1 },
  );
});

test("worker clone failure does not strand publication or prevent recovery", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-runtime-status-clone-"));
  const publisher = new RuntimeStatusPublisher(directory);
  const failed = publisher.schedule({ unsupported: () => {} });
  await assert.rejects(publisher.flush(failed));
  const recovered = publisher.schedule({ schema: "fixture", generation: 2 });
  await publisher.flush(recovered);
  await publisher.close();
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(directory, "runtime.json"), "utf8")),
    { schema: "fixture", generation: 2 },
  );
});

test("close drains the latest scheduled generation before closing the writer", async () => {
  let release;
  let writerClosed = false;
  const publisher = new SerializedStatusPublisher({
    write: async (_snapshot, generation) => {
      await new Promise((resolve) => { release = resolve; });
      return { byteLength: generation, activatedAt: generation };
    },
    close: async () => { writerClosed = true; },
  });
  const generation = publisher.schedule({ generation: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const closing = publisher.close();
  assert.equal(writerClosed, false);
  release();
  await closing;
  assert.equal(writerClosed, true);
  assert.equal(publisher.health().last_success_generation, generation);
});
