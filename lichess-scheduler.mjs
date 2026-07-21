function requireAudience(audience) {
  if (audience !== "human" && audience !== "bot") {
    throw new Error(`Unsupported Lichess slot audience: ${audience}`);
  }
  return audience;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export class SlotPool {
  constructor(capacity) {
    this.capacity = capacity;
    this.sequence = 0;
    this.slots = [];
    for (const audience of ["human", "bot"]) {
      for (let index = 0; index < capacity[audience].slots; index += 1) {
        this.slots.push({
          id: `${audience}-${index + 1}`,
          audience,
          configuredAudience: audience,
          state: "empty",
          generation: 0,
        });
      }
    }
  }

  acquire(audience, details = {}) {
    requireAudience(audience);
    let slot = this.slots.find((candidate) => candidate.state === "empty"
      && candidate.configuredAudience === audience);
    if (!slot && audience === "bot" && this.capacity.human.allow_borrowing) {
      slot = this.slots.find((candidate) => candidate.state === "empty"
        && candidate.configuredAudience === "human");
    }
    if (!slot && this.capacity.legacy_shared) {
      slot = this.slots.find((candidate) => candidate.state === "empty");
    }
    if (!slot) return null;
    return this.claim(slot, audience, details);
  }

  acquireStarted(audience, details = {}) {
    const native = this.acquire(audience, details);
    if (native) return native;
    const recovery = this.slots.find((candidate) => candidate.state === "empty");
    return recovery ? this.claim(recovery, audience, details) : null;
  }

  claim(slot, audience, details) {
    slot.audience = audience;
    slot.state = "preparing";
    slot.generation = ++this.sequence;
    slot.createdAt = details.createdAt ?? Date.now();
    slot.opponent = details.opponent?.toLocaleLowerCase() ?? null;
    slot.direction = details.direction ?? null;
    slot.challengeId = details.challengeId ? String(details.challengeId) : null;
    slot.gameId = null;
    slot.engine = null;
    slot.cancelRetryAt = null;
    slot.cancelAttempts = 0;
    slot.cancelInFlight = false;
    slot.reconcileReleaseAt = null;
    return slot;
  }

  attachEngine(slot, engine, expectedGeneration = slot?.generation) {
    this.requireOwned(slot, "preparing", expectedGeneration);
    slot.engine = engine;
    return slot;
  }

  pending(slot, challengeId) {
    this.requireOwned(slot, "preparing");
    slot.challengeId = String(challengeId);
    slot.state = "pending";
    return slot;
  }

  cancelling(slot) {
    this.requireOwned(slot, ["pending", "cancelling"]);
    slot.state = "cancelling";
    slot.cancelInFlight = true;
    return slot;
  }

  active(slot, gameId) {
    this.requireOwned(slot, ["preparing", "pending", "cancelling", "active"]);
    slot.gameId = String(gameId);
    slot.state = "active";
    return slot;
  }

  findPending(game) {
    const gameId = String(game?.gameId ?? game?.id ?? "");
    const challengeId = String(game?.challengeId ?? gameId);
    const exact = this.slots.find((slot) => ["pending", "cancelling"].includes(slot.state)
      && (slot.challengeId === challengeId || slot.challengeId === gameId));
    if (exact) return exact;
    const opponent = String(game?.opponent?.id ?? game?.opponent?.username
      ?? game?.opponent?.name ?? "").toLocaleLowerCase();
    if (opponent) {
      return this.slots
        .filter((slot) => ["pending", "cancelling"].includes(slot.state)
          && slot.opponent === opponent)
        .sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;
    }
    const pending = this.slots.filter((slot) => ["pending", "cancelling"].includes(slot.state));
    return pending.length === 1 ? pending[0] : null;
  }

  findChallenge(challengeId) {
    const id = String(challengeId ?? "");
    return this.slots.find((slot) => slot.challengeId === id && slot.state !== "empty") ?? null;
  }

  findGame(gameId) {
    const id = String(gameId ?? "");
    return this.slots.find((slot) => slot.gameId === id && slot.state !== "empty") ?? null;
  }

  occupied(audience, states = ["preparing", "pending", "cancelling", "active", "draining"]) {
    requireAudience(audience);
    return this.slots.filter((slot) => slot.audience === audience && states.includes(slot.state)).length;
  }

  available(audience) {
    requireAudience(audience);
    const native = this.slots.filter((slot) => slot.state === "empty"
      && slot.configuredAudience === audience).length;
    if (native > 0 || audience !== "bot" || !this.capacity.human.allow_borrowing) return native;
    return this.slots.filter((slot) => slot.state === "empty"
      && slot.configuredAudience === "human").length;
  }

  hasOpponent(opponent, audience) {
    const normalized = String(opponent ?? "").toLocaleLowerCase();
    return this.slots.some((slot) => slot.state !== "empty" && slot.opponent === normalized
      && (!audience || slot.audience === audience));
  }

  async release(slot, expectedGeneration = slot?.generation) {
    if (!slot || !this.slots.includes(slot) || slot.state === "empty" || slot.state === "draining"
        || slot.generation !== expectedGeneration) return false;
    slot.state = "draining";
    const engine = slot.engine;
    slot.engine = null;
    try {
      await engine?.close();
    } finally {
      slot.audience = slot.configuredAudience;
      slot.state = "empty";
      slot.createdAt = null;
      slot.opponent = null;
      slot.direction = null;
      slot.challengeId = null;
      slot.gameId = null;
      slot.cancelRetryAt = null;
      slot.cancelAttempts = null;
      slot.cancelInFlight = null;
      slot.reconcileReleaseAt = null;
    }
    return true;
  }

  async drainAll() {
    await Promise.allSettled(this.slots.map((slot) => this.release(slot)));
  }

  snapshot() {
    const byAudience = {};
    for (const audience of ["human", "bot"]) {
      byAudience[audience] = Object.fromEntries(
        ["empty", "preparing", "pending", "cancelling", "active", "draining"].map((state) => [
          state,
          this.slots.filter((slot) => slot.audience === audience && slot.state === state).length,
        ]),
      );
    }
    return {
      total: this.slots.length,
      byAudience,
      slots: this.slots.map((slot) => ({
        id: slot.id,
        configuredAudience: slot.configuredAudience,
        audience: slot.audience,
        state: slot.state,
        opponent: slot.opponent,
        challengeId: slot.challengeId,
        gameId: slot.gameId,
      })),
    };
  }

  requireOwned(slot, expectedState, expectedGeneration = slot?.generation) {
    if (!slot || !this.slots.includes(slot)) throw new Error("Lichess slot is not owned by this pool");
    if (slot.generation !== expectedGeneration) {
      throw new Error(`Lichess slot ${slot.id} generation changed from ${expectedGeneration} to ${slot.generation}`);
    }
    const expected = Array.isArray(expectedState) ? expectedState : [expectedState];
    if (!expected.includes(slot.state)) {
      throw new Error(`Lichess slot ${slot.id} is ${slot.state}; expected ${expected.join(" or ")}`);
    }
  }
}

export class AsyncSemaphore {
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Semaphore limit must be positive");
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async run(task) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

export function candidateWeight(candidate, scheduler, now = Date.now()) {
  const rating = Number(candidate.rating) || scheduler.rating_target;
  const spread = Math.max(1, Number(scheduler.rating_spread));
  const ratingProximity = Math.exp(-Math.abs(rating - scheduler.rating_target) / spread);
  const accepts = Number(candidate.accepts) || 0;
  const declines = Number(candidate.declines) || 0;
  const timeouts = Number(candidate.timeouts) || 0;
  const acceptance = (accepts + 1) / (accepts + declines + timeouts + 3);
  const underSampling = 1 / Math.sqrt((Number(candidate.total_games) || 0) + 1);
  const hoursSinceGame = candidate.last_game_at
    ? Math.max(0, now - Number(candidate.last_game_at)) / 3_600_000
    : 168;
  const freshness = clamp(hoursSinceGame / 24, 0.15, 1);
  const whiteGames = Number(candidate.white_games) || 0;
  const blackGames = Number(candidate.black_games) || 0;
  const colorBalance = 1 - Math.abs(whiteGames - blackGames) / Math.max(2, whiteGames + blackGames + 2);
  return Math.max(0.0001,
    (0.2 + 0.8 * ratingProximity)
    * (0.35 + 0.65 * acceptance)
    * (0.25 + 0.75 * underSampling)
    * freshness
    * colorBalance);
}

export function selectWeightedCandidate(candidates, scheduler, random = Math.random, now = Date.now()) {
  if (!candidates.length) return null;
  const weighted = candidates.map((candidate) => ({
    candidate,
    weight: candidateWeight(candidate, scheduler, now),
  }));
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = clamp(Number(random()), 0, 0.999999999999) * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.candidate;
  }
  return weighted.at(-1).candidate;
}

export function reservationBlocksPublicHuman({ reservation, opponent, reservationOccupied, availableHuman }) {
  if (!reservation || reservation.opponent === String(opponent ?? "").toLocaleLowerCase()) return false;
  return !reservationOccupied && availableHuman <= 1;
}

export class LichessHttpError extends Error {
  constructor(method, endpoint, status, retryAfterMs = 0) {
    super(`Lichess ${method} ${endpoint} failed with HTTP ${status}`);
    this.name = "LichessHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PriorityRequestQueue {
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.queue = [];
    this.sequence = 0;
    this.running = false;
    this.nonMoveBlockedUntil = 0;
    this.timer = null;
  }

  enqueue(task, priority = 20) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, priority, sequence: this.sequence++, resolve, reject });
      this.queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      if (priority === 0 && this.timer) {
        this.clearTimer(this.timer);
        this.timer = null;
      }
      this.pump();
    });
  }

  blockNonMove(milliseconds) {
    this.nonMoveBlockedUntil = Math.max(this.nonMoveBlockedUntil, this.now() + milliseconds);
  }

  blockNonMoveUntil(timestamp) {
    this.nonMoveBlockedUntil = Math.max(this.nonMoveBlockedUntil, Number(timestamp) || 0);
    this.pump();
  }

  snapshot() {
    return {
      nonMoveBlockedUntil: this.nonMoveBlockedUntil,
      nonMoveRemainingMs: Math.max(0, this.nonMoveBlockedUntil - this.now()),
      queued: this.queue.length,
      running: this.running,
    };
  }

  pump() {
    if (this.running || !this.queue.length) return;
    const next = this.queue[0];
    const remaining = this.nonMoveBlockedUntil - this.now();
    if (next.priority > 0 && remaining > 0) {
      if (!this.timer) {
        this.timer = this.setTimer(() => {
          this.timer = null;
          this.pump();
        }, remaining);
      }
      return;
    }
    this.queue.shift();
    this.running = true;
    Promise.resolve().then(next.task).then(next.resolve, next.reject).finally(() => {
      this.running = false;
      this.pump();
    });
  }
}
