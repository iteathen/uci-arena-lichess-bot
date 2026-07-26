#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  LIVE_ACCEPTANCE_CONFIRMATION,
} from "./lichess-adapter.mjs";
import { normalizedUsername } from "./lichess-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ADAPTER = path.join(HERE, "lichess-adapter.mjs");

export const MAX_LIVE_ACCEPTANCE_ATTEMPTS = 3;
export const MAX_LIVE_ACCEPTANCE_MINUTES = 20;
const COMPLETED_GAME_STATUSES = new Set([
  "mate",
  "resign",
  "stalemate",
  "timeout",
  "draw",
  "outoftime",
  "cheat",
  "variantEnd",
]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid live-acceptance argument near ${flag ?? "<end>"}`);
    }
    options[flag.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

function boundedInteger(value, label, fallback, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
  }
  return parsed;
}

export function validateAcceptanceOptions(options) {
  if (options.confirm !== LIVE_ACCEPTANCE_CONFIRMATION) {
    throw new Error("Live acceptance requires the exact explicit confirmation phrase");
  }
  const expectedAccount = normalizedUsername(options.expected_account);
  const opponent = normalizedUsername(options.opponent);
  if (!expectedAccount) throw new Error("--expected-account is required");
  if (!opponent) throw new Error("--opponent is required");
  if (expectedAccount === opponent) {
    throw new Error("Live acceptance opponent must differ from the operator account");
  }
  if (!options.token_file) throw new Error("--token-file is required");
  return {
    ...options,
    expected_account: expectedAccount,
    opponent,
    attempts: boundedInteger(
      options.attempts,
      "--attempts",
      MAX_LIVE_ACCEPTANCE_ATTEMPTS,
      1,
      MAX_LIVE_ACCEPTANCE_ATTEMPTS,
    ),
    minutes: boundedInteger(
      options.minutes,
      "--minutes",
      MAX_LIVE_ACCEPTANCE_MINUTES,
      1,
      MAX_LIVE_ACCEPTANCE_MINUTES,
    ),
  };
}

export function buildAcceptanceConfig(sourceConfig) {
  const config = structuredClone(sourceConfig);
  if (config.schema !== "uci_arena_lichess_adapter_v5") {
    throw new Error("Live acceptance requires a v5 Lichess adapter configuration");
  }
  if (!config.capacity?.bot || config.capacity.bot.slots < 1) {
    throw new Error("Live acceptance requires at least one configured bot slot");
  }
  config.scheduler = { ...config.scheduler, enabled: false };
  config.capacity.bot = { ...config.capacity.bot, target_active: 0 };
  config.capacity.human = {
    ...config.capacity.human,
    accept_public: false,
  };
  config.challenges = {
    ...config.challenges,
    accept_bots: false,
    modes: ["casual"],
  };
  config.outbound_challenge = {
    ...config.outbound_challenge,
    rated: false,
    color: "random",
  };
  return config;
}

export function observeAcceptanceEvent(state, event, target) {
  const expectedTarget = normalizedUsername(target);
  const opponent = event?.opponent === undefined
    ? null
    : normalizedUsername(event.opponent);
  if (opponent && opponent !== expectedTarget
      && new Set(["challenge_created", "game_started", "game_finished"]).has(event.event)) {
    return {
      ...state,
      terminal: {
        status: "inconclusive",
        reason: `Observed unrelated ${event.event}`,
      },
    };
  }
  if (event?.event === "challenge_created") {
    return { ...state, challengeCreated: true, challengeId: event.challenge_id ?? null };
  }
  if (event?.event === "game_started") {
    return { ...state, gameStarted: true, gameId: event.game_id ?? null };
  }
  if (event?.event === "game_finished") {
    if (!event.game_id || opponent !== expectedTarget
        || !COMPLETED_GAME_STATUSES.has(event.status)) {
      return {
        ...state,
        terminal: {
          status: "inconclusive",
          reason: "Malformed, aborted, or unrelated game completion",
        },
      };
    }
    return {
      ...state,
      gameStarted: true,
      gameId: event.game_id,
      terminal: {
        status: "completed",
        gameId: event.game_id,
        opponent,
        gameStatus: event.status,
        result: event.result ?? "",
        challengeAttempted: state.challengeCreated,
      },
    };
  }
  if (event?.event === "challenge_terminal"
      || event?.event === "challenge_timeout"
      || event?.event === "challenge_timeout_not_found_released") {
    return {
      ...state,
      terminal: {
        status: "retryable",
        reason: event.status ?? event.event,
        challengeAttempted: state.challengeCreated,
      },
    };
  }
  if (event?.event === "game_error"
      || event?.event === "adapter_fatal"
      || event?.event === "scheduler_error") {
    return {
      ...state,
      terminal: {
        status: "inconclusive",
        reason: event.message ?? event.event,
      },
    };
  }
  return state;
}

async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let index = 0; index < 20; index += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await wait(100);
  }
  child.kill("SIGKILL");
}

function adapterArguments(options, configPath, runtimeDir) {
  const values = [
    ADAPTER,
    "run",
    "--config",
    configPath,
    "--token-file",
    path.resolve(options.token_file),
    "--expected-account",
    options.expected_account,
    "--opponent",
    options.opponent,
    "--acceptance-mode",
    "operator-bot-v1",
    "--acceptance-confirm",
    LIVE_ACCEPTANCE_CONFIRMATION,
    "--runtime-dir",
    runtimeDir,
  ];
  for (const [flag, value] of [
    ["--repo-root", options.repo_root],
    ["--profile", options.profile],
    ["--time-profile", options.time_profile],
    ["--capacity-profile", options.capacity_profile],
    ["--model-root", options.model_root],
  ]) {
    if (value) values.push(flag, path.resolve(value));
  }
  return values;
}

export async function runSpawnedAttempt({
  options,
  configPath,
  runtimeDir,
  deadline,
  spawnImpl = spawn,
  now = Date.now,
}) {
  const logPath = path.join(runtimeDir, "adapter.ndjson");
  let logOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  let partial = "";
  let state = {
    challengeCreated: false,
    gameStarted: false,
    gameId: null,
    terminal: null,
  };
  const child = spawnImpl(process.execPath, adapterArguments(options, configPath, runtimeDir), {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  let exited = false;
  let exitCode = null;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  try {
    while (now() < deadline) {
      if (existsSync(logPath)) {
        const bytes = readFileSync(logPath);
        if (bytes.length < logOffset) {
          logOffset = 0;
          partial = "";
        }
        if (bytes.length > logOffset) {
          const appended = bytes.subarray(logOffset).toString("utf8");
          logOffset = bytes.length;
          const lines = `${partial}${appended}`.split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch {
              state = {
                ...state,
                terminal: {
                  status: "inconclusive",
                  reason: "Adapter emitted malformed acceptance evidence",
                },
              };
              break;
            }
            state = observeAcceptanceEvent(state, event, options.opponent);
            if (state.terminal) break;
          }
        }
      }
      if (state.terminal) return state.terminal;
      if (exited) {
        return {
          status: "inconclusive",
          reason: `Adapter exited before a completed game (code ${exitCode ?? "signal"})`,
          gameId: state.gameId,
        };
      }
      await wait(250);
    }
    return {
      status: "inconclusive",
      reason: "Live acceptance wall-clock limit expired",
      gameId: state.gameId,
    };
  } finally {
    await terminateChild(child);
  }
}

export async function executeAcceptancePlan({
  options,
  runAttempt,
  now = Date.now,
}) {
  const deadline = now() + options.minutes * 60_000;
  const attempts = [];
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (now() >= deadline) {
      throw new Error("Live acceptance wall-clock limit expired before completion");
    }
    const result = await runAttempt({ attempt, deadline });
    attempts.push({
      attempt,
      status: result.status,
      reason: result.reason ?? null,
      game_id: result.gameId ?? null,
      challenge_attempted: result.challengeAttempted === true,
    });
    if (result.status === "completed") {
      if (normalizedUsername(result.opponent) !== options.opponent || !result.gameId) {
        throw new Error("Live acceptance completion did not match the named opponent");
      }
      return {
        schema: "uci_arena_lichess_live_acceptance_v1",
        status: "passed",
        account: options.expected_account,
        opponent: options.opponent,
        game_id: result.gameId,
        game_status: result.gameStatus,
        result: result.result ?? "",
        challenge_attempts: attempts.filter((row) => row.challenge_attempted).length,
        attempts,
      };
    }
    if (result.status !== "retryable") {
      throw new Error(`Live acceptance was inconclusive: ${result.reason ?? "unknown reason"}`);
    }
  }
  throw new Error(`Live acceptance exhausted ${options.attempts} challenge attempts`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = validateAcceptanceOptions(parseArguments(argv));
  const runtimeDir = path.resolve(
    options.runtime_dir ?? path.join(ROOT, "runtime_state", "lichess", "live-acceptance"),
  );
  mkdirSync(runtimeDir, { recursive: true });
  const sourceConfigPath = path.resolve(
    options.config ?? path.join(HERE, "config.uci_arena.template.yml"),
  );
  const configPath = path.join(runtimeDir, "acceptance.config.json");
  const sourceConfig = JSON.parse(readFileSync(sourceConfigPath, "utf8"));
  const acceptanceConfig = buildAcceptanceConfig(sourceConfig);
  writeFileSync(configPath, `${JSON.stringify(acceptanceConfig, null, 2)}\n`, "utf8");
  const resultPath = path.join(runtimeDir, "acceptance-result.json");
  try {
    const result = await executeAcceptancePlan({
      options,
      runAttempt: ({ deadline }) => runSpawnedAttempt({
        options,
        configPath,
        runtimeDir,
        deadline,
      }),
    });
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const failure = {
      schema: "uci_arena_lichess_live_acceptance_v1",
      status: "failed",
      rerunnable: true,
      account: options.expected_account,
      opponent: options.opponent,
      reason: error.message,
    };
    writeFileSync(resultPath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    throw error;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`lichess-live-acceptance: ${error.message}\n`);
    process.exitCode = 1;
  });
}
