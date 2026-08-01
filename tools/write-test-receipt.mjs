#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

const args = argumentsFrom(process.argv.slice(2));
if (!args.output || !/^(?:windows|linux)-x86_64$/u.test(args.target ?? "")) {
  throw new Error("usage: write-test-receipt --output <path> --target <windows-x86_64|linux-x86_64>");
}
const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
const tree = execFileSync("git", ["-C", root, "ls-tree", "-r", "--full-tree", "HEAD"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
let testExitCode = 0;
try {
  const adjacentNpmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const command = existsSync(adjacentNpmCli) ? process.execPath : "npm";
  const commandArguments = existsSync(adjacentNpmCli)
    ? [adjacentNpmCli, "run", "check"]
    : ["run", "check"];
  execFileSync(command, commandArguments, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
} catch (error) {
  testExitCode = Number.isSafeInteger(error?.status) ? error.status : 1;
}
const receipt = {
  schema: "uci_arena_component_test_receipt_v1",
  component_id: "lichess.adapter",
  component_version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
  target: args.target,
  source_commit: commit,
  source_tree_sha256: createHash("sha256").update(tree).digest("hex"),
  command: "npm run check",
  passed: testExitCode === 0,
  exit_code: testExitCode,
  recorded_at: new Date().toISOString(),
};
const target = path.resolve(args.output);
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
if (!receipt.passed) process.exit(receipt.exit_code);
process.stdout.write(`wrote ${target}\n`);
