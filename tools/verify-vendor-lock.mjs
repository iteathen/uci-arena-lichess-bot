#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, "vendor");
const lockPath = path.join(vendor, "upstream.lock.json");
const textExtensions = new Set([".cpp", ".h", ".json", ".md", ".mjs", ".txt", ".yaml", ".yml"]);

function canonicalBytes(name, bytes) {
  if (path.posix.basename(name) !== "CMakeLists.txt"
      && !textExtensions.has(path.posix.extname(name))) return bytes;
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}

function walk(directory, relative = "") {
  const rows = [];
  for (const name of readdirSync(directory).sort()) {
    if (!relative && name === "upstream.lock.json") continue;
    const child = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, name);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new Error(`vendor symlink is forbidden: ${child}`);
    if (entry.isDirectory()) rows.push(...walk(absolute, child));
    else if (entry.isFile()) rows.push(child.replaceAll("\\", "/"));
  }
  return rows;
}

const files = Object.fromEntries(walk(vendor).map((name) => [
  name,
  createHash("sha256")
    .update(canonicalBytes(name, readFileSync(path.join(vendor, name))))
    .digest("hex"),
]));

if (process.argv.includes("--write")) {
  writeFileSync(lockPath, `${JSON.stringify({
    schema: "uci_arena_upstream_vendor_lock_v1",
    source_repository: "iteathen/UCI_Arena",
    source_commit: "b7d5e8c011dc4a412bbf9c157835f0e2dc1cb56d",
    packages: { "@uci-arena/time-profile-contract": "1.1.0" },
    files,
  }, null, 2)}\n`);
  process.stdout.write(`wrote ${lockPath}\n`);
  process.exit(0);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (lock.schema !== "uci_arena_upstream_vendor_lock_v1"
    || lock.source_repository !== "iteathen/UCI_Arena"
    || lock.source_commit !== "b7d5e8c011dc4a412bbf9c157835f0e2dc1cb56d"
    || lock.packages?.["@uci-arena/time-profile-contract"] !== "1.1.0"
    || JSON.stringify(lock.files) !== JSON.stringify(files)) {
  throw new Error("vendored upstream package closure does not match its exact lock");
}
process.stdout.write("lichess-bot vendor lock: pass\n");
