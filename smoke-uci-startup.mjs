#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_TEMPLATE,
  ROOT,
  UciEngine,
  applySingleGameProfile,
  loadRuntimeConfig,
} from "./lichess-adapter.mjs";

function parseArguments(argv) {
  const options = { template: DEFAULT_TEMPLATE, engineRoot: ROOT, depth: 1, timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument: ${key}`);
    if (key === "--config") options.template = value;
    else if (key === "--engine-root") options.engineRoot = value;
    else if (key === "--depth") options.depth = Number(value);
    else if (key === "--timeout") options.timeoutMs = Number(value) * 1000;
    else throw new Error(`Unknown argument: ${key}`);
  }
  return options;
}

export async function smoke(options) {
  const config = loadRuntimeConfig({
    templatePath: path.resolve(options.template),
    engineRoot: options.engineRoot,
  });
  const extended = config.engine.adapter !== "standard_uci_v1";
  if (extended) applySingleGameProfile(config);
  const engine = new UciEngine(config.engine);
  try {
    await engine.start();
    if (extended && engine.timeProfileStatus?.accepted !== true) {
      throw new Error(
        `UCI Arena extended smoke rejected its timing profile: ${engine.timeProfileStatus?.reason ?? "unknown reason"}`,
      );
    }
    const probe = await engine.fixedDepthProbe(options.depth, options.timeoutMs);
    const runtimeStatus = engine.qualificationStatus?.live_runtime_status ?? {};
    return {
      schema: "uci_arena_lichess_adapter_smoke_v3",
      engine: config.engine.executable,
      engine_adapter: config.engine.adapter,
      working_directory: config.engine.working_directory,
      depth: options.depth,
      bestmove: probe.bestmove,
      advertised_option_count: engine.advertisedOptions.size,
      applied_uci_options: Object.keys(engine.appliedUciOptions).sort(),
      opening_book_active: runtimeStatus.opening_book_active === true,
      opening_book_entries: Number(runtimeStatus.opening_book_entries ?? 0),
      syzygy_active: runtimeStatus.syzygy_active === true,
      syzygy_loaded_cardinality: Number(
        runtimeStatus.syzygy_loaded_cardinality ?? 0,
      ),
    };
  } finally {
    await engine.close();
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
