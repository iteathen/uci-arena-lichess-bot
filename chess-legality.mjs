import { performance } from "node:perf_hooks";

import { Chess } from "chess.js";

function createInitialPosition(initialFen) {
  if (initialFen === "startpos") return new Chess();
  if (typeof initialFen !== "string" || !initialFen.trim()) {
    throw new Error("Authoritative game is missing an initial position");
  }
  try {
    return new Chess(initialFen);
  } catch (error) {
    throw new Error(`Unsupported authoritative initial FEN: ${error.message}`);
  }
}

function parsedUci(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci[4] ? { promotion: uci[4] } : {}),
  };
}

function applyLegalMove(chess, uci) {
  try {
    return chess.move(parsedUci(uci));
  } catch {
    return null;
  }
}

function startsWithMoves(moves, prefix) {
  return moves.length >= prefix.length && prefix.every((move, index) => moves[index] === move);
}

export class AuthoritativeChessState {
  constructor(initialFen, now = performance.now.bind(performance)) {
    this.initialFen = initialFen;
    this.now = now;
    this.chess = createInitialPosition(initialFen);
    this.moves = [];
  }

  synchronize(moves, { forceRebuild = false } = {}) {
    if (!Array.isArray(moves)) throw new Error("Authoritative move list is unavailable");
    const startedAt = this.now();
    const rebuild = forceRebuild || !startsWithMoves(moves, this.moves);
    if (rebuild) {
      this.chess = createInitialPosition(this.initialFen);
      this.moves = [];
    }
    const firstPly = this.moves.length;
    for (let ply = firstPly; ply < moves.length; ply += 1) {
      if (!applyLegalMove(this.chess, moves[ply])) {
        throw new Error(`Authoritative move list is illegal at ply ${ply + 1}: ${moves[ply]}`);
      }
      this.moves.push(moves[ply]);
    }
    return {
      elapsedMs: this.now() - startedAt,
      appliedPlies: moves.length - firstPly,
      rebuilt: rebuild,
      rootKey: this.moves.join(" "),
      rootFen: this.chess.fen(),
    };
  }

  validateCandidate(moves, candidate) {
    if (!Array.isArray(moves) || moves.length !== this.moves.length
        || moves.some((move, index) => move !== this.moves[index])) {
      throw new Error("Legality state does not match the exact authoritative root");
    }
    const startedAt = this.now();
    const legalMove = applyLegalMove(this.chess, candidate);
    if (legalMove) this.chess.undo();
    return {
      legal: Boolean(legalMove),
      elapsedMs: this.now() - startedAt,
      replayedPlies: 0,
      rootFen: this.chess.fen(),
    };
  }
}

/** Standalone exact-root helper used by focused tests and diagnostics. */
export function validateLegalMoveAtAuthoritativeRoot({
  initialFen,
  moves,
  candidate,
  now = performance.now.bind(performance),
}) {
  const state = new AuthoritativeChessState(initialFen, now);
  const synchronization = state.synchronize(moves);
  const validation = state.validateCandidate(moves, candidate);
  return {
    ...validation,
    elapsedMs: synchronization.elapsedMs + validation.elapsedMs,
    replayedPlies: synchronization.appliedPlies,
  };
}
