import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  RESOURCE_LEASE_REVOCATION_SCHEMA,
  RESOURCE_LEASE_SCHEMA,
  RESOURCE_LEASE_SCOPE,
  acquireResourceLease,
  resourceLeaseSnapshot,
  validateInheritedResourceLease,
} from "../src/background-resource-lease.mjs";
import {
  RESOURCE_LEASE_MAX_PRODUCER_LENGTH,
  RESOURCE_LEASE_MAX_REQUESTS,
  RESOURCE_LEASE_MAX_STORE_BYTES,
  RESOURCE_LEASE_STORE_FILENAME,
  ResourceLeaseStore,
} from "../src/background-resource-lease-store.mjs";

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function leaseRoot() {
  return mkdtempSync(join(tmpdir(), "uci-arena-resource-lease-test-"));
}

function legacyPacket({
  priority = "foreground",
  producer = "legacy-client",
  nonce = randomUUID(),
  token = randomUUID(),
  requestedAt = new Date().toISOString(),
  heartbeatAt = new Date().toISOString(),
  kind = "request",
} = {}) {
  return {
    schema: RESOURCE_LEASE_SCHEMA,
    scope: RESOURCE_LEASE_SCOPE,
    kind,
    priority,
    producer,
    pid: process.pid,
    nonce,
    token,
    requested_at: requestedAt,
    heartbeat_at: heartbeatAt,
  };
}

function writeLegacyRequest(root, packet) {
  const filename = join(root, `request-${packet.priority}-${packet.nonce}.json`);
  writeFileSync(filename, `${JSON.stringify(packet)}\n`, "utf8");
  return filename;
}

test("typed revocation reports none and release without private paths", async () => {
  const root = leaseRoot();
  let lease;
  try {
    lease = await acquireResourceLease({
      producer: "typed-observation-test",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    assert.ok(lease);
    const observation = lease.observeRevocation();
    assert.equal(observation.schema, RESOURCE_LEASE_REVOCATION_SCHEMA);
    assert.equal(observation.revoked, false);
    assert.equal(observation.code, "none");
    assert.equal(lease.revocationReason(), "");
    assert.equal(validateInheritedResourceLease(lease.token, { root }).valid, true);

    const snapshot = resourceLeaseSnapshot({ root });
    assert.equal(snapshot.holder.producer, "typed-observation-test");
    assert.equal("root" in snapshot, false);
    assert.equal("filename" in snapshot.holder, false);

    lease.release();
    assert.equal(lease.observeRevocation().code, "released");
    lease = null;
  } finally {
    lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait selects the earliest foreground request and heartbeats preserve its origin", async () => {
  const root = leaseRoot();
  let background;
  let firstPromise;
  let secondPromise;
  let first;
  let second;
  try {
    background = await acquireResourceLease({
      producer: "background-holder",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    const wait = background.waitForRevocation({ maximumPollMs: 50, timeoutMs: 1_000 });
    firstPromise = acquireResourceLease({
      producer: "first-foreground",
      priority: "foreground",
      root,
      timeoutMs: 3_000,
    });
    await delay(20);
    secondPromise = acquireResourceLease({
      producer: "second-foreground",
      priority: "foreground",
      root,
      timeoutMs: 3_000,
    });

    const observation = await wait;
    assert.equal(observation.code, "foreground_request", JSON.stringify(observation));
    assert.equal(observation.request.producer, "first-foreground");
    assert.ok(Number.isSafeInteger(observation.request.visible_at_ms));
    assert.equal(
      observation.request.visible_at,
      new Date(observation.request.visible_at_ms).toISOString(),
    );
    const originalVisibility = observation.request.visible_at_ms;
    await delay(25);
    assert.equal(background.heartbeat(), true);
    assert.equal(background.observeRevocation().request.visible_at_ms, originalVisibility);

    background.release();
    background = null;
    first = await firstPromise;
    assert.equal(first.packet.producer, "first-foreground");
    first.release();
    first = null;
    second = await secondPromise;
    assert.equal(second.packet.producer, "second-foreground");
    second.release();
    second = null;
  } finally {
    try { background?.release(); } catch {}
    try { first?.release(); } catch {}
    try { second?.release(); } catch {}
    try { (await firstPromise)?.release(); } catch {}
    try { (await secondPromise)?.release(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("wait timeout and cancellation close their resources", async () => {
  const root = leaseRoot();
  let lease;
  try {
    lease = await acquireResourceLease({
      producer: "wait-cleanup",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    const timeout = await lease.waitForRevocation({ maximumPollMs: 10, timeoutMs: 30 });
    assert.equal(timeout.code, "none");

    const controller = new AbortController();
    const cancelled = lease.waitForRevocation({
      signal: controller.signal,
      maximumPollMs: 10,
      timeoutMs: 1_000,
    });
    controller.abort("operator cancelled wait");
    await assert.rejects(cancelled, { name: "AbortError" });
    lease.release();
    lease = null;
  } finally {
    lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("current clients consume legacy foreground requests and publish legacy holders", async () => {
  const root = leaseRoot();
  let lease;
  let requestPath;
  try {
    lease = await acquireResourceLease({
      producer: "current-client",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    assert.equal(resourceLeaseSnapshot({ root }).holder.producer, "current-client");

    const packet = legacyPacket({ producer: "previous-client" });
    requestPath = writeLegacyRequest(root, packet);
    const observation = lease.observeRevocation();
    assert.equal(observation.code, "foreground_request");
    assert.equal(observation.request.producer, "previous-client");
    assert.equal(observation.request.visible_at, packet.requested_at);
  } finally {
    if (requestPath) {
      try { unlinkSync(requestPath); } catch {}
    }
    lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live previous-version holder blocks a current client", async () => {
  const root = leaseRoot();
  const holder = legacyPacket({
    kind: "holder",
    priority: "background",
    producer: "previous-holder",
  });
  const holderPath = join(root, "holder.json");
  try {
    writeFileSync(holderPath, `${JSON.stringify(holder)}\n`, "utf8");
    const lease = await acquireResourceLease({
      producer: "current-waiter",
      priority: "background",
      root,
      pollMs: 10,
      timeoutMs: 40,
    });
    assert.equal(lease, null);
    assert.equal(resourceLeaseSnapshot({ root }).holder.producer, "previous-holder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("future and malformed legacy visibility origins revoke fail closed", async () => {
  const root = leaseRoot();
  let lease;
  let requestPath;
  try {
    lease = await acquireResourceLease({
      producer: "time-validator",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    const futureAt = new Date(Date.now() + 60_000).toISOString();
    requestPath = writeLegacyRequest(root, legacyPacket({ requestedAt: futureAt }));
    const future = lease.observeRevocation();
    assert.equal(future.code, "coordination_failure");
    assert.equal(future.detail, "resource_lease_request_time_invalid");

    unlinkSync(requestPath);
    requestPath = writeLegacyRequest(root, legacyPacket({ requestedAt: "not-a-time" }));
    const malformed = lease.observeRevocation();
    assert.equal(malformed.code, "coordination_failure");
    assert.equal(malformed.detail, "resource_lease_request_time_invalid");
  } finally {
    if (requestPath) {
      try { unlinkSync(requestPath); } catch {}
    }
    lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("producer and legacy request capacity are bounded", async () => {
  const root = leaseRoot();
  let lease;
  try {
    await assert.rejects(
      acquireResourceLease({
        producer: "x".repeat(RESOURCE_LEASE_MAX_PRODUCER_LENGTH + 1),
        priority: "background",
        root,
        timeoutMs: 10,
      }),
      /producer must be/,
    );
    await assert.rejects(
      acquireResourceLease({
        producer: "invalid-poll",
        priority: "background",
        root,
        pollMs: 1_001,
      }),
      /pollMs must be/,
    );
    await assert.rejects(
      acquireResourceLease({
        producer: "invalid\nproducer",
        priority: "background",
        root,
      }),
      /without control characters/,
    );
    lease = await acquireResourceLease({
      producer: "capacity-holder",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    const timestamp = new Date().toISOString();
    for (let index = 0; index <= RESOURCE_LEASE_MAX_REQUESTS; index += 1) {
      writeLegacyRequest(root, legacyPacket({
        producer: `legacy-${index}`,
        requestedAt: timestamp,
        heartbeatAt: timestamp,
      }));
    }
    const observation = lease.observeRevocation();
    assert.equal(observation.code, "coordination_failure");
    assert.equal(observation.detail, "resource_lease_capacity_exceeded");
  } finally {
    lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("transactional store preserves FIFO identity and conditional cleanup", () => {
  const root = leaseRoot();
  let now = Date.now();
  const store = new ResourceLeaseStore(root, {
    clock: () => now,
    isProcessAlive: () => true,
  });
  try {
    const background = store.publishRequest({
      nonce: randomUUID(),
      token: randomUUID(),
      priority: "background",
      producer: "background",
      pid: process.pid,
    }, 10_000);
    now += 1;
    const foreground = store.publishRequest({
      nonce: randomUUID(),
      token: randomUUID(),
      priority: "foreground",
      producer: "foreground",
      pid: process.pid,
    }, 10_000);
    assert.equal(store.tryAcquireHolder(background, 10_000), null);
    const holder = store.tryAcquireHolder(foreground, 10_000);
    assert.equal(holder.producer, "foreground");
    const originalVisibility = holder.visible_at_ms;
    now += 50;
    assert.equal(store.heartbeatHolder(holder), now);
    assert.equal(store.snapshot(10_000).holder.visible_at_ms, originalVisibility);
    now -= 25;
    assert.equal(store.snapshot(10_000).holder.nonce, holder.nonce);
    now += 25;
    store.database.prepare("UPDATE lease_holder SET heartbeat_ms = ? WHERE slot = 1")
      .run(now + 1_000);
    assert.throws(
      () => store.snapshot(10_000),
      { code: "resource_lease_store_clock_invalid" },
    );
    store.database.prepare("UPDATE lease_holder SET heartbeat_ms = ? WHERE slot = 1").run(now);
    assert.equal(store.releaseHolder({ ...holder, token: randomUUID() }), false);
    assert.equal(store.snapshot(10_000).holder.nonce, holder.nonce);
    assert.equal(store.releaseHolder(holder), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("holder replacement is a typed identity-change revocation", async () => {
  const root = leaseRoot();
  let lease;
  try {
    lease = await acquireResourceLease({
      producer: "identity-holder",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    const replacement = legacyPacket({
      kind: "holder",
      priority: "background",
      producer: "replacement-holder",
    });
    writeFileSync(join(root, "holder.json"), `${JSON.stringify(replacement)}\n`, "utf8");
    const observation = lease.observeRevocation();
    assert.equal(observation.code, "holder_identity_changed");
    assert.equal(observation.request, null);
  } finally {
    lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy compatibility directory scans have a total entry bound", async () => {
  const root = leaseRoot();
  let lease;
  try {
    lease = await acquireResourceLease({
      producer: "scan-bound-holder",
      priority: "background",
      root,
      timeoutMs: 500,
    });
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(join(root, `unrelated-${index}.tmp`), "x", "utf8");
    }
    const observation = lease.observeRevocation();
    assert.equal(observation.code, "coordination_failure");
    assert.equal(observation.detail, "resource_lease_compatibility_scan_exceeded");
  } finally {
    lease?.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("transactional store rejects an oversized existing database", () => {
  const root = leaseRoot();
  try {
    writeFileSync(
      join(root, RESOURCE_LEASE_STORE_FILENAME),
      Buffer.alloc(RESOURCE_LEASE_MAX_STORE_BYTES + 1),
    );
    assert.throws(
      () => new ResourceLeaseStore(root),
      { code: "resource_lease_store_capacity_exceeded" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreground request preempts a holder in another process", { timeout: 10_000 }, async () => {
  const root = leaseRoot();
  const leaseModule = pathToFileURL(
    join(import.meta.dirname, "..", "src", "background-resource-lease.mjs"),
  ).href;
  const childSource = `
    import { acquireResourceLease } from ${JSON.stringify(leaseModule)};
    const lease = await acquireResourceLease({
      producer: "child-background",
      priority: "background",
      root: process.env.UCI_ARENA_TEST_LEASE_ROOT,
      timeoutMs: 2_000,
    });
    if (!lease) throw new Error("child background lease unavailable");
    console.log("READY");
    const observation = await lease.waitForRevocation({ maximumPollMs: 50, timeoutMs: 5_000 });
    console.log(JSON.stringify(observation));
    lease.release();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
    env: { ...process.env, UCI_ARENA_TEST_LEASE_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const exitPromise = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const readyDeadline = Date.now() + 3_000;
    while (!stdout.includes("READY\n") && Date.now() < readyDeadline) await delay(10);
    assert.match(stdout, /READY\n/);

    const foreground = await acquireResourceLease({
      producer: "parent-foreground",
      priority: "foreground",
      root,
      timeoutMs: 5_000,
    });
    assert.ok(foreground);
    foreground.release();
    const [exitCode] = await exitPromise;
    assert.equal(exitCode, 0, stderr.slice(0, 512));
    const observationLine = stdout.trim().split(/\r?\n/).find((line) => line.startsWith("{"));
    const observation = JSON.parse(observationLine);
    assert.equal(observation.code, "foreground_request", JSON.stringify(observation));
    assert.equal(observation.request.producer, "parent-foreground");
    assert.ok(observation.elapsed_ms < 2_000);
  } finally {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await exitPromise;
    rmSync(root, { recursive: true, force: true });
  }
});
