import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_TEMPLATE,
  BotController,
  LichessClient,
  ROOT,
  UciEngine,
  challengeFromSelf,
  challengeDeclineReason,
  applySingleGameProfile,
  loadCapacityProfile,
  loadRuntimeConfig,
  loadSingleGameProfile,
  parseNdjsonStream,
  parseArguments,
  parseRuntimeStatus,
  probeAccount,
  validateRuntimeStatus,
} from "./lichess-adapter.mjs";
import { LichessStore } from "./lichess-store.mjs";

function temporaryToken() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-"));
  const tokenFile = path.join(directory, "token");
  writeFileSync(tokenFile, "test-token\n", "utf8");
  return tokenFile;
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function qualifiedFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-profile-"));
  const executable = path.join(directory, "engine.exe");
  const executableContent = Buffer.from("qualified-engine");
  writeFileSync(executable, executableContent);
  const modelRoot = path.join(directory, "model");
  mkdirSync(modelRoot);
  const checkpointHash = "a".repeat(64);
  writeFileSync(path.join(modelRoot, "checkpoint_manifest.json"), JSON.stringify({
    model_id: "model_v1",
    checkpoint_hash: checkpointHash,
  }));
  const evidenceContent = Buffer.from("qualified-evidence");
  writeFileSync(path.join(directory, "evidence.json"), evidenceContent);
  const evidence = Object.fromEntries([
    "cursor_correctness",
    "provider_parity",
    "deadline",
    "topology",
    "complete_game",
  ].map((name) => [name, {
    passed: true,
    artifact: "evidence.json",
    artifact_sha256: sha256(evidenceContent),
  }]));
  const profilePath = path.join(directory, "profile.json");
  const profile = {
    schema: "uci_arena_single_game_profile_v1",
    qualified: true,
    published_at: "2026-07-19T00:00:00Z",
    model_id: "model_v1",
    model_fingerprint: "1234",
    checkpoint_hash: checkpointHash,
    adapter_id: "adapter_v1",
    engine_build_fingerprint: sha256(executableContent),
    hardware_driver_fingerprint: "5678",
    onnx_runtime_version: "1.22.0",
    provider_numeric_fingerprint: "9012",
    search_core: "v2",
    provider: "directml",
    threads: 4,
    root_workers: 4,
    split_depth: 2,
    batch_size: 8,
    batch_wait_us: 150,
    speculation: false,
    qualification_probe: { depth: 4, timeout_ms: 30_000 },
    evidence,
  };
  writeFileSync(profilePath, JSON.stringify(profile));
  const config = {
    engine: {
      executable,
      working_directory: directory,
      single_game_profile: profilePath,
      uci_options: { ModelRoot: "model", BehaviorProfile: "balanced" },
    },
  };
  return { config, profile, profilePath };
}

function qualifiedRuntimeStatus(profile) {
  return {
    schema: "uci_runtime_status_v1",
    model_loaded: true,
    model_id: profile.model_id,
    model_fingerprint: profile.model_fingerprint,
    adapter_id: profile.adapter_id,
    provider_requested: profile.provider,
    provider_effective: profile.provider,
    provider_numeric_fingerprint: profile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: profile.hardware_driver_fingerprint,
    onnx_runtime_version: profile.onnx_runtime_version,
    search_core_configured: "v2",
    threads_configured: profile.threads,
    root_workers_configured: profile.root_workers,
    split_depth_configured: profile.split_depth,
    batch_size_configured: profile.batch_size,
    batch_size_effective: profile.batch_size,
    batch_wait_us_configured: profile.batch_wait_us,
    batch_wait_us_effective: profile.batch_wait_us,
    background_search: false,
    last_search_available: true,
    last_search_core: "v2",
    last_search_threads: profile.threads,
    last_search_root_workers: profile.root_workers,
    actual_active_workers: 4,
    root_workers_active: true,
    worker_gate_active: true,
    persistent_workers: true,
    search_batch_coupling: true,
    v2_cursor_admissions: 19,
    v2_cursor_async_pending: 8,
    v2_cursor_ready_resumes: 8,
    v2_cursor_peak_waiting: 4,
    evaluation_service_async_lease_completions: 8,
    evaluation_service_stale_publications_discarded: 0,
    evaluation_service_active_async_leases: 0,
    evaluation_service_active_tickets: 0,
    model_cache_eviction_deferrals: 0,
    repetition_unbalanced_workers: 0,
  };
}

test("runtime config is credential-free and resolves repository paths", () => {
  const config = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    repoRoot: ROOT,
    modelRoot: "engine/runtime/models/example/engine",
  });
  const serialized = JSON.stringify(config).toLowerCase();
  assert.equal(serialized.includes("test-token"), false);
  assert.equal(serialized.includes("oauth_token"), false);
  assert.equal(config.engine.uci_options.ModelRoot, "engine/runtime/models/example/engine");
  assert.equal(config.engine.executable.includes(ROOT.replaceAll("\\", "/")), true);
});

test("runtime config accepts the shared active model environment override", () => {
  const selected = "engine/runtime/models/compact_chessformer_gab_v1/engine";
  const config = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    repoRoot: ROOT,
    environment: { UCI_ARENA_MODEL_ROOT: selected },
  });
  assert.equal(config.engine.uci_options.ModelRoot, selected);

  const explicit = loadRuntimeConfig({
    templatePath: DEFAULT_TEMPLATE,
    repoRoot: ROOT,
    modelRoot: "engine/runtime/models/explicit/engine",
    environment: { UCI_ARENA_MODEL_ROOT: selected },
  });
  assert.equal(explicit.engine.uci_options.ModelRoot, "engine/runtime/models/explicit/engine");
});

test("v2 config migrates to one shared slot with automatic scheduling disabled", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-v2-config-"));
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.schema = "uci_arena_lichess_adapter_v2";
  delete template.capacity;
  delete template.scheduler;
  template.challenges.concurrency = 1;
  const configPath = path.join(directory, "v2.json");
  writeFileSync(configPath, JSON.stringify(template));
  const config = loadRuntimeConfig({ templatePath: configPath });
  assert.equal(config.capacity.total_slots, 1);
  assert.equal(config.capacity.legacy_shared, true);
  assert.equal(config.scheduler.enabled, false);
});

test("v3 accepts a configurable sixteen-slot layout and rejects invalid sums", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-v3-config-"));
  const template = JSON.parse(readFileSync(DEFAULT_TEMPLATE, "utf8"));
  template.capacity = {
    ...template.capacity,
    total_slots: 16,
    startup_parallelism: 4,
    human: { ...template.capacity.human, slots: 2 },
    bot: { ...template.capacity.bot, slots: 14, target_active: 14 },
  };
  const configPath = path.join(directory, "v3.json");
  writeFileSync(configPath, JSON.stringify(template));
  assert.equal(loadRuntimeConfig({ templatePath: configPath }).capacity.total_slots, 16);
  template.capacity.bot.slots = 13;
  template.capacity.bot.target_active = 13;
  writeFileSync(configPath, JSON.stringify(template));
  assert.throws(() => loadRuntimeConfig({ templatePath: configPath }), /must sum/);
});

test("qualified single-game profile is identity-bound and owns the parallel topology", () => {
  const fixture = qualifiedFixture();
  const loaded = loadSingleGameProfile(fixture.profilePath);
  assert.equal(loaded.model_id, fixture.profile.model_id);
  applySingleGameProfile(fixture.config);
  assert.deepEqual(
    Object.fromEntries(Object.entries(fixture.config.engine.uci_options).filter(([name]) => [
      "SearchCore",
      "Threads",
      "RootWorkers",
      "V2SplitDepth",
      "OnnxProvider",
      "NNBatchSize",
      "NNBatchWaitUs",
      "NNSpeculation",
      "BackgroundSearch",
    ].includes(name))),
    {
      SearchCore: "v2",
      Threads: 4,
      RootWorkers: 4,
      V2SplitDepth: 2,
      OnnxProvider: "directml",
      NNBatchSize: 8,
      NNBatchWaitUs: 150,
      NNSpeculation: false,
      BackgroundSearch: false,
    },
  );
});

test("profile-owned topology rejects a conflicting tracked option", () => {
  const fixture = qualifiedFixture();
  fixture.config.engine.uci_options.SearchCore = "legacy";
  assert.throws(() => applySingleGameProfile(fixture.config), /conflicts.*SearchCore/);
});

test("capacity profile is exact-identity-bound and may qualify a larger configured pool", () => {
  const fixture = qualifiedFixture();
  const single = loadSingleGameProfile(fixture.profilePath);
  fixture.config.capacity = { total_slots: 2, legacy_shared: false };
  const capacityPath = path.join(path.dirname(fixture.profilePath), "capacity.json");
  const capacity = {
    schema: "uci_arena_lichess_capacity_profile_v1",
    qualified: true,
    published_at: "2026-07-20T00:00:00Z",
    maximum_concurrency: 4,
    engine_build_fingerprint: fixture.profile.engine_build_fingerprint,
    single_game_profile_sha256: sha256(readFileSync(fixture.profilePath)),
    model_fingerprint: fixture.profile.model_fingerprint,
    provider_numeric_fingerprint: fixture.profile.provider_numeric_fingerprint,
    hardware_driver_fingerprint: fixture.profile.hardware_driver_fingerprint,
    evidence: Array.from({ length: 4 }, (_, index) => ({ child: index + 1, qualified: true })),
  };
  writeFileSync(capacityPath, JSON.stringify(capacity));
  assert.equal(loadCapacityProfile(capacityPath, fixture.config, single).maximum_concurrency, 4);
  fixture.config.capacity.total_slots = 5;
  assert.throws(() => loadCapacityProfile(capacityPath, fixture.config, single), /exceeds qualified/);
  fixture.config.capacity.total_slots = 2;
  capacity.model_fingerprint = "different";
  writeFileSync(capacityPath, JSON.stringify(capacity));
  assert.throws(() => loadCapacityProfile(capacityPath, fixture.config, single), /model_fingerprint mismatch/);
});

test("runtime status gate accepts active one-game cursor batching and rejects fallback", () => {
  const { profile } = qualifiedFixture();
  const status = qualifiedRuntimeStatus(profile);
  const line = `info string runtime_status_v1 ${JSON.stringify(status)}`;
  assert.deepEqual(parseRuntimeStatus(line), status);
  assert.equal(validateRuntimeStatus(profile, status), status);
  assert.throws(
    () => validateRuntimeStatus(profile, { ...status, provider_effective: "cpu" }),
    /GPU provider fallback/,
  );
});

test("runtime qualification bypasses the book probe and restores live book play", async () => {
  const { profile } = qualifiedFixture();
  const engine = new UciEngine({ uci_options: {}, qualification_profile: profile });
  engine.advertisedOptions.add("OwnBook");
  const commands = [];
  engine.send = (command) => commands.push(command);
  engine.newGame = async () => commands.push("ucinewgame+isready");
  engine.exchange = async (command) => {
    commands.push(command);
    if (command.startsWith("go depth ")) return "bestmove e2e4";
    if (command === "isready") return "readyok";
    throw new Error(`Unexpected command: ${command}`);
  };
  engine.runtimeStatus = async () => qualifiedRuntimeStatus(profile);

  await engine.qualifyRuntime();

  assert.deepEqual(commands, [
    "setoption name OwnBook value false",
    "isready",
    "ucinewgame+isready",
    "position startpos",
    `go depth ${profile.qualification_probe.depth}`,
    "setoption name OwnBook value true",
    "isready",
  ]);
});

test("NDJSON parser handles split chunks and keepalive lines", async () => {
  const encoder = new TextEncoder();
  const chunks = ["{\"type\":\"game", "Start\"}\n\n{\"type\":\"gameFinish\"}"];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseNdjsonStream(stream)) events.push(event);
  assert.deepEqual(events, [{ type: "gameStart" }, { type: "gameFinish" }]);
});

test("API client keeps credentials in the authorization header", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const client = new LichessClient({ token: "test-token", fetchImpl });
  await client.json("api/account");
  assert.equal(request.url.includes("test-token"), false);
  assert.equal(request.options.headers.Authorization, "Bearer test-token");
  assert.equal(JSON.stringify(request.options).includes("test-token"), true);
});

test("API client applies at least sixty seconds of non-move backoff after 429", async () => {
  const client = new LichessClient({
    token: "test-token",
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "1" },
    }),
  });
  const before = Date.now();
  await assert.rejects(client.json("api/account"), /HTTP 429/);
  assert.ok(client.requestQueue.nonMoveBlockedUntil >= before + 60_000);
});

test("account probe rejects a mismatched account", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ username: "other", title: "BOT" }),
  });
  await assert.rejects(
    probeAccount({ tokenFile: temporaryToken(), expectedAccount: "expected", fetchImpl }),
    /account mismatch/,
  );
});

test("account probe explains BOT ineligibility after prior play", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ username: "expected", count: { all: 1 } }),
  });
  await assert.rejects(
    probeAccount({ tokenFile: temporaryToken(), expectedAccount: "expected", fetchImpl }),
    /prior games=1/,
  );
});

test("challenge policy accepts only the configured clean standard shape", () => {
  const policy = loadRuntimeConfig().challenges;
  const challenge = {
    id: "challenge",
    direction: "in",
    rated: false,
    speed: "rapid",
    variant: { key: "standard" },
    timeControl: { type: "clock", limit: 300, increment: 2 },
    challenger: { title: "BOT" },
  };
  assert.equal(challengeDeclineReason(challenge, policy), null);
  assert.equal(challengeDeclineReason({ ...challenge, initialFen: "startpos" }, policy), null);
  assert.equal(challengeDeclineReason({ ...challenge, rated: true }, policy), "rated");
  assert.equal(challengeDeclineReason({ ...challenge, variant: { key: "chess960" } }, policy), "variant");
  assert.equal(challengeDeclineReason({ ...challenge, initialFen: "8/8/8/8/8/8/8/8 w - - 0 1" }, policy), "variant");
  assert.equal(challengeDeclineReason(challenge, policy, 1), "later");
});

test("challenge ownership comes from challenger identity, not direction", () => {
  const selfChallenge = { direction: "in", challenger: { name: "UCI_Arena_Bot" } };
  const incomingChallenge = { direction: "out", challenger: { name: "Opponent" } };
  assert.equal(challengeFromSelf(selfChallenge, "uci_arena_bot"), true);
  assert.equal(challengeFromSelf(incomingChallenge, "UCI_Arena_Bot"), false);
});

test("nested local control commands parse without touching credentials", () => {
  assert.deepEqual(parseArguments(["owner", "add", "--username", "owner"]), {
    command: "owner", action: "add", username: "owner",
  });
  assert.deepEqual(parseArguments(["reserve", "--opponent", "owner", "--games", "2"]), {
    command: "reserve", opponent: "owner", games: "2",
  });
});

test("concurrent inbound events cannot overbook one bot slot", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-admission-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  const posts = [];
  const client = {
    post: async (endpoint, form) => {
      posts.push({ endpoint, form });
      return { json: async () => ({}) };
    },
  };
  const config = {
    capacity: {
      total_slots: 1,
      startup_parallelism: 1,
      legacy_shared: false,
      human: { slots: 0, allow_borrowing: false, accept_public: true },
      bot: { slots: 1, target_active: 0 },
    },
    challenges: {
      accept_bots: true,
      min_base: 180,
      max_base: 1800,
      min_increment: 0,
      max_increment: 10,
      speeds: ["blitz", "rapid", "classical"],
      modes: ["casual"],
    },
    scheduler: { decline_cooldown_minutes: 360 },
  };
  const controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  controller.prepareSlot = async (slot) => {
    await preparationGate;
    controller.slots.attachEngine(slot, { close: async () => {} });
    return slot;
  };
  const challenge = (id, name) => ({
    id,
    rated: false,
    speed: "blitz",
    variant: { key: "standard" },
    timeControl: { type: "clock", limit: 180, increment: 2 },
    challenger: { id: name, title: "BOT" },
  });
  try {
    const first = controller.onChallenge(challenge("one", "bot-one"));
    const second = controller.onChallenge(challenge("two", "bot-two"));
    releasePreparation();
    await Promise.all([first, second]);
    assert.equal(posts.filter((entry) => entry.endpoint.endsWith("/accept")).length, 1);
    assert.equal(posts.filter((entry) => entry.endpoint.endsWith("/decline")
      && entry.form.reason === "later").length, 1);
    assert.equal(controller.slots.snapshot().byAudience.bot.pending, 1);
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});

test("restart recovery prefers canonical opponent id over a title-prefixed display name", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-recovery-"));
  const store = new LichessStore(path.join(directory, "matches.sqlite"));
  store.replaceOnlineBots([{ username: "usunfish", title: "BOT" }]);
  let requestedEndpoint;
  const client = {
    json: async (endpoint) => {
      requestedEndpoint = endpoint;
      return {
        nowPlaying: [{
          gameId: "game",
          opponent: { id: "usunfish", username: "BOT uSunfish" },
        }],
      };
    },
  };
  const config = {
    capacity: {
      total_slots: 2,
      startup_parallelism: 2,
      human: { slots: 1, allow_borrowing: false, accept_public: true },
      bot: { slots: 1, target_active: 1 },
    },
  };
  const controller = new BotController({
    client,
    config,
    account: "self",
    runtimeDir: directory,
    signal: new AbortController().signal,
    store,
  });
  let recovered;
  controller.prepareSlot = async (slot) => {
    controller.slots.attachEngine(slot, { close: async () => {} });
    return slot;
  };
  controller.startGame = async (game, slot) => { recovered = { game, slot }; };
  try {
    await controller.recoverPlayingGames();
    assert.equal(requestedEndpoint, "api/account/playing?nb=50");
    assert.equal(recovered.slot.opponent, "usunfish");
    assert.equal(recovered.slot.audience, "bot");
  } finally {
    await controller.slots.drainAll();
    store.close();
  }
});
