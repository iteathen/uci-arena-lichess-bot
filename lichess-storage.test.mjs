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
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec("DROP TABLE provider_lifecycle_control");
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

test("malformed schema-five lifecycle extensions fail closed", () => {
  const file = initializedDatabase("uci-arena-storage-lifecycle-malformed-");
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
    assert.equal(retried.status().schemaVersion, 5);
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
