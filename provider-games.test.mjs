import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProviderGameLine,
  parseProviderHistoricalGame,
  projectProviderGame,
  projectProviderGamePage,
  providerGameArchiveSha256,
} from "./provider-games.mjs";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

function historicalRecord(overrides = {}) {
  return {
    id: "archive-game-1",
    variant: "standard",
    moves: "e4 c5 Nf3",
    clocks: [18_000, 17_990, 17_850],
    status: "resign",
    winner: "white",
    lastMoveAt: 1_777_000_000_000,
    ...overrides,
  };
}

function storedRow(line, overrides = {}) {
  return {
    archive_cursor: 4,
    completion_cursor: 2,
    game_id: "archive-game-1",
    opponent: "fixture_bot",
    color: "white",
    rated: 1,
    speed: "blitz",
    variant: "standard",
    clock_limit: 180,
    clock_increment: 2,
    status: "resign",
    result: "win",
    winner: "white",
    plies: line.plies.length,
    started_at: 1_776_999_000_000,
    finished_at: 1_777_000_000_000,
    archive_completeness: "reconciled",
    archive_reason: "",
    archive_sha256: SHA_A,
    initial_fen: line.initialFen,
    provider_component_id: "lichess.adapter",
    provider_component_version: "1.0.24",
    provider_component_manifest_sha256: SHA_A,
    engine_component_id: "uci_arena.engine",
    engine_component_version: "0.9.0",
    engine_component_manifest_sha256: SHA_B,
    runtime_provenance_sha256: SHA_B,
    runtime_provenance_json: JSON.stringify({
      schema: "uci_arena_game_runtime_provenance_v1",
      engine: {
        adapter: "uci_arena_extended_v1",
        build_fingerprint: "build.fixture",
        launch_identity_sha256: SHA_A,
        uci_identity_sha256: SHA_B,
        executable_path: "C:\\private\\engine.exe",
        raw_uci_id: "id name private engine output",
      },
      model: { id: "model.fixture", fingerprint: "model.fingerprint" },
      provider: { name: "directml", numeric_fingerprint: "numeric.fixture" },
      search: { core: "mcgs", threads: 6, root_workers: 6 },
      timing: { status: "accepted", accepted: true, applied: true },
      book: { configuration_identity: "book.fixture" },
      environment: { PRIVATE_PATH: "C:\\private" },
    }),
    ...overrides,
  };
}

function storedPlies(line) {
  return line.plies.map((ply) => ({
    game_id: "archive-game-1",
    ply: ply.ply,
    uci_move: ply.uciMove,
    before_fen: ply.beforeFen,
    after_fen: ply.afterFen,
    actor_color: ply.actorColor,
    clock_available: ply.clockMs === null ? 0 : 1,
    clock_ms: ply.clockMs ?? 0,
  }));
}

test("historical export parsing derives canonical legal UCI, FEN, and exact clocks", () => {
  const parsed = parseProviderHistoricalGame(historicalRecord());
  assert.equal(parsed.initialFen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  assert.deepEqual(parsed.plies.map((ply) => ({
    move: ply.uciMove,
    actor: ply.actorColor,
    clock: ply.clockMs,
  })), [
    { move: "e2e4", actor: "white", clock: 180_000 },
    { move: "c7c5", actor: "black", clock: 179_900 },
    { move: "g1f3", actor: "white", clock: 178_500 },
  ]);
  assert.equal(parsed.plies[1].beforeFen, parsed.plies[0].afterFen);
  assert.equal(parsed.status, "resign");
  assert.equal(parsed.finishedAt, 1_777_000_000_000);
  const blackToMove = parseProviderHistoricalGame(historicalRecord({
    id: "black-to-move",
    initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
    moves: "e5",
    clocks: [6_000],
  }));
  assert.equal(blackToMove.plies[0].actorColor, "black");
});

test("archive legality and content identity reject unsupported or conflicting replay", () => {
  const parsed = parseProviderHistoricalGame(historicalRecord());
  const identity = providerGameArchiveSha256({
    gameId: parsed.id,
    initialFen: parsed.initialFen,
    variant: parsed.variant,
    status: parsed.status,
    result: "win",
    winner: parsed.winner,
    plies: parsed.plies,
  });
  assert.match(identity, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(identity, providerGameArchiveSha256({
    gameId: parsed.id,
    initialFen: parsed.initialFen,
    variant: parsed.variant,
    status: parsed.status,
    result: "win",
    winner: parsed.winner,
    plies: parsed.plies,
  }));
  assert.throws(
    () => parseProviderHistoricalGame(historicalRecord({ variant: "chess960" })),
    /variant is unsupported/,
  );
  assert.throws(
    () => parseProviderHistoricalGame(historicalRecord({ moves: "e4 e5 Bh6" })),
    /illegal at ply 2/,
  );
  assert.throws(
    () => parseProviderHistoricalGame(historicalRecord({ clocks: [1, 2, 3, 4] })),
    /clocks are malformed/,
  );
  const conflicting = structuredClone(parsed.plies);
  conflicting[1].beforeFen = conflicting[0].beforeFen;
  assert.throws(
    () => normalizeProviderGameLine({
      initialFen: parsed.initialFen,
      variant: parsed.variant,
      plies: conflicting,
    }),
    /before FEN conflicts/,
  );
});

test("Manager game projections are closed, cursor-stable, and omit private provenance", () => {
  const line = parseProviderHistoricalGame(historicalRecord());
  const row = storedRow(line);
  const detail = projectProviderGame(row, storedPlies(line));
  assert.equal(detail.schema, "uci_arena_provider_game_v1");
  assert.equal(detail.cursor, 2);
  assert.equal(detail.replay[0].actor_color, "white");
  assert.equal(detail.replay[1].actor_color, "black");
  assert.deepEqual(detail.provider_component, {
    component_id: "lichess.adapter",
    version: "1.0.24",
    manifest_sha256: SHA_A,
  });
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes("C:\\\\private"), false);
  assert.equal(serialized.includes("raw_uci_id"), false);
  assert.equal(serialized.includes("PRIVATE_PATH"), false);

  const page = projectProviderGamePage({
    request: { scope: "history", beforeCursor: 9, limit: 2 },
    rows: [row, storedRow(line, { game_id: "archive-game-0", completion_cursor: 1 })],
    hasMore: true,
  });
  assert.deepEqual({
    schema: page.schema,
    scope: page.scope,
    before: page.before_cursor,
    next: page.next_cursor,
    more: page.has_more,
    ids: page.games.map((game) => game.game_id),
  }, {
    schema: "uci_arena_provider_game_page_v1",
    scope: "history",
    before: 9,
    next: 1,
    more: true,
    ids: ["archive-game-1", "archive-game-0"],
  });
});
