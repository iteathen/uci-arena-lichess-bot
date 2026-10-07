import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  RESOURCE_LEASE_MAX_CLOCK_REGRESSION_MS,
  RESOURCE_LEASE_MAX_PRODUCER_LENGTH,
  RESOURCE_LEASE_MAX_REQUESTS,
  ResourceLeaseStore,
  ResourceLeaseStoreError,
  isResourceLeaseIdentity,
  isResourceLeaseProducer,
} from "./background-resource-lease-store.mjs";

export const RESOURCE_LEASE_SCHEMA = "uci_arena_background_resource_lease_v1";
export const RESOURCE_LEASE_REVOCATION_SCHEMA = "uci_arena_background_resource_lease_revocation_v1";
export const RESOURCE_LEASE_SCOPE = "host_account_global_os_temp";
export const RESOURCE_LEASE_TOKEN_ENV = "UCI_ARENA_RESOURCE_LEASE_TOKEN";
export const RESOURCE_LEASE_ROOT_ENV = "UCI_ARENA_RESOURCE_LEASE_ROOT";

const HOLDER_FILENAME = "holder.json";
const DEFAULT_STALE_MS = 10_000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_ACQUIRE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MIN_POLL_MS = 10;
const MAX_POLL_MS = 1_000;
const MAX_LEGACY_PACKET_BYTES = 4_096;
const MAX_LEGACY_DIRECTORY_ENTRIES = 256;

function nowIso() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function leaseRoot(explicitRoot = "") {
  return resolve(
    explicitRoot
      || process.env[RESOURCE_LEASE_ROOT_ENV]?.trim()
      || resolve(os.tmpdir(), "uci_arena_background_resource_lease"),
  );
}

function safeJson(filename) {
  let descriptor;
  try {
    descriptor = openSync(filename, "r");
    if (!fstatSync(descriptor).isFile()) {
      return { ok: false, error: "resource lease packet is not a regular file" };
    }
    const buffer = Buffer.allocUnsafe(MAX_LEGACY_PACKET_BYTES + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LEGACY_PACKET_BYTES) {
      return { ok: false, error: "resource lease packet exceeds byte limit" };
    }
    return { ok: true, value: JSON.parse(buffer.toString("utf8", 0, bytesRead)) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function packetCurrent(packet, staleMs, currentTime = Date.now()) {
  const heartbeat = Date.parse(String(packet?.heartbeat_at ?? ""));
  return packet?.schema === RESOURCE_LEASE_SCHEMA
    && packet?.scope === RESOURCE_LEASE_SCOPE
    && processAlive(Number(packet?.pid))
    && Number.isFinite(heartbeat)
    && heartbeat <= currentTime
    && currentTime - heartbeat <= staleMs;
}

function removeStaleFile(filename, staleMs) {
  if (!existsSync(filename)) return;
  const parsed = safeJson(filename);
  let stale = !parsed.ok || !packetCurrent(parsed.value, staleMs);
  if (!stale) return;
  try {
    const age = Date.now() - statSync(filename).mtimeMs;
    stale = age >= Math.min(staleMs, 1_000) || !parsed.ok;
  } catch {
    stale = true;
  }
  if (stale) {
    try {
      unlinkSync(filename);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function requestFilename(root, priority, nonce) {
  return resolve(root, `request-${priority}-${nonce}.json`);
}

function holderFilename(root) {
  return resolve(root, HOLDER_FILENAME);
}

function writeExclusiveJson(filename, value) {
  mkdirSync(dirname(filename), { recursive: true });
  const descriptor = openSync(filename, "wx");
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function replaceJson(filename, value) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  try {
    renameSync(temporary, filename);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

function listRequests(root, staleMs) {
  if (!existsSync(root)) return [];
  const requests = [];
  let matchingEntries = 0;
  let scannedEntries = 0;
  const directory = opendirSync(root);
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      scannedEntries += 1;
      if (scannedEntries > MAX_LEGACY_DIRECTORY_ENTRIES) {
        throw new ResourceLeaseStoreError(
          "resource_lease_compatibility_scan_exceeded",
          `legacy resource lease directory exceeds ${MAX_LEGACY_DIRECTORY_ENTRIES} entries`,
        );
      }
      if (!entry.isFile()
          || !/^request-(foreground|background)-[0-9a-f-]{36}\.json$/i.test(entry.name)) {
        continue;
      }
      matchingEntries += 1;
      if (matchingEntries > RESOURCE_LEASE_MAX_REQUESTS) {
        throw new ResourceLeaseStoreError(
          "resource_lease_capacity_exceeded",
          `legacy resource lease request capacity exceeds ${RESOURCE_LEASE_MAX_REQUESTS}`,
        );
      }
      const filename = resolve(root, entry.name);
      removeStaleFile(filename, staleMs);
      if (!existsSync(filename)) continue;
      const parsed = safeJson(filename);
      if (!parsed.ok || !packetCurrent(parsed.value, staleMs)) continue;
      requests.push({ ...parsed.value, filename });
    }
  } finally {
    try {
      directory.closeSync();
    } catch (error) {
      if (error?.code !== "ERR_DIR_CLOSED") throw error;
    }
  }
  return requests.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority === "foreground" ? -1 : 1;
    const time = Date.parse(left.requested_at) - Date.parse(right.requested_at);
    return time || String(left.nonce).localeCompare(String(right.nonce));
  });
}

function holder(root, staleMs) {
  const filename = holderFilename(root);
  removeStaleFile(filename, staleMs);
  if (!existsSync(filename)) return null;
  const parsed = safeJson(filename);
  return parsed.ok && packetCurrent(parsed.value, staleMs) ? { ...parsed.value, filename } : null;
}

function sameIdentity(left, right) {
  return (left?.schema === undefined || left.schema === RESOURCE_LEASE_SCHEMA)
    && (right?.schema === undefined || right.schema === RESOURCE_LEASE_SCHEMA)
    && (left?.scope === undefined || left.scope === RESOURCE_LEASE_SCOPE)
    && (right?.scope === undefined || right.scope === RESOURCE_LEASE_SCOPE)
    && left?.nonce === right?.nonce
    && left?.token === right?.token
    && Number(left?.pid) === Number(right?.pid);
}

function packetWithoutPath(packet) {
  if (!packet) return null;
  const { filename: _filename, ...publicPacket } = packet;
  return publicPacket;
}

function requestVisibility(request, observedAtMs) {
  if (request?.priority !== "foreground" && request?.priority !== "background") {
    throw new ResourceLeaseStoreError(
      "resource_lease_request_invalid",
      "resource lease request has invalid priority",
    );
  }
  if (!isResourceLeaseProducer(request?.producer)
      || !isResourceLeaseIdentity(request?.nonce)
      || !isResourceLeaseIdentity(request?.token)) {
    throw new ResourceLeaseStoreError(
      "resource_lease_request_invalid",
      "resource lease request has invalid identity",
    );
  }
  const explicit = request?.visible_at_ms;
  const visibleAtMs = Number.isSafeInteger(explicit)
    ? explicit
    : Date.parse(String(request?.requested_at ?? ""));
  if (!Number.isSafeInteger(visibleAtMs)
      || visibleAtMs < 0
      || visibleAtMs - observedAtMs > RESOURCE_LEASE_MAX_CLOCK_REGRESSION_MS) {
    throw new ResourceLeaseStoreError(
      "resource_lease_request_time_invalid",
      "foreground resource request has an invalid or future visibility origin",
    );
  }
  const visibleAt = new Date(visibleAtMs).toISOString();
  if (explicit === undefined && request?.requested_at !== visibleAt) {
    throw new ResourceLeaseStoreError(
      "resource_lease_request_time_invalid",
      "legacy foreground request time is not canonical",
    );
  }
  if (request?.visible_at !== undefined && request.visible_at !== visibleAt) {
    throw new ResourceLeaseStoreError(
      "resource_lease_request_time_invalid",
      "foreground resource request visibility text is not canonical",
    );
  }
  return { visibleAtMs, visibleAt };
}

function orderedRequests(currentRequests, legacyRequests, observedAtMs) {
  const deduplicated = new Map();
  for (const request of [...currentRequests, ...legacyRequests]) {
    const visibility = requestVisibility(request, observedAtMs);
    const normalized = {
      ...packetWithoutPath(request),
      visible_at_ms: visibility.visibleAtMs,
      visible_at: visibility.visibleAt,
    };
    const key = `${normalized.nonce}:${normalized.token}`;
    const existing = deduplicated.get(key);
    if (!existing || normalized.visible_at_ms < existing.visible_at_ms) {
      deduplicated.set(key, normalized);
    }
  }
  return [...deduplicated.values()].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority === "foreground" ? -1 : 1;
    return left.visible_at_ms - right.visible_at_ms
      || String(left.nonce).localeCompare(String(right.nonce));
  });
}

function revocationObservation(code, observedAtMs, request = null, detail = "") {
  const revoked = code !== "none";
  const result = {
    schema: RESOURCE_LEASE_REVOCATION_SCHEMA,
    revoked,
    code,
    observed_at_ms: observedAtMs,
    observed_at: new Date(observedAtMs).toISOString(),
    request: null,
  };
  if (request) {
    result.request = {
      producer: String(request.producer).slice(0, RESOURCE_LEASE_MAX_PRODUCER_LENGTH),
      nonce: request.nonce,
      priority: request.priority,
      visible_at_ms: request.visible_at_ms,
      visible_at: request.visible_at,
    };
    Object.freeze(result.request);
    result.elapsed_ms = Math.max(0, observedAtMs - request.visible_at_ms);
  }
  if (detail) result.detail = String(detail).slice(0, 160);
  return Object.freeze(result);
}

function abortError(reason = "resource lease wait aborted") {
  const error = new Error(String(reason));
  error.name = "AbortError";
  return error;
}

function coordinationDetail(error) {
  if (typeof error?.code === "string" && /^resource_lease_[a-z_]+$/.test(error.code)) {
    return error.code;
  }
  return "resource_lease_coordination_failed";
}

export function resourceLeaseSnapshot({ root: explicitRoot = "", staleMs = DEFAULT_STALE_MS } = {}) {
  const root = leaseRoot(explicitRoot);
  return {
    schema: RESOURCE_LEASE_SCHEMA,
    scope: RESOURCE_LEASE_SCOPE,
    holder: packetWithoutPath(holder(root, staleMs)),
    requests: listRequests(root, staleMs).map(packetWithoutPath),
    sampled_at: nowIso(),
  };
}

export function foregroundResourceDemand(options = {}) {
  return resourceLeaseSnapshot(options).requests.some((request) => request.priority === "foreground");
}

export function validateInheritedResourceLease(
  token = process.env[RESOURCE_LEASE_TOKEN_ENV]?.trim() || "",
  options = {},
) {
  if (!token) return { valid: false, reason: "resource_lease_token_missing" };
  const snapshot = resourceLeaseSnapshot(options);
  if (!snapshot.holder || snapshot.holder.token !== token) {
    return { valid: false, reason: "resource_lease_token_not_current", snapshot };
  }
  return { valid: true, lease: snapshot.holder, snapshot };
}

export async function acquireResourceLease({
  producer,
  priority = "background",
  root: explicitRoot = "",
  staleMs = DEFAULT_STALE_MS,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = 0,
  signal,
} = {}) {
  const normalizedProducer = String(producer ?? "").trim();
  if (!normalizedProducer) throw new Error("resource lease producer is required");
  if (!isResourceLeaseProducer(normalizedProducer)) {
    throw new Error(
      `resource lease producer must be ${RESOURCE_LEASE_MAX_PRODUCER_LENGTH} characters or fewer without control characters`,
    );
  }
  if (!new Set(["foreground", "background"]).has(priority)) {
    throw new Error("resource lease priority must be foreground or background");
  }
  if (!Number.isSafeInteger(staleMs) || staleMs <= 0) {
    throw new TypeError("resource lease staleMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > MAX_POLL_MS) {
    throw new TypeError(`resource lease pollMs must be 1..${MAX_POLL_MS}`);
  }
  if (!Number.isSafeInteger(timeoutMs)
      || timeoutMs < 0
      || timeoutMs > MAX_ACQUIRE_TIMEOUT_MS) {
    throw new TypeError(`resource lease timeoutMs must be 0..${MAX_ACQUIRE_TIMEOUT_MS}`);
  }
  const root = leaseRoot(explicitRoot);
  mkdirSync(root, { recursive: true });
  const nonce = randomUUID();
  const token = randomUUID();
  const store = new ResourceLeaseStore(root);
  const request = store.publishRequest({
    priority,
    producer: normalizedProducer,
    pid: process.pid,
    nonce,
    token,
  }, staleMs);
  const requestPacket = {
    schema: RESOURCE_LEASE_SCHEMA,
    scope: RESOURCE_LEASE_SCOPE,
    ...request,
  };
  const requestPath = requestFilename(root, priority, nonce);
  let acquired = false;
  let pendingHolderPacket = null;
  try {
    writeExclusiveJson(requestPath, requestPacket);
  } catch (error) {
    store.removeRequest(requestPacket);
    store.close();
    throw error;
  }
  const startedAt = Date.now();
  try {
    while (!signal?.aborted) {
      const currentTime = Date.now();
      const heartbeatAtMs = store.heartbeatRequest(requestPacket);
      if (!heartbeatAtMs) {
        throw new ResourceLeaseStoreError(
          "resource_lease_request_identity_changed",
          "resource lease request identity changed before acquisition",
        );
      }
      requestPacket.heartbeat_at_ms = heartbeatAtMs;
      requestPacket.heartbeat_at = new Date(heartbeatAtMs).toISOString();
      replaceJson(requestPath, requestPacket);
      const currentHolder = holder(root, staleMs);
      const currentSnapshot = store.snapshot(staleMs);
      const requests = orderedRequests(
        currentSnapshot.requests,
        listRequests(root, staleMs),
        currentSnapshot.sampled_at_ms,
      );
      const first = requests[0];
      const eligible = first?.nonce === nonce
        && first?.token === token
        && currentHolder === null
        && currentSnapshot.holder === null;
      if (eligible) {
        const legacyPacket = {
          schema: RESOURCE_LEASE_SCHEMA,
          scope: RESOURCE_LEASE_SCOPE,
          ...requestPacket,
          kind: "holder",
        };
        let legacyHolderPublished = false;
        try {
          writeExclusiveJson(holderFilename(root), legacyPacket);
          legacyHolderPublished = true;
          const packet = store.tryAcquireHolder(requestPacket, staleMs);
          if (packet) {
            pendingHolderPacket = packet;
            const publicPacket = {
              schema: RESOURCE_LEASE_SCHEMA,
              scope: RESOURCE_LEASE_SCOPE,
              ...packet,
            };
            replaceJson(holderFilename(root), publicPacket);
            try {
              unlinkSync(requestPath);
            } catch {}
            acquired = true;
            pendingHolderPacket = null;
            legacyHolderPublished = false;
            return new ResourceLease(root, publicPacket, staleMs, store);
          }
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        } finally {
          if (legacyHolderPublished) {
            const visibleHolder = holder(root, staleMs);
            if (sameIdentity(visibleHolder, legacyPacket)) {
              try {
                unlinkSync(holderFilename(root));
              } catch {}
            }
          }
        }
      }
      if (timeoutMs === 0 || currentTime - startedAt >= timeoutMs) return null;
      await delay(Math.min(pollMs, Math.max(1, timeoutMs - (currentTime - startedAt))));
    }
    return null;
  } finally {
    try {
      unlinkSync(requestPath);
    } catch {}
    if (!acquired) {
      if (pendingHolderPacket) {
        try {
          store.releaseHolder(pendingHolderPacket);
        } catch {}
      }
      try {
        store.removeRequest(requestPacket);
      } catch {}
      store.close();
    }
  }
}

export async function withForegroundResourceLease(producer, work, options = {}) {
  const inherited = validateInheritedResourceLease(
    process.env[RESOURCE_LEASE_TOKEN_ENV]?.trim() || "",
    options,
  );
  if (inherited.valid) return work(inherited.lease);
  const lease = await acquireResourceLease({
    ...options,
    producer,
    priority: "foreground",
    timeoutMs: options.timeoutMs ?? 24 * 60 * 60 * 1_000,
  });
  if (!lease) throw new Error("foreground resource lease could not be acquired");
  const heartbeat = setInterval(() => lease.heartbeat(), 2_000);
  try {
    return await work(lease.packet);
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}

export class ResourceLease {
  #store;
  #coordinationFailure = null;

  constructor(root, packet, staleMs = DEFAULT_STALE_MS, store = null) {
    this.root = root;
    this.packet = packet;
    this.staleMs = staleMs;
    this.#store = store ?? new ResourceLeaseStore(root);
    this.released = false;
  }

  get token() {
    return this.packet.token;
  }

  environment(environment = process.env) {
    return {
      ...environment,
      [RESOURCE_LEASE_TOKEN_ENV]: this.token,
      [RESOURCE_LEASE_ROOT_ENV]: this.root,
    };
  }

  heartbeat() {
    if (this.released) return false;
    try {
      const heartbeatAtMs = this.#store.heartbeatHolder(this.packet);
      const current = holder(this.root, this.staleMs);
      if (!heartbeatAtMs || !sameIdentity(current, this.packet)) {
        return false;
      }
      this.packet = {
        ...this.packet,
        heartbeat_at_ms: heartbeatAtMs,
        heartbeat_at: new Date(heartbeatAtMs).toISOString(),
      };
      replaceJson(holderFilename(this.root), this.packet);
      return true;
    } catch (error) {
      this.#coordinationFailure = coordinationDetail(error);
      return false;
    }
  }

  observeRevocation() {
    const fallbackObservedAtMs = Date.now();
    if (this.released) {
      return revocationObservation("released", fallbackObservedAtMs);
    }
    if (this.#coordinationFailure) {
      return revocationObservation(
        "coordination_failure",
        fallbackObservedAtMs,
        null,
        this.#coordinationFailure,
      );
    }
    try {
      const currentSnapshot = this.#store.snapshot(this.staleMs);
      const currentLegacyHolder = holder(this.root, this.staleMs);
      if (!sameIdentity(currentSnapshot.holder, this.packet)
          || !sameIdentity(currentLegacyHolder, this.packet)) {
        return revocationObservation("holder_identity_changed", currentSnapshot.sampled_at_ms);
      }
      if (this.packet.priority !== "background") {
        return revocationObservation("none", currentSnapshot.sampled_at_ms);
      }
      const foreground = orderedRequests(
        currentSnapshot.requests,
        listRequests(this.root, this.staleMs),
        currentSnapshot.sampled_at_ms,
      ).find((request) => request.priority === "foreground");
      return foreground
        ? revocationObservation("foreground_request", currentSnapshot.sampled_at_ms, foreground)
        : revocationObservation("none", currentSnapshot.sampled_at_ms);
    } catch (error) {
      return revocationObservation(
        "coordination_failure",
        fallbackObservedAtMs,
        null,
        coordinationDetail(error),
      );
    }
  }

  async waitForRevocation({
    signal,
    maximumPollMs = DEFAULT_POLL_MS,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  } = {}) {
    if (!Number.isSafeInteger(maximumPollMs)
        || maximumPollMs < MIN_POLL_MS
        || maximumPollMs > MAX_POLL_MS) {
      throw new TypeError(
        `resource lease maximumPollMs must be ${MIN_POLL_MS}..${MAX_POLL_MS}`,
      );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_POLL_MS || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
      throw new TypeError(
        `resource lease timeoutMs must be ${MIN_POLL_MS}..${MAX_WAIT_TIMEOUT_MS}`,
      );
    }
    if (signal?.aborted) throw abortError(signal.reason);
    const initial = this.observeRevocation();
    if (initial.revoked) return initial;
    return new Promise((resolvePromise, rejectPromise) => {
      const startedAt = performance.now();
      let timer = null;
      let watcher = null;
      let watcherClosed = Promise.resolve();
      let settled = false;
      let checking = false;

      const cleanup = async () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        signal?.removeEventListener("abort", onAbort);
        const activeWatcher = watcher;
        watcher = null;
        if (activeWatcher) {
          try {
            activeWatcher.close();
            await watcherClosed;
          } catch {}
        }
      };
      const settle = async (value, error = null) => {
        if (settled) return;
        settled = true;
        await cleanup();
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };
      const schedule = () => {
        if (settled) return;
        const remaining = timeoutMs - (performance.now() - startedAt);
        if (remaining <= 0) {
          void settle(this.observeRevocation());
          return;
        }
        timer = setTimeout(check, Math.min(maximumPollMs, remaining));
      };
      const check = () => {
        if (settled || checking) return;
        checking = true;
        try {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          const observation = this.observeRevocation();
          if (observation.revoked || performance.now() - startedAt >= timeoutMs) {
            void settle(observation);
          } else {
            schedule();
          }
        } finally {
          checking = false;
        }
      };
      const onAbort = () => { void settle(null, abortError(signal.reason)); };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        watcher = watch(this.root, { persistent: false }, check);
        watcherClosed = once(watcher, "close").catch(() => []);
        watcher.on("error", () => {
          try {
            watcher?.close();
          } catch {}
        });
      } catch {
        watcher = null;
      }
      schedule();
    });
  }

  revocationReason() {
    const observation = this.observeRevocation();
    if (!observation.revoked) return "";
    if (observation.code === "foreground_request") {
      return `foreground_resource_request:${observation.request.producer}`;
    }
    return `resource_lease_${observation.code}`;
  }

  release() {
    if (this.released) return;
    let releaseError = null;
    const filename = holderFilename(this.root);
    try {
      this.#store.releaseHolder(this.packet);
    } catch (error) {
      releaseError = error;
    }
    try {
      const current = holder(this.root, this.staleMs);
      if (sameIdentity(current, this.packet)) {
        try {
          unlinkSync(filename);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      releaseError ??= error;
    } finally {
      this.released = true;
      this.#store.close();
    }
    if (releaseError) throw releaseError;
  }
}
