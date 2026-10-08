import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import artifactSchema from "./contracts/continuous-game-diagnostic.schema.json" with { type: "json" };
import sourceClosure from "./contracts/continuous-game-diagnostic-source-closure.v1.json" with { type: "json" };
import { AuthoritativeChessState } from "./chess-legality.mjs";
import { hashExactFileSync, readExactJsonSync } from "./exact-file.mjs";

export const CONTINUOUS_DIAGNOSTIC_SCHEMA = "uci_continuous_complete_game_diagnostic_v1";
export const CONTINUOUS_PROFILE_SCHEMA = "uci_arena_single_game_profile_v2";
export const CONTINUOUS_AUTHORITY = Object.freeze({ diagnostic: true, timing: false, strength: false,
  performance: false, release: false, retention: false });
const LIMIT = 16 * 1024 * 1024;
const EXACT_FILES = Object.freeze({ hashExactFileSync, readExactJsonSync });
const SHA = /^sha256:[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
export const digestText = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const fail = (message) => { throw new Error(`Continuous local-live qualification: ${message}`); };
export const requireContinuous = (condition, message) => { if (!condition) fail(message); };
const same = (actual, expected, label) => requireContinuous(actual === expected, `${label} mismatch`);
const number = (value, label) => requireContinuous(Number.isSafeInteger(value) && value >= 0, `${label} is unknown or unsafe`);
const identity = (value, label) => requireContinuous(typeof value === "string" && DECIMAL.test(value)
  && value !== "0" && BigInt(value) <= 0xffff_ffff_ffff_ffffn, `${label} is not a supported lossless identity`);
export function equalFocus(actual, expected) {
  return ["graph_epoch", "subject_identity", "position_key", "transition_sequence"]
    .every((key) => actual?.[key] === expected?.[key]);
}
export function canonicalMoveDigest(moves) {
  requireContinuous(Array.isArray(moves) && new Set(moves).size === moves.length
    && moves.every((move) => typeof move === "string" && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)),
  "candidate move set is malformed or duplicated");
  return digestText(JSON.stringify([...moves].sort()));
}
// Deliberately limited to the pinned producer schema's vocabulary; unsupported evolution fails closed.
function shape(value, node, location = "artifact") {
  const vocabulary = ["$schema", "$id", "$defs", "$ref", "anyOf", "allOf", "const", "enum", "type", "minimum", "maximum",
    "pattern", "items", "maxItems", "maxLength", "properties", "required", "additionalProperties", "maxProperties"];
  requireContinuous(node && Object.keys(node).every((key) => vocabulary.includes(key)), "public schema vocabulary is unsupported");
  if (node.maxLength !== undefined) requireContinuous(typeof value === "string"
    && Array.from(value).length <= node.maxLength, `${location} string exceeds its bound`);
  if (node.$ref) return shape(value, artifactSchema.$defs[node.$ref.split("/").at(-1)], location);
  if (node.allOf) for (const branch of node.allOf) shape(value, branch, location);
  if (node.anyOf) {
    for (const branch of node.anyOf) {
      try { shape(value, branch, location); return; } catch {}
    }
    fail(`${location} does not match its public contract`);
  }
  if (Object.hasOwn(node, "const")) same(JSON.stringify(value), JSON.stringify(node.const), location);
  if (node.enum) requireContinuous(node.enum.some((item) => item === value), `${location} has an unknown value`);
  if (node.type === "null") same(value, null, location);
  if (node.type === "boolean" || node.type === "string") same(typeof value, node.type, location);
  if (node.type === "number") requireContinuous(typeof value === "number" && Number.isFinite(value), `${location} is not finite`);
  if (node.type === "integer") number(value, location);
  if (node.minimum !== undefined) requireContinuous(value >= node.minimum, `${location} is below its bound`);
  if (node.maximum !== undefined) requireContinuous(value <= node.maximum, `${location} exceeds its bound`);
  if (node.pattern) requireContinuous(new RegExp(node.pattern).test(value), `${location} has invalid syntax`);
  if (node.type === "array") {
    requireContinuous(Array.isArray(value) && value.length <= (node.maxItems ?? Number.MAX_SAFE_INTEGER), `${location} array exceeds its bound`);
    for (const [index, item] of value.entries()) shape(item, node.items, `${location}[${index}]`);
  }
  if (node.type === "object") {
    requireContinuous(value !== null && typeof value === "object" && !Array.isArray(value), `${location} is not an object`);
    requireContinuous(Object.keys(value).length <= (node.maxProperties ?? Number.MAX_SAFE_INTEGER), `${location} has too many properties`);
    for (const field of node.required ?? []) requireContinuous(Object.hasOwn(value, field), `${location}.${field} is missing`);
    for (const [key, item] of Object.entries(value)) {
      if (node.properties?.[key]) shape(item, node.properties[key], `${location}.${key}`);
      else if (node.additionalProperties === false) fail(`${location}.${key} is not in the public contract`);
      else if (typeof node.additionalProperties === "object") shape(item, node.additionalProperties, `${location}.${key}`);
    }
  }
}
function gauge(value, capacity, label) {
  number(value, label); number(capacity, `${label} capacity`);
  requireContinuous(capacity > 0 && value <= capacity, `${label} exceeds its native capacity`);
}
export function validateContinuousObservation(current, previous = null) {
  shape(current, artifactSchema.$defs.observation, "observation");
  same(current.execution_active, true, "continuous execution active");
  same(current.execution_failed, false, "continuous execution failure");
  for (const field of ["execution_lineage", "worker_set_identity", "execution_activations"]) identity(current[field], field);
  for (const field of ["graph_epoch", "subject_identity", "transition_sequence"]) identity(current.focus[field], `focus ${field}`);
  requireContinuous(DECIMAL.test(current.focus.position_key)
    && BigInt(current.focus.position_key) <= 0xffff_ffff_ffff_ffffn, "focus key is not lossless");
  requireContinuous(BigInt(current.focus.transition_sequence) <= 0xffff_ffffn, "focus sequence exceeds UInt32");
  same(current.history_available, true, "canonical history availability");
  same(current.search.supported, true, "search resource observation support");
  same(current.search.lineage, current.execution_lineage, "search resource lineage");
  gauge(current.search.active_reservations, current.search.reservation_capacity, "search reservations");
  same(current.search.stale_backups, 0, "stale graph backups");
  same(current.search.final_residue_available, false, "active search final residue availability");
  same(current.search.final_residue, null, "active search final residue unknownness");
  number(current.search.async_admissions, "canonical async graph admissions");
  same(current.evaluation.supported, true, "evaluation observation support");
  for (const field of ["lifetime_identity", "queue_owner_lifetime_identity", "generation"]) identity(current.evaluation[field], `evaluation ${field}`);
  same(current.evaluation.queue_owner_lifetime_identity, current.evaluation.lifetime_identity, "fixed queue container owner");
  same(current.cache.owner_lifetime_identity, current.evaluation.lifetime_identity, "fixed cache container owner");
  for (const field of ["active_tickets", "peak_tickets", "pending_tickets", "executing_tickets"])
    gauge(current.evaluation[field], current.evaluation.ticket_capacity, `evaluation ${field}`);
  for (const field of ["active_leases", "peak_leases", "submitted", "provider_batches", "lease_completions", "cancellations", "lease_abandons"]) number(current.evaluation[field], `evaluation ${field}`);
  for (const field of ["executor_failures", "stale_publications"])
    same(current.evaluation[field], 0, `evaluation ${field}`);
  same(current.evaluation.lease_capacity, null, "undeclared universal lease capacity");
  same(current.cache.supported, true, "cache observation support");
  identity(current.cache.owner_lifetime_identity, "cache lifetime");
  gauge(current.cache.entries, current.cache.capacity, "cache entries");
  gauge(current.cache.policy_payload_bytes, current.cache.policy_payload_budget_bytes, "cache policy bytes");
  number(current.cache.evictions, "cache evictions"); number(current.cache.eviction_deferrals, "cache deferrals"); number(current.cache.drops, "cache drops");
  if (previous) {
    for (const field of ["execution_lineage", "worker_set_identity", "execution_activations"]) same(current[field], previous[field], field);
    same(current.focus.graph_epoch, previous.focus.graph_epoch, "graph lifetime");
    same(current.search.reservation_capacity, previous.search.reservation_capacity, "declared reservation capacity changed");
    same(current.evaluation.ticket_capacity, previous.evaluation.ticket_capacity, "declared ticket capacity changed");
    same(current.cache.capacity, previous.cache.capacity, "declared cache capacity changed");
    same(current.cache.policy_payload_budget_bytes, previous.cache.policy_payload_budget_bytes, "declared payload budget changed");
    for (const field of ["lifetime_identity", "queue_owner_lifetime_identity"]) same(current.evaluation[field], previous.evaluation[field], field);
    same(current.cache.owner_lifetime_identity, previous.cache.owner_lifetime_identity, "cache lifetime");
    same(current.evaluation.generation, previous.evaluation.generation, "evaluation generation changed");
  }
  return current;
}
export function validateContinuousShutdown(shutdown, observed) {
  shape(shutdown, artifactSchema.$defs.shutdown, "shutdown");
  const completion = shutdown.completion;
  requireContinuous(completion !== null, "native completion receipt is missing");
  same(completion.observed, true, "native completion observation");
  same(completion.disposition, "joined", "native completion disposition");
  same(completion.execution_lineage, observed.execution_lineage, "native completion lineage");
  same(completion.graph_epoch, observed.focus.graph_epoch, "native completion graph epoch");
  same(completion.execution_failed, false, "native completion failure");
  same(completion.reservation_residue, 0, "final graph reservation residue");
  same(completion.stale_backups_discarded, 0, "final stale graph backups");
  same(completion.evaluation_active_async_leases, 0, "final async leases");
  gauge(completion.evaluation_active_tickets, observed.evaluation.ticket_capacity, "final observed evaluation tickets");
  for (const field of ["exit_observed", "stdio_closed", "joined_search_safe", "normal_process_close"]) same(shutdown[field], true, field);
  same(shutdown.exit_code, 0, "child exit code"); same(shutdown.exit_signal, null, "child exit signal");
  same(shutdown.forced, false, "forced child cleanup"); same(shutdown.provider_destruction_observed, false, "provider destruction authority");
  return shutdown;
}
export function validateContinuousElapsed(elapsed, requested, configuration) {
  requireContinuous(typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0
    && elapsed <= requested * configuration.maximum_movetime_ratio + configuration.maximum_movetime_grace_ms,
  "publication exceeded declared diagnostic movetime tolerance");
}
function validatePublication(record, state, moves, observed, knowledge, configuration, requireExactObservedFocus = false) {
  const canonical = state.positionObservation();
  same(record.ply, moves.length + 1, "selected publication ply");
  validateContinuousElapsed(record.elapsed_ms, record.requested_ms, configuration);
  same(record.position_key, observed.focus.position_key, "publication canonical key");
  const publishedFocus = record.current_focus;
  for (const field of ["graph_epoch", "subject_identity", "transition_sequence"]) identity(publishedFocus[field], `publication ${field}`);
  requireContinuous(DECIMAL.test(publishedFocus.position_key)
    && BigInt(publishedFocus.position_key) <= 0xffff_ffff_ffff_ffffn
    && BigInt(publishedFocus.transition_sequence) <= 0xffff_ffffn, "publication focus is outside its lossless native domain");
  requireContinuous(["graph_epoch", "subject_identity", "position_key"].every((field) => publishedFocus[field] === observed.focus[field]),
    "publication current node differs from admitted focus");
  requireContinuous(BigInt(publishedFocus.transition_sequence) >= BigInt(observed.focus.transition_sequence),
    "publication sequence precedes canonical admission");
  if (requireExactObservedFocus) requireContinuous(equalFocus(publishedFocus, observed.focus), "startup publication focus differs from its captured observation");
  if (record.native_focus !== null) requireContinuous(equalFocus(record.native_focus, publishedFocus), "native publication focus mismatch");
  requireContinuous(state.validateCandidate(moves, record.move).legal, "publication move is illegal at the canonical root");
  const candidates = record.candidates;
  same(candidates.current, true, "candidate currentness");
  same(candidates.complete_legal_set, true, "complete candidate eligibility");
  requireContinuous(equalFocus(candidates.focus, publishedFocus), "candidate focus mismatch");
  same(candidates.execution_lineage, observed.execution_lineage, "candidate lineage");
  same(candidates.worker_set_identity, observed.worker_set_identity, "candidate worker identity");
  same(candidates.canonical_count, canonical.legal_moves.length, "canonical candidate count");
  same(candidates.candidate_count, canonical.legal_moves.length, "native candidate count");
  const digest = canonicalMoveDigest(canonical.legal_moves);
  same(candidates.canonical_moves_sha256, digest, "canonical legal move digest");
  same(candidates.candidate_moves_sha256, digest, "native legal move digest");
  same(record.canonical_legal_count, canonical.legal_moves.length, "publication legal count");
  requireContinuous(!["unknown"].includes(record.completion_source), "publication completion source is unknown");
  if (record.timing_applicability === "search_derived") {
    requireContinuous(["search", "fallback"].includes(record.completion_source), "searched applicability has a conflicting source");
    requireContinuous(record.native_focus !== null, "native search publication focus is missing");
    requireContinuous(Number.isSafeInteger(record.publication_allowed_count)
      && record.publication_allowed_count > 0 && record.publication_allowed_count <= canonical.legal_moves.length,
    "publication candidate constraint is invalid");
    for (const field of ["policy_moves", "seeded_moves"]) number(record[field], field);
    requireContinuous(record.seeded_moves <= record.policy_moves && record.policy_moves <= record.publication_allowed_count,
      "policy or completed seed count exceeds actual allowed candidates");
  } else {
    same(record.timing_applicability, "non_search_resolved", "timing applicability");
    requireContinuous(["opening_book", "tablebase", "sole_legal"].includes(record.completion_source), "non-search resolution source is invalid");
    if (record.completion_source === "sole_legal") same(canonical.legal_moves.length, 1, "sole-legal resolution");
    if (record.completion_source === "opening_book") requireContinuous(knowledge.opening_book_enabled
      && knowledge.opening_book_active, "book resolution has no qualified active book");
    if (record.completion_source === "tablebase") same(knowledge.syzygy_active, true, "tablebase resolution authority");
  }
}
function validateGame(game, expectedColor, knowledge, configuration) {
  same(game.model_color, expectedColor, "paired game color");
  same(game.complete, true, "complete actual game");
  requireContinuous(game.problems.length === 0, "game has qualification failures");
  requireContinuous(game.moves.length > 0 && game.transitions.length === game.moves.length, "game history or transitions are incomplete");
  const state = new AuthoritativeChessState("startpos");
  state.synchronize([]);
  requireContinuous(game.startup_probe !== null, "startup probe is missing");
  let previous = validateContinuousObservation(game.startup_probe.observation);
  same(previous.admitted_fen, state.positionObservation().fen, "startup admitted FEN");
  same(previous.accepted_position_command_sha256, digestText("position startpos"), "startup accepted request");
  same(previous.history_length, 1, "startup repetition prefix length");
  validatePublication(game.startup_probe.publication, state, [], previous, knowledge, configuration, true);
  same(game.startup_probe.used_as_game_move, expectedColor === "white", "startup publication game use");
  if (expectedColor === "white") {
    same(game.startup_probe.publication.move, game.moves[0], "consumed startup move");
    requireContinuous(isDeepStrictEqual(game.startup_probe.publication, game.publications[0]), "consumed startup publication facts differ");
  }
  let modelPly = 0;
  for (let index = 0; index < game.moves.length; index += 1) {
    const moves = game.moves.slice(0, index);
    const modelMove = (index % 2 === 0) === (expectedColor === "white");
    let publication = null;
    if (modelMove) {
      publication = game.publications[modelPly++];
      requireContinuous(publication !== undefined, "model publication is missing");
      same(publication.move, game.moves[index], "actual applied publication");
      validatePublication(publication, state, moves, previous, knowledge, configuration);
    }
    state.synchronize(game.moves.slice(0, index + 1));
    const canonical = state.positionObservation();
    const transition = game.transitions[index];
    validateContinuousElapsed(transition.publication_elapsed_ms, transition.requested_ms, configuration);
    same(transition.ply, index + 1, "accepted transition ply");
    same(transition.owner, modelMove ? "model" : "opponent", "transition owner");
    same(transition.move, game.moves[index], "accepted transition move");
    same(transition.fen, canonical.fen, "accepted canonical FEN");
    const refereeTerminal = ["checkmate", "stalemate", "fifty_move_rule", "threefold_repetition"]
      .some((reason) => canonical.terminal_conditions[reason]);
    same(transition.terminal, refereeTerminal, "accepted terminal truth");
    requireContinuous(!refereeTerminal || index === game.moves.length - 1,
      "game continued after its first canonical terminal transition");
    const current = validateContinuousObservation(transition.observation, previous);
    requireContinuous(BigInt(current.focus.transition_sequence) > BigInt(publication?.current_focus.transition_sequence ?? previous.focus.transition_sequence),
      "canonical transition does not follow its preceding publication/admission sequence");
    same(current.admitted_fen, canonical.fen, "native admitted FEN");
    same(current.focus.position_key, transition.position_key, "native admitted canonical key");
    same(current.accepted_position_command_sha256,
      digestText(`position startpos moves ${game.moves.slice(0, index + 1).join(" ")}`), "accepted complete history request");
    same(current.history_length, index + 2, "accepted repetition prefix length");
    previous = current;
  }
  same(modelPly, game.publications.length, "model publication completeness");
  const terminal = state.positionObservation();
  requireContinuous(["checkmate", "stalemate", "fifty_move_rule", "threefold_repetition"].includes(game.termination),
    "canonical terminal reason is unsupported");
  same(terminal.terminal_conditions[game.termination], true, "declared canonical terminal reason");
  if (game.termination !== "checkmate") same(terminal.terminal_conditions.checkmate, false, "checkmate precedence");
  same(game.result, game.termination === "checkmate" ? terminal.result : "1/2-1/2", "canonical terminal result");
  requireContinuous(game.result !== "*", "game is incomplete");
  const observations = [game.startup_probe.observation, ...game.transitions.map((item) => item.observation)];
  requireContinuous(observations.some((item) => item.search.async_admissions > 0), "actual game admitted no async graph work");
  for (const field of ["submitted", "provider_batches", "lease_completions"])
    requireContinuous(observations.some((item) => item.evaluation[field] > 0), `actual game has no ${field}`);
  validateContinuousShutdown(game.shutdown, previous);
}
function exactFile(binding, label, maximumBytes = 16 * 1024 * 1024 * 1024, files = EXACT_FILES) {
  requireContinuous(typeof binding?.path === "string" && path.isAbsolute(binding.path) && SHA.test(binding.sha256), `${label} binding is malformed`);
  same(files.hashExactFileSync(binding.path, { maximumBytes, label }).sha256, binding.sha256, `${label} file bytes`);
}
export function safePublicPath(value, label) {
  requireContinuous(typeof value === "string" && value.length > 0 && value.length <= 32768
    && !/[\u0000\r\n]/.test(value), `${label} public path is invalid`);
  const drivePrefixLength = /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0;
  requireContinuous(!value.slice(drivePrefixLength).includes(":"), `${label} forbidden colon or alternate-stream path`);
  const parts = value.replaceAll("\\", "/").split("/");
  requireContinuous(!parts.some((part) => /[. ]$/.test(part)), `${label} ambiguous trailing-dot/space path segment`);
  requireContinuous(!parts.some((part) =>
    /^(?:secrets?|credentials?|tokens?|private|signing|client[_-]?keys?)(?:[._-]|$)/i.test(part)
    || /^\.(?:git|env|ssh|aws|azure|gcp)(?:\.|$)/i.test(part)
    || /^(?:lichess_bot_token\.txt|auth\.json)$/i.test(part)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(part)
    || /(?:^|[^a-z0-9])(?:token|secret|password|credential|private[_-]?key|client[_-]?key|signing[_-]?key)(?:[^a-z0-9]|$)/i.test(part)),
  `${label} forbidden credential or private path`);
}
export function samePublicPath(left, right, workingDirectory = process.cwd()) {
  const canonical = (value) => {
    const absolute = path.resolve(workingDirectory, value);
    return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute;
  };
  return canonical(left) === canonical(right);
}
export function validateContinuousLaunchContext(binding, configuration) {
  requireContinuous(binding && configuration && typeof configuration.working_directory === "string",
    "current launch context is unavailable");
  requireContinuous(samePublicPath(configuration.executable, binding.engine.path)
    && samePublicPath(configuration.working_directory, binding.engine.working_directory),
  "actual executable or working directory differs from the qualified launch context");
  requireContinuous(isDeepStrictEqual(configuration.arguments ?? [], binding.engine.arguments),
    "actual literal argument vector differs from the qualified launch context");
  requireContinuous(typeof configuration.uci_options?.ModelRoot === "string"
    && samePublicPath(configuration.uci_options.ModelRoot, binding.model.root, configuration.working_directory),
  "actual configured model root differs from the qualified package");
}
export function validateContinuousPublicPaths(binding) {
  for (const name of ["engine", "opponent", "referee"]) {
    safePublicPath(binding[name].path, `${name} executable`);
    safePublicPath(binding[name].working_directory, `${name} working directory`);
  }
  safePublicPath(binding.model.root, "model root");
  const requiredModelFiles = validateModelAssetDeclaration(binding.model.asset_declaration);
  for (const item of binding.model.files) {
    safePublicPath(item.path, "model package asset");
    const relative = path.relative(path.resolve(binding.model.root), path.resolve(item.path));
    requireContinuous(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative) && publicModelAsset(relative.replaceAll("\\", "/"), requiredModelFiles.includes(relative.replaceAll("\\", "/"))),
    "model public asset is outside its package or has a forbidden type");
  }
  requireContinuous(binding.knowledge !== null && binding.timing_profile !== null, "knowledge/timing binding is missing");
  safePublicPath(binding.timing_profile.path, "timing evidence");
  for (const field of ["opening_book_file", "opening_book_stats_file", "opening_book_policy_file", "syzygy_path", "syzygy_manifest"]) {
    if (binding.knowledge[field]) safePublicPath(binding.knowledge[field], `knowledge ${field}`);
  }
  const bookPaths = [binding.knowledge.opening_book_file, binding.knowledge.opening_book_stats_file,
    binding.knowledge.opening_book_policy_file].filter(Boolean);
  if (binding.knowledge.opening_book_file) bookPaths.push(path.join(path.dirname(binding.knowledge.opening_book_file), "snapshot.manifest.json"));
  for (const item of binding.knowledge.files) {
    safePublicPath(item.path, "book asset");
    requireContinuous(path.isAbsolute(item.path) && bookPaths.some((candidate) => samePublicPath(candidate, item.path,
      binding.engine.working_directory)), "book closure has a file outside its configured public asset set");
  }
  if (binding.knowledge.syzygy_manifest) {
    requireContinuous(path.extname(binding.knowledge.syzygy_manifest).toLowerCase() === ".json", "tablebase manifest has a forbidden type");
    const relative = path.relative(path.resolve(binding.knowledge.syzygy_path), path.resolve(binding.knowledge.syzygy_manifest));
    requireContinuous(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      "tablebase manifest escapes its configured public asset root");
  }
}
export function validateModelAssetDeclaration(value) {
  requireContinuous(value?.supported === true && typeof value.selected_relative_file === "string"
    && Array.isArray(value.required_relative_files) && value.required_relative_files.length > 0
    && value.required_relative_files.length <= 32, "native model asset declaration is unsupported or missing");
  for (const relative of [value.selected_relative_file, ...value.required_relative_files]) {
    safePublicPath(relative, "declared model input");
    requireContinuous(relative.length <= 1024 && !path.isAbsolute(relative) && !/^[A-Za-z]:/.test(relative)
      && !relative.includes("\\") && !relative.includes(":") && relative.split("/").every((segment) => segment && segment !== "." && segment !== "..")
      && publicModelAsset(relative, true), "declared model input is not a safe public relative package asset");
  }
  requireContinuous(new Set(value.required_relative_files).size === value.required_relative_files.length
    && value.required_relative_files.includes(value.selected_relative_file)
    && path.extname(value.selected_relative_file).toLowerCase() === ".onnx",
  "native selected model input is missing or ambiguous");
  return value.required_relative_files;
}
function publicModelAsset(relative, declaredRequired = false) {
  if (!declaredRequired) return artifactSchema.$defs.model_package_metadata_relative_path?.enum.includes(relative) === true;
  return [".json", ".onnx", ".bin"].includes(path.extname(relative).toLowerCase())
    || relative === "model_io_contract.yaml";
}
export function validateNativeModelAssets(status, model) {
  const actual = { supported: status.model_asset_declaration_supported,
    selected_relative_file: status.model_selected_artifact, required_relative_files: status.model_required_artifacts };
  validateModelAssetDeclaration(actual);
  requireContinuous(actual.selected_relative_file === model.asset_declaration.selected_relative_file
    && isDeepStrictEqual([...actual.required_relative_files].sort(), [...model.asset_declaration.required_relative_files].sort()),
  "actual native selected model/required inputs differ from qualification");
}

function publicSourceClosure(producer, files) {
  same(producer.source_clean, true, "clean qualified tool source");
  requireContinuous(typeof producer.source_revision === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(producer.source_revision)
    && typeof producer.source_tree === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(producer.source_tree),
  "declared source revision/tree is missing");
  safePublicPath(producer.entrypoint.path, "producer entrypoint");
  safePublicPath(producer.node_runtime.path, "producer runtime");
  requireContinuous(path.isAbsolute(producer.entrypoint.path)
    && path.basename(producer.entrypoint.path) === "run_complete_game_matrix.mjs"
    && path.basename(path.dirname(producer.entrypoint.path)) === "arena", "public producer entrypoint layout is invalid");
  const sourceRoot = path.dirname(path.dirname(producer.entrypoint.path));
  requireContinuous(producer.source_files.length > 0, "producer source closure is missing");
  const admitted = producer.source_files.map((item) => {
    safePublicPath(item.path, "producer source");
    const relative = item.path.replaceAll("\\", "/");
    requireContinuous(!path.isAbsolute(item.path) && !/^[A-Za-z]:/.test(item.path)
      && !relative.split("/").some((part) => !part || part === "." || part === "..")
      && /^(arena|contracts|specs|packages|engine|tools)\//.test(relative)
      && /\.(mjs|json|yaml|yml|py|cpp|hpp|h)$/.test(relative), "public source closure path is forbidden or outside");
    const target = path.resolve(sourceRoot, item.path);
    const containment = path.relative(sourceRoot, target);
    requireContinuous(containment && containment !== ".." && !containment.startsWith(`..${path.sep}`)
      && !path.isAbsolute(containment), "public source closure escapes its owner root");
    return { path: target, sha256: item.sha256 };
  });
  requireContinuous(new Set(admitted.map((item) => item.path)).size === admitted.length, "source closure has duplicate files");
  requireContinuous(isDeepStrictEqual(producer.source_files.map((item) => item.path.replaceAll("\\", "/")).sort(),
    sourceClosure.required_source_paths), "public source closure membership differs from its pinned owner declaration");
  requireContinuous(admitted.some((item) => path.resolve(item.path) === path.resolve(producer.entrypoint.path)
    && item.sha256 === producer.entrypoint.sha256), "public entrypoint is missing from source closure");
  // Validate every listed path before opening any file. Exact-file then proves non-link physical containment.
  for (const item of admitted) exactFile(item, "Qualified public producer source", 64 * 1024 * 1024, files);
  safePublicPath(producer.node_runtime.path, "producer runtime");
  exactFile(producer.node_runtime, "Qualified producer runtime", 1024 * 1024 * 1024, files);
}
export function validateContinuousGameDiagnostic(value, { executableSha, modelRoot, identity: timedIdentity, timeProfile, timeProfileSha,
  fileAuthority = EXACT_FILES }) {
  shape(value, artifactSchema);
  requireContinuous(value.completed === true && value.failures.length === 0 && value.binding !== null,
    "complete diagnostic evidence is missing or failed");
  requireContinuous(typeof value.completed_at === "string" && Number.isFinite(Date.parse(value.completed_at)), "completion timestamp is invalid");
  const isolation = value.resource_isolation;
  requireContinuous(isolation?.schema === "uci_arena_gpu_resource_isolation_v1" && isolation.finalized === true
    && isolation.can_run === true && isolation.interval_id.length > 0, "owning resource report is unavailable, unfinalized or denied");
  if (isolation.shared_diagnostic) same(isolation.qualification_scope, "correctness_and_deadline_only", "shared diagnostic scope");
  else requireContinuous(isolation.qualification_scope === "performance_and_strength" && isolation.problems.length === 0,
    "isolated owning resource report has no clean isolated authority");
  validateContinuousPublicPaths(value.binding);
  publicSourceClosure(value.producer, fileAuthority);
  const binding = value.binding;
  same(binding.engine.sha256, executableSha, "exact current executable");
  for (const [name, tool] of [["engine", binding.engine], ["opponent", binding.opponent], ["referee", binding.referee]]) {
    safePublicPath(tool.path, `diagnostic ${name}`);
    safePublicPath(tool.working_directory, `diagnostic ${name} working directory`);
    exactFile(tool, `Diagnostic ${name}`, undefined, fileAuthority);
  }
  requireContinuous(samePublicPath(binding.model.root, modelRoot), "model package root mismatch");
  const model = binding.model;
  for (const [actual, expected, label] of [
    [model.id, timedIdentity.model.model_id, "model id"], [model.fingerprint, timedIdentity.model.model_fingerprint, "model fingerprint"],
    [model.input_adapter_id, timedIdentity.model.adapter_id, "model adapter"], [model.provider, timedIdentity.search.provider_effective, "actual GPU provider"],
    [model.provider_numeric_fingerprint, timedIdentity.provider.provider_numeric_fingerprint, "provider numeric identity"],
    [model.hardware_driver_fingerprint, timedIdentity.provider.hardware_driver_fingerprint, "hardware/driver"],
    [model.onnx_runtime_version, timedIdentity.provider.onnx_runtime_version, "ONNX runtime"],
  ]) same(actual, expected, label);
  requireContinuous(["checkpoint_manifest.json", "deployment_source_fingerprint.json"].every((name) =>
    model.files.some((item) => path.basename(item.path) === name))
    && model.files.some((item) => path.extname(item.path).toLowerCase() === ".onnx"),
  "required public model/checkpoint/runtime file closure is missing");
  const requiredFiles = validateModelAssetDeclaration(model.asset_declaration);
  const availableFiles = model.files.map((item) => path.relative(path.resolve(modelRoot), path.resolve(item.path)).replaceAll("\\", "/"));
  requireContinuous(new Set(availableFiles).size === availableFiles.length
    && requiredFiles.every((relative) => availableFiles.includes(relative)), "declared model input closure is missing or duplicated");
  for (const item of model.files) {
    const relative = path.relative(path.resolve(modelRoot), path.resolve(item.path));
    requireContinuous(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "model file escapes package root");
    safePublicPath(item.path, "model package");
    requireContinuous(publicModelAsset(relative.replaceAll("\\", "/"), requiredFiles.includes(relative.replaceAll("\\", "/"))), "model file is not a declared public package asset");
    exactFile(item, "Diagnostic model package", undefined, fileAuthority);
  }
  const timing = binding.timing_profile;
  requireContinuous(timing !== null && timing.accepted === true && timing.applied === true
    && timing.predictive_controller_enabled === false, "timing profile was not accepted and applied");
  same(timing.sha256, timeProfileSha, "timing profile exact bytes"); same(timing.identity_sha256, timeProfile.identity_sha256, "timing semantic identity");
  for (const field of ["provider_service_reserve_us", "backup_emit_reserve_us", "iteration_forecast_scale_permille"])
    same(timing[field], timeProfile.calibration[field], `applied ${field}`);
  same(timing.engine_provenance.current_executable_sha256, executableSha, "current timing executable provenance");
  requireContinuous(binding.knowledge !== null, "configured knowledge observation is missing");
  const knowledge = binding.knowledge;
  same(timing.configured_opening_book_enabled, knowledge.opening_book_enabled, "actual configured timing book applicability");
  same(timing.qualified_opening_book_enabled, timedIdentity.search.opening_book, "qualified timing book regime");
  same(timing.ponder_option, true, "actual Ponder publication compatibility");
  same(timing.book_prior_blend_permille, timedIdentity.search.mcgs.book_prior_blend_permille, "qualified timing book prior blend");
  requireContinuous(isDeepStrictEqual(timing.move_overhead_envelope, timeProfile.applicability.move_overhead_ms)
    && timing.move_overhead_ms >= timing.move_overhead_envelope.minimum
    && timing.move_overhead_ms <= timing.move_overhead_envelope.maximum, "actual transport overhead is outside qualified applicability");
  same(timing.searched_regime_timing_authority_match, true, "searched timing regime match");
  same(timing.schema, timeProfile.schema, "timing profile schema");
  if (timing.validation_scope === "historical_searched_regime" || timing.validation_scope === "continuous_searched_regime") {
    const continuous = timing.validation_scope === "continuous_searched_regime";
    same(timeProfile.schema, continuous ? "uci_time_profile_v4" : "uci_time_profile_v3", "declared searched timing regime schema");
    same(timing.validation_schema, continuous ? "uci_time_profile_continuous_searched_regime_runtime_status_v1"
      : "uci_time_profile_searched_regime_runtime_status_v1", "scoped timing public schema");
    same(timing.qualified_opening_book_enabled, false, "historical searched book regime");
    same(timing.book_prior_blend_permille, 0, "unchanged searched prior blend");
    same(timing.whole_runtime_timing_authority_match, !knowledge.opening_book_enabled, "whole actual timing context match");
  } else {
    requireContinuous(["uci_time_profile_v3", "uci_time_profile_v4"].includes(timeProfile.schema), "exact timing profile schema is unsupported");
    same(timing.validation_scope, "exact_runtime", "timing validation scope");
    same(timing.validation_schema, "uci_time_profile_runtime_status_v1", "exact timing public schema");
    same(timing.configured_opening_book_enabled, timing.qualified_opening_book_enabled, "exact timing book regime");
    same(timing.whole_runtime_timing_authority_match, true, "whole actual timing context match");
  }
  same(timing.timing_authority_match, timing.whole_runtime_timing_authority_match, "legacy whole timing label");
  for (const item of knowledge.files) { safePublicPath(item.path, "book asset"); exactFile(item, "Diagnostic book asset", undefined, fileAuthority); }
  const options = binding.effective_options.model;
  same(options.Ponder, "true", "effective Ponder publication compatibility");
  same(options["Move Overhead"], String(timing.move_overhead_ms), "effective transport overhead");
  const expected = { SearchCore: "mcgs", Threads: String(timedIdentity.search.threads), RootWorkers: String(timedIdentity.search.root_workers),
    V2SplitDepth: String(timedIdentity.search.split_depth), NNBatchSize: String(timedIdentity.search.batch_size_effective),
    NNBatchWaitUs: String(timedIdentity.search.batch_wait_us_effective), NNSpeculation: String(timedIdentity.search.nn_speculation),
    OnnxProvider: timedIdentity.search.provider_effective, BackgroundSearch: "false", SearchGraphMB: String(timedIdentity.search.mcgs.search_graph_mb),
    McgsCpuctPermille: String(timedIdentity.search.mcgs.cpuct_permille), McgsOutstandingBatches: String(timedIdentity.search.mcgs.outstanding_batches),
    McgsBookPriorBlendPermille: String(timedIdentity.search.mcgs.book_prior_blend_permille), McgsTimePolicy: timedIdentity.search.mcgs.time_policy,
    TimeProfileProviderReserveUs: String(timing.provider_service_reserve_us), TimeProfileBackupEmitReserveUs: String(timing.backup_emit_reserve_us),
    TimeProfileIterationForecastScalePermille: String(timing.iteration_forecast_scale_permille), IterativeTimeController: "false" };
  for (const [name, selected] of Object.entries(expected)) same(options[name], selected, `effective option ${name}`);
  same(options.OwnBook, String(knowledge.opening_book_enabled), "configured book applicability");
  if (knowledge.opening_book_enabled) {
    same(knowledge.opening_book_active, true, "activated book");
    for (const [option, field] of [["BookFile", "opening_book_file"], ["BookStatsFile", "opening_book_stats_file"], ["BookPolicyFile", "opening_book_policy_file"]]) {
      requireContinuous(knowledge[field] ? samePublicPath(options[option] ?? "", knowledge[field], binding.engine.working_directory)
        : (options[option] ?? "") === "", `configured ${option} mismatch`);
      if (knowledge[field]) requireContinuous(knowledge.files.some((file) => samePublicPath(file.path, knowledge[field])), `${option} exact file closure is missing`);
    }
  } else same(knowledge.files.length, 0, "disabled book file closure");
  let tablebase = null;
  if (knowledge.syzygy_path || options.SyzygyPath) {
    same(knowledge.syzygy_active, true, "configured tablebase activation");
  } else {
    requireContinuous(knowledge.syzygy_active === false && knowledge.syzygy_manifest === ""
      && knowledge.syzygy_manifest_identity === "" && knowledge.syzygy_manifest_file_sha256 === null
      && knowledge.syzygy_loaded_cardinality === 0, "disabled tablebase path has contradictory activation");
  }
  if (knowledge.syzygy_active) {
    requireContinuous(samePublicPath(options.SyzygyPath, knowledge.syzygy_path, binding.engine.working_directory), "configured tablebase path mismatch");
    exactFile({ path: knowledge.syzygy_manifest, sha256: knowledge.syzygy_manifest_file_sha256 }, "Diagnostic tablebase manifest", LIMIT, fileAuthority);
    const manifest = fileAuthority.readExactJsonSync(knowledge.syzygy_manifest, { maximumBytes: LIMIT, label: "Diagnostic tablebase manifest" }).value;
    same(manifest.identity_sha256, knowledge.syzygy_manifest_identity, "tablebase manifest identity");
    tablebase = { path: knowledge.syzygy_path, manifest: knowledge.syzygy_manifest,
      manifest_identity: knowledge.syzygy_manifest_identity, manifest_file_sha256: knowledge.syzygy_manifest_file_sha256,
      loaded_cardinality: knowledge.syzygy_loaded_cardinality, probe_limit: knowledge.syzygy_probe_limit,
      probe_threads: knowledge.syzygy_probe_threads, rule50: knowledge.syzygy_rule50,
      root_probe: knowledge.syzygy_root_probe, internal_probe: knowledge.syzygy_internal_probe };
  }
  requireContinuous(value.games.length === 2, "opposite-color completed pair is missing");
  for (const [index, color] of ["white", "black"].entries()) validateGame(value.games[index], color, knowledge, value.configuration);
  return { tablebase, binding };
}


export function validateContinuousProfileShape(profile) {
  const fields = ["schema", "qualified", "qualification_scope", "published_at", "model_id", "model_fingerprint",
    "checkpoint_hash", "adapter_id", "engine_build_fingerprint", "hardware_driver_fingerprint", "onnx_runtime_version",
    "provider_numeric_fingerprint", "search_core", "provider", "threads", "root_workers", "split_depth", "batch_size",
    "batch_wait_us", "speculation", "qualification_probe", "evidence", "search_graph_mb", "mcgs_cpuct_permille",
    "mcgs_outstanding_batches", "mcgs_book_prior_blend_permille", "runtime_binding", "diagnostic_authority", "diagnostic_configuration"];
  requireContinuous(profile !== null && typeof profile === "object" && !Array.isArray(profile), "profile is not an object");
  requireContinuous(fields.every((field) => Object.hasOwn(profile, field))
    && Object.keys(profile).every((field) => fields.includes(field) || field === "tablebase"), "profile v2 closed shape is invalid");
  same(profile.qualification_scope, "local_live_safety", "profile v2 scope");
  same(profile.search_core, "mcgs", "profile v2 core");
  shape(profile.runtime_binding, artifactSchema.$defs.binding, "runtime binding");
  shape(profile.diagnostic_authority, artifactSchema.properties.authority, "profile authority");
  shape(profile.diagnostic_configuration, artifactSchema.properties.configuration, "profile diagnostic configuration");
  const probe = profile.qualification_probe;
  requireContinuous(probe !== null && typeof probe === "object" && !Array.isArray(probe)
    && Object.keys(probe).length === 5, "profile v2 probe is not a closed bounded operation");
  for (const [field, expected] of Object.entries({ publication_wait_ms: 500, publication_timeout_ms: 30000,
    publication_count: 1, candidate_sample_count: 1, read_only_candidate_request: true })) same(probe[field], expected, `probe ${field}`);
  requireContinuous(profile.evidence !== null && typeof profile.evidence === "object" && !Array.isArray(profile.evidence)
    && Object.keys(profile.evidence).length === 2 && Object.hasOwn(profile.evidence, "continuous_game")
    && Object.hasOwn(profile.evidence, "timing"), "profile v2 evidence shape is invalid");
  for (const evidence of Object.values(profile.evidence)) requireContinuous(evidence !== null
    && typeof evidence === "object" && Object.keys(evidence).length === 3
    && evidence.passed === true && typeof evidence.artifact === "string" && SHA.test(evidence.artifact_sha256),
  "profile v2 evidence binding is invalid");
}
