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
  constructor(
    method,
    endpoint,
    status,
    retryAfterMs = 0,
    requestClass = "ordinary",
    detail = "",
  ) {
    super(`Lichess ${method} ${endpoint} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "LichessHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.requestClass = requestClass;
    this.detail = detail;
  }
}

export const API_REQUEST_PRIORITY = Object.freeze({
  move: 0,
  game_stream: 5,
  event_stream: 10,
  reconciliation: 15,
  challenge_control: 20,
  identity: 20,
  challenge_create: 30,
  discovery: 40,
  ordinary: 50,
});

export const API_RATE_LIMIT_BACKOFF_MS = Object.freeze([
  60_000,
  120_000,
  300_000,
  900_000,
  3_600_000,
]);
export const API_RATE_LIMIT_STRIKE_RESET_MS = 6 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (value === null || value === undefined) return 0;
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1_000)) : 0;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error("Lichess request was cancelled");
}

export class ApiSafetyCoordinator {
  constructor({
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    initialState = {},
    persistSafetyState = null,
    onStateChange = null,
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.persistSafetyState = persistSafetyState;
    this.onStateChange = onStateChange;
    this.queue = [];
    this.sequence = 0;
    this.running = false;
    this.inFlightClass = null;
    this.cooldownUntil = Number(initialState.cooldownUntil ?? initialState.cooldown_until) || 0;
    this.strikeCount = Number(initialState.strikeCount ?? initialState.strike_count) || 0;
    this.last429At = Number(initialState.last429At ?? initialState.last_429_at) || 0;
    this.lastRetryAfterMs = Number(
      initialState.lastRetryAfterMs ?? initialState.last_retry_after_ms,
    ) || 0;
    this.timer = null;
    this.timerDeadline = 0;
    this.counters = {
      dispatched: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
    };
  }

  enqueue(task, options = {}) {
    const normalized = typeof options === "number" ? { priority: options } : options;
    const requestClass = normalized.requestClass ?? "ordinary";
    const priority = normalized.priority ?? API_REQUEST_PRIORITY[requestClass]
      ?? API_REQUEST_PRIORITY.ordinary;
    const signal = normalized.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const entry = {
        task,
        priority,
        requestClass,
        signal,
        sequence: this.sequence++,
        resolve,
        reject,
        abortListener: null,
      };
      if (signal?.addEventListener) {
        entry.abortListener = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortReason(signal));
          this.pump();
        };
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      this.pump();
    });
  }

  async registerRateLimit(retryAfter, requestClass = "ordinary") {
    const now = this.now();
    const retryAfterMs = typeof retryAfter === "number"
      ? Math.max(0, Math.ceil(retryAfter))
      : retryAfterMilliseconds(retryAfter, now);
    const recent = this.last429At > 0 && now - this.last429At < API_RATE_LIMIT_STRIKE_RESET_MS;
    this.strikeCount = recent
      ? Math.min(API_RATE_LIMIT_BACKOFF_MS.length, this.strikeCount + 1)
      : 1;
    const scheduled = API_RATE_LIMIT_BACKOFF_MS[this.strikeCount - 1];
    const delayMs = Math.max(scheduled, retryAfterMs);
    this.last429At = now;
    this.lastRetryAfterMs = retryAfterMs;
    this.cooldownUntil = Math.max(this.cooldownUntil, now + delayMs);
    this.counters.rateLimited += 1;
    this.rescheduleCooldownTimer();
    const state = this.safetyState();
    if (this.persistSafetyState) await this.persistSafetyState(state);
    this.onStateChange?.({ event: "api_rate_limit_entered", requestClass, ...state });
    return Math.max(0, this.cooldownUntil - now);
  }

  safetyState() {
    return {
      cooldownUntil: this.cooldownUntil,
      strikeCount: this.effectiveStrikeCount(),
      last429At: this.last429At,
      lastRetryAfterMs: this.lastRetryAfterMs,
    };
  }

  effectiveStrikeCount() {
    if (!this.last429At || this.now() - this.last429At >= API_RATE_LIMIT_STRIKE_RESET_MS) return 0;
    return this.strikeCount;
  }

  cooldownRemainingMs() {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  isCoolingDown() {
    return this.cooldownRemainingMs() > 0;
  }

  snapshot() {
    const queueDepthByClass = {};
    for (const entry of this.queue) {
      queueDepthByClass[entry.requestClass] = (queueDepthByClass[entry.requestClass] ?? 0) + 1;
    }
    return {
      state: this.isCoolingDown() ? "cooldown" : "ready",
      cooldown_until: this.cooldownUntil || null,
      cooldown_remaining_ms: this.cooldownRemainingMs(),
      strike_count: this.effectiveStrikeCount(),
      last_429_at: this.last429At || null,
      last_retry_after_ms: this.lastRetryAfterMs,
      in_flight_class: this.inFlightClass,
      queue_depth: this.queue.length,
      queue_depth_by_class: queueDepthByClass,
      counters: {
        dispatched: this.counters.dispatched,
        succeeded: this.counters.succeeded,
        failed: this.counters.failed,
        rate_limited: this.counters.rateLimited,
      },
    };
  }

  rescheduleCooldownTimer() {
    const remaining = this.cooldownRemainingMs();
    if (remaining <= 0 || !this.queue.length) {
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      this.timerDeadline = 0;
      return;
    }
    if (this.timer && this.timerDeadline === this.cooldownUntil) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timerDeadline = this.cooldownUntil;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerDeadline = 0;
      if (this.isCoolingDown()) {
        this.rescheduleCooldownTimer();
        return;
      }
      this.onStateChange?.({ event: "api_rate_limit_cleared", ...this.safetyState() });
      this.pump();
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  }

  pump() {
    if (this.running || !this.queue.length) return;
    if (this.isCoolingDown()) {
      this.rescheduleCooldownTimer();
      return;
    }
    const next = this.queue.shift();
    if (next.abortListener) next.signal.removeEventListener("abort", next.abortListener);
    if (next.signal?.aborted) {
      next.reject(abortReason(next.signal));
      this.pump();
      return;
    }
    this.running = true;
    this.inFlightClass = next.requestClass;
    this.counters.dispatched += 1;
    Promise.resolve().then(next.task).then((value) => {
      this.counters.succeeded += 1;
      next.resolve(value);
    }, (error) => {
      this.counters.failed += 1;
      next.reject(error);
    }).finally(() => {
      this.running = false;
      this.inFlightClass = null;
      this.pump();
    });
  }
}

export class PriorityRequestQueue extends ApiSafetyCoordinator {}
