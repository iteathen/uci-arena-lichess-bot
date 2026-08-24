import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  admitExactFileSync,
  classifyExactPathSync,
  ensureExactDirectorySync,
  publishExactFileSync,
} from "./exact-file.mjs";

const DATABASE_MAXIMUM_BYTES = 1_099_511_627_776;
const BUSY_TIMEOUT_MS = 5_000;
const CURRENT_SCHEMA_VERSION = 5;
const MAXIMUM_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const CORE_TABLES = Object.freeze({
  owners: [
    ["username", "TEXT", 1], ["created_at", "INTEGER", 0],
  ],
  reservations: [
    ["id", "INTEGER", 1], ["opponent", "TEXT", 0],
    ["games_remaining", "INTEGER", 0], ["expires_at", "INTEGER", 0],
    ["created_at", "INTEGER", 0],
  ],
  scheduler_control: [
    ["id", "INTEGER", 1], ["paused", "INTEGER", 0], ["updated_at", "INTEGER", 0],
  ],
  opponents: [
    ["username", "TEXT", 1], ["title", "TEXT", 0], ["rating", "INTEGER", 0],
    ["online", "INTEGER", 0], ["first_seen_at", "INTEGER", 0],
    ["last_seen_at", "INTEGER", 0], ["cooldown_until", "INTEGER", 0],
    ["accepts", "INTEGER", 0], ["declines", "INTEGER", 0], ["timeouts", "INTEGER", 0],
  ],
  challenge_attempts: [
    ["challenge_id", "TEXT", 1], ["opponent", "TEXT", 0], ["audience", "TEXT", 0],
    ["direction", "TEXT", 0], ["status", "TEXT", 0], ["color", "TEXT", 0],
    ["clock_limit", "INTEGER", 0], ["clock_increment", "INTEGER", 0],
    ["created_at", "INTEGER", 0], ["updated_at", "INTEGER", 0],
  ],
});

const GAME_COLUMNS_V1 = Object.freeze([
  ["game_id", "TEXT", 1], ["opponent", "TEXT", 0], ["audience", "TEXT", 0],
  ["color", "TEXT", 0], ["rated", "INTEGER", 0], ["speed", "TEXT", 0],
  ["clock_limit", "INTEGER", 0], ["clock_increment", "INTEGER", 0],
  ["status", "TEXT", 0], ["result", "TEXT", 0], ["winner", "TEXT", 0],
  ["plies", "INTEGER", 0], ["started_at", "INTEGER", 0], ["finished_at", "INTEGER", 0],
  ["engine_build_fingerprint", "TEXT", 0], ["model_fingerprint", "TEXT", 0],
  ["provider_fingerprint", "TEXT", 0], ["book_identity", "TEXT", 0],
]);

const GAME_PROVENANCE_COLUMNS = Object.freeze([
  ["model_id", "TEXT", 0], ["checkpoint_hash", "TEXT", 0], ["adapter_id", "TEXT", 0],
  ["provider", "TEXT", 0], ["hardware_driver_fingerprint", "TEXT", 0],
  ["onnx_runtime_version", "TEXT", 0], ["search_core", "TEXT", 0],
  ["threads", "INTEGER", 0], ["root_workers", "INTEGER", 0],
  ["split_depth", "INTEGER", 0], ["batch_size", "INTEGER", 0],
  ["batch_wait_us", "INTEGER", 0], ["time_profile_identity", "TEXT", 0],
  ["runtime_provenance_sha256", "TEXT", 0], ["runtime_provenance_json", "TEXT", 0],
]);

const API_SAFETY_COLUMNS_V2 = Object.freeze([
  ["authority_key", "TEXT", 1], ["cooldown_until", "INTEGER", 0],
  ["strike_count", "INTEGER", 0], ["last_429_at", "INTEGER", 0],
  ["last_retry_after_ms", "INTEGER", 0], ["updated_at", "INTEGER", 0],
]);

const API_SAFETY_CHALLENGE_COLUMNS = Object.freeze([
  ["challenge_blocked_until", "INTEGER", 0], ["challenge_strike_count", "INTEGER", 0],
  ["challenge_last_429_at", "INTEGER", 0], ["challenge_recovered_at", "INTEGER", 0],
  ["challenge_half_open", "INTEGER", 0],
]);

const API_LEASE_COLUMNS_V2 = Object.freeze([
  ["authority_key", "TEXT", 1], ["owner_id", "TEXT", 0], ["pid", "INTEGER", 0],
  ["heartbeat_at", "INTEGER", 0], ["expires_at", "INTEGER", 0],
]);

const LEGACY_RATE_LIMIT_COLUMNS = Object.freeze([
  ["id", "INTEGER", 1], ["consecutive_429", "INTEGER", 0],
  ["blocked_until", "INTEGER", 0], ["last_429_at", "INTEGER", 0],
  ["half_open", "INTEGER", 0],
]);

const PROVIDER_LIFECYCLE_COLUMNS = Object.freeze([
  ["id", "INTEGER", 1], ["admission_blocked", "INTEGER", 0],
  ["owner_id", "TEXT", 0], ["active_work", "INTEGER", 0],
  ["updated_at", "INTEGER", 0],
]);

const EXPECTED_COLUMN_DEFAULTS = Object.freeze({
  "scheduler_control.paused": "0",
  "opponents.title": "''",
  "opponents.rating": "0",
  "opponents.online": "0",
  "opponents.cooldown_until": "0",
  "opponents.accepts": "0",
  "opponents.declines": "0",
  "opponents.timeouts": "0",
  "challenge_attempts.color": "'random'",
  "challenge_attempts.clock_limit": "0",
  "challenge_attempts.clock_increment": "0",
  "games.opponent": "''",
  "games.color": "''",
  "games.rated": "0",
  "games.speed": "''",
  "games.clock_limit": "0",
  "games.clock_increment": "0",
  "games.status": "'started'",
  "games.result": "''",
  "games.winner": "''",
  "games.plies": "0",
  "games.finished_at": "0",
  "games.engine_build_fingerprint": "''",
  "games.model_fingerprint": "''",
  "games.provider_fingerprint": "''",
  "games.book_identity": "''",
  "games.model_id": "''",
  "games.checkpoint_hash": "''",
  "games.adapter_id": "''",
  "games.provider": "''",
  "games.hardware_driver_fingerprint": "''",
  "games.onnx_runtime_version": "''",
  "games.search_core": "''",
  "games.threads": "0",
  "games.root_workers": "0",
  "games.split_depth": "0",
  "games.batch_size": "0",
  "games.batch_wait_us": "0",
  "games.time_profile_identity": "''",
  "games.runtime_provenance_sha256": "''",
  "games.runtime_provenance_json": "'{}'",
  "api_safety_state.cooldown_until": "0",
  "api_safety_state.strike_count": "0",
  "api_safety_state.last_429_at": "0",
  "api_safety_state.last_retry_after_ms": "0",
  "api_safety_state.challenge_blocked_until": "0",
  "api_safety_state.challenge_strike_count": "0",
  "api_safety_state.challenge_last_429_at": "0",
  "api_safety_state.challenge_recovered_at": "0",
  "api_safety_state.challenge_half_open": "0",
  "api_client_leases.process_identity_json": "''",
  "api_rate_limit.consecutive_429": "0",
  "api_rate_limit.blocked_until": "0",
  "api_rate_limit.last_429_at": "0",
  "api_rate_limit.half_open": "0",
  "provider_lifecycle_control.admission_blocked": "0",
  "provider_lifecycle_control.owner_id": "''",
  "provider_lifecycle_control.active_work": "0",
  "provider_lifecycle_control.updated_at": "0",
});

const EXPECTED_CHECKS = Object.freeze({
  reservations: ["check(id=1)", "check(games_remaining>0)"],
  scheduler_control: ["check(id=1)"],
  api_rate_limit: ["check(id=1)"],
  provider_lifecycle_control: [
    "check(id=1)", "check(admission_blockedin(0,1))", "check(active_work>=0)",
  ],
});

const BASE_SCHEMA_SQL = `
  CREATE TABLE owners(
    username TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE reservations(
    id INTEGER PRIMARY KEY CHECK(id=1),
    opponent TEXT NOT NULL,
    games_remaining INTEGER NOT NULL CHECK(games_remaining > 0),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE scheduler_control(
    id INTEGER PRIMARY KEY CHECK(id=1),
    paused INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO scheduler_control(id, paused, updated_at) VALUES(1, 0, 0);
  CREATE TABLE opponents(
    username TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    online INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    accepts INTEGER NOT NULL DEFAULT 0,
    declines INTEGER NOT NULL DEFAULT 0,
    timeouts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE challenge_attempts(
    challenge_id TEXT PRIMARY KEY,
    opponent TEXT NOT NULL,
    audience TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'random',
    clock_limit INTEGER NOT NULL DEFAULT 0,
    clock_increment INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE games(
    game_id TEXT PRIMARY KEY,
    opponent TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    rated INTEGER NOT NULL DEFAULT 0,
    speed TEXT NOT NULL DEFAULT '',
    clock_limit INTEGER NOT NULL DEFAULT 0,
    clock_increment INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'started',
    result TEXT NOT NULL DEFAULT '',
    winner TEXT NOT NULL DEFAULT '',
    plies INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL DEFAULT 0,
    engine_build_fingerprint TEXT NOT NULL DEFAULT '',
    model_fingerprint TEXT NOT NULL DEFAULT '',
    provider_fingerprint TEXT NOT NULL DEFAULT '',
    book_identity TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    checkpoint_hash TEXT NOT NULL DEFAULT '',
    adapter_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    hardware_driver_fingerprint TEXT NOT NULL DEFAULT '',
    onnx_runtime_version TEXT NOT NULL DEFAULT '',
    search_core TEXT NOT NULL DEFAULT '',
    threads INTEGER NOT NULL DEFAULT 0,
    root_workers INTEGER NOT NULL DEFAULT 0,
    split_depth INTEGER NOT NULL DEFAULT 0,
    batch_size INTEGER NOT NULL DEFAULT 0,
    batch_wait_us INTEGER NOT NULL DEFAULT 0,
    time_profile_identity TEXT NOT NULL DEFAULT '',
    runtime_provenance_sha256 TEXT NOT NULL DEFAULT '',
    runtime_provenance_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX games_opponent_finished ON games(opponent, finished_at);
  CREATE INDEX challenges_opponent_created ON challenge_attempts(opponent, created_at);
`;

const API_SAFETY_V2_SQL = `
  CREATE TABLE api_safety_state(
    authority_key TEXT PRIMARY KEY,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    strike_count INTEGER NOT NULL DEFAULT 0,
    last_429_at INTEGER NOT NULL DEFAULT 0,
    last_retry_after_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`;

const API_LEASE_V2_SQL = `
  CREATE TABLE api_client_leases(
    authority_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

const PROVIDER_LIFECYCLE_SQL = `
  CREATE TABLE provider_lifecycle_control(
    id INTEGER PRIMARY KEY CHECK(id=1),
    admission_blocked INTEGER NOT NULL DEFAULT 0
      CHECK(admission_blocked IN (0, 1)),
    owner_id TEXT NOT NULL DEFAULT '',
    active_work INTEGER NOT NULL DEFAULT 0 CHECK(active_work >= 0),
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO provider_lifecycle_control(
    id, admission_blocked, owner_id, active_work, updated_at
  ) VALUES(1, 0, '', 0, 0);
`;

const CURRENT_SCHEMA_SQL = `
  CREATE TABLE schema_meta(
    id INTEGER PRIMARY KEY CHECK(id=1),
    version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version > 0)
  ) STRICT;
  INSERT INTO schema_meta(id, version) VALUES(1, ${CURRENT_SCHEMA_VERSION});
  ${BASE_SCHEMA_SQL}
  CREATE TABLE api_safety_state(
    authority_key TEXT PRIMARY KEY,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    strike_count INTEGER NOT NULL DEFAULT 0,
    last_429_at INTEGER NOT NULL DEFAULT 0,
    last_retry_after_ms INTEGER NOT NULL DEFAULT 0,
    challenge_blocked_until INTEGER NOT NULL DEFAULT 0,
    challenge_strike_count INTEGER NOT NULL DEFAULT 0,
    challenge_last_429_at INTEGER NOT NULL DEFAULT 0,
    challenge_recovered_at INTEGER NOT NULL DEFAULT 0,
    challenge_half_open INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE api_client_leases(
    authority_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    process_identity_json TEXT NOT NULL DEFAULT '',
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  ${PROVIDER_LIFECYCLE_SQL}
`;

export class LichessStorageError extends Error {
  constructor(code, detail, cause = undefined) {
    super(String(detail ?? "Lichess storage failed").replaceAll(/[\r\n]/gu, " ").slice(0, 512), { cause });
    this.name = "LichessStorageError";
    this.code = code;
  }
}

function storageError(code, detail, cause) {
  return new LichessStorageError(code, detail, cause);
}

export function safeInteger(value, label, {
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
  defaultValue,
} = {}) {
  const selected = value === undefined || value === null ? defaultValue : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected)
      || selected < minimum || selected > maximum) {
    throw storageError("LICHESS_STORAGE_INTEGER_INVALID", `${label} must be an exact safe integer`);
  }
  return selected;
}

function projectSqliteValue(value) {
  if (typeof value === "bigint") {
    if (value < -MAXIMUM_SAFE_BIGINT || value > MAXIMUM_SAFE_BIGINT) {
      throw storageError(
        "LICHESS_STORAGE_INTEGER_UNSAFE",
        "SQLite returned an integer outside the JavaScript safe-integer domain",
      );
    }
    return Number(value);
  }
  if (Array.isArray(value)) return value.map(projectSqliteValue);
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectSqliteValue(item)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw storageError("LICHESS_STORAGE_NUMBER_INVALID", "SQLite returned a non-finite number");
  }
  return value;
}

class SafeStatement {
  constructor(statement) {
    this.statement = statement;
  }

  all(...parameters) {
    return projectSqliteValue(this.statement.all(...parameters));
  }

  get(...parameters) {
    return projectSqliteValue(this.statement.get(...parameters));
  }

  run(...parameters) {
    return projectSqliteValue(this.statement.run(...parameters));
  }
}

class SafeDatabase {
  constructor(database) {
    this.database = database;
  }

  exec(sql) {
    return this.database.exec(sql);
  }

  prepare(sql) {
    return new SafeStatement(this.database.prepare(sql));
  }

  close() {
    return this.database.close();
  }

  get isTransaction() {
    return this.database.isTransaction;
  }
}

function sameObjectIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.mode === right?.mode;
}

function admitSidecar(filename, label) {
  const classified = classifyExactPathSync(filename, { label });
  if (classified.kind === "missing") return null;
  if (classified.kind !== "file") {
    throw storageError("LICHESS_STORAGE_PATH_TYPE_INVALID", `${label} is not a regular non-link file`);
  }
  return admitExactFileSync(filename, { maximumBytes: DATABASE_MAXIMUM_BYTES, label });
}

function prepareStoragePath(filePath) {
  let classified;
  try {
    if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) {
      throw storageError("LICHESS_STORAGE_PATH_INVALID", "Lichess database path is invalid");
    }
    const requested = path.resolve(filePath);
    if (Buffer.byteLength(requested, "utf8") > 32_768) {
      throw storageError("LICHESS_STORAGE_PATH_INVALID", "Lichess database path exceeds its bound");
    }
    const directory = ensureExactDirectorySync(path.dirname(requested), "Lichess storage directory");
    const resolved = path.join(directory, path.basename(requested));
    classified = classifyExactPathSync(resolved, { label: "Lichess database" });
    if (classified.kind === "missing") {
      const wal = classifyExactPathSync(`${resolved}-wal`, { label: "Lichess database WAL" });
      const shm = classifyExactPathSync(`${resolved}-shm`, { label: "Lichess database SHM" });
      if (wal.kind !== "missing" || shm.kind !== "missing") {
        throw storageError(
          "LICHESS_STORAGE_ORPHAN_SIDECAR",
          "Lichess database sidecars exist without the database",
        );
      }
      publishExactFileSync(resolved, Buffer.alloc(0), {
        maximumBytes: 0,
        label: "Lichess database",
        durable: true,
      });
      classified = classifyExactPathSync(resolved, { label: "Lichess database" });
    }
    if (classified.kind !== "file") {
      throw storageError(
        "LICHESS_STORAGE_PATH_TYPE_INVALID",
        "Lichess database is not a regular non-link file",
      );
    }
    const database = admitExactFileSync(resolved, {
      maximumBytes: DATABASE_MAXIMUM_BYTES,
      label: "Lichess database",
    });
    admitSidecar(`${resolved}-wal`, "Lichess database WAL");
    admitSidecar(`${resolved}-shm`, "Lichess database SHM");
    return Object.freeze({
      filePath: resolved,
      databaseIdentity: database.identity,
      empty: database.byteLength === 0,
    });
  } catch (error) {
    if (error instanceof LichessStorageError) throw error;
    throw storageError(
      error?.code?.startsWith?.("EXACT_") ? "LICHESS_STORAGE_PATH_UNSAFE" : "LICHESS_STORAGE_PATH_FAILED",
      error?.message ?? "Lichess storage path admission failed",
      error,
    );
  }
}

function assertStoragePaths(authority) {
  try {
    const database = admitExactFileSync(authority.filePath, {
      maximumBytes: DATABASE_MAXIMUM_BYTES,
      label: "Lichess database",
    });
    if (!sameObjectIdentity(database.identity, authority.databaseIdentity)) {
      throw storageError(
        "LICHESS_STORAGE_PATH_REPLACED",
        "Lichess database identity changed after admission",
      );
    }
    admitSidecar(`${authority.filePath}-wal`, "Lichess database WAL");
    admitSidecar(`${authority.filePath}-shm`, "Lichess database SHM");
  } catch (error) {
    if (error instanceof LichessStorageError) throw error;
    throw storageError("LICHESS_STORAGE_PATH_REVALIDATION_FAILED", error?.message, error);
  }
}

function rawInteger(value, label, { minimum = 0, maximum = CURRENT_SCHEMA_VERSION } = {}) {
  if (typeof value !== "bigint" || value < BigInt(minimum) || value > BigInt(maximum)) {
    throw storageError("LICHESS_STORAGE_SCHEMA_AUTHORITY_INVALID", `${label} is not a supported integer`);
  }
  return Number(value);
}

function schemaObjects(database) {
  return database.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
  `).all();
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name));
}

function schemaVersion(database) {
  const meta = database.prepare(
    "SELECT type, sql FROM sqlite_master WHERE name='schema_meta'",
  ).get();
  if (!meta || meta.type !== "table") {
    throw storageError("LICHESS_STORAGE_SCHEMA_AUTHORITY_MISSING", "schema_meta is unavailable");
  }
  const columns = database.prepare("PRAGMA table_info(schema_meta)").all();
  const names = columns.map((column) => column.name);
  const historicalShape = names.length === 1 && names[0] === "version";
  const currentShape = names.length === 2 && names[0] === "id" && names[1] === "version";
  if (!historicalShape && !currentShape) {
    throw storageError("LICHESS_STORAGE_SCHEMA_AUTHORITY_INVALID", "schema_meta has an invalid shape");
  }
  const versionColumn = columns.at(-1);
  const idColumn = currentShape ? columns[0] : null;
  if (String(versionColumn.type).toUpperCase() !== "INTEGER"
      || Number(versionColumn.notnull) !== 1 || Number(versionColumn.pk) !== 0
      || versionColumn.dflt_value !== null
      || (idColumn && (String(idColumn.type).toUpperCase() !== "INTEGER"
        || Number(idColumn.pk) !== 1 || idColumn.dflt_value !== null))) {
    throw storageError("LICHESS_STORAGE_SCHEMA_AUTHORITY_INVALID", "schema_meta has an invalid shape");
  }
  const rows = database.prepare(
    names.length === 2
      ? "SELECT id, version, typeof(id) AS id_type, typeof(version) AS version_type FROM schema_meta"
      : "SELECT version, typeof(version) AS version_type FROM schema_meta",
  ).all();
  if (rows.length !== 1 || rows[0].version_type !== "integer"
      || (names.length === 2 && (rows[0].id_type !== "integer" || rows[0].id !== 1n))) {
    throw storageError(
      "LICHESS_STORAGE_SCHEMA_AUTHORITY_INVALID",
      "schema_meta must contain exactly one typed singleton row",
    );
  }
  return rawInteger(rows[0].version, "schema_meta.version");
}

function expectedTables(version, legacyRateLimit, includeLifecycle = false) {
  const tables = { ...CORE_TABLES, games: version >= 3
    ? [...GAME_COLUMNS_V1, ...GAME_PROVENANCE_COLUMNS]
    : GAME_COLUMNS_V1 };
  if (version >= 2) {
    if (legacyRateLimit) tables.api_rate_limit = LEGACY_RATE_LIMIT_COLUMNS;
    else {
      tables.api_safety_state = version >= 5
        ? [...API_SAFETY_COLUMNS_V2.slice(0, -1), ...API_SAFETY_CHALLENGE_COLUMNS, API_SAFETY_COLUMNS_V2.at(-1)]
        : API_SAFETY_COLUMNS_V2;
      tables.api_client_leases = version >= 4
        ? [...API_LEASE_COLUMNS_V2.slice(0, 3), ["process_identity_json", "TEXT", 0], ...API_LEASE_COLUMNS_V2.slice(3)]
        : API_LEASE_COLUMNS_V2;
    }
  }
  if (includeLifecycle) tables.provider_lifecycle_control = PROVIDER_LIFECYCLE_COLUMNS;
  return tables;
}

function admittedColumnOrders(table, expected, version) {
  const orders = [expected];
  if (table === "api_client_leases" && version >= 4) {
    orders.push([...API_LEASE_COLUMNS_V2, ["process_identity_json", "TEXT", 0]]);
  } else if (table === "api_safety_state" && version >= 5) {
    orders.push([...API_SAFETY_COLUMNS_V2, ...API_SAFETY_CHALLENGE_COLUMNS]);
  }
  return orders;
}

function columnsMatch(actual, expected, table) {
  return actual.length === expected.length && expected.every(
    ([name, type, primaryKey], position) => {
      const column = actual[position];
      const expectedDefault = EXPECTED_COLUMN_DEFAULTS[`${table}.${name}`] ?? null;
      return column?.name === name && String(column.type).toUpperCase() === type
        && Number(column.pk) === primaryKey
        && (primaryKey || Number(column.notnull) === 1)
        && column.dflt_value === expectedDefault;
    },
  );
}

function verifyColumns(database, table, expected, version) {
  const actual = database.prepare(`PRAGMA table_info("${table}")`).all();
  if (!admittedColumnOrders(table, expected, version)
    .some((order) => columnsMatch(actual, order, table))) {
    throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", `${table} has malformed columns`);
  }
}

function expectedIndexes(table, columns) {
  const indexes = [];
  const primary = columns.find((column) => column[2] === 1);
  if (primary && primary[1] !== "INTEGER") {
    indexes.push({
      name: `sqlite_autoindex_${table}_1`,
      unique: 1,
      origin: "pk",
      columns: [primary[0]],
    });
  }
  if (table === "games") {
    indexes.push({
      name: "games_opponent_finished",
      unique: 0,
      origin: "c",
      columns: ["opponent", "finished_at"],
    });
  } else if (table === "challenge_attempts") {
    indexes.push({
      name: "challenges_opponent_created",
      unique: 0,
      origin: "c",
      columns: ["opponent", "created_at"],
    });
  }
  return indexes;
}

function verifyIndexes(database, tables) {
  for (const [table, columns] of Object.entries(tables)) {
    const expected = expectedIndexes(table, columns);
    const actual = database.prepare(`PRAGMA index_list("${table}")`).all();
    if (actual.length !== expected.length) {
      throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", `${table} has unexpected indexes`);
    }
    const byName = new Map(actual.map((index) => [index.name, index]));
    for (const index of expected) {
      const admitted = byName.get(index.name);
      const actualColumns = database.prepare(`PRAGMA index_xinfo("${index.name}")`).all()
        .filter((column) => Number(column.key) === 1);
      if (!admitted || Number(admitted.unique) !== index.unique
          || admitted.origin !== index.origin || Number(admitted.partial) !== 0
          || actualColumns.length !== index.columns.length
          || actualColumns.some((column, position) => column.name !== index.columns[position]
            || Number(column.desc) !== 0 || column.coll !== "BINARY")) {
        throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", `${index.name} is malformed`);
      }
    }
  }
}

function verifyTableDefinitions(database, tables, { currentMeta }) {
  for (const table of tables) {
    const normalized = String(database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table)?.sql ?? "").toLocaleLowerCase().replaceAll(/[\s"`\[\]]/gu, "");
    const checks = table === "schema_meta" && currentMeta
      ? ["check(id=1)", "check(typeof(version)='integer'andversion>0)"]
      : EXPECTED_CHECKS[table] ?? [];
    const checkCount = normalized.match(/check\(/gu)?.length ?? 0;
    const strict = normalized.endsWith("strict");
    if (!normalized.startsWith(`createtable${table}(`)
        || checks.some((fragment) => !normalized.includes(fragment))
        || checkCount !== checks.length
        || strict !== (table === "schema_meta" && currentMeta)
        || [
          "asselect", "autoincrement", "collate", "foreignkey", "generated",
          "onconflict", "primarykeyasc", "primarykeydesc", "references", "withoutrowid",
        ]
          .some((fragment) => normalized.includes(fragment))
        || database.prepare(`PRAGMA foreign_key_list("${table}")`).all().length !== 0) {
      throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", `${table} constraints are malformed`);
    }
  }
}

function verifyStoredTypes(database, tables) {
  const booleanColumns = new Set([
    "scheduler_control.paused", "opponents.online", "games.rated",
    "api_safety_state.challenge_half_open", "api_rate_limit.half_open",
    "provider_lifecycle_control.admission_blocked",
  ]);
  for (const [table, columns] of Object.entries(tables)) {
    const invalidPredicates = columns.map(([column, type]) => {
      const quoted = `"${column}"`;
      let predicate = `typeof(${quoted})<>'${type.toLocaleLowerCase()}'`;
      if (type === "INTEGER") {
        predicate += ` OR ${quoted}<0 OR ${quoted}>${Number.MAX_SAFE_INTEGER}`;
        if (booleanColumns.has(`${table}.${column}`)) predicate += ` OR ${quoted} NOT IN (0,1)`;
      }
      return `(${predicate})`;
    });
    const invalid = database.prepare(
      `SELECT 1 AS invalid FROM "${table}" WHERE ${invalidPredicates.join(" OR ")} LIMIT 1`,
    ).get();
    if (invalid) {
      throw storageError(
        "LICHESS_STORAGE_ROW_INVALID",
        `${table} contains an invalid SQLite storage value`,
      );
    }
  }
}

function verifySchema(database, version, { requireLifecycle = false } = {}) {
  const hasLegacyRate = tableExists(database, "api_rate_limit");
  const hasSafety = tableExists(database, "api_safety_state");
  const hasLeases = tableExists(database, "api_client_leases");
  const hasLifecycle = tableExists(database, "provider_lifecycle_control");
  if (version === 2 && hasLegacyRate === hasSafety) {
    throw storageError(
      "LICHESS_STORAGE_SCHEMA_MALFORMED",
      "schema version two has ambiguous API safety authority",
    );
  }
  if (version >= 3 && (!hasSafety || !hasLeases)) {
    throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", "API safety tables are incomplete");
  }
  if (hasLifecycle && version !== CURRENT_SCHEMA_VERSION) {
    throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", "Lifecycle authority belongs only to schema five");
  }
  if (requireLifecycle && !hasLifecycle) {
    throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", "Lifecycle authority is unavailable");
  }
  const tables = expectedTables(
    version,
    version === 2 && hasLegacyRate,
    hasLifecycle,
  );
  const expectedObjects = new Set([
    "schema_meta",
    ...Object.keys(tables),
    "games_opponent_finished",
    "challenges_opponent_created",
  ]);
  if (version >= 3 && hasLegacyRate) expectedObjects.add("api_rate_limit");
  const objects = schemaObjects(database);
  if (objects.some((object) => !expectedObjects.has(object.name))
      || [...expectedObjects].some((name) => !objects.some((object) => object.name === name))) {
    throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", "SQLite objects do not match the admitted version");
  }
  for (const [table, columns] of Object.entries(tables)) {
    verifyColumns(database, table, columns, version);
  }
  if (version >= 3 && hasLegacyRate) {
    verifyColumns(database, "api_rate_limit", LEGACY_RATE_LIMIT_COLUMNS, version);
  }
  const metaColumns = database.prepare("PRAGMA table_info(schema_meta)").all()
    .map((column) => column.name);
  const admittedTables = {
    schema_meta: metaColumns.length === 2
      ? [["id", "INTEGER", 1], ["version", "INTEGER", 0]]
      : [["version", "INTEGER", 0]],
    ...tables,
  };
  if (version >= 3 && hasLegacyRate) admittedTables.api_rate_limit = LEGACY_RATE_LIMIT_COLUMNS;
  verifyIndexes(database, admittedTables);
  verifyTableDefinitions(database, Object.keys(admittedTables), {
    currentMeta: metaColumns.length === 2,
  });
  verifyStoredTypes(database, tables);
  if (version >= 3 && hasLegacyRate) {
    verifyStoredTypes(database, { api_rate_limit: LEGACY_RATE_LIMIT_COLUMNS });
  }
  if (hasLegacyRate) {
    const legacySql = String(database.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='api_rate_limit'",
    ).get()?.sql ?? "").toLocaleLowerCase().replaceAll(/[\s"`\[\]]/gu, "");
    const legacyRows = database.prepare("SELECT id FROM api_rate_limit").all();
    if (!legacySql.includes("check(id=1)")
        || legacyRows.length !== 1 || legacyRows[0].id !== 1n) {
      throw storageError("LICHESS_STORAGE_SCHEMA_MALFORMED", "legacy API rate-limit authority is malformed");
    }
  }
  const controlRows = database.prepare(
    "SELECT id, paused FROM scheduler_control",
  ).all();
  if (controlRows.length !== 1 || controlRows[0].id !== 1n) {
    throw storageError("LICHESS_STORAGE_ROW_INVALID", "scheduler_control singleton is invalid");
  }
  if (hasLifecycle) {
    const lifecycleRows = database.prepare(
      "SELECT id, owner_id FROM provider_lifecycle_control",
    ).all();
    if (lifecycleRows.length !== 1 || lifecycleRows[0].id !== 1n
        || (lifecycleRows[0].owner_id !== ""
          && !/^[A-Za-z0-9-]{1,128}$/u.test(lifecycleRows[0].owner_id))) {
      throw storageError("LICHESS_STORAGE_ROW_INVALID", "provider lifecycle singleton is invalid");
    }
  }
  return { hasLegacyRate, hasLifecycle };
}

function createApiV2(database) {
  database.exec(`${API_SAFETY_V2_SQL}${API_LEASE_V2_SQL}`);
}

function updateVersion(database, version) {
  database.prepare("UPDATE schema_meta SET version=?").run(version);
}

function migrateDatabase(database, initialVersion, { hasLegacyRate }) {
  let version = initialVersion;
  if (version === 1) {
    createApiV2(database);
    updateVersion(database, 2);
    version = 2;
  }
  if (version === 2) {
    if (hasLegacyRate) {
      createApiV2(database);
      database.exec(`
        INSERT INTO api_safety_state(
          authority_key, cooldown_until, strike_count, last_429_at,
          last_retry_after_ms, updated_at
        )
        SELECT '*', blocked_until, consecutive_429, last_429_at, 0,
          MAX(last_429_at, blocked_until)
        FROM api_rate_limit WHERE id=1;
        DROP TABLE api_rate_limit;
      `);
      hasLegacyRate = false;
    }
    for (const [name, type] of GAME_PROVENANCE_COLUMNS) {
      const defaultValue = type === "INTEGER" ? "0" : name === "runtime_provenance_json" ? "'{}'" : "''";
      database.exec(`ALTER TABLE games ADD COLUMN ${name} ${type} NOT NULL DEFAULT ${defaultValue}`);
    }
    updateVersion(database, 3);
    version = 3;
  }
  if (version === 3) {
    database.exec(
      "ALTER TABLE api_client_leases ADD COLUMN process_identity_json TEXT NOT NULL DEFAULT ''",
    );
    updateVersion(database, 4);
    version = 4;
  }
  if (version === 4) {
    for (const [name, type] of API_SAFETY_CHALLENGE_COLUMNS) {
      database.exec(`ALTER TABLE api_safety_state ADD COLUMN ${name} ${type} NOT NULL DEFAULT 0`);
    }
    updateVersion(database, 5);
    version = 5;
  }
  if (version === 5 && tableExists(database, "api_rate_limit")) {
    database.exec(`
      INSERT INTO api_safety_state(
        authority_key, cooldown_until, strike_count, last_429_at,
        last_retry_after_ms, challenge_blocked_until, challenge_strike_count,
        challenge_last_429_at, challenge_recovered_at, challenge_half_open, updated_at
      )
      SELECT '*', blocked_until, consecutive_429, last_429_at, 0, 0, 0, 0, 0, 0,
        MAX(last_429_at, blocked_until)
      FROM api_rate_limit WHERE id=1
      ON CONFLICT(authority_key) DO UPDATE SET
        cooldown_until=MAX(api_safety_state.cooldown_until, excluded.cooldown_until),
        last_429_at=MAX(api_safety_state.last_429_at, excluded.last_429_at),
        updated_at=MAX(api_safety_state.updated_at, excluded.updated_at);
      DROP TABLE api_rate_limit;
    `);
  }
  if (version === CURRENT_SCHEMA_VERSION && !tableExists(database, "provider_lifecycle_control")) {
    database.exec(PROVIDER_LIFECYCLE_SQL);
  }
  return version;
}

function normalizeSchemaMeta(database, version) {
  const columns = database.prepare("PRAGMA table_info(schema_meta)").all().map((column) => column.name);
  const sql = String(database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='schema_meta'",
  ).get()?.sql ?? "").toLocaleLowerCase().replaceAll(/[\s"`\[\]]/gu, "");
  if (columns.length === 2 && columns[0] === "id" && columns[1] === "version"
      && sql.includes("check(id=1)")
      && sql.includes("check(typeof(version)='integer'andversion>0)")
      && sql.includes("strict")) return;
  database.exec(`
    ALTER TABLE schema_meta RENAME TO schema_meta_legacy;
    CREATE TABLE schema_meta(
      id INTEGER PRIMARY KEY CHECK(id=1),
      version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version > 0)
    ) STRICT;
  `);
  database.prepare("INSERT INTO schema_meta(id, version) VALUES(1, ?)").run(version);
  database.exec("DROP TABLE schema_meta_legacy");
}

export function verifySqliteConfiguration(database) {
  const values = {
    journalMode: database.prepare("PRAGMA journal_mode").get()?.journal_mode,
    foreignKeys: database.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
    synchronous: database.prepare("PRAGMA synchronous").get()?.synchronous,
    busyTimeout: database.prepare("PRAGMA busy_timeout").get()?.timeout,
    trustedSchema: database.prepare("PRAGMA trusted_schema").get()?.trusted_schema,
  };
  if (String(values.journalMode).toLocaleLowerCase() !== "wal"
      || values.foreignKeys !== 1n || values.synchronous !== 1n
      || values.busyTimeout !== BigInt(BUSY_TIMEOUT_MS) || values.trustedSchema !== 0n) {
    throw storageError(
      "LICHESS_STORAGE_PRAGMA_REFUSED",
      "SQLite refused the required WAL, foreign-key, synchronous, or busy-timeout configuration",
    );
  }
  return Object.freeze({
    journalMode: "wal",
    foreignKeys: true,
    synchronous: "normal",
    busyTimeoutMs: BUSY_TIMEOUT_MS,
  });
}

function initializeOrMigrate(database, empty, failureInjector) {
  database.exec("BEGIN EXCLUSIVE");
  try {
    failureInjector?.("transaction_started");
    const objects = schemaObjects(database);
    if (objects.length === 0) {
      database.exec(CURRENT_SCHEMA_SQL);
    } else {
      if (empty) {
        throw storageError(
          "LICHESS_STORAGE_EMPTY_CLASSIFICATION_CHANGED",
          "Empty storage acquired objects before initialization",
        );
      }
      const version = schemaVersion(database);
      const admitted = verifySchema(database, version);
      const migrated = migrateDatabase(database, version, admitted);
      normalizeSchemaMeta(database, migrated);
    }
    failureInjector?.("before_final_verification");
    const finalVersion = schemaVersion(database);
    if (finalVersion !== CURRENT_SCHEMA_VERSION) {
      throw storageError("LICHESS_STORAGE_SCHEMA_UNSUPPORTED", "SQLite migration did not reach the current schema");
    }
    verifySchema(database, finalVersion, { requireLifecycle: true });
    const quickCheck = database.prepare("PRAGMA quick_check").get()?.quick_check;
    if (quickCheck !== "ok") {
      throw storageError("LICHESS_STORAGE_INTEGRITY_FAILED", "SQLite quick_check rejected the database");
    }
    failureInjector?.("before_commit");
    database.exec("COMMIT");
  } catch (error) {
    let rollbackError = null;
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (failure) {
        rollbackError = failure;
      }
    }
    if (rollbackError) {
      throw storageError(
        "LICHESS_STORAGE_OPERATION_AND_RECOVERY_FAILED",
        "SQLite initialization and transaction recovery both failed",
        error,
      );
    }
    throw error;
  }
}

export function openLichessStorage(filePath, {
  databaseFactory = (filename, options) => new DatabaseSync(filename, options),
  failureInjector = null,
} = {}) {
  const authority = prepareStoragePath(filePath);
  let database = null;
  try {
    database = databaseFactory(authority.filePath, {
      timeout: BUSY_TIMEOUT_MS,
      readBigInts: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
    });
    failureInjector?.("opened");
    assertStoragePaths(authority);
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};
      PRAGMA trusted_schema=OFF;
    `);
    verifySqliteConfiguration(database);
    failureInjector?.("configured");
    initializeOrMigrate(database, authority.empty, failureInjector);
    assertStoragePaths(authority);
    const safeDatabase = new SafeDatabase(database);
    return Object.freeze({
      filePath: authority.filePath,
      db: safeDatabase,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      assertPaths: () => assertStoragePaths(authority),
      close: () => safeDatabase.close(),
    });
  } catch (error) {
    if (database) {
      try {
        if (database.isTransaction) database.exec("ROLLBACK");
      } catch {}
      try {
        database.close();
      } catch {}
    }
    if (error instanceof LichessStorageError) throw error;
    if (error?.code?.startsWith?.("EXACT_")) {
      throw storageError("LICHESS_STORAGE_PATH_UNSAFE", error.message, error);
    }
    throw storageError(
      "LICHESS_STORAGE_INITIALIZATION_FAILED",
      error?.message ?? "Lichess storage initialization failed",
      error,
    );
  }
}

export const LICHESS_STORAGE_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
