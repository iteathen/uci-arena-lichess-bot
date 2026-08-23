import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { publishExactJsonSync } from "./exact-file.mjs";

if (!parentPort) throw new Error("Runtime status worker requires a parent port");

const target = String(workerData?.target ?? "");
const maximumBytes = Number(workerData?.maximumBytes);
const label = String(workerData?.label ?? "Lichess runtime status");

parentPort.on("message", ({ generation, snapshot }) => {
  try {
    const startedAt = performance.now();
    const published = publishExactJsonSync(target, snapshot, {
      maximumBytes,
      label,
    });
    parentPort.postMessage({
      generation,
      ok: true,
      byteLength: published.byteLength,
      activatedAt: Date.now(),
      writeDurationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    });
  } catch (error) {
    parentPort.postMessage({
      generation,
      ok: false,
      code: String(error?.code ?? "RUNTIME_STATUS_PUBLICATION_FAILED").slice(0, 128),
      detail: String(error?.message ?? "runtime status publication failed")
        .replaceAll(/[\r\n]/gu, " ")
        .slice(0, 512),
    });
  }
});
