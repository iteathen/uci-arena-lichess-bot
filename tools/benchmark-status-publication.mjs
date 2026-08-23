import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { RuntimeStatusPublisher } from "../runtime-status-publisher.mjs";

const CALLBACKS_PER_ROUND = 5_000;
const WARMUP_CALLBACKS = 500;
const STATUS_EVERY_CALLBACKS = 50;
const ACTIVE_GAMES = 16;
const OPPONENTS = 100;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function rounded(value) {
  return Math.round(value * 1_000) / 1_000;
}

function snapshot(iteration) {
  return {
    schema: "uci_arena_lichess_runtime_benchmark_v1",
    iteration,
    slots: {
      active: ACTIVE_GAMES,
      games: Array.from({ length: ACTIVE_GAMES }, (_, index) => ({
        game_id: `game-${index}`,
        generation: index + 1,
        state: "active",
      })),
    },
    opponents: Array.from({ length: OPPONENTS }, (_, index) => ({
      opponent: `opponent-${index}`,
      rating: 2_000 + index,
      games: 646 - index,
      wins: index,
      draws: index,
      losses: index,
      accepts: index,
      declines: 0,
      timeouts: 0,
      last_game_at: iteration,
    })),
  };
}

async function runRound(statusEnabled) {
  const directory = statusEnabled
    ? mkdtempSync(path.join(os.tmpdir(), "uci-arena-status-benchmark-"))
    : null;
  const publisher = statusEnabled ? new RuntimeStatusPublisher(directory) : null;
  const callbackDelays = [];
  const statusScheduleDurations = [];
  let latestGeneration = 0;
  try {
    for (let index = 0; index < CALLBACKS_PER_ROUND + WARMUP_CALLBACKS; index += 1) {
      const queuedAt = performance.now();
      await new Promise((resolve) => setImmediate(resolve));
      if (index >= WARMUP_CALLBACKS) callbackDelays.push(performance.now() - queuedAt);
      if (publisher && index % STATUS_EVERY_CALLBACKS === 0) {
        const scheduledAt = performance.now();
        latestGeneration = publisher.schedule(snapshot(index));
        if (index >= WARMUP_CALLBACKS) {
          statusScheduleDurations.push(performance.now() - scheduledAt);
        }
      }
    }
    if (publisher) await publisher.flush(latestGeneration);
    return { callbackDelays, statusScheduleDurations, health: publisher?.health() ?? null };
  } finally {
    await publisher?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

const observations = { disabled: [], enabled: [], schedules: [], health: [] };
for (const enabled of [false, true, true, false]) {
  const result = await runRound(enabled);
  observations[enabled ? "enabled" : "disabled"].push(...result.callbackDelays);
  observations.schedules.push(...result.statusScheduleDurations);
  if (result.health) observations.health.push(result.health);
}

const disabledP95 = percentile(observations.disabled, 0.95);
const disabledP99 = percentile(observations.disabled, 0.99);
const enabledP95 = percentile(observations.enabled, 0.95);
const enabledP99 = percentile(observations.enabled, 0.99);
const deltaP95 = enabledP95 - disabledP95;
const deltaP99 = enabledP99 - disabledP99;
const qualified = deltaP95 <= 0.5 && deltaP99 <= 1;

const report = {
  schema: "uci_arena_status_publication_benchmark_v1",
  workload: {
    rounds_per_mode: 2,
    callbacks_per_round: CALLBACKS_PER_ROUND,
    warmup_callbacks_per_round: WARMUP_CALLBACKS,
    status_every_callbacks: STATUS_EVERY_CALLBACKS,
    active_games_per_status: ACTIVE_GAMES,
    opponents_per_status: OPPONENTS,
    enabled_status_attempts: observations.health.reduce(
      (total, health) => total + Number(health.last_success_generation ?? 0),
      0,
    ),
  },
  event_loop_callback_delay_ms: {
    disabled: { p95: rounded(disabledP95), p99: rounded(disabledP99) },
    enabled: { p95: rounded(enabledP95), p99: rounded(enabledP99) },
    delta: { p95: rounded(deltaP95), p99: rounded(deltaP99) },
  },
  status_schedule_duration_ms: {
    p95: rounded(percentile(observations.schedules, 0.95)),
    p99: rounded(percentile(observations.schedules, 0.99)),
  },
  acceptance: {
    maximum_p95_regression_ms: 0.5,
    maximum_p99_regression_ms: 1,
    qualified,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!qualified) process.exitCode = 1;
