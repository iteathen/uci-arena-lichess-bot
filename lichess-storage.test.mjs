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
  database.exec("DROP TABLE schema_meta; CREATE TABLE schema_meta(version);");
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
