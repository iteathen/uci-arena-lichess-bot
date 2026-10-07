#!/usr/bin/env node

import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const delayOption = process.argv.indexOf("--uci-delay-ms");
const uciDelayMs = delayOption >= 0 ? Number(process.argv[delayOption + 1]) : 0;
const bookResolution = process.argv.includes("--book-resolution");
const retentionTelemetry = process.argv.includes("--retention-telemetry");

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
    if (retentionTelemetry) reply("info string mcgs_graph_node_capacity 96 mcgs_graph_edge_capacity 2048 mcgs_graph_evictions 17 mcgs_graph_reclaimed_edges 153 mcgs_graph_reclaimed_spans 11 mcgs_graph_span_coalesces 5 mcgs_graph_capacity_deferrals 2 mcgs_graph_stale_handles 3 mcgs_graph_focus_admissions 9 mcgs_graph_focus_fallbacks 1 mcgs_explicit_reroots 0");
    if (bookResolution) reply("info string time_completion_kind opening_book book_move_used 1");
    reply("bestmove e2e4");
  } else if (command === "quit") {
    input.close();
  }
});

input.on("close", () => {
  process.exitCode = 0;
});
