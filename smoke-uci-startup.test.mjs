import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_TEMPLATE } from "./lichess-adapter.mjs";
import { smoke } from "./smoke-uci-startup.mjs";

test("packaged UCI smoke honors the standard adapter and literal engine arguments", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-standard-smoke-"));
  const fixtureEngine = path.join(directory, "fixture-uci.mjs");
  writeFileSync(fixtureEngine, `
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line === "uci") {
    console.log("id name Smoke Contract Fixture");
    console.log("uciok");
  } else if (line === "isready") console.log("readyok");
  else if (line.startsWith("go ")) console.log("bestmove e2e4");
  else if (line === "stop") console.log("bestmove 0000");
  else if (line === "quit") process.exit(0);
}
`, "utf8");
  const configPath = path.join(directory, "config.json");
  const config = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  config.engine = {
    adapter: "standard_uci_v1",
    executable: process.execPath,
    arguments: [fixtureEngine],
    working_directory: directory,
    uci_options: {},
  };
  config.capacity = {
    total_slots: 1,
    capacity_profile: null,
    startup_parallelism: 1,
    human: { slots: 1, allow_borrowing: false, accept_public: true },
    bot: { slots: 0, target_active: 0 },
  };
  config.scheduler.enabled = false;
  writeFileSync(configPath, JSON.stringify(config), "utf8");

  const result = await smoke({
    template: configPath,
    engineRoot: directory,
    depth: 2,
    timeoutMs: 5_000,
  });
  assert.equal(result.engine_adapter, "standard_uci_v1");
  assert.equal(result.bestmove, "e2e4");
  assert.equal(result.depth, 2);
  assert.equal(result.opening_book_active, false);
  assert.equal(result.syzygy_active, false);
});
