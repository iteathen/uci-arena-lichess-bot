import assert from "node:assert/strict";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createExactFileAuthority,
  ExactFileError,
  exactFiles,
} from "./exact-file.mjs";

function workspace(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "uci-arena-exact-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function requireCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof ExactFileError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("exact reads and streaming hashes bind one unchanged regular file", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "fixture.json");
  writeFileSync(filename, '{"value":7}\n', "utf8");

  const parsed = exactFiles.readExactJsonSync(filename, {
    maximumBytes: 1024,
    label: "Fixture JSON",
  });
  const hashed = exactFiles.hashExactFileSync(filename, {
    maximumBytes: 1024,
    label: "Fixture JSON",
  });

  assert.deepEqual(parsed.value, { value: 7 });
  assert.equal(parsed.byteLength, 12);
  assert.match(hashed.sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(hashed.byteLength, parsed.byteLength);
  assert.equal(hashed.identity.ino, parsed.identity.ino);
});

test("sensitive reads verify bytes without producing a credential hash", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "credential");
  writeFileSync(filename, "synthetic-token", "utf8");
  const admitted = exactFiles.readExactTextSync(filename, {
    maximumBytes: 4096,
    label: "Synthetic credential",
    sensitive: true,
  });
  assert.equal(admitted.text, "synthetic-token");
  assert.equal(admitted.sha256, undefined);
});

test("exact admission rejects final and ancestor link substitutions", (t) => {
  const root = workspace(t);
  const realDirectory = path.join(root, "real");
  mkdirSync(realDirectory);
  const target = path.join(realDirectory, "target");
  writeFileSync(target, "fabricated-value", "utf8");
  const finalLink = path.join(root, "final-link");
  const ancestorLink = path.join(root, "ancestor-link");

  let finalLinkAvailable = true;
  try {
    symlinkSync(target, finalLink, "file");
  } catch (error) {
    assert.match(String(error?.code ?? ""), /EPERM|EACCES/u);
    finalLinkAvailable = false;
    t.diagnostic("file-link creation is unavailable on this host; capability failure was explicit");
  }
  if (finalLinkAvailable) {
    requireCode(() => exactFiles.readExactFileSync(finalLink, {
      maximumBytes: 64,
      label: "Synthetic credential",
    }), "EXACT_FILE_TYPE_INVALID");
  }

  try {
    symlinkSync(realDirectory, ancestorLink, process.platform === "win32" ? "junction" : "dir");
    requireCode(() => exactFiles.readExactFileSync(path.join(ancestorLink, "target"), {
      maximumBytes: 64,
      label: "Synthetic credential",
    }), "EXACT_FILE_ANCESTOR_INVALID");
  } catch (error) {
    if (error instanceof ExactFileError) throw error;
    assert.match(String(error?.code ?? ""), /EPERM|EACCES/u);
    t.diagnostic("directory-link creation is unavailable on this host; capability failure was explicit");
  }
});

test("path swaps and same-size mutation cannot cross exact admission", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "authority");
  const prior = path.join(root, "prior");
  writeFileSync(filename, "alpha", "utf8");
  requireCode(() => exactFiles.readExactFileSync(filename, {
    maximumBytes: 64,
    label: "Authority file",
    hooks: {
      afterPathAdmission() {
        renameSync(filename, prior);
        writeFileSync(filename, "omega", "utf8");
      },
    },
  }), "EXACT_FILE_IDENTITY_CHANGED");

  rmSync(filename);
  renameSync(prior, filename);
  requireCode(() => exactFiles.readExactFileSync(filename, {
    maximumBytes: 64,
    label: "Authority file",
    hooks: {
      beforePostReadValidation() {
        writeFileSync(filename, "bravo", "utf8");
      },
    },
  }), "EXACT_FILE_IDENTITY_CHANGED");
});

test("growth, truncation, and one-byte overflow fail before acceptance", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "bounded");
  writeFileSync(filename, "12345", "utf8");
  requireCode(() => exactFiles.readExactFileSync(filename, {
    maximumBytes: 4,
    label: "Bounded file",
  }), "EXACT_FILE_TOO_LARGE");

  requireCode(() => exactFiles.readExactFileSync(filename, {
    maximumBytes: 64,
    label: "Bounded file",
    hooks: { afterOpen: () => writeFileSync(filename, "12", "utf8") },
  }), "EXACT_FILE_TRUNCATED");

  writeFileSync(filename, "12345", "utf8");
  requireCode(() => exactFiles.readExactFileSync(filename, {
    maximumBytes: 64,
    label: "Bounded file",
    hooks: { afterOpen: () => writeFileSync(filename, "123456", "utf8") },
  }), "EXACT_FILE_GREW");
});

test("directories and malformed JSON fail with bounded path-free diagnostics", (t) => {
  const root = workspace(t);
  requireCode(() => exactFiles.readExactFileSync(root, {
    maximumBytes: 64,
    label: "Synthetic credential",
  }), "EXACT_FILE_TYPE_INVALID");
  const filename = path.join(root, "malformed-private-name.json");
  writeFileSync(filename, "{not-json", "utf8");
  assert.throws(() => exactFiles.readExactJsonSync(filename, {
    maximumBytes: 64,
    label: "Configuration",
  }), (error) => {
    assert.equal(error.code, "EXACT_FILE_JSON_INVALID");
    assert.equal(error.message.includes(root), false);
    assert.equal(error.message.includes("malformed-private-name"), false);
    return true;
  });
});

test("publication uses a private random file and preserves hostile targets", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "runtime.json");
  exactFiles.publishExactJsonSync(filename, { state: "ready" }, {
    maximumBytes: 1024,
    label: "Runtime status",
  });
  assert.deepEqual(JSON.parse(readFileSync(filename, "utf8")), { state: "ready" });
  assert.deepEqual(readdirSync(root), ["runtime.json"]);

  rmSync(filename);
  requireCode(() => exactFiles.publishExactFileSync(filename, "accepted", {
    maximumBytes: 64,
    label: "Runtime status",
    hooks: {
      beforeActivation() {
        writeFileSync(filename, "hostile", "utf8");
      },
    },
  }), "EXACT_FILE_TARGET_CHANGED");
  assert.equal(readFileSync(filename, "utf8"), "hostile");
  assert.deepEqual(readdirSync(root), ["runtime.json"]);
});

test("publication keeps prior authority when write or close fails", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "profile.json");
  writeFileSync(filename, "prior", "utf8");
  const writeFailure = createExactFileAuthority({
    writeSync() {
      const error = new Error("synthetic write failure");
      error.code = "EIO";
      throw error;
    },
  });
  requireCode(() => writeFailure.publishExactFileSync(filename, "replacement", {
    maximumBytes: 64,
    label: "Profile",
  }), "EXACT_FILE_WRITE_FAILED");
  assert.equal(readFileSync(filename, "utf8"), "prior");
  assert.deepEqual(readdirSync(root), ["profile.json"]);

  let failedClose = false;
  const closeFailure = createExactFileAuthority({
    closeSync(descriptor) {
      closeSync(descriptor);
      if (!failedClose) {
        failedClose = true;
        const error = new Error("synthetic close failure");
        error.code = "EIO";
        throw error;
      }
    },
  });
  requireCode(() => closeFailure.publishExactFileSync(filename, "replacement", {
    maximumBytes: 64,
    label: "Profile",
  }), "EXACT_FILE_CLOSE_FAILED");
  assert.equal(readFileSync(filename, "utf8"), "prior");
  assert.deepEqual(readdirSync(root), ["profile.json"]);
});

test("exact append rejects a pre-existing link without touching its target", (t) => {
  const root = workspace(t);
  const target = path.join(root, "target.log");
  const link = path.join(root, "adapter.log");
  writeFileSync(target, "prior\n", "utf8");
  try {
    symlinkSync(target, link, "file");
  } catch (error) {
    assert.match(String(error?.code ?? ""), /EPERM|EACCES/u);
    t.diagnostic("file-link creation is unavailable on this host; capability failure was explicit");
    return;
  }
  requireCode(() => exactFiles.appendExactFileSync(link, "new\n", {
    maximumFileBytes: 1024,
    label: "Runtime log",
  }), "EXACT_FILE_TYPE_INVALID");
  assert.equal(readFileSync(target, "utf8"), "prior\n");
});

test("private temporary files and directories require their admitted identity", (t) => {
  const root = workspace(t);
  const stagedFile = exactFiles.createExactTemporaryFileSync(root, "startup-task", "payload", {
    maximumBytes: 64,
    label: "Startup task",
  });
  assert.match(path.basename(stagedFile.filename), /^\.startup-task\.[0-9a-f]{32}\.tmp$/u);
  assert.equal(readFileSync(stagedFile.filename, "utf8"), "payload");
  assert.equal(exactFiles.removeExactPublishedFileSync(
    stagedFile.filename,
    stagedFile.identity,
    { label: "Startup task" },
  ), true);

  const stagedDirectory = exactFiles.createExactTemporaryDirectorySync(root, "evidence", {
    label: "Evidence staging",
  });
  const child = path.join(stagedDirectory.directory, "artifact.json");
  exactFiles.publishExactFileSync(child, "{}\n", {
    maximumBytes: 64,
    label: "Evidence artifact",
  });
  const target = path.join(root, "evidence");
  const activated = exactFiles.activateExactDirectorySync(
    stagedDirectory.directory,
    target,
    stagedDirectory.identity,
    { label: "Evidence" },
  );
  const admittedChild = exactFiles.hashExactFileSync(path.join(target, "artifact.json"), {
    maximumBytes: 64,
    label: "Evidence artifact",
  });
  exactFiles.removeExactPublishedFileSync(
    path.join(target, "artifact.json"),
    admittedChild.identity,
    { label: "Evidence artifact" },
  );
  assert.equal(exactFiles.removeExactDirectorySync(
    target,
    activated.identity,
    { label: "Evidence" },
  ), true);
  assert.deepEqual(readdirSync(root), []);
});

test("publication validation errors preserve their domain contract", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "configuration.json");
  writeFileSync(filename, "prior", "utf8");
  assert.throws(() => exactFiles.publishExactFileSync(filename, "replacement", {
    maximumBytes: 64,
    label: "Configuration",
    hooks: {
      beforeActivation() {
        throw new Error("synthetic policy rejection");
      },
    },
  }), /synthetic policy rejection/u);
  assert.equal(readFileSync(filename, "utf8"), "prior");
  assert.deepEqual(readdirSync(root), ["configuration.json"]);
});

test("publication rejects a target changed since its exact read", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "configuration.json");
  writeFileSync(filename, "prior", "utf8");
  const admitted = exactFiles.readExactFileSync(filename, {
    maximumBytes: 64,
    label: "Configuration",
  });
  writeFileSync(filename, "newer!", "utf8");
  requireCode(() => exactFiles.publishExactFileSync(filename, "replacement", {
    maximumBytes: 64,
    label: "Configuration",
    expectedTargetIdentity: admitted.identity,
  }), "EXACT_FILE_TARGET_CHANGED");
  assert.equal(readFileSync(filename, "utf8"), "newer!");
  assert.deepEqual(readdirSync(root), ["configuration.json"]);
});

test("special-file and permission failures are explicit and path-free", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "private-authority");
  writeFileSync(filename, "value", "utf8");
  const special = createExactFileAuthority({
    lstatSync(candidate, options) {
      const metadata = lstatSync(candidate, options);
      if (path.resolve(candidate) !== path.resolve(filename)) return metadata;
      return {
        ...metadata,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    },
  });
  requireCode(() => special.readExactFileSync(filename, {
    maximumBytes: 64,
    label: "Private authority",
  }), "EXACT_FILE_TYPE_INVALID");

  const denied = createExactFileAuthority({
    openSync() {
      const error = new Error("synthetic permission failure");
      error.code = "EACCES";
      throw error;
    },
  });
  assert.throws(() => denied.readExactFileSync(filename, {
    maximumBytes: 64,
    label: "Private authority",
  }), (error) => {
    assert.equal(error.code, "EXACT_FILE_OPEN_FAILED");
    assert.equal(error.message.includes(filename), false);
    return true;
  });
});

test("activation failure preserves prior authority and removes the random temporary", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "runtime.json");
  writeFileSync(filename, "prior", "utf8");
  const failedActivation = createExactFileAuthority({
    renameSync() {
      const error = new Error("synthetic activation failure");
      error.code = "EIO";
      throw error;
    },
  });
  requireCode(() => failedActivation.publishExactFileSync(filename, "replacement", {
    maximumBytes: 64,
    label: "Runtime status",
  }), "EXACT_FILE_ACTIVATION_FAILED");
  assert.equal(readFileSync(filename, "utf8"), "prior");
  assert.deepEqual(readdirSync(root), ["runtime.json"]);
});

test("sync and cleanup failures remain typed without activating partial authority", (t) => {
  const root = workspace(t);
  const filename = path.join(root, "profile.json");
  const failedSync = createExactFileAuthority({
    fsyncSync() {
      const error = new Error("synthetic sync failure");
      error.code = "EIO";
      throw error;
    },
  });
  requireCode(() => failedSync.publishExactFileSync(filename, "candidate", {
    maximumBytes: 64,
    label: "Profile",
  }), "EXACT_FILE_WRITE_FAILED");
  assert.deepEqual(readdirSync(root), []);

  const failedCleanup = createExactFileAuthority({
    writeSync() {
      const error = new Error("synthetic write failure");
      error.code = "EIO";
      throw error;
    },
    unlinkSync() {
      const error = new Error("synthetic cleanup failure");
      error.code = "EIO";
      throw error;
    },
  });
  requireCode(() => failedCleanup.publishExactFileSync(filename, "candidate", {
    maximumBytes: 64,
    label: "Profile",
  }), "EXACT_FILE_OPERATION_AND_CLEANUP_FAILED");
  assert.equal(readdirSync(root).length, 1);
});
