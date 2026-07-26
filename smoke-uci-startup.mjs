#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TEMPLATE, ROOT, loadRuntimeConfig } from "./lichess-adapter.mjs";

function parseArguments(argv) {
  const options = { template: DEFAULT_TEMPLATE, repoRoot: ROOT, depth: 1, timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key}`);
    if (key === "--config") options.template = value;
    else if (key === "--repo-root") options.repoRoot = value;
    else if (key === "--depth") options.depth = Number(value);
    else if (key === "--timeout") options.timeoutMs = Number(value) * 1000;
    else throw new Error(`Unknown argument: ${key}`);
  }
  return options;
}

async function readUntil(iterator, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const lines = [];
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer;
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("UCI smoke timed out")), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (next.done) throw new Error("UCI engine exited before expected response");
    lines.push(next.value);
    if (predicate(next.value)) return lines;
  }
  throw new Error("UCI smoke timed out");
}

export async function smoke(options) {
  const config = loadRuntimeConfig({ templatePath: path.resolve(options.template), repoRoot: options.repoRoot });
  const executable = config.engine.executable;
  const child = spawn(executable, [], {
    cwd: config.engine.working_directory,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const send = (text) => child.stdin.write(`${text}\n`);
  try {
    send("uci");
    const uciLines = await readUntil(iterator, (line) => line === "uciok", options.timeoutMs);
    const advertised = new Set(
      uciLines.filter((line) => line.startsWith("option name ") && line.includes(" type "))
        .map((line) => line.slice("option name ".length).split(" type ", 1)[0]),
    );
    const unknown = Object.keys(config.engine.uci_options).filter((name) => !advertised.has(name));
    if (unknown.length) throw new Error(`Template lists unadvertised UCI options: ${unknown.join(", ")}`);
    for (const [name, value] of Object.entries(config.engine.uci_options)) {
      send(`setoption name ${name} value ${String(value)}`);
    }
    send("isready");
    await readUntil(iterator, (line) => line === "readyok", options.timeoutMs);
    send("runtime_status");
    const runtimeStatusPrefix = "info string runtime_status_v1 ";
    const runtimeStatusLines = await readUntil(
      iterator,
      (line) => line.startsWith(runtimeStatusPrefix),
      options.timeoutMs,
    );
    const runtimeStatusLine = runtimeStatusLines.at(-1);
    const runtimeStatus = JSON.parse(
      runtimeStatusLine.slice(runtimeStatusPrefix.length),
    );
    if (Object.hasOwn(config.engine.uci_options, "BookFile")
        && runtimeStatus.opening_book_active !== true) {
      throw new Error(
        `Configured opening book is not active: ${runtimeStatus.opening_book_message ?? "unknown"}`,
      );
    }
    if (Object.hasOwn(config.engine.uci_options, "SyzygyPath")
        && runtimeStatus.syzygy_active !== true) {
      throw new Error(
        `Configured Syzygy tablebases are not active: ${runtimeStatus.syzygy_message ?? "unknown"}`,
      );
    }
    send("ucinewgame");
    send("position startpos");
    send(`go depth ${options.depth}`);
    const bestmoveLines = await readUntil(iterator, (line) => line.startsWith("bestmove "), options.timeoutMs);
    const bestmove = bestmoveLines.at(-1).split(/\s+/)[1];
    if (!bestmove || bestmove === "0000") throw new Error("Engine returned no usable bestmove");
    return {
      schema: "uci_arena_lichess_adapter_smoke_v3",
      engine: executable,
      working_directory: config.engine.working_directory,
      depth: options.depth,
      bestmove,
      advertised_option_count: advertised.size,
      applied_uci_options: Object.keys(config.engine.uci_options).sort(),
      opening_book_active: runtimeStatus.opening_book_active === true,
      opening_book_entries: Number(runtimeStatus.opening_book_entries ?? 0),
      syzygy_active: runtimeStatus.syzygy_active === true,
      syzygy_loaded_cardinality: Number(
        runtimeStatus.syzygy_loaded_cardinality ?? 0,
      ),
    };
  } finally {
    send("quit");
    child.kill();
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  smoke(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(`smoke-uci-startup: ${error.message}`);
    process.exitCode = 1;
  });
}
