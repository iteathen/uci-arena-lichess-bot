import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function normalizedUsername(value) {
  const username = String(value ?? "").trim().toLocaleLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(username)) throw new Error(`Invalid Lichess username: ${value}`);
  return username;
}

function integer(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function authorityKey(value) {
  const key = String(value ?? "").trim().toLocaleLowerCase();
  if (!key || key.length > 512) throw new Error("Invalid Lichess API authority key");
  return key;
}

function botRating(bot) {
  for (const key of ["blitz", "rapid", "classical", "bullet"]) {
    const rating = Number(bot?.perfs?.[key]?.rating);
    if (Number.isFinite(rating)) return Math.round(rating);
  }
  return 0;
}

export class LichessStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
      CREATE TABLE IF NOT EXISTS owners(
        username TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reservations(
        id INTEGER PRIMARY KEY CHECK(id=1),
        opponent TEXT NOT NULL,
        games_remaining INTEGER NOT NULL CHECK(games_remaining > 0),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scheduler_control(
        id INTEGER PRIMARY KEY CHECK(id=1),
        paused INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO scheduler_control(id, paused, updated_at) VALUES(1, 0, 0);
      CREATE TABLE IF NOT EXISTS opponents(
        username TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        rating INTEGER NOT NULL DEFAULT 0,
        online INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        accepts INTEGER NOT NULL DEFAULT 0,
        declines INTEGER NOT NULL DEFAULT 0,
        timeouts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS challenge_attempts(
        challenge_id TEXT PRIMARY KEY,
        opponent TEXT NOT NULL,
        audience TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'random',
        clock_limit INTEGER NOT NULL DEFAULT 0,
        clock_increment INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS games(
        game_id TEXT PRIMARY KEY,
        opponent TEXT NOT NULL DEFAULT '',
        audience TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '',
        rated INTEGER NOT NULL DEFAULT 0,
        speed TEXT NOT NULL DEFAULT '',
        clock_limit INTEGER NOT NULL DEFAULT 0,
        clock_increment INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'started',
        result TEXT NOT NULL DEFAULT '',
        winner TEXT NOT NULL DEFAULT '',
        plies INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL DEFAULT 0,
        engine_build_fingerprint TEXT NOT NULL DEFAULT '',
        model_fingerprint TEXT NOT NULL DEFAULT '',
        provider_fingerprint TEXT NOT NULL DEFAULT '',
        book_identity TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS games_opponent_finished ON games(opponent, finished_at);
      CREATE INDEX IF NOT EXISTS challenges_opponent_created ON challenge_attempts(opponent, created_at);
    `);
    let version = this.db.prepare("SELECT version FROM schema_meta LIMIT 1").get()?.version;
    if (version === 1) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS api_safety_state(
            authority_key TEXT PRIMARY KEY,
            cooldown_until INTEGER NOT NULL DEFAULT 0,
            strike_count INTEGER NOT NULL DEFAULT 0,
            last_429_at INTEGER NOT NULL DEFAULT 0,
            last_retry_after_ms INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS api_client_leases(
            authority_key TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            pid INTEGER NOT NULL,
            heartbeat_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );
          UPDATE schema_meta SET version=2;
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      version = 2;
    }
    if (version !== 2) throw new Error(`Unsupported Lichess store schema version: ${version}`);
  }

  close() {
    this.db.close();
  }

  addOwner(username, now = Date.now()) {
    const normalized = normalizedUsername(username);
    this.db.prepare("INSERT OR IGNORE INTO owners(username, created_at) VALUES(?, ?)").run(normalized, now);
    return normalized;
  }

  removeOwner(username) {
    return this.db.prepare("DELETE FROM owners WHERE username=?").run(normalizedUsername(username)).changes > 0;
  }

  listOwners() {
    return this.db.prepare("SELECT username, created_at FROM owners ORDER BY username").all();
  }

  isOwner(username) {
    if (!username) return false;
    return Boolean(this.db.prepare("SELECT 1 AS found FROM owners WHERE username=?").get(normalizedUsername(username)));
  }

  reserve(opponent, games, minutes, now = Date.now()) {
    const normalized = normalizedUsername(opponent);
    const count = integer(games);
    const duration = integer(minutes);
    if (count < 1 || count > 100) throw new Error("Reservation games must be in 1..100");
    if (duration < 1 || duration > 1440) throw new Error("Reservation minutes must be in 1..1440");
    if (!this.isOwner(normalized)) throw new Error(`Reservation opponent is not a registered owner: ${normalized}`);
    const expiresAt = now + duration * 60_000;
    this.db.prepare(`
      INSERT INTO reservations(id, opponent, games_remaining, expires_at, created_at)
      VALUES(1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET opponent=excluded.opponent,
        games_remaining=excluded.games_remaining, expires_at=excluded.expires_at,
        created_at=excluded.created_at
    `).run(normalized, count, expiresAt, now);
    return this.getReservation(now);
  }

  getReservation(now = Date.now()) {
    this.db.prepare("DELETE FROM reservations WHERE expires_at <= ?").run(now);
    return this.db.prepare("SELECT opponent, games_remaining, expires_at, created_at FROM reservations WHERE id=1").get() ?? null;
  }

  consumeReservation(opponent, now = Date.now()) {
    const reservation = this.getReservation(now);
    if (!reservation || reservation.opponent !== normalizedUsername(opponent)) return false;
    if (reservation.games_remaining <= 1) this.db.prepare("DELETE FROM reservations WHERE id=1").run();
    else this.db.prepare("UPDATE reservations SET games_remaining=games_remaining-1 WHERE id=1").run();
    return true;
  }

  cancelReservation() {
    return this.db.prepare("DELETE FROM reservations WHERE id=1").run().changes > 0;
  }

  setPaused(paused, now = Date.now()) {
    this.db.prepare("UPDATE scheduler_control SET paused=?, updated_at=? WHERE id=1").run(paused ? 1 : 0, now);
  }

  control(now = Date.now()) {
    return {
      paused: Boolean(this.db.prepare("SELECT paused FROM scheduler_control WHERE id=1").get()?.paused),
      reservation: this.getReservation(now),
    };
  }

  apiSafetyState(key) {
    const normalized = authorityKey(key);
    const row = this.db.prepare(`
      SELECT cooldown_until, strike_count, last_429_at, last_retry_after_ms
      FROM api_safety_state WHERE authority_key=?
    `).get(normalized);
    return row ? {
      cooldownUntil: Number(row.cooldown_until),
      strikeCount: Number(row.strike_count),
      last429At: Number(row.last_429_at),
      lastRetryAfterMs: Number(row.last_retry_after_ms),
    } : {
      cooldownUntil: 0,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
    };
  }

  saveApiSafetyState(key, state, now = Date.now()) {
    const normalized = authorityKey(key);
    this.db.prepare(`
      INSERT INTO api_safety_state(authority_key, cooldown_until, strike_count,
        last_429_at, last_retry_after_ms, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(authority_key) DO UPDATE SET
        cooldown_until=MAX(api_safety_state.cooldown_until, excluded.cooldown_until),
        strike_count=excluded.strike_count,
        last_429_at=excluded.last_429_at,
        last_retry_after_ms=excluded.last_retry_after_ms,
        updated_at=excluded.updated_at
    `).run(
      normalized,
      integer(state.cooldownUntil),
      integer(state.strikeCount),
      integer(state.last429At),
      integer(state.lastRetryAfterMs),
      now,
    );
    return this.apiSafetyState(normalized);
  }

  listApiSafetyState() {
    return this.db.prepare(`
      SELECT authority_key, cooldown_until, strike_count, last_429_at,
        last_retry_after_ms, updated_at
      FROM api_safety_state ORDER BY authority_key
    `).all();
  }

  acquireApiLease(key, ownerId, pid, now = Date.now(), ttlMs = 60_000) {
    const normalized = authorityKey(key);
    const owner = String(ownerId ?? "").trim();
    if (!owner) throw new Error("Lichess API lease owner id is required");
    const expiresAt = now + integer(ttlMs, 60_000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare(`
        SELECT owner_id, pid, heartbeat_at, expires_at
        FROM api_client_leases WHERE authority_key=?
      `).get(normalized);
      if (active && active.owner_id !== owner && Number(active.expires_at) > now) {
        const error = new Error(
          `Lichess API authority ${normalized} is already leased by process ${active.pid}`,
        );
        error.code = "LICHESS_API_LEASE_HELD";
        error.expiresAt = Number(active.expires_at);
        throw error;
      }
      this.db.prepare(`
        INSERT INTO api_client_leases(authority_key, owner_id, pid, heartbeat_at, expires_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(authority_key) DO UPDATE SET owner_id=excluded.owner_id,
          pid=excluded.pid, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at
      `).run(normalized, owner, integer(pid), now, expiresAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.apiLease(normalized);
  }

  heartbeatApiLease(key, ownerId, pid, now = Date.now(), ttlMs = 60_000) {
    const normalized = authorityKey(key);
    const result = this.db.prepare(`
      UPDATE api_client_leases SET pid=?, heartbeat_at=?, expires_at=?
      WHERE authority_key=? AND owner_id=?
    `).run(integer(pid), now, now + integer(ttlMs, 60_000), normalized, String(ownerId));
    if (result.changes !== 1) {
      const error = new Error(`Lichess API lease ownership was lost for ${normalized}`);
      error.code = "LICHESS_API_LEASE_LOST";
      throw error;
    }
    return this.apiLease(normalized);
  }

  releaseApiLease(key, ownerId) {
    return this.db.prepare("DELETE FROM api_client_leases WHERE authority_key=? AND owner_id=?")
      .run(authorityKey(key), String(ownerId)).changes > 0;
  }

  apiLease(key) {
    return this.db.prepare(`
      SELECT authority_key, owner_id, pid, heartbeat_at, expires_at
      FROM api_client_leases WHERE authority_key=?
    `).get(authorityKey(key)) ?? null;
  }

  activeApiLeases(now = Date.now()) {
    return this.db.prepare(`
      SELECT authority_key, pid, heartbeat_at, expires_at
      FROM api_client_leases WHERE expires_at>? ORDER BY authority_key
    `).all(now);
  }

  replaceOnlineBots(bots, now = Date.now()) {
    const reset = this.db.prepare("UPDATE opponents SET online=0");
    const upsert = this.db.prepare(`
      INSERT INTO opponents(username, title, rating, online, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, 1, ?, ?)
      ON CONFLICT(username) DO UPDATE SET title=excluded.title, rating=excluded.rating,
        online=1, last_seen_at=excluded.last_seen_at
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      reset.run();
      for (const bot of bots) {
        const username = normalizedUsername(bot.username ?? bot.name ?? bot.id);
        upsert.run(username, String(bot.title ?? "BOT"), botRating(bot), now, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  eligibleBots({ self, now = Date.now(), maximumGamesPerDay = 2 } = {}) {
    const dayStart = now - 24 * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT o.*,
        (SELECT COUNT(*) FROM games g WHERE g.opponent=o.username AND g.started_at>=?) AS games_today,
        (SELECT COUNT(*) FROM games g WHERE g.opponent=o.username) AS total_games,
        (SELECT MAX(g.finished_at) FROM games g WHERE g.opponent=o.username) AS last_game_at,
        (SELECT COUNT(*) FROM games g WHERE g.opponent=o.username AND g.color='white') AS white_games,
        (SELECT COUNT(*) FROM games g WHERE g.opponent=o.username AND g.color='black') AS black_games
      FROM opponents o
      WHERE o.online=1 AND o.cooldown_until<=? AND o.username<>?
        AND (SELECT COUNT(*) FROM games g WHERE g.opponent=o.username AND g.started_at>=?) < ?
    `).all(dayStart, now, normalizedUsername(self), dayStart, maximumGamesPerDay);
  }

  setOpponentCooldown(username, minutes, now = Date.now()) {
    const until = now + integer(minutes) * 60_000;
    this.db.prepare("UPDATE opponents SET cooldown_until=MAX(cooldown_until, ?) WHERE username=?")
      .run(until, normalizedUsername(username));
    return until;
  }

  recordChallenge({ id, opponent, audience, direction, status, color, clockLimit, clockIncrement }, now = Date.now()) {
    if (!id) throw new Error("Challenge id is required");
    const username = normalizedUsername(opponent);
    this.db.prepare(`
      INSERT INTO challenge_attempts(challenge_id, opponent, audience, direction, status,
        color, clock_limit, clock_increment, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(challenge_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
    `).run(String(id), username, audience, direction, status, color ?? "random",
      integer(clockLimit), integer(clockIncrement), now, now);
  }

  updateChallenge(id, status, { cooldownMinutes = 0 } = {}, now = Date.now()) {
    const row = this.db.prepare("SELECT opponent, status FROM challenge_attempts WHERE challenge_id=?").get(String(id));
    this.db.prepare("UPDATE challenge_attempts SET status=?, updated_at=? WHERE challenge_id=?").run(status, now, String(id));
    if (!row) return;
    const column = status === "accepted" ? "accepts" : status === "declined" ? "declines" : status === "timeout" ? "timeouts" : null;
    if (column && row.status !== status) {
      this.db.prepare(`UPDATE opponents SET ${column}=${column}+1 WHERE username=?`).run(row.opponent);
    }
    if (cooldownMinutes > 0) {
      this.db.prepare("UPDATE opponents SET cooldown_until=MAX(cooldown_until, ?) WHERE username=?")
        .run(now + cooldownMinutes * 60_000, row.opponent);
    }
  }

  beginGame(game) {
    const now = game.startedAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO games(game_id, opponent, audience, color, rated, speed, clock_limit,
        clock_increment, status, started_at, engine_build_fingerprint, model_fingerprint,
        provider_fingerprint, book_identity)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET opponent=excluded.opponent,
        audience=excluded.audience, color=excluded.color, rated=excluded.rated,
        speed=excluded.speed, clock_limit=excluded.clock_limit,
        clock_increment=excluded.clock_increment
    `).run(String(game.id), normalizedUsername(game.opponent), game.audience, game.color,
      game.rated ? 1 : 0, game.speed ?? "", integer(game.clockLimit), integer(game.clockIncrement),
      now, game.engineBuildFingerprint ?? "", game.modelFingerprint ?? "",
      game.providerFingerprint ?? "", game.bookIdentity ?? "");
  }

  finishGame({ id, status, result, winner, plies, finishedAt = Date.now() }) {
    this.db.prepare(`UPDATE games SET status=?, result=?, winner=?, plies=?, finished_at=?
      WHERE game_id=? AND finished_at=0`)
      .run(status ?? "unknown", result ?? "", winner ?? "", integer(plies), finishedAt, String(id));
  }

  opponentAudience(username) {
    if (!username) return null;
    const row = this.db.prepare("SELECT title FROM opponents WHERE username=?")
      .get(normalizedUsername(username));
    return String(row?.title ?? "").toUpperCase() === "BOT" ? "bot" : null;
  }

  opponentStats(limit = 100) {
    return this.db.prepare(`
      SELECT g.opponent, COALESCE(MAX(o.rating), 0) AS rating,
        COUNT(*) AS games,
        SUM(CASE WHEN g.result='win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN g.result='draw' THEN 1 ELSE 0 END) AS draws,
        SUM(CASE WHEN g.result='loss' THEN 1 ELSE 0 END) AS losses,
        COALESCE(MAX(o.accepts), 0) AS accepts,
        COALESCE(MAX(o.declines), 0) AS declines,
        COALESCE(MAX(o.timeouts), 0) AS timeouts,
        MAX(g.finished_at) AS last_game_at
      FROM games g LEFT JOIN opponents o ON o.username=g.opponent
      WHERE g.finished_at>0 GROUP BY g.opponent ORDER BY games DESC, g.opponent LIMIT ?
    `).all(integer(limit, 100));
  }

  status(now = Date.now()) {
    return {
      schemaVersion: 2,
      control: this.control(now),
      owners: this.listOwners(),
      opponents: this.db.prepare("SELECT COUNT(*) AS count FROM opponents").get().count,
      challenges: this.db.prepare("SELECT COUNT(*) AS count FROM challenge_attempts").get().count,
      games: this.db.prepare("SELECT COUNT(*) AS count FROM games").get().count,
      opponentStats: this.opponentStats(),
      apiSafety: this.listApiSafetyState(),
      apiLeases: this.activeApiLeases(now),
    };
  }
}

export { normalizedUsername };
