import { createHash } from "node:crypto";

import { Chess } from "chess.js";

export const PROVIDER_GAME_PAGE_SCHEMA = "uci_arena_provider_game_page_v1";
export const PROVIDER_GAME_SCHEMA = "uci_arena_provider_game_v1";
export const PROVIDER_GAME_MAXIMUM_PLIES = 2_048;
export const PROVIDER_GAME_MAXIMUM_PAGE_SIZE = 100;
export const PROVIDER_GAME_BACKFILL_MAXIMUM_IDS = 300;

const GAME_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CLOSED_TOKEN_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/u;
const UCI_MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ARCHIVE_COMPLETENESS = new Set(["live", "summary_only", "complete", "reconciled"]);
const ACTOR_COLORS = new Set(["white", "black"]);
const GAME_SCOPES = new Set(["live", "history"]);
const NONTERMINAL_STATUSES = new Set(["created", "started", "unknown"]);
const GAME_RESULTS = new Set(["", "win", "loss", "draw"]);

function exactSafeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
      || value < minimum || value > maximum) {
    throw new Error(`${label} must be an exact safe integer`);
  }
  return value;
}

function boundedText(value, label, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum
      || (!allowEmpty && value.length === 0) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function closedToken(value, label, { allowEmpty = false } = {}) {
  if (allowEmpty && (value === "" || value === null || value === undefined)) return "";
  const token = boundedText(value, label, 128);
  if (!CLOSED_TOKEN_PATTERN.test(token)) throw new Error(`${label} is not a closed token`);
  return token;
}

function optionalClosedToken(value) {
  try {
    return closedToken(value, "public provenance token", { allowEmpty: true }) || null;
  } catch {
    return null;
  }
}

function optionalSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sha256(value, label, { allowEmpty = false } = {}) {
  if (allowEmpty && (value === "" || value === null || value === undefined)) return "";
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 identity`);
  }
  return value;
}

export function normalizeProviderGameId(value) {
  if (typeof value !== "string" || !GAME_ID_PATTERN.test(value)) {
    throw new Error("provider game id is invalid");
  }
  return value;
}

export function normalizeProviderGamePageRequest({
  scope = "history",
  beforeCursor = 0,
  limit = PROVIDER_GAME_MAXIMUM_PAGE_SIZE,
} = {}) {
  if (!GAME_SCOPES.has(scope)) throw new Error("provider game scope must be live or history");
  return Object.freeze({
    scope,
    beforeCursor: exactSafeInteger(beforeCursor, "provider game before cursor"),
    limit: exactSafeInteger(limit, "provider game page limit", {
      minimum: 1,
      maximum: PROVIDER_GAME_MAXIMUM_PAGE_SIZE,
    }),
  });
}

export function normalizeProviderGameTerminal({ status, result = "", winner = "" }) {
  const normalizedStatus = closedToken(String(status ?? "unknown"), "provider game status");
  const normalizedResult = String(result ?? "");
  const normalizedWinner = String(winner ?? "");
  if (NONTERMINAL_STATUSES.has(normalizedStatus)) {
    throw new Error("provider game status is not terminal");
  }
  if (!GAME_RESULTS.has(normalizedResult)) {
    throw new Error("provider game result is invalid");
  }
  if (normalizedWinner !== "" && !ACTOR_COLORS.has(normalizedWinner)) {
    throw new Error("provider game winner is invalid");
  }
  return Object.freeze({
    status: normalizedStatus,
    result: normalizedResult,
    winner: normalizedWinner,
  });
}

export function normalizeProviderComponentIdentity(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} component identity is invalid`);
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["componentId", "manifestSha256", "version"])) {
    throw new Error(`${label} component identity has an unknown field`);
  }
  return Object.freeze({
    componentId: closedToken(value.componentId, `${label} component id`),
    version: closedToken(value.version, `${label} component version`),
    manifestSha256: sha256(value.manifestSha256, `${label} component manifest`),
  });
}

function normalizeFen(value, label) {
  const fen = boundedText(value, label, 128);
  try {
    return new Chess(fen).fen();
  } catch {
    throw new Error(`${label} is not a legal six-field FEN`);
  }
}

export function canonicalInitialFen(value) {
  if (value === "startpos") return new Chess().fen();
  return normalizeFen(value, "provider game initial FEN");
}

export function normalizeProviderGameLine({ initialFen, variant = "standard", plies }) {
  const canonicalFen = canonicalInitialFen(initialFen);
  if (variant !== "standard") throw new Error("provider game variant is unsupported");
  if (!Array.isArray(plies) || plies.length > PROVIDER_GAME_MAXIMUM_PLIES) {
    throw new Error("provider game replay exceeds its ply bound");
  }
  const normalized = plies.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || exactSafeInteger(entry.ply, "provider game ply", {
          maximum: PROVIDER_GAME_MAXIMUM_PLIES - 1,
        }) !== index
        || typeof entry.uciMove !== "string" || !UCI_MOVE_PATTERN.test(entry.uciMove)
        || !ACTOR_COLORS.has(entry.actorColor)) {
      throw new Error(`provider game ply ${index} is malformed`);
    }
    const clockMs = entry.clockMs === null || entry.clockMs === undefined
      ? null
      : exactSafeInteger(entry.clockMs, `provider game ply ${index} clock`);
    return Object.freeze({
      ply: index,
      uciMove: entry.uciMove,
      beforeFen: normalizeFen(entry.beforeFen, `provider game ply ${index} before FEN`),
      afterFen: normalizeFen(entry.afterFen, `provider game ply ${index} after FEN`),
      actorColor: entry.actorColor,
      clockMs,
    });
  });
  const replay = new Chess(canonicalFen);
  for (const entry of normalized) {
    if (replay.fen() !== entry.beforeFen) {
      throw new Error(`provider game ply ${entry.ply} before FEN conflicts with replay`);
    }
    const expectedActor = replay.turn() === "w" ? "white" : "black";
    if (entry.actorColor !== expectedActor) {
      throw new Error(`provider game ply ${entry.ply} actor color conflicts with replay`);
    }
    const move = replay.move({
      from: entry.uciMove.slice(0, 2),
      to: entry.uciMove.slice(2, 4),
      ...(entry.uciMove[4] ? { promotion: entry.uciMove[4] } : {}),
    });
    if (!move || replay.fen() !== entry.afterFen) {
      throw new Error(`provider game ply ${entry.ply} is illegal or has a conflicting after FEN`);
    }
  }
  return Object.freeze({ initialFen: canonicalFen, variant, plies: Object.freeze(normalized) });
}

export function parseProviderHistoricalGame(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("historical game export is not an object");
  }
  const id = normalizeProviderGameId(String(record.id ?? record.gameId ?? ""));
  const variant = typeof record.variant === "object" ? record.variant?.key : record.variant;
  if ((variant ?? "standard") !== "standard") {
    throw new Error("historical game export variant is unsupported");
  }
  const initialFen = canonicalInitialFen(record.initialFen ?? "startpos");
  const sanText = boundedText(String(record.moves ?? ""), "historical game moves", 131_072, {
    allowEmpty: true,
  });
  const sanMoves = sanText.trim() ? sanText.trim().split(/\s+/u) : [];
  if (sanMoves.length > PROVIDER_GAME_MAXIMUM_PLIES
      || sanMoves.some((move) => move.length > 32)) {
    throw new Error("historical game export exceeds its move bound");
  }
  const clocks = record.clocks === undefined ? null : record.clocks;
  if (clocks !== null && (!Array.isArray(clocks)
      || clocks.length > PROVIDER_GAME_MAXIMUM_PLIES
      || clocks.length > sanMoves.length
      || clocks.some((clock) => !Number.isSafeInteger(clock) || clock < 0))) {
    throw new Error("historical game clocks are malformed");
  }
  const chess = new Chess(initialFen);
  const plies = sanMoves.map((san, ply) => {
    const beforeFen = chess.fen();
    const actorColor = chess.turn() === "w" ? "white" : "black";
    let move;
    try {
      move = chess.move(san);
    } catch {
      move = null;
    }
    if (!move) throw new Error(`historical game move is illegal at ply ${ply}`);
    const centiseconds = clocks?.[ply];
    const clockMs = centiseconds === undefined
      ? null
      : exactSafeInteger(centiseconds * 10, `historical game clock ${ply}`);
    return {
      ply,
      uciMove: `${move.from}${move.to}${move.promotion ?? ""}`,
      beforeFen,
      afterFen: chess.fen(),
      actorColor,
      clockMs,
    };
  });
  const terminal = normalizeProviderGameTerminal({
    status: record.status,
    winner: record.winner,
  });
  return Object.freeze({
    id,
    status: terminal.status,
    winner: terminal.winner,
    finishedAt: exactSafeInteger(record.lastMoveAt, "historical game finish timestamp", {
      minimum: 1,
    }),
    ...normalizeProviderGameLine({ initialFen, variant: "standard", plies }),
  });
}

export function providerGameArchiveSha256({
  gameId,
  initialFen,
  variant,
  status,
  result,
  winner,
  plies,
}) {
  const line = normalizeProviderGameLine({ initialFen, variant, plies });
  const terminal = normalizeProviderGameTerminal({ status, result, winner });
  const identity = JSON.stringify({
    game_id: normalizeProviderGameId(gameId),
    initial_fen: line.initialFen,
    variant: line.variant,
    status: terminal.status,
    result: terminal.result,
    winner: terminal.winner,
    plies: line.plies.map((entry) => ({
      ply: entry.ply,
      uci_move: entry.uciMove,
      before_fen: entry.beforeFen,
      after_fen: entry.afterFen,
      actor_color: entry.actorColor,
      clock_ms: entry.clockMs,
    })),
  });
  return `sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

function componentProjection(row, prefix) {
  const id = row[`${prefix}_component_id`];
  const version = row[`${prefix}_component_version`];
  const manifest = row[`${prefix}_component_manifest_sha256`];
  if (!id && !version && !manifest) return null;
  return {
    component_id: closedToken(id, `${prefix} component id`),
    version: closedToken(version, `${prefix} component version`),
    manifest_sha256: sha256(manifest, `${prefix} component manifest`),
  };
}

function runtimeProvenanceProjection(row) {
  const identity = sha256(row.runtime_provenance_sha256, "runtime provenance", { allowEmpty: true });
  if (!identity) return null;
  let provenance;
  try {
    provenance = JSON.parse(row.runtime_provenance_json);
  } catch {
    return { sha256: identity, details_available: false };
  }
  if (provenance?.schema !== "uci_arena_game_runtime_provenance_v1") {
    return { sha256: identity, details_available: false };
  }
  return {
    sha256: identity,
    details_available: true,
    engine: {
      adapter: optionalClosedToken(provenance.engine?.adapter),
      build_fingerprint: optionalClosedToken(provenance.engine?.build_fingerprint),
      launch_identity_sha256: optionalClosedToken(provenance.engine?.launch_identity_sha256),
      uci_identity_sha256: optionalClosedToken(provenance.engine?.uci_identity_sha256),
    },
    model: {
      id: optionalClosedToken(provenance.model?.id),
      fingerprint: optionalClosedToken(provenance.model?.fingerprint),
      checkpoint_hash: optionalClosedToken(provenance.model?.checkpoint_hash),
      adapter_id: optionalClosedToken(provenance.model?.adapter_id),
    },
    evaluation_runtime: {
      name: optionalClosedToken(provenance.provider?.name),
      numeric_fingerprint: optionalClosedToken(provenance.provider?.numeric_fingerprint),
      hardware_driver_fingerprint:
        optionalClosedToken(provenance.provider?.hardware_driver_fingerprint),
      version: optionalClosedToken(provenance.provider?.onnx_runtime_version),
    },
    search: {
      core: optionalClosedToken(provenance.search?.core),
      threads: optionalSafeInteger(provenance.search?.threads),
      root_workers: optionalSafeInteger(provenance.search?.root_workers),
      split_depth: optionalSafeInteger(provenance.search?.split_depth),
      batch_size: optionalSafeInteger(provenance.search?.batch_size),
      batch_wait_us: optionalSafeInteger(provenance.search?.batch_wait_us),
    },
    timing: {
      profile_identity_sha256: optionalClosedToken(provenance.timing?.profile_identity_sha256),
      status: optionalClosedToken(provenance.timing?.status),
      accepted: provenance.timing?.accepted === true,
      applied: provenance.timing?.applied === true,
    },
    knowledge: {
      book_configuration_identity: optionalClosedToken(provenance.book?.configuration_identity),
      book_snapshot_identity: optionalClosedToken(provenance.book?.observed_snapshot_identity),
      book_manifest_sha256: optionalClosedToken(provenance.book?.observed_manifest_sha256),
      tablebase_identity: optionalClosedToken(provenance.tablebase?.observed_identity),
      tablebase_manifest_identity:
        optionalClosedToken(provenance.tablebase?.observed_manifest_identity),
    },
  };
}

function gameSummary(row, scope) {
  const completeness = row.archive_completeness;
  if (!ARCHIVE_COMPLETENESS.has(completeness)) {
    throw new Error("stored provider game completeness is invalid");
  }
  const cursor = scope === "live" ? row.archive_cursor : row.completion_cursor;
  return {
    cursor: exactSafeInteger(cursor, "provider game cursor", { minimum: 1 }),
    game_id: normalizeProviderGameId(row.game_id),
    state: scope,
    opponent: boundedText(row.opponent, "provider game opponent", 32, { allowEmpty: true }),
    color: row.color === "white" || row.color === "black" ? row.color : null,
    rated: row.rated === 1,
    speed: closedToken(row.speed, "provider game speed", { allowEmpty: true }) || null,
    variant: closedToken(row.variant, "provider game variant"),
    clock_limit: exactSafeInteger(row.clock_limit, "provider game clock limit"),
    clock_increment: exactSafeInteger(row.clock_increment, "provider game clock increment"),
    status: closedToken(row.status, "provider game status"),
    result: closedToken(row.result, "provider game result", { allowEmpty: true }) || null,
    winner: closedToken(row.winner, "provider game winner", { allowEmpty: true }) || null,
    plies: exactSafeInteger(row.plies, "provider game plies", {
      maximum: PROVIDER_GAME_MAXIMUM_PLIES,
    }),
    started_at: exactSafeInteger(row.started_at, "provider game start timestamp"),
    finished_at: row.finished_at === 0
      ? null
      : exactSafeInteger(row.finished_at, "provider game finish timestamp", { minimum: 1 }),
    archive_completeness: completeness,
    incomplete_reason: closedToken(
      row.archive_reason,
      "provider game archive reason",
      { allowEmpty: true },
    ) || null,
    archive_sha256: sha256(row.archive_sha256, "provider game archive", { allowEmpty: true }) || null,
    provider_component: componentProjection(row, "provider"),
    engine_component: componentProjection(row, "engine"),
  };
}

export function projectProviderGamePage({ request, rows, hasMore }) {
  const normalized = normalizeProviderGamePageRequest(request);
  if (!Array.isArray(rows) || rows.length > normalized.limit || typeof hasMore !== "boolean") {
    throw new Error("provider game page source is invalid");
  }
  const games = rows.map((row) => gameSummary(row, normalized.scope));
  return Object.freeze({
    schema: PROVIDER_GAME_PAGE_SCHEMA,
    scope: normalized.scope,
    before_cursor: normalized.beforeCursor,
    next_cursor: games.at(-1)?.cursor ?? 0,
    has_more: hasMore,
    games,
  });
}

export function projectProviderGame(row, plies) {
  if (!row || !Array.isArray(plies) || plies.length > PROVIDER_GAME_MAXIMUM_PLIES) {
    throw new Error("provider game detail source is invalid");
  }
  const scope = row.completion_cursor > 0 ? "history" : "live";
  const summary = gameSummary(row, scope);
  const replay = plies.map((entry, index) => {
    if (entry.ply !== index) throw new Error("provider game replay has a non-contiguous ply");
    if (!ACTOR_COLORS.has(entry.actor_color)) {
      throw new Error("provider game replay actor color is invalid");
    }
    return {
      ply: index,
      uci_move: boundedText(entry.uci_move, "provider game UCI move", 5),
      before_fen: normalizeFen(entry.before_fen, "provider game before FEN"),
      after_fen: normalizeFen(entry.after_fen, "provider game after FEN"),
      actor_color: entry.actor_color,
      clock_ms: entry.clock_available === 1
        ? exactSafeInteger(entry.clock_ms, "provider game replay clock")
        : null,
    };
  });
  return Object.freeze({
    schema: PROVIDER_GAME_SCHEMA,
    ...summary,
    initial_fen: row.initial_fen ? normalizeFen(row.initial_fen, "provider game initial FEN") : null,
    runtime_provenance: runtimeProvenanceProjection(row),
    replay,
  });
}
