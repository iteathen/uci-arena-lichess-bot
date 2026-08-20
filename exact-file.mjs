import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const MAX_PATH_BYTES = 32_768;
const STREAM_BUFFER_BYTES = 64 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const FILE_TYPE_MASK = constants.S_IFMT;

export class ExactFileError extends Error {
  constructor(code, label, reason, details = {}) {
    super(`${label} ${reason}`);
    this.name = "ExactFileError";
    this.code = code;
    Object.assign(this, details);
  }
}

function exactError(code, label, reason, details) {
  return new ExactFileError(code, label, reason, details);
}

function boundedPath(filename, label) {
  if (typeof filename !== "string" || !filename || filename.includes("\0")) {
    throw exactError("EXACT_FILE_PATH_INVALID", label, "path is invalid");
  }
  const resolved = path.resolve(filename);
  if (Buffer.byteLength(resolved, "utf8") > MAX_PATH_BYTES) {
    throw exactError("EXACT_FILE_PATH_INVALID", label, "path exceeds the supported bound");
  }
  return resolved;
}

function nativeIdentity(metadata) {
  return Object.freeze({
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
  });
}

function sameObject(left, right, { content = true } = {}) {
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & BigInt(FILE_TYPE_MASK)) === (right.mode & BigInt(FILE_TYPE_MASK))
    && (!content || (left.size === right.size
      && left.mtimeNs === right.mtimeNs
      && left.ctimeNs === right.ctimeNs));
}

function rawMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function lstatExact(io, filename, label) {
  try {
    return io.lstatSync(filename, { bigint: true });
  } catch (error) {
    if (rawMissing(error)) {
      throw exactError("EXACT_FILE_MISSING", label, "is unavailable");
    }
    throw exactError("EXACT_FILE_PATH_UNAVAILABLE", label, "path cannot be inspected");
  }
}

function validateAncestors(io, filename, label) {
  const root = path.parse(filename).root;
  const ancestors = [];
  let current = path.dirname(filename);
  while (current !== root && current !== path.dirname(current)) {
    ancestors.push(current);
    current = path.dirname(current);
  }
  for (const ancestor of ancestors.reverse()) {
    const metadata = lstatExact(io, ancestor, label);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw exactError("EXACT_FILE_ANCESTOR_INVALID", label, "has an unsafe path ancestor");
    }
  }
}

function validateRegular(metadata, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw exactError("EXACT_FILE_TYPE_INVALID", label, "is not a regular non-link file");
  }
}

function validatedMaximum(maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw exactError("EXACT_FILE_LIMIT_INVALID", label, "byte limit is invalid");
  }
  return BigInt(maximumBytes);
}

function closeOwned(io, descriptor, label, primaryError) {
  try {
    io.closeSync(descriptor);
  } catch {
    if (primaryError) {
      throw exactError(
        "EXACT_FILE_OPERATION_AND_CLOSE_FAILED",
        label,
        "operation and descriptor close both failed",
        { primaryCode: primaryError.code ?? "EXACT_FILE_OPERATION_FAILED" },
      );
    }
    throw exactError("EXACT_FILE_CLOSE_FAILED", label, "descriptor close failed");
  }
  if (primaryError) throw primaryError;
}

function openExact(io, filename, label, maximumBytes, hooks = {}) {
  const resolved = boundedPath(filename, label);
  validateAncestors(io, resolved, label);
  const before = lstatExact(io, resolved, label);
  validateRegular(before, label);
  const maximum = validatedMaximum(maximumBytes, label);
  if (before.size > maximum) {
    throw exactError("EXACT_FILE_TOO_LARGE", label, `exceeds ${maximumBytes} bytes`);
  }
  hooks.afterPathAdmission?.({ filename: resolved, identity: nativeIdentity(before) });

  let descriptor;
  try {
    descriptor = io.openSync(resolved, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    throw exactError("EXACT_FILE_OPEN_FAILED", label, "could not be opened safely");
  }
  try {
    const opened = io.fstatSync(descriptor, { bigint: true });
    validateRegular(opened, label);
    if (!sameObject(before, opened)) {
      throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed during admission");
    }
    hooks.afterOpen?.({ filename: resolved, descriptor, identity: nativeIdentity(opened) });
    return { resolved, descriptor, before, opened, maximum };
  } catch (error) {
    closeOwned(io, descriptor, label, error);
    throw error;
  }
}

function finishExactRead(io, state, label, hooks, primaryError = null) {
  let failure = primaryError;
  if (!failure) {
    try {
      hooks.beforePostReadValidation?.({
        filename: state.resolved,
        descriptor: state.descriptor,
      });
      if (state.contentBytes) {
        const verification = Buffer.allocUnsafe(state.contentBytes.length);
        let offset = 0;
        try {
          while (offset < verification.length) {
            const count = io.readSync(
              state.descriptor,
              verification,
              offset,
              verification.length - offset,
              offset,
            );
            if (count === 0) {
              throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "content changed during use");
            }
            offset += count;
          }
          const overflow = Buffer.allocUnsafe(1);
          if (io.readSync(state.descriptor, overflow, 0, 1, offset) !== 0
              || !timingSafeEqual(verification, state.contentBytes)) {
            throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "content changed during use");
          }
        } finally {
          verification.fill(0);
          state.contentBytes.fill(0);
        }
      }
      if (state.contentSha256) {
        const verification = createHash("sha256");
        const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
        let offset = 0;
        while (true) {
          const count = io.readSync(state.descriptor, buffer, 0, buffer.length, offset);
          if (count === 0) break;
          offset += count;
          verification.update(buffer.subarray(0, count));
        }
        if (BigInt(offset) !== state.opened.size
            || `sha256:${verification.digest("hex")}` !== state.contentSha256) {
          throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "content changed during use");
        }
      }
      const descriptorAfter = io.fstatSync(state.descriptor, { bigint: true });
      validateAncestors(io, state.resolved, label);
      const pathAfter = lstatExact(io, state.resolved, label);
      validateRegular(descriptorAfter, label);
      validateRegular(pathAfter, label);
      if (!sameObject(state.opened, descriptorAfter)
          || !sameObject(descriptorAfter, pathAfter)) {
        throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed during use");
      }
      state.finalMetadata = descriptorAfter;
    } catch (error) {
      failure = error instanceof ExactFileError
        ? error
        : exactError("EXACT_FILE_POST_READ_FAILED", label, "could not be revalidated");
    }
  }
  closeOwned(io, state.descriptor, label, failure);
}

function readComplete(io, state, label) {
  const expectedBytes = Number(state.opened.size);
  const bytes = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < bytes.length) {
    const count = io.readSync(state.descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) {
      throw exactError("EXACT_FILE_TRUNCATED", label, "was truncated during use");
    }
    offset += count;
  }
  const overflow = Buffer.allocUnsafe(1);
  if (io.readSync(state.descriptor, overflow, 0, 1, offset) !== 0) {
    throw exactError("EXACT_FILE_GREW", label, "grew during use");
  }
  return bytes;
}

const defaultIo = Object.freeze({
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
});

export function createExactFileAuthority(overrides = {}) {
  const io = { ...defaultIo, ...overrides };

  function admitExactDirectorySync(directory, {
    label = "Directory",
  } = {}) {
    const resolved = boundedPath(directory, label);
    validateAncestors(io, path.join(resolved, ".authority-target"), label);
    const before = lstatExact(io, resolved, label);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw exactError("EXACT_FILE_ANCESTOR_INVALID", label, "is not a safe directory");
    }
    const after = lstatExact(io, resolved, label);
    if (!sameObject(before, after)) {
      throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed during admission");
    }
    return Object.freeze({ resolved, identity: nativeIdentity(after) });
  }

  function classifyExactPathSync(filename, {
    label = "Path",
  } = {}) {
    const resolved = boundedPath(filename, label);
    try {
      validateAncestors(io, resolved, label);
    } catch (error) {
      if (error?.code === "EXACT_FILE_MISSING") {
        return Object.freeze({ kind: "missing", resolved });
      }
      throw error;
    }
    let before;
    try {
      before = io.lstatSync(resolved, { bigint: true });
    } catch (error) {
      if (rawMissing(error)) return Object.freeze({ kind: "missing", resolved });
      throw exactError("EXACT_FILE_PATH_UNAVAILABLE", label, "cannot be inspected");
    }
    if (before.isSymbolicLink()) {
      throw exactError("EXACT_FILE_TYPE_INVALID", label, "may not be a link");
    }
    const after = lstatExact(io, resolved, label);
    if (!sameObject(before, after)) {
      throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed during classification");
    }
    const kind = after.isFile() ? "file" : after.isDirectory() ? "directory" : "other";
    return Object.freeze({ kind, resolved, identity: nativeIdentity(after) });
  }

  function admitExactFileSync(filename, {
    maximumBytes,
    label = "File",
    hooks = {},
  }) {
    const state = openExact(io, filename, label, maximumBytes, hooks);
    finishExactRead(io, state, label, hooks);
    return Object.freeze({
      filename: state.resolved,
      byteLength: Number(state.finalMetadata.size),
      identity: nativeIdentity(state.finalMetadata),
    });
  }

  function readExactFileSync(filename, {
    maximumBytes,
    label = "File",
    sensitive = false,
    hooks = {},
  }) {
    const state = openExact(io, filename, label, maximumBytes, hooks);
    let bytes;
    let failure = null;
    try {
      bytes = readComplete(io, state, label);
      if (sensitive) state.contentBytes = Buffer.from(bytes);
      else state.contentSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    } catch (error) {
      failure = error instanceof ExactFileError
        ? error
        : exactError("EXACT_FILE_READ_FAILED", label, "could not be read");
    }
    finishExactRead(io, state, label, hooks, failure);
    return Object.freeze({
      bytes,
      byteLength: bytes.length,
      identity: nativeIdentity(state.finalMetadata),
      sha256: sensitive ? undefined : state.contentSha256,
    });
  }

  function readExactTextSync(filename, options) {
    const result = readExactFileSync(filename, options);
    return Object.freeze({ ...result, text: result.bytes.toString("utf8") });
  }

  function readExactJsonSync(filename, options) {
    const result = readExactTextSync(filename, options);
    try {
      return Object.freeze({ ...result, value: JSON.parse(result.text) });
    } catch {
      throw exactError("EXACT_FILE_JSON_INVALID", options?.label ?? "JSON file", "contains invalid JSON");
    }
  }

  function hashExactFileSync(filename, {
    maximumBytes,
    label = "File",
    hooks = {},
    capturePrefixBytes = 0,
  }) {
    if (!Number.isSafeInteger(capturePrefixBytes) || capturePrefixBytes < 0
        || capturePrefixBytes > STREAM_BUFFER_BYTES) {
      throw exactError("EXACT_FILE_LIMIT_INVALID", label, "prefix byte limit is invalid");
    }
    const state = openExact(io, filename, label, maximumBytes, hooks);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STREAM_BUFFER_BYTES);
    const prefix = Buffer.allocUnsafe(Math.min(capturePrefixBytes, Number(state.opened.size)));
    let offset = 0;
    let failure = null;
    try {
      while (true) {
        const count = io.readSync(state.descriptor, buffer, 0, buffer.length, offset);
        if (count === 0) break;
        offset += count;
        if (BigInt(offset) > state.maximum) {
          throw exactError("EXACT_FILE_TOO_LARGE", label, `exceeds ${maximumBytes} bytes`);
        }
        if (offset - count < prefix.length) {
          const start = offset - count;
          const copied = Math.min(count, prefix.length - start);
          buffer.copy(prefix, start, 0, copied);
        }
        digest.update(buffer.subarray(0, count));
      }
      if (BigInt(offset) !== state.opened.size) {
        throw exactError("EXACT_FILE_SIZE_CHANGED", label, "changed size during hashing");
      }
    } catch (error) {
      failure = error instanceof ExactFileError
        ? error
        : exactError("EXACT_FILE_READ_FAILED", label, "could not be hashed");
    }
    const sha256 = failure ? null : `sha256:${digest.digest("hex")}`;
    state.contentSha256 = sha256;
    finishExactRead(io, state, label, hooks, failure);
    return Object.freeze({
      sha256,
      byteLength: offset,
      identity: nativeIdentity(state.finalMetadata),
      prefix,
    });
  }

  function exactFileMetadataSync(filename, {
    maximumBytes,
    label = "File",
    hooks = {},
  }) {
    const result = hashExactFileSync(filename, { maximumBytes, label, hooks });
    return Object.freeze({
      byteLength: result.byteLength,
      sha256: result.sha256,
      identity: result.identity,
    });
  }

  function ensureExactDirectorySync(directory, label = "Publication directory") {
    const resolved = boundedPath(directory, label);
    const root = path.parse(resolved).root;
    const missing = [];
    let current = resolved;
    while (current !== root) {
      try {
        const metadata = io.lstatSync(current, { bigint: true });
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw exactError("EXACT_FILE_ANCESTOR_INVALID", label, "is not a safe directory");
        }
        break;
      } catch (error) {
        if (error instanceof ExactFileError) throw error;
        if (!rawMissing(error)) {
          throw exactError("EXACT_FILE_PATH_UNAVAILABLE", label, "cannot be inspected");
        }
        missing.push(current);
        current = path.dirname(current);
      }
    }
    validateAncestors(io, current === root ? path.join(root, ".") : current, label);
    for (const candidate of missing.reverse()) {
      try {
        io.mkdirSync(candidate, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw exactError("EXACT_FILE_DIRECTORY_CREATE_FAILED", label, "could not be created");
        }
      }
      const metadata = lstatExact(io, candidate, label);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw exactError("EXACT_FILE_ANCESTOR_INVALID", label, "is not a safe directory");
      }
    }
    validateAncestors(io, path.join(resolved, ".authority-target"), label);
    return resolved;
  }

  function targetState(filename, label) {
    try {
      const metadata = io.lstatSync(filename, { bigint: true });
      validateRegular(metadata, label);
      return metadata;
    } catch (error) {
      if (error instanceof ExactFileError) throw error;
      if (rawMissing(error)) return null;
      throw exactError("EXACT_FILE_PATH_UNAVAILABLE", label, "target cannot be inspected");
    }
  }

  function removeOwnedTemporary(filename, expected, label) {
    try {
      const observed = io.lstatSync(filename, { bigint: true });
      if (sameObject(expected, observed, { content: false })) io.unlinkSync(filename);
    } catch (error) {
      if (!rawMissing(error)) {
        throw exactError("EXACT_FILE_CLEANUP_FAILED", label, "temporary cleanup failed");
      }
    }
  }

  function matchesNativeIdentity(metadata, expected, { content = true } = {}) {
    if (!expected) return false;
    const observed = nativeIdentity(metadata);
    return observed.dev === expected.dev
      && observed.ino === expected.ino
      && observed.mode === expected.mode
      && (!content || (observed.size === expected.size
        && observed.mtimeNs === expected.mtimeNs
        && observed.ctimeNs === expected.ctimeNs));
  }

  function syncParentDirectory(directory) {
    if (process.platform === "win32") return;
    let descriptor;
    try {
      descriptor = io.openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      io.fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) io.closeSync(descriptor);
    }
  }

  function publishExactFileSync(filename, bytes, {
    maximumBytes,
    label = "Published file",
    durable = true,
    expectedTargetIdentity,
    hooks = {},
  }) {
    const resolved = boundedPath(filename, label);
    const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0
        || payload.length > maximumBytes) {
      throw exactError("EXACT_FILE_TOO_LARGE", label, `exceeds ${maximumBytes} bytes`);
    }
    const directory = ensureExactDirectorySync(path.dirname(resolved), `${label} directory`);
    const before = targetState(resolved, label);
    if (expectedTargetIdentity !== undefined
        && (!before || !matchesNativeIdentity(before, expectedTargetIdentity))) {
      throw exactError("EXACT_FILE_TARGET_CHANGED", label, "target changed before publication");
    }
    let temporary;
    let descriptor;
    let temporaryIdentity;
    let primaryError = null;
    for (let attempt = 0; attempt < 16 && descriptor === undefined; attempt += 1) {
      temporary = path.join(
        directory,
        `.${path.basename(resolved)}.${randomBytes(16).toString("hex")}.tmp`,
      );
      try {
        descriptor = io.openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw exactError("EXACT_FILE_TEMP_CREATE_FAILED", label, "temporary file creation failed");
        }
      }
    }
    if (descriptor === undefined) {
      throw exactError("EXACT_FILE_TEMP_CREATE_FAILED", label, "could not allocate a private temporary file");
    }
    try {
      temporaryIdentity = io.fstatSync(descriptor, { bigint: true });
      validateRegular(temporaryIdentity, label);
      let offset = 0;
      while (offset < payload.length) {
        const count = io.writeSync(descriptor, payload, offset, payload.length - offset, offset);
        if (count <= 0) throw exactError("EXACT_FILE_WRITE_FAILED", label, "write made no progress");
        offset += count;
      }
      if (durable) io.fsyncSync(descriptor);
      const writtenIdentity = io.fstatSync(descriptor, { bigint: true });
      validateRegular(writtenIdentity, label);
      if (!sameObject(temporaryIdentity, writtenIdentity, { content: false })
          || writtenIdentity.size !== BigInt(payload.length)) {
        throw exactError("EXACT_FILE_WRITE_FAILED", label, "temporary byte count is incorrect");
      }
      temporaryIdentity = writtenIdentity;
    } catch (error) {
      primaryError = error instanceof ExactFileError
        ? error
        : exactError("EXACT_FILE_WRITE_FAILED", label, "temporary publication failed");
    }
    try {
      closeOwned(io, descriptor, label, primaryError);
    } catch (error) {
      primaryError = error;
    }
    if (primaryError) {
      try {
        if (temporaryIdentity) removeOwnedTemporary(temporary, temporaryIdentity, label);
      } catch {
        throw exactError(
          "EXACT_FILE_OPERATION_AND_CLEANUP_FAILED",
          label,
          "publication and temporary cleanup both failed",
          { primaryCode: primaryError.code ?? "EXACT_FILE_WRITE_FAILED" },
        );
      }
      throw primaryError;
    }

    try {
      hooks.beforeActivation?.({ filename: resolved, temporary });
    } catch (error) {
      try {
        removeOwnedTemporary(temporary, temporaryIdentity, label);
      } catch {
        throw exactError(
          "EXACT_FILE_OPERATION_AND_CLEANUP_FAILED",
          label,
          "publication validation and temporary cleanup both failed",
          { primaryCode: error?.code ?? "EXACT_FILE_VALIDATION_FAILED" },
        );
      }
      throw error;
    }

    try {
      validateAncestors(io, resolved, label);
      const current = targetState(resolved, label);
      if ((before === null) !== (current === null)
          || (before && !sameObject(before, current))) {
        throw exactError("EXACT_FILE_TARGET_CHANGED", label, "target changed before activation");
      }
      io.renameSync(temporary, resolved);
      const activated = lstatExact(io, resolved, label);
      validateRegular(activated, label);
      if (!sameObject(temporaryIdentity, activated, { content: false })
          || temporaryIdentity.size !== activated.size) {
        throw exactError("EXACT_FILE_ACTIVATION_FAILED", label, "activated identity is incorrect");
      }
      if (durable) syncParentDirectory(directory);
      return Object.freeze({
        byteLength: payload.length,
        identity: nativeIdentity(activated),
      });
    } catch (error) {
      const activationError = error instanceof ExactFileError
        ? error
        : exactError("EXACT_FILE_ACTIVATION_FAILED", label, "activation failed");
      try {
        removeOwnedTemporary(temporary, temporaryIdentity, label);
      } catch {
        throw exactError(
          "EXACT_FILE_OPERATION_AND_CLEANUP_FAILED",
          label,
          "activation and temporary cleanup both failed",
          { primaryCode: activationError.code },
        );
      }
      throw activationError;
    }
  }

  function publishExactJsonSync(filename, value, options) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    return publishExactFileSync(filename, bytes, options);
  }

  function createExactTemporaryFileSync(directory, prefix, bytes, options) {
    const resolvedDirectory = ensureExactDirectorySync(directory, `${options?.label ?? "Temporary file"} directory`);
    const safePrefix = String(prefix ?? "temporary").replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const filename = path.join(
        resolvedDirectory,
        `.${safePrefix}.${randomBytes(16).toString("hex")}.tmp`,
      );
      try {
        const published = publishExactFileSync(filename, bytes, options);
        return Object.freeze({ filename, ...published });
      } catch (error) {
        if (error?.code !== "EXACT_FILE_TARGET_CHANGED") throw error;
      }
    }
    throw exactError(
      "EXACT_FILE_TEMP_CREATE_FAILED",
      options?.label ?? "Temporary file",
      "could not allocate a private temporary file",
    );
  }

  function removeExactPublishedFileSync(filename, expectedIdentity, {
    label = "Published file",
  } = {}) {
    const resolved = boundedPath(filename, label);
    validateAncestors(io, resolved, label);
    let metadata;
    try {
      metadata = io.lstatSync(resolved, { bigint: true });
    } catch (error) {
      if (rawMissing(error)) return false;
      throw exactError("EXACT_FILE_PATH_UNAVAILABLE", label, "cannot be inspected for removal");
    }
    validateRegular(metadata, label);
    if (!matchesNativeIdentity(metadata, expectedIdentity)) {
      throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed before removal");
    }
    io.unlinkSync(resolved);
    return true;
  }

  function createExactTemporaryDirectorySync(directory, prefix, {
    label = "Temporary directory",
  } = {}) {
    const parent = ensureExactDirectorySync(directory, `${label} parent`);
    const safePrefix = String(prefix ?? "temporary").replaceAll(/[^A-Za-z0-9_.-]/gu, "_");
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const temporary = path.join(parent, `.${safePrefix}.${randomBytes(16).toString("hex")}.tmp`);
      try {
        io.mkdirSync(temporary, { mode: 0o700 });
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw exactError("EXACT_FILE_DIRECTORY_CREATE_FAILED", label, "could not be created");
      }
      const metadata = lstatExact(io, temporary, label);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw exactError("EXACT_FILE_ANCESTOR_INVALID", label, "is not a safe directory");
      }
      return Object.freeze({
        directory: temporary,
        identity: nativeIdentity(metadata),
      });
    }
    throw exactError("EXACT_FILE_TEMP_CREATE_FAILED", label, "could not allocate a private directory");
  }

  function activateExactDirectorySync(temporary, target, expectedIdentity, {
    label = "Published directory",
  } = {}) {
    const resolvedTemporary = boundedPath(temporary, label);
    const resolvedTarget = boundedPath(target, label);
    if (path.dirname(resolvedTemporary) !== path.dirname(resolvedTarget)
        || resolvedTemporary === resolvedTarget) {
      throw exactError("EXACT_FILE_PATH_INVALID", label, "activation target is invalid");
    }
    validateAncestors(io, resolvedTarget, label);
    const staged = lstatExact(io, resolvedTemporary, label);
    if (!staged.isDirectory() || staged.isSymbolicLink()
        || !matchesNativeIdentity(staged, expectedIdentity, { content: false })) {
      throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed before activation");
    }
    try {
      io.lstatSync(resolvedTarget, { bigint: true });
      throw exactError("EXACT_FILE_TARGET_CHANGED", label, "target already exists");
    } catch (error) {
      if (error instanceof ExactFileError) throw error;
      if (!rawMissing(error)) {
        throw exactError("EXACT_FILE_PATH_UNAVAILABLE", label, "target cannot be inspected");
      }
    }
    io.renameSync(resolvedTemporary, resolvedTarget);
    const activated = lstatExact(io, resolvedTarget, label);
    if (!activated.isDirectory() || activated.isSymbolicLink()
        || !matchesNativeIdentity(activated, expectedIdentity, { content: false })) {
      throw exactError("EXACT_FILE_ACTIVATION_FAILED", label, "activated identity is incorrect");
    }
    syncParentDirectory(path.dirname(resolvedTarget));
    return Object.freeze({ directory: resolvedTarget, identity: nativeIdentity(activated) });
  }

  function removeExactDirectorySync(directory, expectedIdentity, {
    label = "Published directory",
  } = {}) {
    const resolved = boundedPath(directory, label);
    validateAncestors(io, path.join(resolved, ".authority-target"), label);
    let metadata;
    try {
      metadata = io.lstatSync(resolved, { bigint: true });
    } catch (error) {
      if (rawMissing(error)) return false;
      throw exactError("EXACT_FILE_PATH_UNAVAILABLE", label, "cannot be inspected for removal");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || !matchesNativeIdentity(metadata, expectedIdentity, { content: false })) {
      throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed before removal");
    }
    io.rmdirSync(resolved);
    return true;
  }

  function appendExactFileSync(filename, bytes, {
    maximumFileBytes,
    label = "Append file",
  }) {
    const resolved = boundedPath(filename, label);
    const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
    const directory = ensureExactDirectorySync(path.dirname(resolved), `${label} directory`);
    validateAncestors(io, path.join(directory, path.basename(resolved)), label);
    let before = targetState(resolved, label);
    let descriptor;
    try {
      descriptor = before
        ? io.openSync(resolved, constants.O_WRONLY | constants.O_APPEND | NO_FOLLOW)
        : io.openSync(
          resolved,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
    } catch {
      throw exactError("EXACT_FILE_OPEN_FAILED", label, "could not be opened safely");
    }
    let failure = null;
    try {
      const opened = io.fstatSync(descriptor, { bigint: true });
      validateRegular(opened, label);
      if (before && !sameObject(before, opened)) {
        throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed before append");
      }
      if (!before) before = opened;
      if (opened.size + BigInt(payload.length) > BigInt(maximumFileBytes)) {
        throw exactError("EXACT_FILE_TOO_LARGE", label, "would exceed its byte bound");
      }
      let offset = 0;
      while (offset < payload.length) {
        const count = io.writeSync(descriptor, payload, offset, payload.length - offset);
        if (count <= 0) throw exactError("EXACT_FILE_WRITE_FAILED", label, "append made no progress");
        offset += count;
      }
      const after = io.fstatSync(descriptor, { bigint: true });
      const pathAfter = lstatExact(io, resolved, label);
      if (!sameObject(after, pathAfter)) {
        throw exactError("EXACT_FILE_IDENTITY_CHANGED", label, "changed during append");
      }
    } catch (error) {
      failure = error instanceof ExactFileError
        ? error
        : exactError("EXACT_FILE_WRITE_FAILED", label, "append failed");
    }
    closeOwned(io, descriptor, label, failure);
  }

  function rotateExactFileSync(filename, previousFilename, {
    maximumFileBytes,
    label = "Rotated file",
  }) {
    const resolved = boundedPath(filename, label);
    const previous = boundedPath(previousFilename, label);
    if (path.dirname(resolved) !== path.dirname(previous) || resolved === previous) {
      throw exactError("EXACT_FILE_PATH_INVALID", label, "rotation target is invalid");
    }
    validateAncestors(io, resolved, label);
    const active = targetState(resolved, label);
    if (!active) return false;
    if (active.size > BigInt(maximumFileBytes)) {
      throw exactError("EXACT_FILE_TOO_LARGE", label, "exceeds its byte bound");
    }
    const retained = targetState(previous, label);
    if (retained) {
      const currentRetained = targetState(previous, label);
      if (!sameObject(retained, currentRetained)) {
        throw exactError("EXACT_FILE_TARGET_CHANGED", label, "retained target changed");
      }
      io.unlinkSync(previous);
    }
    const currentActive = targetState(resolved, label);
    if (!currentActive || !sameObject(active, currentActive)) {
      throw exactError("EXACT_FILE_TARGET_CHANGED", label, "active file changed before rotation");
    }
    if (targetState(previous, label) !== null) {
      throw exactError("EXACT_FILE_TARGET_CHANGED", label, "rotation target appeared");
    }
    io.renameSync(resolved, previous);
    const activated = lstatExact(io, previous, label);
    if (!sameObject(active, activated, { content: false }) || active.size !== activated.size) {
      throw exactError("EXACT_FILE_ACTIVATION_FAILED", label, "rotated identity is incorrect");
    }
    return true;
  }

  return Object.freeze({
    activateExactDirectorySync,
    admitExactDirectorySync,
    admitExactFileSync,
    appendExactFileSync,
    classifyExactPathSync,
    createExactTemporaryDirectorySync,
    createExactTemporaryFileSync,
    ensureExactDirectorySync,
    exactFileMetadataSync,
    hashExactFileSync,
    publishExactFileSync,
    publishExactJsonSync,
    readExactFileSync,
    readExactJsonSync,
    readExactTextSync,
    removeExactDirectorySync,
    removeExactPublishedFileSync,
    rotateExactFileSync,
  });
}

export const exactFiles = createExactFileAuthority();
export const {
  activateExactDirectorySync,
  admitExactDirectorySync,
  admitExactFileSync,
  appendExactFileSync,
  classifyExactPathSync,
  createExactTemporaryDirectorySync,
  createExactTemporaryFileSync,
  ensureExactDirectorySync,
  exactFileMetadataSync,
  hashExactFileSync,
  publishExactFileSync,
  publishExactJsonSync,
  readExactFileSync,
  readExactJsonSync,
  readExactTextSync,
  removeExactDirectorySync,
  removeExactPublishedFileSync,
  rotateExactFileSync,
} = exactFiles;
