import assert from "node:assert/strict";
import test from "node:test";
import { UciEngine, validateRuntimeStatus, GameSession, LichessClient, publishCapacityProfile } from "./lichess-adapter.mjs";
import { CONTINUOUS_PROFILE_SCHEMA, validateContinuousLaunchContext } from "./continuous-game-qualification.mjs";
import { AuthoritativeChessState } from "./chess-legality.mjs";
import { MOVE_EVIDENCE_PREFIX } from "./continuous-uci-observation.mjs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { continuousObservationFromRuntime, validateNativePublication } from "./continuous-uci-observation.mjs";
import { startFakeLichessApi } from "./fake-api-server.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function runtime() {
  const result = { schema: "uci_runtime_status_v1", model_loaded: true, model_id: "model_v1",
    model_fingerprint: "123", adapter_id: "adapter", provider_requested: "directml", provider_effective: "directml",
    provider_numeric_fingerprint: "456", hardware_driver_fingerprint: "789", onnx_runtime_version: "1.2.3",
    search_core_configured: "mcgs", threads_configured: 3, root_workers_configured: 1, split_depth_configured: 2,
    batch_size_configured: 64, batch_size_effective: 64, batch_wait_us_configured: 0, batch_wait_us_effective: 0,
    background_search: false, mcgs_book_prior_blend_permille_configured: 0,
    continuous_search_active: true, continuous_search_failed: false, continuous_search_lineage: 1,
    continuous_worker_set_identity: 1, continuous_search_activations: 1, continuous_focus_valid: true,
    continuous_focus_graph_epoch: "1", continuous_focus_subject_identity: "1", continuous_focus_position_key: "100",
    continuous_graph_focus_position_key: "100", continuous_focus_transition_sequence: 1,
    admitted_position_fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    admitted_position_key: "100", admitted_position_history_available: true, admitted_position_history_length: 1,
    accepted_position_command: "position startpos", continuous_execution_observations_available: true,
    continuous_observation_execution_lineage: "1", continuous_active_reservations: 3, continuous_reservation_capacity: 64,
    continuous_reservation_residue_available: false, continuous_reservation_residue: null,
    continuous_stale_backups_discarded: 0, continuous_focus_completed_visits: 10, continuous_async_admissions: 10,
    evaluation_service_supported: true, evaluation_service_lifetime_identity: "1", evaluation_queue_owner_lifetime_identity: "1",
    evaluation_service_generation: "1", evaluation_service_active_tickets: 4, evaluation_service_peak_active_tickets: 5,
    evaluation_service_pending_tickets: 2, evaluation_service_executing_tickets: 2, evaluation_service_ticket_capacity: 32,
    evaluation_service_active_async_leases: 2, evaluation_service_peak_async_leases: 3,
    evaluation_service_cancellations: 0, evaluation_service_executor_failures: 0,
    evaluation_service_stale_publications_discarded: 0, evaluation_service_submitted: 10,
    evaluation_service_provider_batches: 10, evaluation_service_async_lease_completions: 10,
    evaluation_service_async_lease_abandons: 0, model_cache_supported: true, model_cache_owner_lifetime_identity: "1",
    model_cache_entries: 5, model_cache_capacity: 128, model_cache_approx_policy_payload_bytes: 20,
    model_cache_policy_payload_budget_bytes: 512, model_cache_evictions: 0, model_cache_eviction_deferrals: 0,
    model_cache_drops: 0, mcgs_root_legal_moves: 20, mcgs_root_policy_moves: 20, mcgs_root_seeded_moves: 1 };
  return result;
}
const profile = { schema: CONTINUOUS_PROFILE_SCHEMA, qualification_scope: "local_live_safety", model_id: "model_v1",
  model_fingerprint: "123", adapter_id: "adapter", provider: "directml", provider_numeric_fingerprint: "456",
  hardware_driver_fingerprint: "789", onnx_runtime_version: "1.2.3", search_core: "mcgs", threads: 3,
  root_workers: 1, split_depth: 2, batch_size: 64, batch_wait_us: 0, mcgs_book_prior_blend_permille: 0 };

test("v2 runtime admits bounded ongoing work without historical drain or full-seeding gate", () => {
  const status = runtime();
  assert.equal(validateRuntimeStatus(profile, status), status);
});

test("v2 runtime rejects unsafe numeric execution identity before lossless conversion", () => {
  assert.throws(() => validateRuntimeStatus(profile, { ...runtime(), continuous_search_lineage: 9007199254740992 }),
    /unsafe|lossless/);
});

test("v2 runtime never infers unsupported or missing owner observations", () => {
  const status = runtime();
  delete status.evaluation_service_lifetime_identity;
  assert.throws(() => validateRuntimeStatus(profile, status), /identity|supported|lifetime/);
});

test("continuous launch binding preserves actual literal argv and working-directory context", () => {
  const binding = { engine: { path: process.execPath, arguments: ["literal argument"], working_directory: process.cwd() },
    model: { root: path.join(process.cwd(), "model") } };
  const configuration = { executable: process.execPath, arguments: ["literal argument"], working_directory: process.cwd(),
    uci_options: { ModelRoot: "model" } };
  validateContinuousLaunchContext(binding, configuration);
  assert.throws(() => validateContinuousLaunchContext(binding, { ...configuration, arguments: ["changed literal argument"] }), /literal argument/);
  assert.throws(() => validateContinuousLaunchContext(binding, { ...configuration, working_directory: os.tmpdir() }), /launch context/);
});

test("v2 retains exact Ponder publication compatibility independently of transport opponent-turn optimization", () => {
  const engine = new UciEngine({ qualification_profile: profile, uci_options: {}, timing: { opponent_turn_search: false } });
  const commands = [];
  engine.send = (line) => commands.push(line);
  for (const name of ["Move Overhead", "IterativeTimeController", "TimeProfileProviderReserveUs",
    "TimeProfileBackupEmitReserveUs", "TimeProfileIterationForecastScalePermille", "McgsTimePolicy", "Ponder", "OwnBook"])
    engine.onLine(`option name ${name} type string default ${name === "OwnBook" ? "true" : "0"}`);
  engine.configureUciOptions();
  assert.ok(commands.includes("setoption name Ponder value true"));
  assert.equal(engine.timeProfileConfiguration().ponderOption, true);
});

test("runtime option observation retains actual advertised defaults and applied values without sorting declarations", () => {
  const engine = new UciEngine({ uci_options: {} });
  engine.onLine("option name OwnBook type check default false");
  engine.onLine("option name Move Overhead type spin default 250 min 0 max 10000");
  engine.onLine("option name BookFile type string default C:/public book/default.bin");
  engine.onLine("option name Clear Hash type button");
  assert.deepEqual(engine.effectiveOptionValues(), { OwnBook: "false", "Move Overhead": "250", BookFile: "C:/public book/default.bin" });
  assert.equal(engine.timeProfileConfiguration().ownBook, false);
  engine.appliedUciOptions.OwnBook = "true";
  assert.equal(engine.effectiveOptionValues().OwnBook, "true");
  assert.equal(engine.uciOptionLines[0], "option name OwnBook type check default false");
});

test("v2 fresh child baseline refuses unavailable OS instance identity", () => {
  const engine = new UciEngine({ qualification_profile: profile, executable: process.execPath, uci_options: {} });
  engine.child = { pid: process.pid };
  assert.throws(() => engine.captureContinuousChildIdentity(() => ({ state: "unverifiable" })), /process instance/);
});

test("v2 direct capacity publication refuses clean close labels without the genuine native join receipt", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "continuous-capacity-boundary-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const executable = path.join(root, "engine-fixture.exe");
  const timeProfile = path.join(root, "time.json");
  const singleProfile = path.join(root, "single.json");
  writeFileSync(executable, "explicit synthetic engine bytes");
  writeFileSync(timeProfile, "{}"); writeFileSync(singleProfile, JSON.stringify(profile));
  const status = { continuous_observation: continuousObservationFromRuntime(runtime()), qualification_cleanup: {
    clean_exit: true, exit_observed: true, close_observed: true, exit_code: 0, exit_signal: null,
    forced_termination: false, cleanup_diagnostics: [] } };
  assert.throws(() => publishCapacityProfile(path.join(root, "capacity.json"), 1, { engine: { executable,
    time_profile_status: { accepted: true, profile_path: timeProfile, identity_sha256: `sha256:${"a".repeat(64)}` } } },
  { ...profile, profile_path: singleProfile }, [status]), /native completion|receipt/);
});

function startupEngine(mutate = () => {}) {
  const configured = { ...profile, qualification_probe: { publication_wait_ms: 500, publication_timeout_ms: 30000,
    publication_count: 1, candidate_sample_count: 1, read_only_candidate_request: true },
    diagnostic_configuration: { maximum_movetime_ratio: 1.5, maximum_movetime_grace_ms: 50 } };
  const engine = new UciEngine({ qualification_profile: configured, uci_options: { OwnBook: true } });
  // Isolate admission/publication from the separately tested public timing/configuration owner.
  engine.timeProfileStatus = { accepted: true, applied: true };
  engine.validateContinuousRuntimeContext = () => {};
  engine.advertisedOptions.add("OwnBook");
  const commands = [];
  const status = runtime();
  status.opening_book_enabled = true;
  status.opening_book_active = true;
  const state = new AuthoritativeChessState("startpos"); state.synchronize([]);
  const evidence = { schema: "uci_move_decision_evidence_v1", decision_authority: "none", evidence_current: true,
    continuous_search_lineage: "1", continuous_worker_set_identity: "1", candidate_count: 20,
    focus: { graph_epoch: "1", subject_identity: "1", position_key: "100", transition_sequence: 1 },
    candidates: state.positionObservation().legal_moves.map((move) => ({ move })) };
  engine.newGame = async () => commands.push("ucinewgame");
  engine.send = (command) => commands.push(command);
  engine.validateOpeningBookRuntime = () => {};
  engine.runtimeStatus = async () => { commands.push("runtime_status"); return status; };
  engine.runtimeStatusAfterInferenceDrain = async () => { throw new Error("historical drain is forbidden"); };
  engine.exchange = async (command) => {
    commands.push(command);
    if (command === "go movetime 500") {
      engine.latestInfo = { time_completion_kind: "searched_decision", mcgs_decision_focus_graph_epoch: "1", mcgs_decision_focus_subject_identity: "1",
        mcgs_decision_focus_position_key: "100", mcgs_decision_focus_transition_sequence: "1" };
      return "bestmove e2e4";
    }
    if (command === "move_decision_evidence") return MOVE_EVIDENCE_PREFIX + JSON.stringify(evidence);
    throw new Error(`unexpected command ${command}`);
  };
  mutate({ engine, status, evidence });
  return { engine, commands };
}

test("v2 startup uses one bounded publication and full legal candidate sample with configured book intact", async () => {
  const { engine, commands } = startupEngine();
  const result = await engine.qualifyRuntime();
  assert.equal(result.bestmove, "e2e4");
  assert.equal(result.continuous_observation.history_length, 1);
  assert.deepEqual(commands, ["ucinewgame", "position startpos", "go movetime 500", "runtime_status", "move_decision_evidence"]);
});

test("v2 actual opponent-only game takes a fresh admission baseline after ucinewgame", async () => {
  const { engine, commands } = startupEngine(({ status }) => {
    status.continuous_search_lineage = 2;
    status.continuous_observation_execution_lineage = "2";
    status.continuous_worker_set_identity = 2;
  });
  engine.timing.opponent_turn_search = true;
  engine.stopAndDrain = async () => ({ drained: false });
  engine.newGame = UciEngine.prototype.newGame.bind(engine);
  engine.exchange = async (command) => { commands.push(command); return "readyok"; };
  engine.continuousObservation = continuousObservationFromRuntime(runtime());
  await engine.newGame();
  assert.equal(engine.continuousObservation, null);
  engine.beginSearch = (_kind, command) => { commands.push(command); return { rootMoves: [] }; };
  await engine.startOpponentTurnSearch({ moves: [], wtime: 10000, btime: 10000, winc: 0, binc: 0 });
  assert.equal(engine.continuousObservation?.execution_lineage, "2");
  assert.equal(commands.filter((command) => command === "runtime_status").length, 1);
  assert.equal(commands.some((command) => command.startsWith("bestmove") || command === "move_decision_evidence"), false);
});

test("v2 startup rejects acknowledged history drift despite matching FEN", async () => {
  const { engine } = startupEngine(({ status }) => { status.accepted_position_command = "position startpos moves g1f3 g8f6 f3g1 f6g8"; });
  await assert.rejects(engine.qualifyRuntime(), /exact sent history/);
});

test("v2 startup rejects omitted legal candidate without requiring completed seeds", async () => {
  const { engine } = startupEngine(({ evidence }) => { evidence.candidates.pop(); evidence.candidate_count -= 1; });
  await assert.rejects(engine.qualifyRuntime(), /canonical legal moves/);
});

test("v2 startup rejects a legal publication exceeding the bound despite an unexpired IPC timeout", async () => {
  const { engine } = startupEngine();
  const exchange = engine.exchange;
  engine.exchange = async (command) => {
    if (command === "go movetime 500") await new Promise((resolve) => setTimeout(resolve, 900));
    return exchange(command);
  };
  await assert.rejects(engine.qualifyRuntime(), /movetime tolerance/);
});

test("v2 fixed500 startup with actual overhead650 rejects urgent fallback lacking emitted focus", async () => {
  const { engine, commands } = startupEngine();
  assert.equal(engine.timing.initial_transport_reserve_ms, 650);
  const exchange = engine.exchange;
  engine.exchange = async (command) => {
    const result = await exchange(command);
    if (command === "go movetime 500") {
      engine.latestInfo = {};
      // Synthetic reproduction of the owner's urgent wire shape; current runtime focus is still available.
      engine.onLine("info string time_deadline_expired_before_search time_completion_kind deadline_fallback");
    }
    return result;
  };
  await assert.rejects(engine.qualifyRuntime(), /unsafe|lossless/);
  assert.ok(commands.includes("go movetime 500"));
  assert.equal(engine.config.uci_options.OwnBook, true);
});

for (const kind of [undefined, "unknown_resolution"]) {
  test(`v2 startup rejects ${kind ?? "missing"} typed native completion`, async () => {
    const { engine } = startupEngine();
    const exchange = engine.exchange;
    engine.exchange = async (command) => {
      const result = await exchange(command);
      if (command === "go movetime 500") engine.latestInfo.time_completion_kind = kind;
      return result;
    };
    await assert.rejects(engine.qualifyRuntime(), /completion kind/);
  });
}

test("v2 startup cannot bypass publication focus by inventing unresolved book authority", async () => {
  const { engine } = startupEngine();
  const exchange = engine.exchange;
  engine.exchange = async (command) => {
    const result = await exchange(command);
    if (command === "go movetime 500") Object.assign(engine.latestInfo,
      { time_completion_kind: "opening_book", book_move_used: 0 });
    return result;
  };
  await assert.rejects(engine.qualifyRuntime(), /book resolution/);
});

test("synthetic typed tablebase compatibility needs active qualified authority but no search-only wire fields", () => {
  const engine = new UciEngine({ uci_options: {} });
  engine.onLine("info string time_completion_kind exact_tablebase");
  const observed = continuousObservationFromRuntime(runtime());
  const legality = new AuthoritativeChessState("6k1/8/8/8/8/8/8/KQ6 w - - 0 1");
  legality.synchronize([]);
  const context = { legalMoves: legality.positionObservation().legal_moves, runtime: { syzygy_active: true },
    tablebase: { loaded_cardinality: 6 } };
  validateNativePublication(engine.latestInfo, observed, context);
  assert.equal(engine.latestInfo.mcgs_decision_focus_position_key, undefined);
  assert.throws(() => validateNativePublication(engine.latestInfo, observed, { ...context, runtime: { syzygy_active: false } }), /tablebase resolution/);
  assert.throws(() => validateNativePublication(engine.latestInfo, observed, { ...context, tablebase: undefined }), /tablebase resolution/);
  engine.latestInfo = {};
  engine.onLine("info string tablebase hint exact_tablebase");
  assert.throws(() => validateNativePublication(engine.latestInfo, observed, context), /completion kind|lossless|unsafe/);
});

test("v2 actual game search rejects a publication from a different focus before submission", async () => {
  const { engine } = startupEngine();
  engine.stopAndDrain = async () => ({ drained: false });
  engine.beginSearch = () => ({});
  engine.awaitCancellableSearch = async () => ({ bestmove: "e2e4", telemetry: {
    time_completion_kind: "searched_decision", mcgs_decision_focus_graph_epoch: "1", mcgs_decision_focus_subject_identity: "2",
    mcgs_decision_focus_position_key: "100", mcgs_decision_focus_transition_sequence: "1" } });
  await assert.rejects(engine.search({ moves: [], color: "white", wtime: 10000, btime: 10000, winc: 0, binc: 0 }),
    /publication is not fenced/);
});

async function closeChild(t, completion, exitCode = 0) {
  const engine = new UciEngine({ qualification_profile: profile, uci_options: {}, shutdown_grace_ms: 1000 });
  engine.continuousObservation = continuousObservationFromRuntime(runtime());
  const receipt = { schema: "uci_execution_completion_v1", decision_authority: "none", completion };
  const source = `process.stdin.once('data', () => { process.stdout.write(${JSON.stringify(
    "info string execution_completion_v1 " + JSON.stringify(receipt) + "\n")}); process.exitCode=${exitCode}; process.stdin.destroy(); });`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] });
  engine.child = child;
  engine.lines = createInterface({ input: child.stdout });
  engine.lines.on("line", (line) => engine.onLine(line));
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  return engine.close({ requireCleanExit: true });
}
const joinedReceipt = { observed: true, disposition: "joined", execution_lineage: "1", graph_epoch: "1",
  execution_failed: false, reservation_residue: 0, stale_backups_discarded: 0,
  evaluation_active_tickets: 4, evaluation_active_async_leases: 0 };

test("v2 clean real child exit rejects a missing genuine joined receipt", async (t) => {
  await assert.rejects(closeChild(t, null), /did not close cleanly/);
});

for (const [name, completion, exitCode] of [
  ["wrong ended lineage", { ...joinedReceipt, execution_lineage: "2" }, 0],
  ["native execution failure", { ...joinedReceipt, execution_failed: true }, 0],
  ["receipt with nonzero process exit", joinedReceipt, 7],
]) {
  test(`v2 real child rejects ${name}`, async (t) => {
    await assert.rejects(closeChild(t, completion, exitCode), (error) =>
      error.code === "UCI_CHILD_CLOSE_FAILED" && error.closeOutcome.clean_exit === false);
  });
}

test("v2 real child close retains bounded nonzero ticket receipt separately from zero exit and stdio close", async (t) => {
  const outcome = await closeChild(t, joinedReceipt);
  assert.equal(outcome.clean_exit, true);
  assert.equal(outcome.close_observed, true);
  assert.equal(outcome.execution_completion.completion.evaluation_active_tickets, 4);
  assert.equal(outcome.execution_completion.provider_destruction_observed, false);
});

test("v2 public protocol child submits a scoreless legal move to loopback and closes the actual new game lineage", async (t) => {
  const fixtureToken = "continuous-public-protocol-fixture";
  const api = await startFakeLichessApi({ fixtureToken });
  const status = runtime(); status.opening_book_enabled = false;
  const state = new AuthoritativeChessState("startpos"); state.synchronize([]);
  const source = `import {createInterface} from 'node:readline';
const status=${JSON.stringify(status)};
const moves=${JSON.stringify(state.positionObservation().legal_moves)};
const emit=(v)=>process.stdout.write(v+'\\n');
createInterface({input:process.stdin}).on('line', line=>{
 if(line==='ucinewgame'){
  for(const k of ['continuous_search_lineage','continuous_worker_set_identity','continuous_focus_graph_epoch',
    'continuous_observation_execution_lineage','evaluation_service_lifetime_identity',
    'evaluation_queue_owner_lifetime_identity','model_cache_owner_lifetime_identity']) status[k]=typeof status[k]==='number'?2:'2';
 }else if(line==='isready') emit('readyok');
 else if(line==='runtime_status') emit('info string runtime_status_v1 '+JSON.stringify(status));
 else if(line==='move_decision_evidence') emit('info string move_decision_evidence_v1 '+JSON.stringify({
  schema:'uci_move_decision_evidence_v1',decision_authority:'none',evidence_current:true,
  continuous_search_lineage:'2',continuous_worker_set_identity:'2',candidate_count:moves.length,
  focus:{graph_epoch:'2',subject_identity:'1',position_key:'100',transition_sequence:1},candidates:moves.map(move=>({move}))}));
 else if(line.startsWith('go ')){
  emit('info string mcgs_decision_focus_graph_epoch 2 mcgs_decision_focus_subject_identity 1 mcgs_decision_focus_position_key 100 mcgs_decision_focus_transition_sequence 1 time_policy RelativeClockTemporalV1 time_completion_kind searched_decision time_opponent_remaining_ms 10000 time_opponent_increment_ms 0 time_temporal_weight_permille 1000 time_relative_surplus_ms 0 time_relative_credit_ms 0 time_relative_scheduled_ms 500 time_completion_applied 1');
  emit('bestmove e2e4');
 }else if(line==='quit'){
  emit('info string execution_completion_v1 '+JSON.stringify({schema:'uci_execution_completion_v1',decision_authority:'none',
   completion:${JSON.stringify({ ...joinedReceipt, execution_lineage: "2", graph_epoch: "2" })}}));
  process.stdin.destroy();
 }
});`;
  const engine = new UciEngine({ adapter: "uci_arena_extended_v1", qualification_profile: profile,
    uci_options: { SearchCore: "mcgs", OwnBook: false }, shutdown_grace_ms: 1000,
    timing: { opponent_turn_search: false } });
  engine.validateContinuousRuntimeContext = () => {};
  // This is public protocol conformance, not fabricated model or completed-profile qualification.
  engine.child = spawn(process.execPath, ["--input-type=module", "--eval", source], { windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] });
  const child = engine.child;
  engine.lines = createInterface({ input: child.stdout });
  engine.lines.on("line", (line) => engine.onLine(line));
  child.once("exit", (code) => engine.rejectWaiters(new Error(`fixture exit ${code}`)));
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  t.after(async () => {
    if (engine.child) await engine.close().catch(() => child.kill());
    await api.close();
  });
  engine.continuousObservation = continuousObservationFromRuntime(runtime());
  const session = new GameSession({ client: new LichessClient({ token: fixtureToken, baseUrl: api.origin }),
    config: { engine: engine.config, timing: { opponent_turn_search: false } }, account: "fixturearenabot",
    gameId: "continuous-fixture", signal: new AbortController().signal,
    slot: { id: "test-slot", audience: "bot", engine },
    store: { beginGame() {}, reconcileGameLine() {}, finishGame() {} } });
  const gameState = { type: "gameState", moves: "", status: "started", wtime: 10000, btime: 10000, winc: 0, binc: 0 };
  await session.initialize({ variant: { key: "standard" }, initialFen: "startpos", white: { id: "fixturearenabot" },
    black: { id: "fixtureopponent" }, clock: { initial: 10000, increment: 0 }, state: gameState }, engine);
  assert.equal(engine.continuousObservation, null, "genuine game boundary clears only the previous Bot observation baseline");
  await session.onState(gameState, engine);
  assert.deepEqual(api.state.moves, [{ gameId: "continuous-fixture", move: "e2e4", form: {} }]);
  assert.equal(engine.continuousObservation.execution_lineage, "2");
  assert.equal(engine.latestInfo.score, undefined);
  const close = await engine.close();
  assert.equal(close.clean_exit, true);
  assert.equal(close.execution_completion.completion.execution_lineage, "2");
});
