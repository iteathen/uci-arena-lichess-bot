import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  sameProcessInstance,
  validProcessIdentity,
} from "./process-instance-identity.mjs";

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

const GAME_PROVENANCE_BACKFILL_COLUMNS = Object.freeze({
  model_id: "text",
  checkpoint_hash: "text",
  adapter_id: "text",
  provider: "text",
  hardware_driver_fingerprint: "text",
  onnx_runtime_version: "text",
  search_core: "text",
  threads: "integer",
  root_workers: "integer",
  split_depth: "integer",
  batch_size: "integer",
  batch_wait_us: "integer",
  time_profile_identity: "text",
});

function timestamp(value, label) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function exactIdentity(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Historical provenance requires ${label}`);
  return normalized;
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_safety_state(
        authority_key TEXT PRIMARY KEY,
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        strike_count INTEGER NOT NULL DEFAULT 0,
        last_429_at INTEGER NOT NULL DEFAULT 0,
        last_retry_after_ms INTEGER NOT NULL DEFAULT 0,
        challenge_blocked_until INTEGER NOT NULL DEFAULT 0,
        challenge_strike_count INTEGER NOT NULL DEFAULT 0,
        challenge_last_429_at INTEGER NOT NULL DEFAULT 0,
        challenge_recovered_at INTEGER NOT NULL DEFAULT 0,
        challenge_half_open INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_client_leases(
        authority_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_identity_json TEXT NOT NULL DEFAULT '',
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const legacyRateLimit = this.db.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type='table' AND name='api_rate_limit'
    `).get();
    if (legacyRateLimit) {
      this.db.exec(`
        INSERT INTO api_safety_state(
          authority_key, cooldown_until, strike_count, last_429_at,
          last_retry_after_ms, updated_at
        )
        SELECT '*', blocked_until, consecutive_429, last_429_at, 0,
          MAX(last_429_at, blocked_until)
        FROM api_rate_limit WHERE id=1
        ON CONFLICT(authority_key) DO UPDATE SET
          cooldown_until=MAX(api_safety_state.cooldown_until, excluded.cooldown_until),
          strike_count=CASE
            WHEN excluded.last_429_at >= api_safety_state.last_429_at
              THEN excluded.strike_count
            ELSE api_safety_state.strike_count
          END,
          last_429_at=MAX(api_safety_state.last_429_at, excluded.last_429_at),
          updated_at=MAX(api_safety_state.updated_at, excluded.updated_at);
      `);
    }
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
            challenge_blocked_until INTEGER NOT NULL DEFAULT 0,
            challenge_strike_count INTEGER NOT NULL DEFAULT 0,
            challenge_last_429_at INTEGER NOT NULL DEFAULT 0,
            challenge_recovered_at INTEGER NOT NULL DEFAULT 0,
            challenge_half_open INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS api_client_leases(
            authority_key TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            pid INTEGER NOT NULL,
            process_identity_json TEXT NOT NULL DEFAULT '',
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
    if (version === 2) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
          ALTER TABLE games ADD COLUMN model_id TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN checkpoint_hash TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN adapter_id TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN provider TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN hardware_driver_fingerprint TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN onnx_runtime_version TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN search_core TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN threads INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE games ADD COLUMN root_workers INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE games ADD COLUMN split_depth INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE games ADD COLUMN batch_size INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE games ADD COLUMN batch_wait_us INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE games ADD COLUMN time_profile_identity TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN runtime_provenance_sha256 TEXT NOT NULL DEFAULT '';
          ALTER TABLE games ADD COLUMN runtime_provenance_json TEXT NOT NULL DEFAULT '{}';
          UPDATE schema_meta SET version=3;
        `);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      version = 3;
    }
    if (version === 3) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const columns = new Set(this.db.prepare("PRAGMA table_info(api_client_leases)").all()
          .map((column) => column.name));
        if (!columns.has("process_identity_json")) {
          this.db.exec(
            "ALTER TABLE api_client_leases ADD COLUMN process_identity_json TEXT NOT NULL DEFAULT ''",
          );
        }
        this.db.exec("UPDATE schema_meta SET version=4");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      version = 4;
    }
    if (version === 4) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const columns = new Set(this.db.prepare("PRAGMA table_info(api_safety_state)").all()
          .map((column) => column.name));
        for (const [name, definition] of [
          ["challenge_blocked_until", "INTEGER NOT NULL DEFAULT 0"],
          ["challenge_strike_count", "INTEGER NOT NULL DEFAULT 0"],
          ["challenge_last_429_at", "INTEGER NOT NULL DEFAULT 0"],
          ["challenge_recovered_at", "INTEGER NOT NULL DEFAULT 0"],
          ["challenge_half_open", "INTEGER NOT NULL DEFAULT 0"],
        ]) {
          if (!columns.has(name)) {
            this.db.exec(`ALTER TABLE api_safety_state ADD COLUMN ${name} ${definition}`);
          }
        }
        this.db.exec("UPDATE schema_meta SET version=5");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      version = 5;
    }
    if (version !== 5) throw new Error(`Unsupported Lichess store schema version: ${version}`);
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
    const normalized = normalizedUsername(opponent);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM reservations WHERE expires_at <= ?").run(now);
      const reservation = this.db.prepare(`
        SELECT opponent, games_remaining FROM reservations WHERE id=1
      `).get();
      if (!reservation || reservation.opponent !== normalized) {
        this.db.exec("COMMIT");
        return false;
      }
      if (reservation.games_remaining <= 1) {
        this.db.prepare("DELETE FROM reservations WHERE id=1 AND opponent=?").run(normalized);
      } else {
        this.db.prepare(`
          UPDATE reservations SET games_remaining=games_remaining-1
          WHERE id=1 AND opponent=?
        `).run(normalized);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
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
    const rows = this.db.prepare(`
      SELECT authority_key, cooldown_until, strike_count, last_429_at,
        last_retry_after_ms, challenge_blocked_until, challenge_strike_count,
        challenge_last_429_at, challenge_recovered_at, challenge_half_open
      FROM api_safety_state WHERE authority_key=? OR authority_key='*'
    `).all(normalized);
    const latest = rows.reduce((selected, row) => {
      if (!selected || row.last_429_at > selected.last_429_at) return row;
      if (row.last_429_at === selected.last_429_at && row.authority_key === normalized) {
        return row;
      }
      return selected;
    }, null);
    const challengeLatest = rows.reduce((selected, row) => {
      const eventAt = Math.max(
        Number(row.challenge_last_429_at),
        Number(row.challenge_recovered_at),
      );
      const selectedAt = selected
        ? Math.max(
          Number(selected.challenge_last_429_at),
          Number(selected.challenge_recovered_at),
        )
        : -1;
      if (!selected || eventAt > selectedAt) return row;
      if (eventAt === selectedAt && row.authority_key === normalized) return row;
      return selected;
    }, null);
    return latest ? {
      cooldownUntil: Math.max(...rows.map((row) => Number(row.cooldown_until))),
      strikeCount: Number(latest.strike_count),
      last429At: Number(latest.last_429_at),
      lastRetryAfterMs: Number(latest.last_retry_after_ms),
      challengeBlockedUntil: Math.max(
        ...rows.map((row) => Number(row.challenge_blocked_until)),
      ),
      challengeStrikeCount: Number(challengeLatest.challenge_strike_count),
      challengeLast429At: Number(challengeLatest.challenge_last_429_at),
      challengeRecoveredAt: Number(challengeLatest.challenge_recovered_at),
      challengeHalfOpen: Boolean(challengeLatest.challenge_half_open),
    } : {
      cooldownUntil: 0,
      strikeCount: 0,
      last429At: 0,
      lastRetryAfterMs: 0,
      challengeBlockedUntil: 0,
      challengeStrikeCount: 0,
      challengeLast429At: 0,
      challengeRecoveredAt: 0,
      challengeHalfOpen: false,
    };
  }

  saveApiSafetyState(key, state, now = Date.now()) {
    const normalized = authorityKey(key);
    this.db.prepare(`
      INSERT INTO api_safety_state(authority_key, cooldown_until, strike_count,
        last_429_at, last_retry_after_ms, challenge_blocked_until,
        challenge_strike_count, challenge_last_429_at, challenge_recovered_at,
        challenge_half_open, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(authority_key) DO UPDATE SET
        cooldown_until=MAX(api_safety_state.cooldown_until, excluded.cooldown_until),
        strike_count=CASE
          WHEN excluded.last_429_at>api_safety_state.last_429_at THEN excluded.strike_count
          WHEN excluded.last_429_at=api_safety_state.last_429_at
            THEN MAX(api_safety_state.strike_count, excluded.strike_count)
          ELSE api_safety_state.strike_count
        END,
        last_429_at=MAX(api_safety_state.last_429_at, excluded.last_429_at),
        last_retry_after_ms=CASE
          WHEN excluded.last_429_at>api_safety_state.last_429_at
            THEN excluded.last_retry_after_ms
          WHEN excluded.last_429_at=api_safety_state.last_429_at
            THEN MAX(api_safety_state.last_retry_after_ms, excluded.last_retry_after_ms)
          ELSE api_safety_state.last_retry_after_ms
        END,
        challenge_blocked_until=CASE
          WHEN MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
              > MAX(api_safety_state.challenge_last_429_at,
                api_safety_state.challenge_recovered_at)
            OR (MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
                = MAX(api_safety_state.challenge_last_429_at,
                  api_safety_state.challenge_recovered_at)
              AND excluded.updated_at>=api_safety_state.updated_at)
            THEN excluded.challenge_blocked_until
          ELSE api_safety_state.challenge_blocked_until
        END,
        challenge_strike_count=CASE
          WHEN MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
              > MAX(api_safety_state.challenge_last_429_at,
                api_safety_state.challenge_recovered_at)
            OR (MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
                = MAX(api_safety_state.challenge_last_429_at,
                  api_safety_state.challenge_recovered_at)
              AND excluded.updated_at>=api_safety_state.updated_at)
            THEN excluded.challenge_strike_count
          ELSE api_safety_state.challenge_strike_count
        END,
        challenge_last_429_at=CASE
          WHEN MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
              > MAX(api_safety_state.challenge_last_429_at,
                api_safety_state.challenge_recovered_at)
            OR (MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
                = MAX(api_safety_state.challenge_last_429_at,
                  api_safety_state.challenge_recovered_at)
              AND excluded.updated_at>=api_safety_state.updated_at)
            THEN excluded.challenge_last_429_at
          ELSE api_safety_state.challenge_last_429_at
        END,
        challenge_recovered_at=MAX(
          api_safety_state.challenge_recovered_at,
          excluded.challenge_recovered_at
        ),
        challenge_half_open=CASE
          WHEN MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
              > MAX(api_safety_state.challenge_last_429_at,
                api_safety_state.challenge_recovered_at)
            OR (MAX(excluded.challenge_last_429_at, excluded.challenge_recovered_at)
                = MAX(api_safety_state.challenge_last_429_at,
                  api_safety_state.challenge_recovered_at)
              AND excluded.updated_at>=api_safety_state.updated_at)
            THEN excluded.challenge_half_open
          ELSE api_safety_state.challenge_half_open
        END,
        updated_at=MAX(api_safety_state.updated_at, excluded.updated_at)
    `).run(
      normalized,
      integer(state.cooldownUntil),
      integer(state.strikeCount),
      integer(state.last429At),
      integer(state.lastRetryAfterMs),
      integer(state.challengeBlockedUntil),
      integer(state.challengeStrikeCount),
      integer(state.challengeLast429At),
      integer(state.challengeRecoveredAt),
      state.challengeHalfOpen ? 1 : 0,
      now,
    );
    return this.apiSafetyState(normalized);
  }

  listApiSafetyState() {
    return this.db.prepare(`
      SELECT authority_key, cooldown_until, strike_count, last_429_at,
        last_retry_after_ms, challenge_blocked_until, challenge_strike_count,
        challenge_last_429_at, challenge_recovered_at, challenge_half_open,
        updated_at
      FROM api_safety_state ORDER BY authority_key
    `).all();
  }

  acquireApiLease(
    key,
    ownerId,
    pid,
    now = Date.now(),
    ttlMs = 60_000,
    ownerProcessProbe = null,
    processIdentity = null,
  ) {
    const normalized = authorityKey(key);
    const owner = String(ownerId ?? "").trim();
    if (!owner) throw new Error("Lichess API lease owner id is required");
    if (ownerProcessProbe !== null && typeof ownerProcessProbe !== "function") {
      throw new Error("Lichess API lease owner process probe is invalid");
    }
    if (!validProcessIdentity(processIdentity, Number(pid))) {
      throw new Error("Lichess API lease process identity is invalid");
    }
    const expiresAt = now + integer(ttlMs, 60_000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const active = this.db.prepare(`
        SELECT owner_id, pid, process_identity_json, heartbeat_at, expires_at
        FROM api_client_leases WHERE authority_key=?
      `).get(normalized);
      const activePid = Number(active?.pid);
      let ownerProvenReplaced = false;
      if (active && active.owner_id !== owner && Number.isSafeInteger(activePid)
          && activePid > 0 && ownerProcessProbe) {
        let observed = { state: "unverifiable" };
        try {
          observed = ownerProcessProbe(activePid) ?? observed;
        } catch {}
        let recordedIdentity = null;
        try {
          const parsed = JSON.parse(active.process_identity_json);
          if (validProcessIdentity(parsed, activePid)) recordedIdentity = parsed;
        } catch {}
        ownerProvenReplaced = observed.state === "absent"
          || (recordedIdentity && observed.state === "present"
            && !sameProcessInstance(recordedIdentity, observed.identity));
      }
      if (active && active.owner_id !== owner && Number(active.expires_at) > now
          && !ownerProvenReplaced) {
        const error = new Error(
          `Lichess API authority ${normalized} is already leased by process ${active.pid}`,
        );
        error.code = "LICHESS_API_LEASE_HELD";
        error.expiresAt = Number(active.expires_at);
        throw error;
      }
      this.db.prepare(`
        INSERT INTO api_client_leases(authority_key, owner_id, pid, process_identity_json,
          heartbeat_at, expires_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(authority_key) DO UPDATE SET owner_id=excluded.owner_id,
          pid=excluded.pid, process_identity_json=excluded.process_identity_json,
          heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at
      `).run(normalized, owner, integer(pid), JSON.stringify(processIdentity), now, expiresAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.apiLease(normalized);
  }

  heartbeatApiLease(
    key,
    ownerId,
    pid,
    now = Date.now(),
    ttlMs = 60_000,
    processIdentity = null,
  ) {
    const normalized = authorityKey(key);
    if (!validProcessIdentity(processIdentity, Number(pid))) {
      throw new Error("Lichess API lease process identity is invalid");
    }
    const result = this.db.prepare(`
      UPDATE api_client_leases SET heartbeat_at=?, expires_at=?
      WHERE authority_key=? AND owner_id=? AND pid=? AND process_identity_json=?
    `).run(
      now,
      now + integer(ttlMs, 60_000),
      normalized,
      String(ownerId),
      integer(pid),
      JSON.stringify(processIdentity),
    );
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
      SELECT authority_key, owner_id, pid, process_identity_json, heartbeat_at, expires_at
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
    const runtimeProvenanceJson = JSON.stringify(game.runtimeProvenance ?? {});
    this.db.prepare(`
      INSERT INTO games(game_id, opponent, audience, color, rated, speed, clock_limit,
        clock_increment, status, started_at, engine_build_fingerprint, model_fingerprint,
        provider_fingerprint, book_identity, model_id, checkpoint_hash, adapter_id,
        provider, hardware_driver_fingerprint, onnx_runtime_version, search_core, threads,
        root_workers, split_depth, batch_size, batch_wait_us, time_profile_identity,
        runtime_provenance_sha256, runtime_provenance_json)
      VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'started', ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
        ?27, ?28)
      ON CONFLICT(game_id) DO UPDATE SET opponent=excluded.opponent,
        audience=excluded.audience, color=excluded.color, rated=excluded.rated,
        speed=excluded.speed, clock_limit=excluded.clock_limit,
        clock_increment=excluded.clock_increment
    `).run(String(game.id), normalizedUsername(game.opponent), game.audience, game.color,
      game.rated ? 1 : 0, game.speed ?? "", integer(game.clockLimit), integer(game.clockIncrement),
      now, game.engineBuildFingerprint ?? "", game.modelFingerprint ?? "",
      game.providerFingerprint ?? "", game.bookIdentity ?? "", game.modelId ?? "",
      game.checkpointHash ?? "", game.adapterId ?? "", game.provider ?? "",
      game.hardwareDriverFingerprint ?? "", game.onnxRuntimeVersion ?? "",
      game.searchCore ?? "", integer(game.threads), integer(game.rootWorkers),
      integer(game.splitDepth), integer(game.batchSize), integer(game.batchWaitUs),
      game.timeProfileIdentity ?? "", game.runtimeProvenanceSha256 ?? "",
      runtimeProvenanceJson);
  }

  backfillGameProvenance(entries, { apply = false } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("Historical provenance backfill requires at least one evidence entry");
    }
    const reports = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        const deploymentId = exactIdentity(entry.deployment_id, "deployment_id");
        const from = timestamp(entry.started_at_or_after, "started_at_or_after");
        const before = timestamp(entry.started_before, "started_before");
        if (from >= before) throw new Error(`Invalid historical interval for ${deploymentId}`);
        const match = entry.match ?? {};
        const engineBuild = exactIdentity(match.engine_build_fingerprint, "engine_build_fingerprint");
        const modelFingerprint = exactIdentity(match.model_fingerprint, "model_fingerprint");
        const providerFingerprint = exactIdentity(match.provider_fingerprint, "provider_fingerprint");
        const bookIdentity = exactIdentity(match.book_identity, "book_identity");
        if (!Array.isArray(match.game_ids ?? [])) {
          throw new Error(`Invalid historical game_ids selector for ${deploymentId}`);
        }
        const gameIds = (match.game_ids ?? []).map((gameId) => String(gameId));
        if (new Set(gameIds).size !== gameIds.length
            || gameIds.some((gameId) => !/^[A-Za-z0-9]{8}$/.test(gameId))) {
          throw new Error(`Invalid historical game_ids selector for ${deploymentId}`);
        }
        const expectedGames = integer(entry.expected_game_count, -1);
        if (expectedGames < 1) throw new Error(`Invalid expected_game_count for ${deploymentId}`);
        const values = entry.values ?? {};
        for (const field of Object.keys(values)) {
          if (!Object.hasOwn(GAME_PROVENANCE_BACKFILL_COLUMNS, field)) {
            throw new Error(`Unsupported historical provenance field for ${deploymentId}: ${field}`);
          }
        }
        const provenance = {
          ...(entry.provenance ?? {}),
          historical_backfill: {
            deployment_id: deploymentId,
            interval: {
              started_at_or_after: new Date(from).toISOString(),
              started_before: new Date(before).toISOString(),
            },
            matched_identity: {
              engine_build_fingerprint: engineBuild,
              model_fingerprint: modelFingerprint,
              provider_fingerprint: providerFingerprint,
              book_identity: bookIdentity,
              game_ids: gameIds,
            },
            evidence_sources: entry.evidence_sources ?? [],
            unknown_fields: entry.unknown_fields ?? [],
          },
        };
        if (provenance.schema !== "uci_arena_game_runtime_provenance_v1") {
          throw new Error(`Invalid provenance schema for ${deploymentId}`);
        }
        if (provenance.engine?.build_fingerprint !== engineBuild
            || provenance.model?.fingerprint !== modelFingerprint
            || provenance.provider?.numeric_fingerprint !== providerFingerprint
            || provenance.book?.configuration_identity !== bookIdentity) {
          throw new Error(`Historical provenance identity does not match evidence selector for ${deploymentId}`);
        }
        const serialized = JSON.stringify(provenance);
        const provenanceSha256 = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
        const gameSelector = gameIds.length > 0
          ? ` AND game_id IN (${gameIds.map(() => "?").join(", ")})`
          : "";
        const rows = this.db.prepare(`
          SELECT game_id, model_id, checkpoint_hash, adapter_id, provider,
            hardware_driver_fingerprint, onnx_runtime_version, search_core, threads,
            root_workers, split_depth, batch_size, batch_wait_us, time_profile_identity,
            runtime_provenance_sha256
          FROM games
          WHERE started_at>=? AND started_at<? AND engine_build_fingerprint=?
            AND model_fingerprint=? AND provider_fingerprint=? AND book_identity=?
            ${gameSelector}
          ORDER BY started_at, game_id
        `).all(from, before, engineBuild, modelFingerprint, providerFingerprint, bookIdentity, ...gameIds);
        if (rows.length !== expectedGames) {
          throw new Error(
            `Historical provenance match count mismatch for ${deploymentId}: expected ${expectedGames}, got ${rows.length}`,
          );
        }
        const report = {
          deployment_id: deploymentId,
          matched: rows.length,
          updated: 0,
          would_update: 0,
          skipped_existing: 0,
          conflicts: [],
          runtime_provenance_sha256: provenanceSha256,
        };
        const columns = Object.keys(values);
        for (const row of rows) {
          const conflicts = columns.filter((field) => {
            const existing = row[field];
            const kind = GAME_PROVENANCE_BACKFILL_COLUMNS[field];
            const populated = kind === "integer" ? Number(existing) !== 0 : String(existing ?? "") !== "";
            return populated && existing !== values[field];
          });
          if (row.runtime_provenance_sha256) {
            if (row.runtime_provenance_sha256 === provenanceSha256 && conflicts.length === 0) {
              report.skipped_existing += 1;
            } else {
              report.conflicts.push({ game_id: row.game_id, fields: ["runtime_provenance_sha256", ...conflicts] });
            }
            continue;
          }
          if (conflicts.length > 0) {
            report.conflicts.push({ game_id: row.game_id, fields: conflicts });
            continue;
          }
          report.would_update += 1;
          if (!apply) continue;
          const assignments = columns.map((field) => {
            const blank = GAME_PROVENANCE_BACKFILL_COLUMNS[field] === "integer" ? "0" : "''";
            return `${field}=CASE WHEN ${field}=${blank} THEN ? ELSE ${field} END`;
          });
          this.db.prepare(`UPDATE games SET ${assignments.join(", ")},
            runtime_provenance_sha256=?, runtime_provenance_json=?
            WHERE game_id=? AND runtime_provenance_sha256=''`)
            .run(...columns.map((field) => values[field]), provenanceSha256, serialized, row.game_id);
          report.updated += 1;
        }
        reports.push(report);
      }
      const conflicts = reports.flatMap((report) => report.conflicts);
      if (conflicts.length > 0) {
        const error = new Error(`Historical provenance backfill found ${conflicts.length} conflicting rows`);
        error.reports = reports;
        throw error;
      }
      this.db.exec(apply ? "COMMIT" : "ROLLBACK");
      return reports;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
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
      schemaVersion: 5,
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
