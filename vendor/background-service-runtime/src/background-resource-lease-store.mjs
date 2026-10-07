import { lstatSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RESOURCE_LEASE_STORE_SCHEMA = "uci_arena_background_resource_lease_store_v2";
export const RESOURCE_LEASE_STORE_FILENAME = "lease-v2.sqlite";
export const RESOURCE_LEASE_MAX_REQUESTS = 128;
export const RESOURCE_LEASE_MAX_PRODUCER_LENGTH = 128;
export const RESOURCE_LEASE_MAX_CLOCK_REGRESSION_MS = 50;
export const RESOURCE_LEASE_MAX_STORE_BYTES = 2 * 1024 * 1024;

const STORE_BUSY_TIMEOUT_MS = 250;
const MAX_SAFE_SQLITE_INTEGER = 9_007_199_254_740_991;
const RESOURCE_LEASE_MAX_VALUE_BYTES = 4_096;

export function isResourceLeaseIdentity(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isResourceLeaseProducer(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= RESOURCE_LEASE_MAX_PRODUCER_LENGTH
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export class ResourceLeaseStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ResourceLeaseStoreError";
    this.code = code;
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

function safeInteger(value, field) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_invalid",
      `resource lease store contains invalid ${field}`,
    );
  }
  return number;
}

function canonicalUtc(unixMs, value, field) {
  let expected;
  try {
    expected = new Date(unixMs).toISOString();
  } catch {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_invalid",
      `resource lease store contains invalid ${field}`,
    );
  }
  if (value !== expected) {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_invalid",
      `resource lease store contains non-canonical ${field}`,
    );
  }
  return value;
}

function validateIdentity(value, field) {
  if (!isResourceLeaseIdentity(value)) {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_invalid",
      `resource lease store contains invalid ${field}`,
    );
  }
  return value;
}

function packetFromRow(row, kind) {
  if (!row) return null;
  const visibleAtMs = safeInteger(row.visible_ms, "visible_ms");
  const heartbeatAtMs = safeInteger(row.heartbeat_ms, "heartbeat_ms");
  const acquiredAtMs = row.acquired_ms === null || row.acquired_ms === undefined
    ? null
    : safeInteger(row.acquired_ms, "acquired_ms");
  const priority = row.priority;
  if (priority !== "foreground" && priority !== "background") {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_invalid",
      "resource lease store contains invalid priority",
    );
  }
  if (!isResourceLeaseProducer(row.producer)) {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_invalid",
      "resource lease store contains invalid producer",
    );
  }
  return {
    kind,
    priority,
    producer: row.producer,
    pid: safeInteger(row.pid, "pid"),
    nonce: validateIdentity(row.nonce, "nonce"),
    token: validateIdentity(row.token, "token"),
    requested_at: canonicalUtc(visibleAtMs, row.visible_utc, "visible_utc"),
    visible_at_ms: visibleAtMs,
    visible_at: row.visible_utc,
    acquired_at: acquiredAtMs === null ? undefined : new Date(acquiredAtMs).toISOString(),
    acquired_at_ms: acquiredAtMs ?? undefined,
    heartbeat_at: new Date(heartbeatAtMs).toISOString(),
    heartbeat_at_ms: heartbeatAtMs,
  };
}

function validateRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStatus = lstatSync(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new ResourceLeaseStoreError(
      "resource_lease_root_invalid",
      "resource lease root must be a real directory",
    );
  }
  const databasePath = resolve(root, RESOURCE_LEASE_STORE_FILENAME);
  try {
    const databaseStatus = lstatSync(databasePath);
    if (databaseStatus.isSymbolicLink()) {
      throw new ResourceLeaseStoreError(
        "resource_lease_root_invalid",
        "resource lease database must not be a symbolic link",
      );
    }
    if (!databaseStatus.isFile() || databaseStatus.size > RESOURCE_LEASE_MAX_STORE_BYTES) {
      throw new ResourceLeaseStoreError(
        "resource_lease_store_capacity_exceeded",
        "resource lease database exceeds its file-size bound",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return databasePath;
}

function initializeDatabase(database) {
  database.limits.length = RESOURCE_LEASE_MAX_VALUE_BYTES;
  database.limits.sqlLength = 32_768;
  database.limits.column = 32;
  database.limits.variableNumber = 32;
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA wal_autocheckpoint = 32;
    CREATE TABLE IF NOT EXISTS lease_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS lease_requests (
      nonce TEXT PRIMARY KEY CHECK(length(nonce) = 36),
      token TEXT NOT NULL CHECK(length(token) = 36),
      priority TEXT NOT NULL CHECK(priority IN ('foreground', 'background')),
      producer TEXT NOT NULL CHECK(length(producer) BETWEEN 1 AND ${RESOURCE_LEASE_MAX_PRODUCER_LENGTH}),
      pid INTEGER NOT NULL CHECK(pid BETWEEN 1 AND ${MAX_SAFE_SQLITE_INTEGER}),
      visible_ms INTEGER NOT NULL CHECK(visible_ms BETWEEN 0 AND ${MAX_SAFE_SQLITE_INTEGER}),
      visible_utc TEXT NOT NULL CHECK(length(visible_utc) = 24),
      heartbeat_ms INTEGER NOT NULL CHECK(heartbeat_ms BETWEEN 0 AND ${MAX_SAFE_SQLITE_INTEGER})
    ) STRICT;
    CREATE INDEX IF NOT EXISTS lease_requests_order
      ON lease_requests(priority DESC, visible_ms ASC, nonce ASC);
    CREATE TABLE IF NOT EXISTS lease_holder (
      slot INTEGER PRIMARY KEY CHECK(slot = 1),
      nonce TEXT NOT NULL CHECK(length(nonce) = 36),
      token TEXT NOT NULL CHECK(length(token) = 36),
      priority TEXT NOT NULL CHECK(priority IN ('foreground', 'background')),
      producer TEXT NOT NULL CHECK(length(producer) BETWEEN 1 AND ${RESOURCE_LEASE_MAX_PRODUCER_LENGTH}),
      pid INTEGER NOT NULL CHECK(pid BETWEEN 1 AND ${MAX_SAFE_SQLITE_INTEGER}),
      visible_ms INTEGER NOT NULL CHECK(visible_ms BETWEEN 0 AND ${MAX_SAFE_SQLITE_INTEGER}),
      visible_utc TEXT NOT NULL CHECK(length(visible_utc) = 24),
      acquired_ms INTEGER NOT NULL CHECK(acquired_ms BETWEEN 0 AND ${MAX_SAFE_SQLITE_INTEGER}),
      heartbeat_ms INTEGER NOT NULL CHECK(heartbeat_ms BETWEEN 0 AND ${MAX_SAFE_SQLITE_INTEGER})
    ) STRICT;
  `);
  const pageSize = safeInteger(
    database.prepare("PRAGMA page_size").get().page_size,
    "page size",
  );
  const maximumPages = Math.max(16, Math.floor(RESOURCE_LEASE_MAX_STORE_BYTES / pageSize));
  database.exec(`PRAGMA max_page_count = ${maximumPages}`);
  const pageCount = safeInteger(
    database.prepare("PRAGMA page_count").get().page_count,
    "page count",
  );
  if (pageCount > maximumPages) {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_capacity_exceeded",
      "resource lease database exceeds its page-count bound",
    );
  }
  database.prepare(`
    INSERT INTO lease_metadata(key, value) VALUES ('schema', ?)
    ON CONFLICT(key) DO NOTHING
  `).run(RESOURCE_LEASE_STORE_SCHEMA);
  const metadata = database.prepare(
    "SELECT value FROM lease_metadata WHERE key = 'schema'",
  ).get();
  if (metadata?.value !== RESOURCE_LEASE_STORE_SCHEMA) {
    throw new ResourceLeaseStoreError(
      "resource_lease_store_incompatible",
      "resource lease store schema is incompatible",
    );
  }
}

export class ResourceLeaseStore {
  constructor(root, {
    clock = Date.now,
    isProcessAlive = processAlive,
    timeoutMs = STORE_BUSY_TIMEOUT_MS,
  } = {}) {
    this.root = resolve(root);
    this.clock = clock;
    this.isProcessAlive = isProcessAlive;
    this.closed = false;
    try {
      this.database = new DatabaseSync(validateRoot(this.root), {
        allowExtension: false,
        defensive: true,
        readBigInts: true,
        timeout: timeoutMs,
      });
      initializeDatabase(this.database);
    } catch (error) {
      this.database?.close?.();
      if (error instanceof ResourceLeaseStoreError) throw error;
      throw new ResourceLeaseStoreError(
        "resource_lease_store_unavailable",
        "resource lease store unavailable",
        { cause: error },
      );
    }
  }

  #assertOpen() {
    if (this.closed || !this.database?.isOpen) {
      throw new ResourceLeaseStoreError(
        "resource_lease_store_closed",
        "resource lease store is closed",
      );
    }
  }

  #now() {
    const currentTime = this.clock();
    if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
      throw new ResourceLeaseStoreError(
        "resource_lease_clock_invalid",
        "resource lease clock did not return a safe Unix millisecond",
      );
    }
    return currentTime;
  }

  #transaction(work) {
    this.#assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #readTransaction(work) {
    this.#assertOpen();
    this.database.exec("BEGIN");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  #requestRows() {
    const rows = this.database.prepare(`
      SELECT nonce, token, priority, producer, pid, visible_ms, visible_utc, heartbeat_ms
      FROM lease_requests
      ORDER BY CASE priority WHEN 'foreground' THEN 0 ELSE 1 END, visible_ms, nonce
      LIMIT ${RESOURCE_LEASE_MAX_REQUESTS + 1}
    `).all();
    if (rows.length > RESOURCE_LEASE_MAX_REQUESTS) {
      throw new ResourceLeaseStoreError(
        "resource_lease_capacity_exceeded",
        `resource lease request capacity exceeds ${RESOURCE_LEASE_MAX_REQUESTS}`,
      );
    }
    return rows;
  }

  #holderRow() {
    return this.database.prepare(`
      SELECT nonce, token, priority, producer, pid, visible_ms, visible_utc,
             acquired_ms, heartbeat_ms
      FROM lease_holder WHERE slot = 1
    `).get();
  }

  #packetCurrent(packet, staleMs, currentTime) {
    if (packet.visible_at_ms - currentTime > RESOURCE_LEASE_MAX_CLOCK_REGRESSION_MS
        || packet.heartbeat_at_ms - currentTime > RESOURCE_LEASE_MAX_CLOCK_REGRESSION_MS
        || (packet.kind === "holder"
          && packet.acquired_at_ms - currentTime > RESOURCE_LEASE_MAX_CLOCK_REGRESSION_MS)) {
      throw new ResourceLeaseStoreError(
        "resource_lease_store_clock_invalid",
        `resource lease ${packet.kind} contains a future timestamp`,
      );
    }
    return currentTime - packet.heartbeat_at_ms <= staleMs
      && this.isProcessAlive(packet.pid);
  }

  #readSnapshot(staleMs) {
    const requests = this.#requestRows().map((row) => packetFromRow(row, "request"));
    const holder = packetFromRow(this.#holderRow(), "holder");
    const currentTime = this.#now();
    const stale = requests.some((packet) => !this.#packetCurrent(packet, staleMs, currentTime))
      || (holder !== null && !this.#packetCurrent(holder, staleMs, currentTime));
    return { holder, requests, stale, sampled_at_ms: currentTime };
  }

  #prune(staleMs, currentTime) {
    if (!Number.isSafeInteger(staleMs) || staleMs <= 0) {
      throw new TypeError("resource lease staleMs must be a positive safe integer");
    }
    for (const row of this.#requestRows()) {
      const packet = packetFromRow(row, "request");
      if (!this.#packetCurrent(packet, staleMs, currentTime)) {
        this.database.prepare(`
          DELETE FROM lease_requests
          WHERE nonce = ? AND token = ? AND heartbeat_ms = ?
        `).run(packet.nonce, packet.token, packet.heartbeat_at_ms);
      }
    }
    const holderRow = this.#holderRow();
    if (holderRow) {
      const packet = packetFromRow(holderRow, "holder");
      if (!this.#packetCurrent(packet, staleMs, currentTime)) {
        this.database.prepare(`
          DELETE FROM lease_holder
          WHERE slot = 1 AND nonce = ? AND token = ? AND heartbeat_ms = ?
        `).run(packet.nonce, packet.token, packet.heartbeat_at_ms);
      }
    }
  }

  publishRequest({ nonce, token, priority, producer, pid }, staleMs) {
    validateIdentity(nonce, "nonce");
    validateIdentity(token, "token");
    if (priority !== "foreground" && priority !== "background") {
      throw new TypeError("resource lease priority must be foreground or background");
    }
    if (!isResourceLeaseProducer(producer)) {
      throw new TypeError(
        `resource lease producer must contain 1..${RESOURCE_LEASE_MAX_PRODUCER_LENGTH} characters`,
      );
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new TypeError("resource lease pid must be a positive safe integer");
    }
    return this.#transaction(() => {
      this.#prune(staleMs, this.#now());
      const count = safeInteger(
        this.database.prepare("SELECT COUNT(*) AS count FROM lease_requests").get().count,
        "request count",
      );
      if (count >= RESOURCE_LEASE_MAX_REQUESTS) {
        throw new ResourceLeaseStoreError(
          "resource_lease_capacity_exceeded",
          `resource lease request capacity is ${RESOURCE_LEASE_MAX_REQUESTS}`,
        );
      }
      const visibleAtMs = this.#now();
      const visibleUtc = new Date(visibleAtMs).toISOString();
      this.database.prepare(`
        INSERT INTO lease_requests(
          nonce, token, priority, producer, pid, visible_ms, visible_utc, heartbeat_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nonce, token, priority, producer, pid, visibleAtMs, visibleUtc, visibleAtMs);
      return {
        kind: "request",
        priority,
        producer,
        pid,
        nonce,
        token,
        requested_at: visibleUtc,
        visible_at_ms: visibleAtMs,
        visible_at: visibleUtc,
        heartbeat_at: visibleUtc,
        heartbeat_at_ms: visibleAtMs,
      };
    });
  }

  heartbeatRequest(packet) {
    return this.#transaction(() => {
      const currentTime = this.#now();
      const result = this.database.prepare(`
        UPDATE lease_requests SET heartbeat_ms = ?
        WHERE nonce = ? AND token = ? AND pid = ? AND visible_ms = ?
      `).run(currentTime, packet.nonce, packet.token, packet.pid, packet.visible_at_ms);
      return Number(result.changes) === 1 ? currentTime : 0;
    });
  }

  removeRequest(packet) {
    return this.#transaction(() => {
      const result = this.database.prepare(`
        DELETE FROM lease_requests
        WHERE nonce = ? AND token = ? AND pid = ? AND visible_ms = ?
      `).run(packet.nonce, packet.token, packet.pid, packet.visible_at_ms);
      return Number(result.changes) === 1;
    });
  }

  tryAcquireHolder(packet, staleMs) {
    return this.#transaction(() => {
      const currentTime = this.#now();
      this.#prune(staleMs, currentTime);
      if (this.#holderRow()) return null;
      const first = this.#requestRows()[0];
      if (!first || first.nonce !== packet.nonce || first.token !== packet.token) return null;
      this.database.prepare(`
        INSERT INTO lease_holder(
          slot, nonce, token, priority, producer, pid, visible_ms, visible_utc,
          acquired_ms, heartbeat_ms
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        packet.nonce,
        packet.token,
        packet.priority,
        packet.producer,
        packet.pid,
        packet.visible_at_ms,
        packet.visible_at,
        currentTime,
        currentTime,
      );
      this.database.prepare(`
        DELETE FROM lease_requests
        WHERE nonce = ? AND token = ? AND pid = ? AND visible_ms = ?
      `).run(packet.nonce, packet.token, packet.pid, packet.visible_at_ms);
      return {
        ...packet,
        kind: "holder",
        acquired_at: new Date(currentTime).toISOString(),
        acquired_at_ms: currentTime,
        heartbeat_at: new Date(currentTime).toISOString(),
        heartbeat_at_ms: currentTime,
      };
    });
  }

  heartbeatHolder(packet) {
    return this.#transaction(() => {
      const currentTime = this.#now();
      const result = this.database.prepare(`
        UPDATE lease_holder SET heartbeat_ms = ?
        WHERE slot = 1 AND nonce = ? AND token = ? AND pid = ? AND visible_ms = ?
      `).run(currentTime, packet.nonce, packet.token, packet.pid, packet.visible_at_ms);
      return Number(result.changes) === 1 ? currentTime : 0;
    });
  }

  releaseHolder(packet) {
    return this.#transaction(() => {
      const result = this.database.prepare(`
        DELETE FROM lease_holder
        WHERE slot = 1 AND nonce = ? AND token = ? AND pid = ? AND visible_ms = ?
      `).run(packet.nonce, packet.token, packet.pid, packet.visible_at_ms);
      return Number(result.changes) === 1;
    });
  }

  snapshot(staleMs) {
    if (!Number.isSafeInteger(staleMs) || staleMs <= 0) {
      throw new TypeError("resource lease staleMs must be a positive safe integer");
    }
    const sampled = this.#readTransaction(
      () => this.#readSnapshot(staleMs),
    );
    if (sampled.stale) {
      return this.#transaction(() => {
        const currentTime = this.#now();
        this.#prune(staleMs, currentTime);
        const pruned = this.#readSnapshot(staleMs);
        return {
          sampled_at_ms: pruned.sampled_at_ms,
          sampled_at: new Date(pruned.sampled_at_ms).toISOString(),
          holder: pruned.holder,
          requests: pruned.requests,
        };
      });
    }
    return {
      sampled_at_ms: sampled.sampled_at_ms,
      sampled_at: new Date(sampled.sampled_at_ms).toISOString(),
      holder: sampled.holder,
      requests: sampled.requests,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database?.close();
  }
}
