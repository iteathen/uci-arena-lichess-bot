#!/usr/bin/env node

import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function reply(line) {
  process.stdout.write(`${line}\n`);
}

input.on("line", (line) => {
  const command = line.trim();
  if (command === "uci") {
    reply("id name UCI Arena Conforming Fixture");
    reply("id author UCI Arena tests");
    reply("uciok");
  } else if (command === "isready") {
    reply("readyok");
  } else if (command.startsWith("go ")) {
    reply("info depth 1 nodes 1 time 1");
    reply("bestmove e2e4");
  } else if (command === "quit") {
    input.close();
  }
});

input.on("close", () => {
  process.exitCode = 0;
});
