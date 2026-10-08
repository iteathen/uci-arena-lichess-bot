import { digestText, equalFocus, canonicalMoveDigest, validateContinuousObservation,
  requireContinuous } from "./continuous-game-qualification.mjs";

export const EXECUTION_COMPLETION_PREFIX = "info string execution_completion_v1 ";
export const MOVE_EVIDENCE_PREFIX = "info string move_decision_evidence_v1 ";
export function nativeDecimal(value, label, { allowZero = false, maximum = 0xffff_ffff_ffff_ffffn } = {}) {
  requireContinuous((typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === "string" && value.length <= 20 && /^(0|[1-9][0-9]*)$/.test(value)), `${label} is unsafe or not lossless`);
  const result = String(value);
  requireContinuous(BigInt(result) <= maximum && (allowZero || result !== "0"), `${label} is outside its native domain`);
  return result;
}
export function nativeFocus(value) {
  return { graph_epoch: nativeDecimal(value?.graph_epoch, "focus epoch"),
    subject_identity: nativeDecimal(value?.subject_identity, "focus subject"),
    position_key: nativeDecimal(value?.position_key, "focus key", { allowZero: true }),
    transition_sequence: nativeDecimal(value?.transition_sequence, "focus sequence", { maximum: 0xffff_ffffn }) };
}
export function continuousObservationFromRuntime(status, previous = null) {
  requireContinuous(status?.schema === "uci_runtime_status_v1", "runtime contract schema is unsupported");
  requireContinuous(status.continuous_focus_valid === true, "native active focus is unavailable");
  const focus = nativeFocus({ graph_epoch: status.continuous_focus_graph_epoch,
    subject_identity: status.continuous_focus_subject_identity, position_key: status.continuous_focus_position_key,
    transition_sequence: status.continuous_focus_transition_sequence });
  requireContinuous(nativeDecimal(status.admitted_position_key, "admitted key", { allowZero: true }) === focus.position_key
    && nativeDecimal(status.continuous_graph_focus_position_key, "graph focus key", { allowZero: true }) === focus.position_key,
  "admitted position and current graph focus disagree");
  requireContinuous(typeof status.accepted_position_command === "string"
    && status.accepted_position_command.length > 0 && status.accepted_position_command.length <= 65536
    && !/[\u0000\r\n]/.test(status.accepted_position_command), "accepted native position command is missing or invalid");
  const observed = { focus, admitted_fen: status.admitted_position_fen,
    accepted_position_command_sha256: digestText(status.accepted_position_command),
    history_available: status.admitted_position_history_available, history_length: status.admitted_position_history_length,
    execution_lineage: nativeDecimal(status.continuous_search_lineage, "execution lineage"),
    worker_set_identity: nativeDecimal(status.continuous_worker_set_identity, "worker identity"),
    execution_activations: nativeDecimal(status.continuous_search_activations, "execution activations"),
    execution_active: status.continuous_search_active, execution_failed: status.continuous_search_failed,
    search: { supported: status.continuous_execution_observations_available,
      lineage: nativeDecimal(status.continuous_observation_execution_lineage, "resource lineage"),
      active_reservations: status.continuous_active_reservations,
      reservation_capacity: status.continuous_reservation_capacity,
      final_residue: status.continuous_reservation_residue, final_residue_available: status.continuous_reservation_residue_available,
      stale_backups: status.continuous_stale_backups_discarded, completed_visits: status.continuous_focus_completed_visits,
      async_admissions: status.continuous_async_admissions },
    evaluation: { supported: status.evaluation_service_supported,
      lifetime_identity: nativeDecimal(status.evaluation_service_lifetime_identity, "evaluation lifetime"),
      queue_owner_lifetime_identity: nativeDecimal(status.evaluation_queue_owner_lifetime_identity, "queue lifetime"),
      generation: nativeDecimal(status.evaluation_service_generation, "evaluation generation"),
      active_tickets: status.evaluation_service_active_tickets, peak_tickets: status.evaluation_service_peak_active_tickets,
      pending_tickets: status.evaluation_service_pending_tickets, executing_tickets: status.evaluation_service_executing_tickets,
      ticket_capacity: status.evaluation_service_ticket_capacity, active_leases: status.evaluation_service_active_async_leases,
      peak_leases: status.evaluation_service_peak_async_leases, cancellations: status.evaluation_service_cancellations,
      executor_failures: status.evaluation_service_executor_failures, stale_publications: status.evaluation_service_stale_publications_discarded,
      submitted: status.evaluation_service_submitted, provider_batches: status.evaluation_service_provider_batches,
      lease_completions: status.evaluation_service_async_lease_completions, lease_abandons: status.evaluation_service_async_lease_abandons,
      lease_capacity: null },
    cache: { supported: status.model_cache_supported,
      owner_lifetime_identity: nativeDecimal(status.model_cache_owner_lifetime_identity, "cache lifetime"),
      entries: status.model_cache_entries, capacity: status.model_cache_capacity,
      policy_payload_bytes: status.model_cache_approx_policy_payload_bytes,
      policy_payload_budget_bytes: status.model_cache_policy_payload_budget_bytes,
      evictions: status.model_cache_evictions, eviction_deferrals: status.model_cache_eviction_deferrals, drops: status.model_cache_drops } };
  return validateContinuousObservation(observed, previous);
}
export function validateNativeAdmission(status, expected) {
  requireContinuous(status.accepted_position_command === expected.position_command, "native accepted position request differs from exact sent history");
  requireContinuous(status.admitted_position_fen === expected.fen, "native admitted canonical FEN differs from requested state");
  requireContinuous(status.admitted_position_history_available === true
    && status.admitted_position_history_length === expected.history_length, "native repetition prefix differs from requested history");
}
export function validateNativeCandidates(evidence, observed, legalMoves) {
  requireContinuous(evidence?.schema === "uci_move_decision_evidence_v1" && evidence.decision_authority === "none"
    && evidence.evidence_current === true, "read-only candidate evidence is unavailable or stale");
  requireContinuous(equalFocus(nativeFocus(evidence.focus), observed.focus), "read-only candidate focus differs from admission");
  requireContinuous(nativeDecimal(evidence.continuous_search_lineage, "candidate lineage") === observed.execution_lineage
    && nativeDecimal(evidence.continuous_worker_set_identity, "candidate worker identity") === observed.worker_set_identity,
  "candidate owner differs from actual child baseline");
  requireContinuous(Array.isArray(evidence.candidates) && evidence.candidates.length === evidence.candidate_count,
    "candidate set is incomplete");
  const candidateMoves = evidence.candidates.map((candidate) => candidate.move);
  requireContinuous(evidence.candidate_count === legalMoves.length
    && canonicalMoveDigest(candidateMoves) === canonicalMoveDigest(legalMoves), "native candidates omit or replace canonical legal moves");
  return { count: evidence.candidate_count, moves_sha256: canonicalMoveDigest(candidateMoves), focus: observed.focus };
}
export function validateNativePublication(telemetry, observed, { legalMoves, runtime, tablebase } = {}) {
  requireContinuous(["searched_decision", "useful_ponder", "deadline_fallback", "opening_book", "exact_tablebase", "objective_no_choice"]
    .includes(telemetry.time_completion_kind), "native publication completion kind is missing or unknown");
  if (telemetry.time_completion_kind === "opening_book") {
    requireContinuous(telemetry.book_move_used === 1 && runtime?.opening_book_enabled === true
      && runtime.opening_book_active === true, "book resolution has no actual active move authority");
    return;
  }
  if (telemetry.time_completion_kind === "exact_tablebase") {
    requireContinuous(tablebase && runtime?.syzygy_active === true, "tablebase resolution has no qualified active authority");
    return;
  }
  if (telemetry.time_completion_kind === "objective_no_choice") {
    requireContinuous(legalMoves?.length === 1, "sole-legal resolution has multiple canonical legal moves");
    return;
  }
  const focus = nativeFocus({ graph_epoch: telemetry.mcgs_decision_focus_graph_epoch,
    subject_identity: telemetry.mcgs_decision_focus_subject_identity,
    position_key: telemetry.mcgs_decision_focus_position_key,
    transition_sequence: telemetry.mcgs_decision_focus_transition_sequence });
  requireContinuous(equalFocus(focus, observed.focus), "native publication is not fenced to the current admitted focus");
}
