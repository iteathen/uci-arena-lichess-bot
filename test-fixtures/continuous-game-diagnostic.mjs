import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Chess } from "chess.js";
import { validateStoredProfile } from "@uci-arena/time-profile-contract";
import schema from "../contracts/continuous-game-diagnostic.schema.json" with { type: "json" };
import sourceClosure from "../contracts/continuous-game-diagnostic-source-closure.v1.json" with { type: "json" };

const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const file = (name) => ({ path: name, sha256: hash(readFileSync(name)) });
// Materialize structural fixture slots from the independently owned public producer schema.
// Semantic facts and the hand-checked fool's-mate history below remain literal test inputs.
function slots(node) {
  if (node.$ref) return slots(schema.$defs[node.$ref.split("/").at(-1)]);
  if (Object.hasOwn(node, "const")) return structuredClone(node.const);
  if (node.enum) return node.enum[0];
  if (node.anyOf) return slots(node.anyOf[0]);
  if (node.type === "object") return Object.fromEntries(Object.entries(node.properties ?? {})
    .map(([key, child]) => [key, slots(child)]));
  if (node.type === "array") return [];
  if (node.type === "boolean") return false;
  if (node.type === "number" || node.type === "integer") return 0;
  if (node.type === "null") return null;
  return "fixture";
}
const focus = (ply) => ({ graph_epoch: "1", subject_identity: String(ply + 1),
  position_key: String(100 + ply), transition_sequence: String(ply + 1) });
const positionCommand = (moves) => `position startpos${moves.length ? ` moves ${moves.join(" ")}` : ""}`;
const legalMoves = (chess) => chess.moves({ verbose: true }).map((move) =>
  `${move.from}${move.to}${move.promotion ?? ""}`).sort();
function rawFen(chess, moves) {
  const fields = chess.fen().split(" ");
  // Literal raw targets in the hand-checked four-ply fixture, independent of consumer logic.
  fields[3] = ({ e7e5: "e6", g2g4: "g3" })[moves.at(-1)] ?? "-";
  return fields.join(" ");
}
function observation(chess, moves) {
  const result = slots(schema.$defs.observation);
  Object.assign(result, { focus: focus(moves.length), admitted_fen: rawFen(chess, moves),
    accepted_position_command_sha256: hash(positionCommand(moves)), history_available: true,
    history_length: moves.length + 1, execution_lineage: "1", worker_set_identity: "1", execution_activations: "1",
    execution_active: true, execution_failed: false });
  Object.assign(result.search, { supported: true, lineage: "1", active_reservations: 3,
    reservation_capacity: 64, final_residue: null, stale_backups: 0,
    final_residue_available: false, completed_visits: 10 + moves.length, async_admissions: 10 + moves.length });
  Object.assign(result.evaluation, { supported: true, lifetime_identity: "1", queue_owner_lifetime_identity: "1",
    generation: "1", active_tickets: 4, peak_tickets: 5, pending_tickets: 2, executing_tickets: 2,
    ticket_capacity: 32, active_leases: 2, peak_leases: 3, cancellations: 0, executor_failures: 0,
    stale_publications: 0, submitted: 10 + moves.length, provider_batches: 10 + moves.length,
    lease_completions: 10 + moves.length, lease_abandons: 0, lease_capacity: null });
  Object.assign(result.cache, { supported: true, owner_lifetime_identity: "1", entries: 5,
    capacity: 128, policy_payload_bytes: 20, policy_payload_budget_bytes: 512,
    evictions: 0, eviction_deferrals: 0, drops: 0 });
  return result;
}
function publication(chess, moves, move) {
  const result = slots(schema.$defs.publication);
  const legal = legalMoves(chess);
  const state = focus(moves.length);
  Object.assign(result, { ply: moves.length + 1, move, elapsed_ms: 500, completion_source: "search",
    timing_applicability: "search_derived", native_focus: state, current_focus: state,
    position_key: state.position_key, canonical_legal_count: legal.length,
    publication_allowed_count: legal.length, policy_moves: legal.length, seeded_moves: 1 });
  Object.assign(result.candidates, { current: true, expanded: false, focus: state,
    execution_lineage: "1", worker_set_identity: "1", canonical_count: legal.length,
    candidate_count: legal.length, canonical_moves_sha256: hash(JSON.stringify(legal)),
    candidate_moves_sha256: hash(JSON.stringify(legal)), complete_legal_set: true });
  return result;
}
function game(color, history) {
  const result = slots(schema.$defs.game);
  Object.assign(result, { game_id: `fixture-${color}`, model_color: color, result: "0-1",
    termination: "checkmate", complete: true, problems: [] });
  const chess = new Chess();
  const prefix = [];
  result.startup_probe = slots(schema.$defs.probe);
  Object.assign(result.startup_probe, { observation: observation(chess, prefix),
    publication: publication(chess, prefix, color === "white" ? "f2f3" : "e2e4"),
    used_as_game_move: color === "white" });
  if (color === "white") result.startup_probe.publication = publication(chess, prefix, history[0]);
  for (const move of history) {
    const modelOwnsMove = (chess.turn() === "w") === (color === "white");
    if (modelOwnsMove) result.publications.push(publication(chess, prefix, move));
    chess.move({ from: move.slice(0, 2), to: move.slice(2, 4) });
    prefix.push(move);
    result.transitions.push({ ply: prefix.length, owner: modelOwnsMove ? "model" : "opponent", move,
      position_key: focus(prefix.length).position_key, fen: rawFen(chess, prefix),
      terminal: chess.isCheckmate() || chess.isStalemate() || chess.isDrawByFiftyMoves() || chess.isThreefoldRepetition(),
      observation: observation(chess, prefix), requested_ms: 500, publication_elapsed_ms: 500 });
  }
  result.moves = [...prefix];
  result.shutdown = slots(schema.$defs.shutdown);
  Object.assign(result.shutdown, { exit_code: 0, exit_signal: null, exit_observed: true, stdio_closed: true,
    forced: false, joined_search_safe: true, normal_process_close: true, provider_destruction_observed: false });
  Object.assign(result.shutdown.completion, { observed: true, disposition: "joined", execution_lineage: "1",
    graph_epoch: "1", execution_failed: false, reservation_residue: 0,
    stale_backups_discarded: 0, evaluation_active_tickets: 4, evaluation_active_async_leases: 0 });
  return result;
}

export function continuousDiagnosticFixture(options, history = ["f2f3", "e7e5", "g2g4", "d8h4"]) {
  const result = slots(schema);
  result.configuration.maximum_movetime_ratio = 1.5;
  result.configuration.maximum_movetime_grace_ms = 50;
  const producerRoot = path.join(path.dirname(options.complete_game_evidence), "producer");
  const producerEntry = path.join(producerRoot, "arena", "run_complete_game_matrix.mjs");
  mkdirSync(path.dirname(producerEntry), { recursive: true });
  writeFileSync(producerEntry, "// explicit synthetic public producer fixture\n");
  const source = file(producerEntry);
  const runtimeFingerprint = path.join(options.model_root, "deployment_source_fingerprint.json");
  const modelPayload = path.join(options.model_root, "model.onnx");
  const modelIoContract = path.join(options.model_root, "model_io_contract.yaml");
  writeFileSync(runtimeFingerprint, JSON.stringify({ fixture: true }));
  writeFileSync(modelPayload, "explicit-synthetic-model-fixture");
  writeFileSync(modelIoContract, "schema: explicit_synthetic_model_io_fixture\n");
  const time = validateStoredProfile(JSON.parse(readFileSync(options.time_profile)));
  const identity = time.identity;
  Object.assign(result.producer, { source_revision: "a".repeat(40), source_tree: "b".repeat(40), source_clean: true,
    entrypoint: source,
    source_files: [], node_runtime: file(process.execPath), node_version: process.versions.node });
  result.producer.source_files = sourceClosure.required_source_paths.map((relative) => {
    const target = path.join(producerRoot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    if (target !== producerEntry) writeFileSync(target, "explicit-synthetic-public-source-fixture\n");
    return { path: relative, sha256: file(target).sha256 };
  });
  Object.assign(result.binding.engine, { ...file(options.engine), uci_id_lines: ["id name fixture"],
    uci_option_declarations_sha256: hash("fixture-options"), arguments: [], working_directory: path.dirname(options.engine) });
  result.binding.opponent = structuredClone(result.binding.engine);
  result.binding.referee = { ...file(options.engine), arguments: [], working_directory: path.dirname(options.engine) };
  Object.assign(result.binding.model, { root: options.model_root, id: identity.model.model_id,
    fingerprint: identity.model.model_fingerprint, input_adapter_id: identity.model.adapter_id,
    provider: identity.search.provider_effective, provider_numeric_fingerprint: identity.provider.provider_numeric_fingerprint,
    hardware_driver_fingerprint: identity.provider.hardware_driver_fingerprint,
    onnx_runtime_version: identity.provider.onnx_runtime_version,
    files: [file(path.join(options.model_root, "checkpoint_manifest.json")), file(runtimeFingerprint), file(modelPayload), file(modelIoContract)],
    asset_declaration: { supported: true, selected_relative_file: "model.onnx",
      required_relative_files: ["checkpoint_manifest.json", "deployment_source_fingerprint.json", "model.onnx", "model_io_contract.yaml"] } });
  result.binding.effective_options = { model: { OwnBook: "false", Threads: "3", SearchCore: "mcgs",
    OnnxProvider: "directml", ModelRoot: options.model_root, NNBatchSize: "64", NNBatchWaitUs: "0",
    NNSpeculation: "false", RootWorkers: "1", V2SplitDepth: "2", BackgroundSearch: "false",
    SearchGraphMB: "64", McgsCpuctPermille: "1500", McgsOutstandingBatches: "2",
    McgsBookPriorBlendPermille: "0", McgsTimePolicy: "RelativeClockTemporalV1", McgsTemporalWeightProfile: "EarlyCurrent",
    IterativeTimeController: "false", TimeProfileProviderReserveUs: "2000",
    TimeProfileBackupEmitReserveUs: "1000", TimeProfileIterationForecastScalePermille: "1000" }, opponent: {} };
  Object.assign(result.binding.effective_options.model, { Ponder: "true", "Move Overhead": "250" });
  Object.assign(result.binding.timing_profile, { ...file(options.time_profile), schema: time.schema, identity_sha256: time.identity_sha256,
    accepted: true, applied: true, timing_authority_match: true, predictive_controller_enabled: false,
    validation_schema: "uci_time_profile_runtime_status_v1", validation_scope: "exact_runtime",
    searched_regime_timing_authority_match: true, whole_runtime_timing_authority_match: true,
    qualified_opening_book_enabled: false, configured_opening_book_enabled: false, ponder_option: true,
    book_prior_blend_permille: 0, move_overhead_ms: 250, move_overhead_envelope: structuredClone(time.applicability.move_overhead_ms),
    provider_service_reserve_us: time.calibration.provider_service_reserve_us,
    backup_emit_reserve_us: time.calibration.backup_emit_reserve_us,
    iteration_forecast_scale_permille: time.calibration.iteration_forecast_scale_permille,
    engine_provenance: { exact: true, executable_match: true, arguments_match: true,
      uci_identity_lines_match: true, uci_option_contract_match: true,
      qualified_executable_sha256: result.binding.engine.sha256, current_executable_sha256: result.binding.engine.sha256,
      qualified_engine_build_fingerprint: null, current_engine_build_fingerprint: null } });
  Object.assign(result.binding.knowledge, { opening_book_enabled: false, opening_book_active: false,
    opening_book_file: "", opening_book_stats_file: "", opening_book_policy_file: "",
    opening_book_snapshot_identity: "", opening_book_snapshot_generation: "",
    opening_book_manifest_sha256: "", opening_book_policy_sha256: "", opening_book_validation: "",
    opening_book_identity: "0", syzygy_path: "", syzygy_manifest: "", syzygy_manifest_identity: "",
    syzygy_manifest_file_sha256: null, syzygy_active: false, syzygy_rule50: true,
    syzygy_root_probe: true, syzygy_internal_probe: true, syzygy_loaded_cardinality: 0,
    syzygy_probe_limit: 0, syzygy_probe_threads: 2, files: [] });
  result.games = [game("white", history), game("black", history)];
  Object.assign(result.resource_isolation, { schema: "uci_arena_gpu_resource_isolation_v1", interval_id: "fixture",
    shared_diagnostic: true, qualification_scope: "correctness_and_deadline_only", report_sha256: hash("fixture-isolation"),
    finalized: true, can_run: true,
    problems: [], performance_authority: false, strength_authority: false });
  Object.assign(result, { failures: [], completed: true, completed_at: "2026-10-07T00:00:00Z" });
  return result;
}
