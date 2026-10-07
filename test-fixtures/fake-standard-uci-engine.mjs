#!/usr/bin/env node

import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const delayOption = process.argv.indexOf("--uci-delay-ms");
const uciDelayMs = delayOption >= 0 ? Number(process.argv[delayOption + 1]) : 0;
const bookResolution = process.argv.includes("--book-resolution");

if (!Number.isSafeInteger(uciDelayMs) || uciDelayMs < 0 || uciDelayMs > 10_000) {
  throw new Error("--uci-delay-ms must be an integer from 0 through 10000");
}

function reply(line) {
  process.stdout.write(`${line}\n`);
}

input.on("line", (line) => {
  const command = line.trim();
  if (command === "uci") {
    setTimeout(() => {
      reply("id name UCI Arena Conforming Fixture");
      reply("id author UCI Arena tests");
      reply("uciok");
    }, uciDelayMs);
  } else if (command === "isready") {
    reply("readyok");
  } else if (command.startsWith("go ")) {
    reply("info depth 1 nodes 1 time 1");
    if (bookResolution) reply("info string time_completion_kind opening_book book_move_used 1");
    reply("bestmove e2e4");
  } else if (command === "quit") {
    input.close();
  }
});

input.on("close", () => {
  process.exitCode = 0;
});
