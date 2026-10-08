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
    this.plySnapshots = [];
    this.canonicalInitialFen = this.chess.fen();
    this.rawEnPassantSquare = initialFen === "startpos" ? "-" : initialFen.trim().split(/\s+/)[3];
  }

  synchronize(moves, { forceRebuild = false } = {}) {
    if (!Array.isArray(moves)) throw new Error("Authoritative move list is unavailable");
    const startedAt = this.now();
    const rebuild = forceRebuild || !startsWithMoves(moves, this.moves);
    if (rebuild) {
      this.chess = createInitialPosition(this.initialFen);
      this.moves = [];
      this.plySnapshots = [];
      this.rawEnPassantSquare = this.initialFen === "startpos" ? "-" : this.initialFen.trim().split(/\s+/)[3];
    }
    const firstPly = this.moves.length;
    for (let ply = firstPly; ply < moves.length; ply += 1) {
      const beforeFen = this.chess.fen();
      const moveActorColor = this.chess.turn() === "w" ? "white" : "black";
      const acceptedMove = applyLegalMove(this.chess, moves[ply]);
      if (!acceptedMove) {
        throw new Error(`Authoritative move list is illegal at ply ${ply + 1}: ${moves[ply]}`);
      }
      // Raw FEN projection follows the already validated move flag. chess.js may
      // discard a non-capturable target internally; legality and v1 FEN remain unchanged.
      this.rawEnPassantSquare = acceptedMove.isBigPawn()
        ? `${acceptedMove.from[0]}${(Number(acceptedMove.from[1]) + Number(acceptedMove.to[1])) / 2}`
        : "-";
      this.moves.push(moves[ply]);
      this.plySnapshots.push(Object.freeze({
        ply,
        uciMove: moves[ply],
        beforeFen,
        afterFen: this.chess.fen(),
        actorColor: moveActorColor,
        clockMs: null,
      }));
    }
    return {
      elapsedMs: this.now() - startedAt,
      appliedPlies: moves.length - firstPly,
      rebuilt: rebuild,
      rootKey: this.moves.join(" "),
      rootFen: this.chess.fen(),
      initialFen: this.canonicalInitialFen,
      plies: this.plySnapshots.map((ply) => ({ ...ply })),
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

  positionObservation() {
    const fenFields = this.chess.fen({ forceEnpassantSquare: true }).split(" ");
    fenFields[3] = this.rawEnPassantSquare;
    const terminal = this.chess.isGameOver();
    const result = this.chess.isCheckmate()
      ? (this.chess.turn() === "w" ? "0-1" : "1-0")
      : this.chess.isDraw() ? "1/2-1/2" : "*";
    return {
      fen: fenFields.join(" "),
      legal_moves: this.chess.moves({ verbose: true }).map((move) =>
        `${move.from}${move.to}${move.promotion ?? ""}`),
      terminal,
      terminal_conditions: {
        checkmate: this.chess.isCheckmate(),
        stalemate: this.chess.isStalemate(),
        fifty_move_rule: Number(this.chess.fen().split(" ")[4]) >= 100 && !this.chess.isCheckmate(),
        threefold_repetition: this.chess.isThreefoldRepetition(),
        insufficient_material: this.chess.isInsufficientMaterial(),
      },
      result,
    };
  }

  legalMoveCount() {
    return this.chess.moves().length;
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
