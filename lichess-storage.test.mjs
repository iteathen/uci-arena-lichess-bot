import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LichessStore } from "./lichess-store.mjs";
import { verifySqliteConfiguration } from "./lichess-storage.mjs";

function databasePath(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(directory, "matches.sqlite");
}

function initializedDatabase(prefix) {
  const file = databasePath(prefix);
  const store = new LichessStore(file);
  store.close();
  return file;
}

const ARCHIVE_COLUMNS = Object.freeze([
  "backfill_last_attempted_at", "backfill_attempts",
  "engine_component_manifest_sha256", "engine_component_version", "engine_component_id",
  "provider_component_manifest_sha256", "provider_component_version", "provider_component_id",
  "archive_sha256", "archive_reason", "archive_completeness", "variant", "initial_fen",
  "completion_cursor", "archive_cursor",
]);

function downgradeToSchemaFive(file) {
  const database = new DatabaseSync(file);
  database.exec(`
    DROP INDEX games_live_cursor;
    DROP INDEX games_completion_cursor;
    DROP INDEX games_archive_cursor;
    DROP TABLE game_plies;
    DROP TABLE game_archive_control;
  `);
  for (const column of ARCHIVE_COLUMNS) {
    database.exec(`ALTER TABLE games DROP COLUMN ${column}`);
  }
  database.exec("UPDATE schema_meta SET version=5");
  database.close();
}

function replaceSchemaMeta(file, values) {
  const database = new DatabaseSync(file);
  database.exec("DROP TABLE schema_meta; CREATE TABLE schema_meta(version INTEGER NOT NULL);");
  const insert = database.prepare("INSERT INTO schema_meta(version) VALUES(?)");
  for (const value of values) insert.run(value);
  database.close();
}

test("database, WAL, and SHM paths reject directories and orphan sidecars", () => {
  const directoryTarget = databasePath("uci-arena-storage-directory-");
  mkdirSync(directoryTarget);
  assert.throws(
    () => new LichessStore(directoryTarget),
    (error) => error.code === "LICHESS_STORAGE_PATH_TYPE_INVALID",
  );

  const orphan = databasePath("uci-arena-storage-orphan-");
  writeFileSync(`${orphan}-wal`, "orphan", { flag: "wx" });
  assert.throws(
    () => new LichessStore(orphan),
    (error) => error.code === "LICHESS_STORAGE_ORPHAN_SIDECAR",
  );

  const sidecar = initializedDatabase("uci-arena-storage-sidecar-");
  mkdirSync(`${sidecar}-shm`);
  assert.throws(
    () => new LichessStore(sidecar),
    (error) => error.code === "LICHESS_STORAGE_PATH_TYPE_INVALID",
  );
});

test("database and ancestor links fail exact path admission when links are supported", (context) => {
  const target = initializedDatabase("uci-arena-storage-link-target-");
  const linkDirectory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-storage-link-"));
  const databaseLink = path.join(linkDirectory, "matches.sqlite");
  try {
    symlinkSync(target, databaseLink, "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
      context.skip("file-link creation is unavailable on this host");
      return;
    }
    throw error;
  }
  assert.throws(
    () => new LichessStore(databaseLink),
    (error) => error.code === "LICHESS_STORAGE_PATH_UNSAFE",
  );

  const realParent = mkdtempSync(path.join(os.tmpdir(), "uci-arena-storage-real-parent-"));
  const parentLink = path.join(linkDirectory, "parent-link");
  symlinkSync(realParent, parentLink, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => new LichessStore(path.join(parentLink, "nested", "matches.sqlite")),
    (error) => error.code === "LICHESS_STORAGE_PATH_UNSAFE",
  );
});

test("unversioned nonempty and malformed migration authorities are rejected", () => {
  const unversioned = databasePath("uci-arena-storage-unversioned-");
  const database = new DatabaseSync(unversioned);
  database.exec("CREATE TABLE unrelated(value TEXT)");
  database.close();
  assert.throws(
    () => new LichessStore(unversioned),
    (error) => error.code === "LICHESS_STORAGE_SCHEMA_AUTHORITY_MISSING",
  );

  for (const [label, values] of [
    ["duplicate", [5, 5]],
    ["unknown", [99]],
    ["wrong-type", ["five"]],
  ]) {
    const file = initializedDatabase(`uci-arena-storage-${label}-`);
    replaceSchemaMeta(file, values);
    assert.throws(
      () => new LichessStore(file),
      (error) => error.code === "LICHESS_STORAGE_SCHEMA_AUTHORITY_INVALID",
    );
  }

  const wrongDeclaration = initializedDatabase("uci-arena-storage-meta-declaration-");
  const declared = new DatabaseSync(wrongDeclaration);
  declared.exec(`
    DROP TABLE schema_meta;
    CREATE TABLE schema_meta(version TEXT NOT NULL);
    INSERT INTO schema_meta(version) VALUES('5');
  `);
  declared.close();
  assert.throws(
    () => new LichessStore(wrongDeclaration),
    (error) => error.code === "LICHESS_STORAGE_SCHEMA_AUTHORITY_INVALID",
  );
});

test("schema-five lifecycle extension migrates exactly and preserves admitted authority", () => {
  const legacyFile = initializedDatabase("uci-arena-storage-lifecycle-legacy-");
  downgradeToSchemaFive(legacyFile);
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec(`
    DROP TABLE provider_incidents;
    DROP TABLE provider_incident_control;
    DROP TABLE provider_lifecycle_control;
  `);
  legacy.close();
  const migrated = new LichessStore(legacyFile);
  try {
    assert.deepEqual(migrated.providerLifecycleSnapshot(), {
      admissionBlocked: false,
      owned: false,
      activeWork: 0,
      updatedAt: 0,
    });
  } finally {
    migrated.close();
  }

  const retainedFile = initializedDatabase("uci-arena-storage-lifecycle-retained-");
  const retained = new DatabaseSync(retainedFile);
  retained.exec(`
    UPDATE provider_lifecycle_control
    SET admission_blocked=1, owner_id='retained-owner', active_work=2, updated_at=99
    WHERE id=1
  `);
  retained.close();
  downgradeToSchemaFive(retainedFile);
  const reopened = new LichessStore(retainedFile);
  try {
    assert.deepEqual(reopened.providerLifecycleSnapshot(), {
      admissionBlocked: true,
      owned: true,
      activeWork: 2,
      updatedAt: 99,
    });
  } finally {
    reopened.close();
  }
});

test("schema-five game summaries migrate to deterministic archive cursors without invented replay", () => {
  const file = initializedDatabase("uci-arena-storage-game-archive-v5-");
  downgradeToSchemaFive(file);
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    INSERT INTO games(game_id, opponent, audience, status, plies, started_at, finished_at)
    VALUES
      ('game-b', 'bot-b', 'bot', 'mate', 31, 20, 200),
      ('game-a', 'bot-a', 'bot', 'resign', 42, 10, 300),
      ('game-live', 'bot-live', 'bot', 'started', 7, 5, 0)
  `);
  legacy.close();

  const migrated = new LichessStore(file);
  try {
    assert.equal(migrated.status().schemaVersion, 6);
    assert.deepEqual(migrated.db.prepare(`
      SELECT game_id, archive_cursor, completion_cursor, archive_completeness,
        archive_reason, archive_sha256, provider_component_id, engine_component_id
      FROM games ORDER BY archive_cursor
    `).all().map((row) => ({ ...row })), [
      {
        game_id: "game-live", archive_cursor: 1, completion_cursor: 0,
        archive_completeness: "live", archive_reason: "", archive_sha256: "",
        provider_component_id: "", engine_component_id: "",
      },
      {
        game_id: "game-a", archive_cursor: 2, completion_cursor: 2,
        archive_completeness: "summary_only",
        archive_reason: "historical_moves_unavailable", archive_sha256: "",
        provider_component_id: "", engine_component_id: "",
      },
      {
        game_id: "game-b", archive_cursor: 3, completion_cursor: 1,
        archive_completeness: "summary_only",
        archive_reason: "historical_moves_unavailable", archive_sha256: "",
        provider_component_id: "", engine_component_id: "",
      },
    ]);
    assert.deepEqual({ ...migrated.db.prepare(`
      SELECT next_archive_cursor, next_completion_cursor FROM game_archive_control WHERE id=1
    `).get() }, { next_archive_cursor: 4, next_completion_cursor: 3 });
    assert.equal(migrated.gamePlyRows("game-a").length, 0);
  } finally {
    migrated.close();
  }
});

test("current storage heals only exact legacy archive defaults written after migration", () => {
  const file = initializedDatabase("uci-arena-storage-legacy-archive-defaults-");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    INSERT INTO games(game_id, opponent, audience, status, plies, started_at, finished_at)
    VALUES
      ('legacy-live', 'bot-live', 'bot', 'started', 4, 30, 0),
      ('legacy-terminal-b', 'bot-b', 'bot', 'mate', 31, 20, 200),
      ('legacy-terminal-a', 'bot-a', 'bot', 'resign', 42, 10, 300)
  `);
  legacy.close();

  const repaired = new LichessStore(file);
  try {
    assert.deepEqual(repaired.db.prepare(`
      SELECT game_id, archive_cursor, completion_cursor, archive_completeness, archive_reason
      FROM games ORDER BY archive_cursor
    `).all().map((row) => ({ ...row })), [
      {
        game_id: "legacy-terminal-a", archive_cursor: 1, completion_cursor: 2,
        archive_completeness: "summary_only",
        archive_reason: "historical_moves_unavailable",
      },
      {
        game_id: "legacy-terminal-b", archive_cursor: 2, completion_cursor: 1,
        archive_completeness: "summary_only",
        archive_reason: "historical_moves_unavailable",
      },
      {
        game_id: "legacy-live", archive_cursor: 3, completion_cursor: 0,
        archive_completeness: "live", archive_reason: "",
      },
    ]);
    assert.deepEqual({ ...repaired.db.prepare(`
      SELECT next_archive_cursor, next_completion_cursor FROM game_archive_control WHERE id=1
    `).get() }, { next_archive_cursor: 4, next_completion_cursor: 3 });
  } finally {
    repaired.close();
  }

  const reopened = new LichessStore(file);
  reopened.close();
});

test("current storage rejects non-default malformed archive authority", () => {
  const file = initializedDatabase("uci-arena-storage-malformed-archive-defaults-");
  const malformed = new DatabaseSync(file);
  malformed.exec(`
    INSERT INTO games(
      game_id, opponent, audience, status, plies, started_at, finished_at, archive_reason
    ) VALUES('malformed-terminal', 'bot', 'bot', 'mate', 0, 10, 20, 'unexpected')
  `);
  malformed.close();
  assert.throws(
    () => new LichessStore(file),
    (error) => error.code === "LICHESS_STORAGE_ROW_INVALID",
  );
});

test("schema-five archive migration rolls back completely and retries deterministically", () => {
  const file = initializedDatabase("uci-arena-storage-game-archive-rollback-");
  downgradeToSchemaFive(file);
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    INSERT INTO games(game_id, opponent, audience, status, plies, started_at, finished_at)
    VALUES('rollback-game', 'fixture-bot', 'bot', 'mate', 0, 10, 20)
  `);
  legacy.close();

  assert.throws(
    () => new LichessStore(file, {
      failureInjector: (stage) => {
        if (stage === "before_commit") throw new Error("fixture archive migration interruption");
      },
    }),
    (error) => error.code === "LICHESS_STORAGE_INITIALIZATION_FAILED",
  );
  const rolledBack = new DatabaseSync(file);
  try {
    assert.equal(rolledBack.prepare("SELECT version FROM schema_meta").get().version, 5);
    assert.equal(rolledBack.prepare(`
      SELECT COUNT(*) AS count FROM pragma_table_info('games') WHERE name='archive_cursor'
    `).get().count, 0);
    assert.equal(rolledBack.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE name='game_archive_control'
    `).get().count, 0);
  } finally {
    rolledBack.close();
  }

  const retried = new LichessStore(file);
  try {
    const game = retried.db.prepare(`
      SELECT archive_cursor, completion_cursor, archive_completeness
      FROM games WHERE game_id='rollback-game'
    `).get();
    assert.deepEqual({ ...game }, {
      archive_cursor: 1,
      completion_cursor: 1,
      archive_completeness: "summary_only",
    });
  } finally {
    retried.close();
  }
});

test("malformed schema-five lifecycle extensions fail closed", () => {
  const file = initializedDatabase("uci-arena-storage-lifecycle-malformed-");
  downgradeToSchemaFive(file);
  const database = new DatabaseSync(file);
  database.exec(`
    DROP TABLE provider_lifecycle_control;
    CREATE TABLE provider_lifecycle_control(
      id INTEGER PRIMARY KEY,
      admission_blocked INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      active_work INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO provider_lifecycle_control VALUES(1, 0, '', 0, 0);
  `);
  database.close();
  assert.throws(
    () => new LichessStore(file),
    (error) => error.code === "LICHESS_STORAGE_SCHEMA_MALFORMED",
  );

  const reorderedFile = initializedDatabase("uci-arena-storage-lifecycle-reordered-");
  downgradeToSchemaFive(reorderedFile);
  const reordered = new DatabaseSync(reorderedFile);
  reordered.exec(`
    DROP TABLE provider_lifecycle_control;
    CREATE TABLE provider_lifecycle_control(
      id INTEGER PRIMARY KEY CHECK(id=1),
      owner_id TEXT NOT NULL DEFAULT '',
      admission_blocked INTEGER NOT NULL DEFAULT 0 CHECK(admission_blocked IN (0, 1)),
      active_work INTEGER NOT NULL DEFAULT 0 CHECK(active_work >= 0),
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO provider_lifecycle_control(
      id, owner_id, admission_blocked, active_work, updated_at
    ) VALUES(1, '', 0, 0, 0);
  `);
  reordered.close();
  assert.throws(
    () => new LichessStore(reorderedFile),
    (error) => error.code === "LICHESS_STORAGE_SCHEMA_MALFORMED",
  );
});

test("incident extension completeness and stored sanitization fail closed", () => {
  const partialFile = initializedDatabase("uci-arena-storage-incidents-partial-");
  downgradeToSchemaFive(partialFile);
  const partial = new DatabaseSync(partialFile);
  partial.exec("DROP TABLE provider_incidents");
  partial.close();
  assert.throws(
    () => new LichessStore(partialFile),
    (error) => error.code === "LICHESS_STORAGE_SCHEMA_MALFORMED",
  );

  const unsafeFile = initializedDatabase("uci-arena-storage-incidents-unsafe-");
  const unsafe = new DatabaseSync(unsafeFile);
  unsafe.prepare(`
    INSERT INTO provider_incidents(
      cursor, identity_key, code, severity, source, operation,
      first_occurrence, last_occurrence, occurrence_count, active,
      resolved_at, http_status, retry_deadline, game_id, detail
    ) VALUES(1, ?, 'storage_operation_failed', 'error', 'storage', 'storage_open',
      1, 1, 1, 1, 0, 0, 0, '', 'Authorization header leaked')
  `).run("a".repeat(64));
  unsafe.exec("UPDATE provider_incident_control SET next_cursor=2 WHERE id=1");
  unsafe.close();
  assert.throws(
    () => new LichessStore(unsafeFile),
    (error) => error.code === "LICHESS_STORAGE_ROW_INVALID",
  );
});

test("wrong SQLite storage classes and unsafe integer rows fail before projection", () => {
  for (const [label, value] of [
    ["wrong-type", "invalid"],
    ["negative", -1],
    ["unsafe", 9_007_199_254_740_992n],
  ]) {
    const file = initializedDatabase(`uci-arena-storage-row-${label}-`);
    const database = new DatabaseSync(file);
    database.prepare(`
      INSERT INTO games(game_id, opponent, audience, plies, started_at)
      VALUES('game', 'opponent', 'bot', ?, 1)
    `).run(value);
    database.close();
    assert.throws(
      () => new LichessStore(file),
      (error) => error.code === "LICHESS_STORAGE_ROW_INVALID",
    );
  }
});

test("caller integers are exact and never accept strings or reals", () => {
  const file = databasePath("uci-arena-storage-input-");
  const store = new LichessStore(file);
  try {
    store.addOwner("owner");
    assert.throws(
      () => store.reserve("owner", "2", 15),
      (error) => error.code === "LICHESS_STORAGE_INTEGER_INVALID",
    );
    assert.throws(
      () => store.reserve("owner", 2.5, 15),
      (error) => error.code === "LICHESS_STORAGE_INTEGER_INVALID",
    );
    assert.throws(
      () => store.requestProviderReplacement("1", { allowUnowned: true }),
      (error) => error.code === "LICHESS_STORAGE_INTEGER_INVALID",
    );
    assert.equal(store.getReservation(), null);
  } finally {
    store.close();
  }
});

test("pragma refusal is typed and initialization failure closes for deterministic retry", () => {
  const inMemory = new DatabaseSync(":memory:", { readBigInts: true });
  try {
    assert.throws(
      () => verifySqliteConfiguration(inMemory),
      (error) => error.code === "LICHESS_STORAGE_PRAGMA_REFUSED",
    );
  } finally {
    inMemory.close();
  }

  const file = databasePath("uci-arena-storage-retry-");
  assert.throws(
    () => new LichessStore(file, {
      failureInjector: (stage) => {
        if (stage === "before_commit") throw new Error("fixture migration interruption");
      },
    }),
    (error) => error.code === "LICHESS_STORAGE_INITIALIZATION_FAILED",
  );
  const retried = new LichessStore(file);
  try {
    assert.equal(retried.status().schemaVersion, 6);
  } finally {
    retried.close();
  }
});

test("abrupt process exit rolls back an owned SQLite transaction", () => {
  const file = initializedDatabase("uci-arena-storage-crash-");
  const storeUrl = pathToFileURL(path.resolve("lichess-store.mjs")).href;
  const source = `
    import { LichessStore } from ${JSON.stringify(storeUrl)};
    const store = new LichessStore(process.argv[1]);
    store.db.exec("BEGIN IMMEDIATE");
    store.db.prepare("INSERT INTO owners(username, created_at) VALUES('crash-owner', 1)").run();
    process.exit(17);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source, file], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(child.status, 17, child.stderr);
  const reopened = new LichessStore(file);
  try {
    assert.equal(reopened.isOwner("crash-owner"), false);
    assert.equal(reopened.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  } finally {
    reopened.close();
  }
});
