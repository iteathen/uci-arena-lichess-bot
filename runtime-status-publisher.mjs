import path from "node:path";
import { Worker } from "node:worker_threads";

const RUNTIME_STATUS_MAXIMUM_BYTES = 1_048_576;

function boundedFailure(error) {
  return Object.freeze({
    code: String(error?.code ?? "RUNTIME_STATUS_PUBLICATION_FAILED").slice(0, 128),
    detail: String(error?.message ?? "runtime status publication failed")
      .replaceAll(/[\r\n]/gu, " ")
      .slice(0, 512),
  });
}

export class SerializedStatusPublisher {
  constructor({ write, close = async () => {}, now = Date.now, onOutcome = null } = {}) {
    if (typeof write !== "function") throw new Error("Status publisher write owner is required");
    this.write = write;
    this.closeWriter = close;
    this.now = now;
    this.onOutcome = typeof onOutcome === "function" ? onOutcome : null;
    this.failureActive = false;
    this.generation = 0;
    this.completedGeneration = 0;
    this.lastSuccessGeneration = 0;
    this.latest = null;
    this.running = false;
    this.closed = false;
    this.waiters = [];
    this.coalesced = 0;
    this.failures = 0;
    this.lastFailure = null;
    this.lastSuccessAt = null;
    this.lastByteLength = null;
    this.lastWriteDurationMs = null;
  }

  schedule(snapshot) {
    if (this.closed) throw new Error("Runtime status publisher is closed");
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("Runtime status snapshot must be an object");
    }
    const generation = ++this.generation;
    if (this.latest) this.coalesced += 1;
    this.latest = { generation, snapshot };
    void this.drain();
    return generation;
  }

  flush(generation = this.generation) {
    if (!Number.isSafeInteger(generation) || generation < 0 || generation > this.generation) {
      return Promise.reject(new Error("Invalid runtime status generation"));
    }
    if (generation === 0 || this.lastSuccessGeneration >= generation) return Promise.resolve();
    if (!this.running && !this.latest && this.completedGeneration >= generation) {
      const error = new Error(this.lastFailure?.detail ?? "runtime status publication failed");
      error.code = this.lastFailure?.code ?? "RUNTIME_STATUS_PUBLICATION_FAILED";
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ generation, resolve, reject });
      void this.drain();
    });
  }

  health() {
    return Object.freeze({
      state: this.lastFailure ? "failed" : this.lastSuccessGeneration > 0 ? "ready" : "checking",
      last_success_generation: this.lastSuccessGeneration || null,
      last_success_at: this.lastSuccessAt,
      last_byte_length: this.lastByteLength,
      last_write_duration_ms: this.lastWriteDurationMs,
      pending_generation: this.latest?.generation ?? (this.running ? this.completedGeneration + 1 : null),
      coalesced_generations: this.coalesced,
      failures: this.failures,
      last_failure: this.lastFailure,
    });
  }

  settleSuccess(generation) {
    const retained = [];
    for (const waiter of this.waiters) {
      if (waiter.generation <= generation) waiter.resolve();
      else retained.push(waiter);
    }
    this.waiters = retained;
  }

  settleFailure(generation, error) {
    const retained = [];
    for (const waiter of this.waiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else retained.push(waiter);
    }
    this.waiters = retained;
  }

  reportOutcome(outcome) {
    try {
      this.onOutcome?.(Object.freeze(outcome));
    } catch {}
  }

  async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.latest && !this.closed) {
        const publication = this.latest;
        this.latest = null;
        try {
          const result = await this.write(publication.snapshot, publication.generation);
          this.completedGeneration = publication.generation;
          this.lastSuccessGeneration = publication.generation;
          this.lastSuccessAt = Number(result?.activatedAt ?? this.now());
          this.lastByteLength = Number.isSafeInteger(result?.byteLength)
            ? result.byteLength
            : null;
          this.lastWriteDurationMs = Number.isFinite(result?.writeDurationMs)
            ? Number(result.writeDurationMs)
            : null;
          this.lastFailure = null;
          this.settleSuccess(publication.generation);
          if (this.failureActive) {
            this.failureActive = false;
            this.reportOutcome({ state: "recovered", generation: publication.generation });
          }
        } catch (rawError) {
          const failure = boundedFailure(rawError);
          const error = new Error(failure.detail);
          error.code = failure.code;
          this.completedGeneration = publication.generation;
          this.failures += 1;
          this.lastFailure = failure;
          this.settleFailure(publication.generation, error);
          this.failureActive = true;
          this.reportOutcome({ state: "failed", generation: publication.generation, failure });
        }
      }
    } finally {
      this.running = false;
      if (this.latest && !this.closed) void this.drain();
    }
  }

  async close() {
    if (this.closed) return;
    let failure = null;
    try {
      await this.flush();
    } catch (error) {
      failure = error;
    }
    this.closed = true;
    await this.closeWriter();
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(failure ?? new Error("Runtime status publisher closed"));
    }
    if (failure) throw failure;
  }
}

class WorkerStatusWriter {
  constructor({ target, maximumBytes, label }) {
    this.pending = new Map();
    this.closed = false;
    this.worker = new Worker(new URL("./runtime-status-worker.mjs", import.meta.url), {
      workerData: { target, maximumBytes, label },
    });
    this.worker.on("message", (message) => {
      const pending = this.pending.get(message?.generation);
      if (!pending) return;
      this.pending.delete(message.generation);
      if (message.ok) {
        pending.resolve({
          byteLength: Number(message.byteLength),
          activatedAt: Number(message.activatedAt),
          writeDurationMs: Number(message.writeDurationMs),
        });
      } else {
        const error = new Error(String(message.detail ?? "runtime status publication failed"));
        error.code = String(message.code ?? "RUNTIME_STATUS_PUBLICATION_FAILED");
        pending.reject(error);
      }
      if (this.pending.size === 0) this.worker.unref();
    });
    const rejectPending = (rawError) => {
      const failure = boundedFailure(rawError);
      for (const pending of this.pending.values()) {
        const error = new Error(failure.detail);
        error.code = failure.code;
        pending.reject(error);
      }
      this.pending.clear();
      this.worker.unref();
    };
    this.worker.on("error", rejectPending);
    this.worker.on("exit", (code) => {
      if (!this.closed) {
        const error = new Error(`runtime status worker exited with code ${code}`);
        error.code = "RUNTIME_STATUS_WORKER_EXITED";
        rejectPending(error);
      }
    });
    this.worker.unref();
  }

  write(snapshot, generation) {
    if (this.closed) return Promise.reject(new Error("Runtime status worker is closed"));
    return new Promise((resolve, reject) => {
      this.pending.set(generation, { resolve, reject });
      this.worker.ref();
      try {
        this.worker.postMessage({ generation, snapshot });
      } catch (error) {
        this.pending.delete(generation);
        if (this.pending.size === 0) this.worker.unref();
        reject(error);
      }
    });
  }

  async close() {
    this.closed = true;
    await this.worker.terminate();
  }
}

export class RuntimeStatusPublisher extends SerializedStatusPublisher {
  constructor(runtimeDir, { now = Date.now, onOutcome = null } = {}) {
    const writer = new WorkerStatusWriter({
      target: path.join(path.resolve(runtimeDir), "runtime.json"),
      maximumBytes: RUNTIME_STATUS_MAXIMUM_BYTES,
      label: "Lichess runtime status",
    });
    super({
      write: (snapshot, generation) => writer.write(snapshot, generation),
      close: () => writer.close(),
      now,
      onOutcome,
    });
  }
}
