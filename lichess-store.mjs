import { createHash } from "node:crypto";
import {
  sameProcessInstance,
  validProcessIdentity,
} from "./process-instance-identity.mjs";
import {
  LichessStorageError,
  LICHESS_STORAGE_SCHEMA_VERSION,
  openLichessStorage,
  safeInteger,
} from "./lichess-storage.mjs";
import {
  PROVIDER_INCIDENT_MAXIMUM_ROWS,
  PROVIDER_INCIDENT_PAGE_SCHEMA,
  PROVIDER_INCIDENT_RESOLVED_RETENTION_MS,
  normalizeProviderIncidentPageRequest,
  normalizeProviderIncidentReport,
  normalizeProviderIncidentResolution,
  projectProviderIncidentRow,
  projectProviderIncidentSummary,
  providerIncidentSeverityAtLeast,
} from "./provider-incidents.mjs";
import {
  PROVIDER_GAME_BACKFILL_MAXIMUM_IDS,
  normalizeProviderComponentIdentity,
  normalizeProviderGameId,
  normalizeProviderGameLine,
  normalizeProviderGamePageRequest,
  normalizeProviderGameTerminal,
  projectProviderGame,
  projectProviderGamePage,
  providerGameArchiveSha256,
} from "./provider-games.mjs";

function normalizedUsername(value) {
  const username = String(value ?? "").trim().toLocaleLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(username)) throw new Error(`Invalid Lichess username: ${value}`);
  return username;
}

function authorityKey(value) {
  const key = String(value ?? "").trim().toLocaleLowerCase();
  if (!key || key.length > 512) throw new Error("Invalid Lichess API authority key");
  return key;
}

function botRating(bot) {
  for (const key of ["blitz", "rapid", "classical", "bullet"]) {
    const rating = bot?.perfs?.[key]?.rating;
    if (typeof rating === "number" && Number.isFinite(rating)) return Math.round(rating);
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
  constructor(filePath, storageOptions = {}) {
    this.storage = openLichessStorage(filePath, storageOptions);
    this.filePath = this.storage.filePath;
    this.db = this.storage.db;
    this.statusControl = this.readControlProjection();
    this.statusOpponents = this.queryOpponentStats();
    this.statusApiLeases = new Map(this.listApiLeaseRows().map((lease) => [lease.authority_key, lease]));
    this.statusIncidents = this.queryProviderIncidentSummary();
    this.statusGameArchive = this.queryGameArchiveSummary();
  }

  close() {
    this.storage.close();
  }

  failOwnedTransaction(primaryError) {
    let recoveryFailed = false;
    if (this.db.isTransaction) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        recoveryFailed = true;
      }
    }
    try {
      this.storage.assertPaths();
    } catch {
      recoveryFailed = true;
    }
    if (recoveryFailed) {
      throw new LichessStorageError(
        "LICHESS_STORAGE_OPERATION_AND_RECOVERY_FAILED",
        "Lichess storage operation and transaction recovery both failed",
        primaryError,
      );
    }
    throw primaryError;
  }

  withImmediateTransaction(operation) {
    this.storage.assertPaths();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      this.storage.assertPaths();
      return result;
    } catch (error) {
      this.failOwnedTransaction(error);
    }
  }

  readControlProjection(now = Date.now()) {
    now = safeInteger(now, "control projection timestamp");
    this.db.prepare("DELETE FROM reservations WHERE expires_at <= ?").run(now);
    return {
      paused: this.db.prepare("SELECT paused FROM scheduler_control WHERE id=1").get()?.paused === 1,
      reservation: this.db.prepare(`
        SELECT opponent, games_remaining, expires_at, created_at
        FROM reservations WHERE id=1
      `).get() ?? null,
    };
  }

  refreshControlProjection(now = Date.now()) {
    this.statusControl = this.readControlProjection(now);
    return this.statusControl;
  }

  queryOpponentStats(limit = 100) {
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
    `).all(safeInteger(limit, "opponent statistics limit", { minimum: 1, maximum: 100 }));
  }

  refreshOpponentProjection() {
    this.statusOpponents = this.queryOpponentStats();
    return this.statusOpponents;
  }

  listApiLeaseRows() {
    return this.db.prepare(`
      SELECT authority_key, owner_id, pid, process_identity_json, heartbeat_at, expires_at
      FROM api_client_leases ORDER BY authority_key
    `).all();
  }

  refreshApiLeaseProjection(key) {
    const normalized = authorityKey(key);
    const lease = this.apiLease(normalized);
    if (lease) this.statusApiLeases.set(normalized, lease);
    else this.statusApiLeases.delete(normalized);
    return lease;
  }

  apiLeaseSnapshot(key) {
    const lease = this.statusApiLeases.get(authorityKey(key));
    return lease ? { ...lease } : null;
  }

  activeApiLeaseCount(now = Date.now()) {
    let count = 0;
    for (const lease of this.statusApiLeases.values()) {
      if (lease.expires_at > now) count += 1;
    }
    return count;
  }

  statusProjection(now = Date.now()) {
    now = safeInteger(now, "status projection timestamp");
    const reservation = this.statusControl.reservation;
    return {
      control: {
        paused: this.statusControl.paused,
        reservation: reservation && reservation.expires_at > now ? { ...reservation } : null,
      },
      opponents: this.statusOpponents.map((opponent) => ({ ...opponent })),
      incidents: { ...this.statusIncidents },
      gameArchive: { ...this.statusGameArchive },
    };
  }

  queryGameArchiveSummary() {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total_games,
        SUM(CASE WHEN archive_completeness IN ('complete','reconciled') THEN 1 ELSE 0 END)
          AS complete_games,
        SUM(CASE WHEN archive_completeness='summary_only' THEN 1 ELSE 0 END)
          AS incomplete_games,
        SUM(CASE WHEN archive_completeness='live' THEN 1 ELSE 0 END) AS live_games
      FROM games
    `).get();
    const pageCount = this.db.prepare("PRAGMA page_count").get()?.page_count ?? 0;
    const pageSize = this.db.prepare("PRAGMA page_size").get()?.page_size ?? 0;
    return Object.freeze({
      available: true,
      total_games: safeInteger(counts.total_games ?? 0, "game archive total"),
      complete_games: safeInteger(counts.complete_games ?? 0, "complete game archive total"),
      incomplete_games: safeInteger(
        counts.incomplete_games ?? 0,
        "incomplete game archive total",
      ),
      live_games: safeInteger(counts.live_games ?? 0, "live game archive total"),
      logical_storage_bytes: safeInteger(
        pageCount * pageSize,
        "game archive logical storage bytes",
      ),
    });
  }

  refreshGameArchiveSummary() {
    this.statusGameArchive = this.queryGameArchiveSummary();
    return { ...this.statusGameArchive };
  }

  gameArchiveSummary() {
    return { ...this.statusGameArchive };
  }

  queryProviderIncidentSummary() {
    const control = this.db.prepare(`
      SELECT next_cursor, truncated_rows FROM provider_incident_control WHERE id=1
    `).get();
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS active_count FROM provider_incidents WHERE active=1
    `).get();
    const severities = this.db.prepare(`
      SELECT DISTINCT severity FROM provider_incidents WHERE active=1
    `).all().map((row) => row.severity);
    return projectProviderIncidentSummary({
      activeCount: counts.active_count,
      severities,
      latestCursor: control.next_cursor - 1,
      truncatedRows: control.truncated_rows,
    });
  }

  refreshProviderIncidentSummary() {
    this.statusIncidents = this.queryProviderIncidentSummary();
    return { ...this.statusIncidents };
  }

  providerIncidentSummary() {
    return { ...this.statusIncidents };
  }

  applyProviderIncidentRetention(now) {
    const cutoff = Math.max(0, now - PROVIDER_INCIDENT_RESOLVED_RETENTION_MS);
    const expired = this.db.prepare(`
      SELECT cursor, active FROM provider_incidents
      WHERE active=0 AND resolved_at<=? ORDER BY resolved_at, cursor
    `).all(cutoff);
    if (expired.length > 0) {
      this.db.prepare(`DELETE FROM provider_incidents WHERE active=0 AND resolved_at<=?`).run(cutoff);
    }
    const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM provider_incidents").get().count;
    const excess = Math.max(0, remaining - PROVIDER_INCIDENT_MAXIMUM_ROWS);
    const capped = excess > 0 ? this.db.prepare(`
      SELECT cursor, active FROM provider_incidents
      ORDER BY active ASC, last_occurrence ASC, cursor ASC LIMIT ?
    `).all(excess) : [];
    if (capped.length > 0) {
      const placeholders = capped.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM provider_incidents WHERE cursor IN (${placeholders})`)
        .run(...capped.map((row) => row.cursor));
    }
    const deleted = [...expired, ...capped];
    if (deleted.length === 0) return;
    const lastTruncatedCursor = Math.max(...deleted.map((row) => row.cursor));
    const activeRows = deleted.filter((row) => row.active === 1).length;
    const control = this.db.prepare(`
      SELECT truncated_rows, truncated_active_rows
      FROM provider_incident_control WHERE id=1
    `).get();
    const truncatedRows = safeInteger(
      control.truncated_rows + deleted.length,
      "truncated incident count",
    );
    const truncatedActiveRows = safeInteger(
      control.truncated_active_rows + activeRows,
      "truncated active incident count",
    );
    this.db.prepare(`
      UPDATE provider_incident_control
      SET last_truncated_cursor=MAX(last_truncated_cursor, ?),
        truncated_rows=?, truncated_active_rows=?, updated_at=?
      WHERE id=1
    `).run(lastTruncatedCursor, truncatedRows, truncatedActiveRows, now);
  }

  recordProviderIncident(report, now = Date.now()) {
    const incident = normalizeProviderIncidentReport(report, now);
    const retained = this.withImmediateTransaction(() => {
      const active = this.db.prepare(`
        SELECT * FROM provider_incidents WHERE identity_key=? AND active=1
      `).get(incident.identityKey);
      if (active) {
        if (!incident.idempotent) {
          const occurrenceCount = safeInteger(
            active.occurrence_count + 1,
            "incident occurrence count",
            { minimum: 2 },
          );
          this.db.prepare(`
            UPDATE provider_incidents SET severity=?, last_occurrence=?,
              occurrence_count=?, retry_deadline=?, detail=?
            WHERE cursor=? AND active=1
          `).run(
            providerIncidentSeverityAtLeast(incident.severity, active.severity),
            Math.max(active.last_occurrence, incident.occurredAt),
            occurrenceCount,
            Math.max(active.retry_deadline, incident.retryDeadline ?? 0),
            incident.detail,
            active.cursor,
          );
        }
        this.applyProviderIncidentRetention(incident.occurredAt);
        return active.cursor;
      }
      if (incident.idempotent) {
        const prior = this.db.prepare(`
          SELECT cursor FROM provider_incidents WHERE identity_key=? ORDER BY cursor DESC LIMIT 1
        `).get(incident.identityKey);
        if (prior) {
          this.applyProviderIncidentRetention(incident.occurredAt);
          return prior.cursor;
        }
      }
      const control = this.db.prepare(`
        SELECT next_cursor FROM provider_incident_control WHERE id=1
      `).get();
      const cursor = safeInteger(control?.next_cursor, "incident cursor", { minimum: 1 });
      safeInteger(cursor + 1, "next incident cursor", { minimum: 2 });
      this.db.prepare(`
        INSERT INTO provider_incidents(
          cursor, identity_key, code, severity, source, operation,
          first_occurrence, last_occurrence, occurrence_count, active,
          resolved_at, http_status, retry_deadline, game_id, detail
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?)
      `).run(
        cursor, incident.identityKey, incident.code, incident.severity,
        incident.source, incident.operation, incident.occurredAt, incident.occurredAt,
        incident.httpStatus ?? 0, incident.retryDeadline ?? 0, incident.gameId ?? "",
        incident.detail,
      );
      this.db.prepare(`
        UPDATE provider_incident_control SET next_cursor=?, updated_at=? WHERE id=1
      `).run(cursor + 1, incident.occurredAt);
      this.applyProviderIncidentRetention(incident.occurredAt);
      return cursor;
    });
    this.refreshProviderIncidentSummary();
    return retained;
  }

  resolveProviderIncident(identity, now = Date.now()) {
    now = safeInteger(now, "incident resolution timestamp");
    const { identityKey } = normalizeProviderIncidentResolution(identity);
    const resolved = this.withImmediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT cursor, last_occurrence FROM provider_incidents
        WHERE identity_key=? AND active=1
      `).get(identityKey);
      if (!row) {
        this.applyProviderIncidentRetention(now);
        return false;
      }
      this.db.prepare(`
        UPDATE provider_incidents SET active=0, resolved_at=? WHERE cursor=? AND active=1
      `).run(Math.max(now, row.last_occurrence), row.cursor);
      this.applyProviderIncidentRetention(now);
      return true;
    });
    this.refreshProviderIncidentSummary();
    return resolved;
  }

  listProviderIncidents(request = {}) {
    const page = normalizeProviderIncidentPageRequest(request);
    const rows = this.db.prepare(`
      SELECT cursor, code, severity, source, operation, first_occurrence,
        last_occurrence, occurrence_count, active, resolved_at, http_status,
        retry_deadline, game_id, detail
      FROM provider_incidents
      WHERE cursor>? ${page.filter === "active" ? "AND active=1" : ""}
      ORDER BY cursor ASC LIMIT ?
    `).all(page.afterCursor, page.limit + 1);
    const hasMore = rows.length > page.limit;
    const incidents = rows.slice(0, page.limit).map(projectProviderIncidentRow);
    const control = this.db.prepare(`
      SELECT last_truncated_cursor, truncated_rows, truncated_active_rows
      FROM provider_incident_control WHERE id=1
    `).get();
    return Object.freeze({
      schema: PROVIDER_INCIDENT_PAGE_SCHEMA,
      filter: page.filter,
      after_cursor: page.afterCursor,
      next_cursor: incidents.at(-1)?.cursor ?? page.afterCursor,
      has_more: hasMore,
      incidents,
      retention: Object.freeze({
        maximum_rows: PROVIDER_INCIDENT_MAXIMUM_ROWS,
        resolved_retention_ms: PROVIDER_INCIDENT_RESOLVED_RETENTION_MS,
        last_truncated_cursor: control.last_truncated_cursor || null,
        truncated_rows: control.truncated_rows,
        truncated_active_rows: control.truncated_active_rows,
      }),
    });
  }

  addOwner(username, now = Date.now()) {
    now = safeInteger(now, "owner creation timestamp");
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
    now = safeInteger(now, "reservation creation timestamp");
    const normalized = normalizedUsername(opponent);
    const count = safeInteger(games, "reservation games", { minimum: 1, maximum: 100 });
    const duration = safeInteger(minutes, "reservation minutes", { minimum: 1, maximum: 1_440 });
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
    this.refreshControlProjection(now);
    return this.statusControl.reservation ? { ...this.statusControl.reservation } : null;
  }

  getReservation(now = Date.now()) {
    now = safeInteger(now, "reservation lookup timestamp");
    this.db.prepare("DELETE FROM reservations WHERE expires_at <= ?").run(now);
    return this.db.prepare("SELECT opponent, games_remaining, expires_at, created_at FROM reservations WHERE id=1").get() ?? null;
  }

  consumeReservation(opponent, now = Date.now()) {
    now = safeInteger(now, "reservation consumption timestamp");
    const normalized = normalizedUsername(opponent);
    const consumed = this.withImmediateTransaction(() => {
      this.db.prepare("DELETE FROM reservations WHERE expires_at <= ?").run(now);
      const reservation = this.db.prepare(`
        SELECT opponent, games_remaining FROM reservations WHERE id=1
      `).get();
      if (!reservation || reservation.opponent !== normalized) {
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
      return true;
    });
    this.refreshControlProjection(now);
    return consumed;
  }

  cancelReservation() {
    const removed = this.db.prepare("DELETE FROM reservations WHERE id=1").run().changes > 0;
    this.refreshControlProjection();
    return removed;
  }

  setPaused(paused, now = Date.now()) {
    if (typeof paused !== "boolean") throw new Error("Scheduler paused state must be boolean");
    now = safeInteger(now, "scheduler control timestamp");
    this.db.prepare("UPDATE scheduler_control SET paused=?, updated_at=? WHERE id=1").run(paused ? 1 : 0, now);
    this.refreshControlProjection(now);
  }

  control(now = Date.now()) {
    const control = this.refreshControlProjection(now);
    return {
      paused: control.paused,
      reservation: control.reservation ? { ...control.reservation } : null,
    };
  }

  claimProviderLifecycle(ownerId, now = Date.now()) {
    const owner = String(ownerId ?? "");
    if (!/^[A-Za-z0-9-]{1,128}$/u.test(owner)) {
      throw new Error("Provider lifecycle owner id is invalid");
    }
    now = safeInteger(now, "provider lifecycle claim timestamp");
    return this.withImmediateTransaction(() => {
      const control = this.db.prepare(`
        SELECT admission_blocked, owner_id, active_work
        FROM provider_lifecycle_control WHERE id=1
      `).get();
      if (!control || control.admission_blocked) {
        const error = new Error("Provider admission is blocked for replacement");
        error.code = "LICHESS_PROVIDER_REPLACEMENT_BLOCKED";
        throw error;
      }
      const exactLease = this.db.prepare(`
        SELECT 1 AS present FROM api_client_leases
        WHERE owner_id=? AND expires_at>?
      `).get(owner, now);
      const conflictingLease = this.db.prepare(`
        SELECT 1 AS present FROM api_client_leases
        WHERE owner_id<>? AND expires_at>? LIMIT 1
      `).get(owner, now);
      if (!exactLease || conflictingLease) {
        const error = new Error("Provider lifecycle claim lacks exclusive API authority");
        error.code = "LICHESS_PROVIDER_LIFECYCLE_AUTHORITY_INVALID";
        throw error;
      }
      if (control.owner_id && control.owner_id !== owner) {
        const priorLease = this.db.prepare(`
          SELECT 1 AS present FROM api_client_leases
          WHERE owner_id=? AND expires_at>?
        `).get(control.owner_id, now);
        if (priorLease) {
          const error = new Error("Provider lifecycle authority is already active");
          error.code = "LICHESS_PROVIDER_LIFECYCLE_HELD";
          throw error;
        }
      }
      this.db.prepare(`
        UPDATE provider_lifecycle_control
        SET owner_id=?, active_work=0, updated_at=? WHERE id=1
      `).run(owner, now);
      return Object.freeze({ admissionBlocked: false, activeWork: 0 });
    });
  }

  releaseProviderLifecycle(ownerId, now = Date.now()) {
    const owner = String(ownerId ?? "");
    now = safeInteger(now, "provider lifecycle release timestamp");
    return this.withImmediateTransaction(() => {
      const result = this.db.prepare(`
        UPDATE provider_lifecycle_control SET owner_id='', updated_at=?
        WHERE id=1 AND owner_id=? AND active_work=0
      `).run(now, owner);
      return result.changes > 0;
    });
  }

  beginProviderWork(ownerId, now = Date.now()) {
    const owner = String(ownerId ?? "");
    now = safeInteger(now, "provider work admission timestamp");
    return this.withImmediateTransaction(() => {
      const control = this.db.prepare(`
        SELECT admission_blocked, owner_id, active_work
        FROM provider_lifecycle_control WHERE id=1
      `).get();
      if (!control || control.admission_blocked || control.owner_id !== owner) {
        const error = new Error("Provider work admission is blocked or unowned");
        error.code = control?.admission_blocked
          ? "LICHESS_PROVIDER_REPLACEMENT_BLOCKED"
          : "LICHESS_PROVIDER_LIFECYCLE_AUTHORITY_INVALID";
        throw error;
      }
      const activeWork = safeInteger(
        control.active_work + 1,
        "provider active work count",
        { minimum: 1 },
      );
      this.db.prepare(`
        UPDATE provider_lifecycle_control SET active_work=?, updated_at=? WHERE id=1
      `).run(activeWork, now);
      return Object.freeze({ ownerId: owner, activeWork });
    });
  }

  finishProviderWork(ownerId, now = Date.now()) {
    const owner = String(ownerId ?? "");
    now = safeInteger(now, "provider work release timestamp");
    return this.withImmediateTransaction(() => {
      const control = this.db.prepare(`
        SELECT owner_id, active_work FROM provider_lifecycle_control WHERE id=1
      `).get();
      if (!control || control.owner_id !== owner || control.active_work < 1) {
        const error = new Error("Provider work release does not own active authority");
        error.code = "LICHESS_PROVIDER_WORK_RELEASE_INVALID";
        throw error;
      }
      const activeWork = control.active_work - 1;
      this.db.prepare(`
        UPDATE provider_lifecycle_control SET active_work=?, updated_at=? WHERE id=1
      `).run(activeWork, now);
      return activeWork;
    });
  }

  requestProviderReplacement(now = Date.now(), { allowUnowned = false } = {}) {
    now = safeInteger(now, "provider replacement timestamp");
    return this.withImmediateTransaction(() => {
      const control = this.db.prepare(`
        SELECT admission_blocked, owner_id, active_work
        FROM provider_lifecycle_control WHERE id=1
      `).get();
      const activeWork = control?.active_work ?? 0;
      const activeLeases = this.db.prepare(`
        SELECT COUNT(*) AS count FROM api_client_leases WHERE expires_at>?
      `).get(now).count;
      const ownerLease = control?.owner_id
        ? this.db.prepare(`
            SELECT 1 AS present FROM api_client_leases
            WHERE owner_id=? AND expires_at>?
          `).get(control.owner_id, now)
        : null;
      let reason = null;
      if (!control) reason = "provider_lifecycle_interlock_unavailable";
      else if (activeWork > 0) reason = "provider_owned_work_active";
      else if ((activeLeases > 0 && !ownerLease)
          || (!control.owner_id && !control.admission_blocked && !allowUnowned)) {
        reason = "provider_lifecycle_interlock_unavailable";
      }
      if (reason) {
        return Object.freeze({
          safe: false,
          reason,
          activeWork,
          admissionBlocked: Boolean(control?.admission_blocked),
        });
      }
      if (!control.admission_blocked) {
        this.db.prepare(`
          UPDATE provider_lifecycle_control
          SET admission_blocked=1, updated_at=? WHERE id=1
        `).run(now);
      }
      return Object.freeze({
        safe: true,
        reason: null,
        activeWork: 0,
        admissionBlocked: true,
      });
    });
  }

  resumeProviderAdmissions(now = Date.now()) {
    now = safeInteger(now, "provider admission resume timestamp");
    return this.withImmediateTransaction(() => {
      const control = this.db.prepare(`
        SELECT active_work FROM provider_lifecycle_control WHERE id=1
      `).get();
      if (!control || control.active_work !== 0) {
        const error = new Error("Provider admission cannot resume with active work");
        error.code = "LICHESS_PROVIDER_WORK_UNRESOLVED";
        throw error;
      }
      this.db.prepare(`
        UPDATE provider_lifecycle_control
        SET admission_blocked=0, owner_id='', updated_at=? WHERE id=1
      `).run(now);
      return Object.freeze({ admissionBlocked: false, activeWork: 0 });
    });
  }

  providerLifecycleSnapshot() {
    const row = this.db.prepare(`
      SELECT admission_blocked, owner_id, active_work, updated_at
      FROM provider_lifecycle_control WHERE id=1
    `).get();
    return Object.freeze({
      admissionBlocked: Boolean(row?.admission_blocked),
      owned: Boolean(row?.owner_id),
      activeWork: row?.active_work ?? 0,
      updatedAt: row?.updated_at ?? 0,
    });
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
        row.challenge_last_429_at,
        row.challenge_recovered_at,
      );
      const selectedAt = selected
        ? Math.max(
          selected.challenge_last_429_at,
          selected.challenge_recovered_at,
        )
        : -1;
      if (!selected || eventAt > selectedAt) return row;
      if (eventAt === selectedAt && row.authority_key === normalized) return row;
      return selected;
    }, null);
    return latest ? {
      cooldownUntil: Math.max(...rows.map((row) => row.cooldown_until)),
      strikeCount: latest.strike_count,
      last429At: latest.last_429_at,
      lastRetryAfterMs: latest.last_retry_after_ms,
      challengeBlockedUntil: Math.max(
        ...rows.map((row) => row.challenge_blocked_until),
      ),
      challengeStrikeCount: challengeLatest.challenge_strike_count,
      challengeLast429At: challengeLatest.challenge_last_429_at,
      challengeRecoveredAt: challengeLatest.challenge_recovered_at,
      challengeHalfOpen: challengeLatest.challenge_half_open === 1,
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
    now = safeInteger(now, "API safety update timestamp");
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
      safeInteger(state.cooldownUntil, "API cooldown deadline", { defaultValue: 0 }),
      safeInteger(state.strikeCount, "API strike count", { defaultValue: 0 }),
      safeInteger(state.last429At, "API last 429 timestamp", { defaultValue: 0 }),
      safeInteger(state.lastRetryAfterMs, "API retry duration", { defaultValue: 0 }),
      safeInteger(state.challengeBlockedUntil, "challenge cooldown deadline", { defaultValue: 0 }),
      safeInteger(state.challengeStrikeCount, "challenge strike count", { defaultValue: 0 }),
      safeInteger(state.challengeLast429At, "challenge last 429 timestamp", { defaultValue: 0 }),
      safeInteger(state.challengeRecoveredAt, "challenge recovery timestamp", { defaultValue: 0 }),
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
    const leasePid = safeInteger(pid, "API lease pid", { minimum: 1, maximum: 2_147_483_647 });
    const leaseTtl = safeInteger(ttlMs, "API lease TTL", {
      minimum: 1,
      maximum: 86_400_000,
      defaultValue: 60_000,
    });
    if (!validProcessIdentity(processIdentity, leasePid)) {
      throw new Error("Lichess API lease process identity is invalid");
    }
    const expiresAt = safeInteger(now, "API lease timestamp") + leaseTtl;
    this.withImmediateTransaction(() => {
      const active = this.db.prepare(`
        SELECT owner_id, pid, process_identity_json, heartbeat_at, expires_at
        FROM api_client_leases WHERE authority_key=?
      `).get(normalized);
      const activePid = active?.pid ?? null;
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
      if (active && active.owner_id !== owner && active.expires_at > now
          && !ownerProvenReplaced) {
        const error = new Error(
          `Lichess API authority ${normalized} is already leased by process ${active.pid}`,
        );
        error.code = "LICHESS_API_LEASE_HELD";
        error.expiresAt = active.expires_at;
        throw error;
      }
      this.db.prepare(`
        INSERT INTO api_client_leases(authority_key, owner_id, pid, process_identity_json,
          heartbeat_at, expires_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(authority_key) DO UPDATE SET owner_id=excluded.owner_id,
          pid=excluded.pid, process_identity_json=excluded.process_identity_json,
          heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at
      `).run(normalized, owner, leasePid, JSON.stringify(processIdentity), now, expiresAt);
    });
    return this.refreshApiLeaseProjection(normalized);
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
    const leasePid = safeInteger(pid, "API lease pid", { minimum: 1, maximum: 2_147_483_647 });
    const leaseTtl = safeInteger(ttlMs, "API lease TTL", {
      minimum: 1,
      maximum: 86_400_000,
      defaultValue: 60_000,
    });
    if (!validProcessIdentity(processIdentity, leasePid)) {
      throw new Error("Lichess API lease process identity is invalid");
    }
    const result = this.db.prepare(`
      UPDATE api_client_leases SET heartbeat_at=?, expires_at=?
      WHERE authority_key=? AND owner_id=? AND pid=? AND process_identity_json=?
    `).run(
      now,
      safeInteger(now, "API lease heartbeat timestamp") + leaseTtl,
      normalized,
      String(ownerId),
      leasePid,
      JSON.stringify(processIdentity),
    );
    if (result.changes !== 1) {
      const error = new Error(`Lichess API lease ownership was lost for ${normalized}`);
      error.code = "LICHESS_API_LEASE_LOST";
      throw error;
    }
    return this.refreshApiLeaseProjection(normalized);
  }

  releaseApiLease(key, ownerId) {
    const normalized = authorityKey(key);
    const removed = this.db.prepare("DELETE FROM api_client_leases WHERE authority_key=? AND owner_id=?")
      .run(normalized, String(ownerId)).changes > 0;
    this.refreshApiLeaseProjection(normalized);
    return removed;
  }

  apiLease(key) {
    return this.db.prepare(`
      SELECT authority_key, owner_id, pid, process_identity_json, heartbeat_at, expires_at
      FROM api_client_leases WHERE authority_key=?
    `).get(authorityKey(key)) ?? null;
  }

  activeApiLeases(now = Date.now()) {
    now = safeInteger(now, "API lease listing timestamp");
    return this.db.prepare(`
      SELECT authority_key, pid, heartbeat_at, expires_at
      FROM api_client_leases WHERE expires_at>? ORDER BY authority_key
    `).all(now);
  }

  replaceOnlineBots(bots, now = Date.now()) {
    now = safeInteger(now, "online discovery timestamp");
    const reset = this.db.prepare("UPDATE opponents SET online=0");
    const upsert = this.db.prepare(`
      INSERT INTO opponents(username, title, rating, online, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, 1, ?, ?)
      ON CONFLICT(username) DO UPDATE SET title=excluded.title, rating=excluded.rating,
        online=1, last_seen_at=excluded.last_seen_at
    `);
    this.withImmediateTransaction(() => {
      reset.run();
      for (const bot of bots) {
        const username = normalizedUsername(bot.username ?? bot.name ?? bot.id);
        upsert.run(username, String(bot.title ?? "BOT"), botRating(bot), now, now);
      }
    });
    this.refreshOpponentProjection();
  }

  eligibleBots({ self, now = Date.now(), maximumGamesPerDay = 2 } = {}) {
    now = safeInteger(now, "opponent selection timestamp");
    maximumGamesPerDay = safeInteger(maximumGamesPerDay, "maximum games per opponent", {
      minimum: 1,
      maximum: 100,
    });
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
    const until = safeInteger(now, "opponent cooldown timestamp")
      + safeInteger(minutes, "opponent cooldown minutes", { maximum: 525_600 }) * 60_000;
    this.db.prepare("UPDATE opponents SET cooldown_until=MAX(cooldown_until, ?) WHERE username=?")
      .run(until, normalizedUsername(username));
    return until;
  }

  recordChallenge({ id, opponent, audience, direction, status, color, clockLimit, clockIncrement }, now = Date.now()) {
    now = safeInteger(now, "challenge creation timestamp");
    if (!id) throw new Error("Challenge id is required");
    const username = normalizedUsername(opponent);
    this.db.prepare(`
      INSERT INTO challenge_attempts(challenge_id, opponent, audience, direction, status,
        color, clock_limit, clock_increment, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(challenge_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
    `).run(String(id), username, audience, direction, status, color ?? "random",
      safeInteger(clockLimit, "challenge clock limit", { defaultValue: 0 }),
      safeInteger(clockIncrement, "challenge clock increment", { defaultValue: 0 }), now, now);
  }

  updateChallenge(id, status, { cooldownMinutes = 0 } = {}, now = Date.now()) {
    now = safeInteger(now, "challenge update timestamp");
    cooldownMinutes = safeInteger(cooldownMinutes, "challenge cooldown minutes", {
      maximum: 525_600,
      defaultValue: 0,
    });
    this.withImmediateTransaction(() => {
      const row = this.db.prepare("SELECT opponent, status FROM challenge_attempts WHERE challenge_id=?")
        .get(String(id));
      this.db.prepare("UPDATE challenge_attempts SET status=?, updated_at=? WHERE challenge_id=?")
        .run(status, now, String(id));
      if (!row) return;
      const column = status === "accepted" ? "accepts"
        : status === "declined" ? "declines"
          : status === "timeout" ? "timeouts" : null;
      if (column && row.status !== status) {
        this.db.prepare(`UPDATE opponents SET ${column}=${column}+1 WHERE username=?`)
          .run(row.opponent);
      }
      if (cooldownMinutes > 0) {
        this.db.prepare("UPDATE opponents SET cooldown_until=MAX(cooldown_until, ?) WHERE username=?")
          .run(now + cooldownMinutes * 60_000, row.opponent);
      }
    });
    this.refreshOpponentProjection();
  }

  beginGameActivation({ id, opponent, audience, challengeId = null }, now = Date.now()) {
    now = safeInteger(now, "game activation timestamp");
    const gameId = String(id ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(gameId)) throw new Error("Game activation id is invalid");
    const normalizedOpponent = normalizedUsername(opponent);
    if (audience !== "human" && audience !== "bot") {
      throw new Error(`Unsupported game activation audience: ${audience}`);
    }
    const correlationId = challengeId ? String(challengeId) : null;
    const activation = this.withImmediateTransaction(() => {
      const existing = this.db.prepare(`
        SELECT status, archive_cursor FROM games WHERE game_id=?
      `).get(gameId);
      const inserted = !existing;
      if (inserted) {
        const control = this.db.prepare(`
          SELECT next_archive_cursor FROM game_archive_control WHERE id=1
        `).get();
        const archiveCursor = safeInteger(
          control.next_archive_cursor,
          "next game archive cursor",
          { minimum: 1 },
        );
        this.db.prepare(`
          UPDATE game_archive_control SET next_archive_cursor=?, updated_at=? WHERE id=1
        `).run(safeInteger(archiveCursor + 1, "next game archive cursor"), now);
        this.db.prepare(`
          INSERT INTO games(game_id, opponent, audience, status, started_at, archive_cursor)
          VALUES(?, ?, ?, 'activating', ?, ?)
        `).run(gameId, normalizedOpponent, audience, now, archiveCursor);
      } else if (existing.status === "activation_failed") {
        this.db.prepare(`
          UPDATE games SET status='activating', finished_at=0
          WHERE game_id=? AND status='activation_failed'
        `).run(gameId);
      }

      let challengeTransitioned = false;
      if (correlationId) {
        const challenge = this.db.prepare(`
          SELECT opponent, status FROM challenge_attempts WHERE challenge_id=?
        `).get(correlationId);
        if (challenge && challenge.status !== "accepted") {
          this.db.prepare(`
            UPDATE challenge_attempts SET status='accepted', updated_at=? WHERE challenge_id=?
          `).run(now, correlationId);
          this.db.prepare("UPDATE opponents SET accepts=accepts+1 WHERE username=?")
            .run(challenge.opponent);
          challengeTransitioned = true;
        }
      }

      let reservationConsumed = false;
      if (inserted && audience === "human") {
        this.db.prepare("DELETE FROM reservations WHERE expires_at <= ?").run(now);
        const reservation = this.db.prepare(`
          SELECT opponent, games_remaining FROM reservations WHERE id=1
        `).get();
        if (reservation?.opponent === normalizedOpponent) {
          if (reservation.games_remaining <= 1) {
            this.db.prepare("DELETE FROM reservations WHERE id=1 AND opponent=?")
              .run(normalizedOpponent);
          } else {
            this.db.prepare(`
              UPDATE reservations SET games_remaining=games_remaining-1
              WHERE id=1 AND opponent=?
            `).run(normalizedOpponent);
          }
          reservationConsumed = true;
        }
      }
      return Object.freeze({
        gameId,
        inserted,
        reservationConsumed,
        challengeTransitioned,
      });
    });
    this.refreshControlProjection(now);
    if (activation.challengeTransitioned) this.refreshOpponentProjection();
    if (activation.inserted) this.refreshGameArchiveSummary();
    return activation;
  }

  failGameActivation(id, now = Date.now()) {
    now = safeInteger(now, "game activation failure timestamp");
    this.db.prepare(`
      UPDATE games SET status='activation_failed'
      WHERE game_id=? AND status='activating'
    `).run(String(id));
    this.refreshOpponentProjection();
    this.refreshGameArchiveSummary();
  }

  markGameProviderError(id, now = Date.now()) {
    now = safeInteger(now, "game provider error timestamp");
    this.db.prepare(`
      UPDATE games SET status='provider_error'
      WHERE game_id=? AND finished_at=0
    `).run(String(id));
    this.refreshOpponentProjection();
    this.refreshGameArchiveSummary();
  }

  beginGame(game) {
    const id = normalizeProviderGameId(String(game.id));
    if (game.audience !== "human" && game.audience !== "bot") {
      throw new Error(`Unsupported provider game audience: ${game.audience}`);
    }
    if (game.color !== "white" && game.color !== "black") {
      throw new Error(`Unsupported provider game color: ${game.color}`);
    }
    if (game.rated !== undefined && typeof game.rated !== "boolean") {
      throw new Error("Provider game rated authority must be boolean");
    }
    const now = safeInteger(game.startedAt, "game start timestamp", { defaultValue: Date.now() });
    const line = normalizeProviderGameLine({
      initialFen: game.initialFen,
      variant: game.variant ?? "standard",
      plies: [],
    });
    const providerComponent = normalizeProviderComponentIdentity(
      game.providerComponent,
      "provider",
    );
    const engineComponent = normalizeProviderComponentIdentity(
      game.engineComponent,
      "engine",
      { optional: true },
    );
    const runtimeProvenanceJson = JSON.stringify(game.runtimeProvenance ?? {});
    this.withImmediateTransaction(() => {
      const existing = this.db.prepare(`
        SELECT archive_cursor, initial_fen, variant,
          provider_component_id, provider_component_version,
          provider_component_manifest_sha256, engine_component_id,
          engine_component_version, engine_component_manifest_sha256
        FROM games WHERE game_id=?
      `).get(id);
      if (existing?.initial_fen && existing.initial_fen !== line.initialFen) {
        throw new Error(`Provider game initial FEN conflicts with ${id}`);
      }
      if (existing?.initial_fen && existing.variant !== line.variant) {
        throw new Error(`Provider game variant conflicts with ${id}`);
      }
      const componentConflicts = (prefix, component) => {
        const componentId = existing?.[`${prefix}_component_id`] ?? "";
        if (!componentId || !component) return false;
        return componentId !== component.componentId
          || existing[`${prefix}_component_version`] !== component.version
          || existing[`${prefix}_component_manifest_sha256`] !== component.manifestSha256;
      };
      if (componentConflicts("provider", providerComponent)
          || componentConflicts("engine", engineComponent)) {
        throw new Error(`Provider game component identity conflicts with ${id}`);
      }
      let archiveCursor = existing?.archive_cursor ?? 0;
      if (!existing) {
        const control = this.db.prepare(`
          SELECT next_archive_cursor FROM game_archive_control WHERE id=1
        `).get();
        archiveCursor = safeInteger(control.next_archive_cursor, "next game archive cursor", {
          minimum: 1,
        });
        this.db.prepare(`
          UPDATE game_archive_control
          SET next_archive_cursor=?, updated_at=? WHERE id=1
        `).run(safeInteger(archiveCursor + 1, "next game archive cursor"), now);
      }
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
        clock_increment=excluded.clock_increment,
        status=CASE WHEN games.status IN ('activating', 'activation_failed', 'provider_error')
          THEN 'started' ELSE games.status END,
        finished_at=CASE WHEN games.status IN ('activation_failed', 'provider_error')
          THEN 0 ELSE games.finished_at END,
        engine_build_fingerprint=CASE WHEN games.engine_build_fingerprint=''
          THEN excluded.engine_build_fingerprint ELSE games.engine_build_fingerprint END,
        model_fingerprint=CASE WHEN games.model_fingerprint=''
          THEN excluded.model_fingerprint ELSE games.model_fingerprint END,
        provider_fingerprint=CASE WHEN games.provider_fingerprint=''
          THEN excluded.provider_fingerprint ELSE games.provider_fingerprint END,
        book_identity=CASE WHEN games.book_identity=''
          THEN excluded.book_identity ELSE games.book_identity END,
        model_id=CASE WHEN games.model_id='' THEN excluded.model_id ELSE games.model_id END,
        checkpoint_hash=CASE WHEN games.checkpoint_hash=''
          THEN excluded.checkpoint_hash ELSE games.checkpoint_hash END,
        adapter_id=CASE WHEN games.adapter_id='' THEN excluded.adapter_id ELSE games.adapter_id END,
        provider=CASE WHEN games.provider='' THEN excluded.provider ELSE games.provider END,
        hardware_driver_fingerprint=CASE WHEN games.hardware_driver_fingerprint=''
          THEN excluded.hardware_driver_fingerprint ELSE games.hardware_driver_fingerprint END,
        onnx_runtime_version=CASE WHEN games.onnx_runtime_version=''
          THEN excluded.onnx_runtime_version ELSE games.onnx_runtime_version END,
        search_core=CASE WHEN games.search_core='' THEN excluded.search_core ELSE games.search_core END,
        threads=CASE WHEN games.threads=0 THEN excluded.threads ELSE games.threads END,
        root_workers=CASE WHEN games.root_workers=0 THEN excluded.root_workers ELSE games.root_workers END,
        split_depth=CASE WHEN games.split_depth=0 THEN excluded.split_depth ELSE games.split_depth END,
        batch_size=CASE WHEN games.batch_size=0 THEN excluded.batch_size ELSE games.batch_size END,
        batch_wait_us=CASE WHEN games.batch_wait_us=0
          THEN excluded.batch_wait_us ELSE games.batch_wait_us END,
        time_profile_identity=CASE WHEN games.time_profile_identity=''
          THEN excluded.time_profile_identity ELSE games.time_profile_identity END,
        runtime_provenance_sha256=CASE WHEN games.runtime_provenance_sha256=''
          THEN excluded.runtime_provenance_sha256 ELSE games.runtime_provenance_sha256 END,
        runtime_provenance_json=CASE WHEN games.runtime_provenance_sha256=''
          THEN excluded.runtime_provenance_json ELSE games.runtime_provenance_json END
      `).run(id, normalizedUsername(game.opponent), game.audience, game.color,
      game.rated ? 1 : 0, game.speed ?? "",
      safeInteger(game.clockLimit, "game clock limit", { defaultValue: 0 }),
      safeInteger(game.clockIncrement, "game clock increment", { defaultValue: 0 }),
      now, game.engineBuildFingerprint ?? "", game.modelFingerprint ?? "",
      game.providerFingerprint ?? "", game.bookIdentity ?? "", game.modelId ?? "",
      game.checkpointHash ?? "", game.adapterId ?? "", game.provider ?? "",
      game.hardwareDriverFingerprint ?? "", game.onnxRuntimeVersion ?? "",
      game.searchCore ?? "", safeInteger(game.threads, "game threads", { defaultValue: 0 }),
      safeInteger(game.rootWorkers, "game root workers", { defaultValue: 0 }),
      safeInteger(game.splitDepth, "game split depth", { defaultValue: 0 }),
      safeInteger(game.batchSize, "game batch size", { defaultValue: 0 }),
      safeInteger(game.batchWaitUs, "game batch wait", { defaultValue: 0 }),
      game.timeProfileIdentity ?? "", game.runtimeProvenanceSha256 ?? "",
      runtimeProvenanceJson);
      this.db.prepare(`
        UPDATE games SET archive_cursor=CASE WHEN archive_cursor=0 THEN ? ELSE archive_cursor END,
          initial_fen=CASE WHEN initial_fen='' THEN ? ELSE initial_fen END,
          variant=CASE WHEN initial_fen='' THEN ? ELSE variant END,
          provider_component_id=CASE WHEN provider_component_id='' THEN ? ELSE provider_component_id END,
          provider_component_version=CASE WHEN provider_component_id='' THEN ? ELSE provider_component_version END,
          provider_component_manifest_sha256=CASE WHEN provider_component_id=''
            THEN ? ELSE provider_component_manifest_sha256 END,
          engine_component_id=CASE WHEN engine_component_id='' THEN ? ELSE engine_component_id END,
          engine_component_version=CASE WHEN engine_component_id='' THEN ? ELSE engine_component_version END,
          engine_component_manifest_sha256=CASE WHEN engine_component_id=''
            THEN ? ELSE engine_component_manifest_sha256 END
        WHERE game_id=?
      `).run(
        archiveCursor,
        line.initialFen,
        line.variant,
        providerComponent.componentId,
        providerComponent.version,
        providerComponent.manifestSha256,
        engineComponent?.componentId ?? "",
        engineComponent?.version ?? "",
        engineComponent?.manifestSha256 ?? "",
        id,
      );
    });
    this.refreshGameArchiveSummary();
  }

  gamePlyRows(id) {
    return this.db.prepare(`
      SELECT game_id, ply, uci_move, before_fen, after_fen, actor_color,
        clock_available, clock_ms
      FROM game_plies WHERE game_id=? ORDER BY ply
    `).all(normalizeProviderGameId(String(id)));
  }

  reconcileGameLine({ id, initialFen, variant = "standard", plies }) {
    const gameId = normalizeProviderGameId(String(id));
    const line = normalizeProviderGameLine({ initialFen, variant, plies });
    return this.withImmediateTransaction(() => {
      const game = this.db.prepare(`
        SELECT finished_at, initial_fen, variant FROM games WHERE game_id=?
      `).get(gameId);
      if (!game) throw new Error(`Provider game is unavailable: ${gameId}`);
      if (game.initial_fen && game.initial_fen !== line.initialFen) {
        throw new Error(`Provider game initial FEN conflicts with ${gameId}`);
      }
      if (game.initial_fen && game.variant !== line.variant) {
        throw new Error(`Provider game variant conflicts with ${gameId}`);
      }
      const stored = this.gamePlyRows(gameId);
      const samePly = (left, right) => left.uci_move === right.uciMove
        && left.before_fen === right.beforeFen && left.after_fen === right.afterFen
        && left.actor_color === right.actorColor;
      if (game.finished_at > 0) {
        if (stored.length !== line.plies.length
            || stored.some((entry, index) => !samePly(entry, line.plies[index])
              || (line.plies[index].clockMs !== null
                && (entry.clock_available !== 1
                  || entry.clock_ms !== line.plies[index].clockMs)))) {
          throw new Error(`Terminal provider game replay is immutable: ${gameId}`);
        }
        return false;
      }
      let common = 0;
      while (common < stored.length && common < line.plies.length
          && samePly(stored[common], line.plies[common])) common += 1;
      if (common < stored.length) {
        this.db.prepare("DELETE FROM game_plies WHERE game_id=? AND ply>=?")
          .run(gameId, common);
      }
      const insert = this.db.prepare(`
        INSERT INTO game_plies(
          game_id, ply, uci_move, before_fen, after_fen, actor_color,
          clock_available, clock_ms
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = common; index < line.plies.length; index += 1) {
        const ply = line.plies[index];
        insert.run(
          gameId,
          ply.ply,
          ply.uciMove,
          ply.beforeFen,
          ply.afterFen,
          ply.actorColor,
          ply.clockMs === null ? 0 : 1,
          ply.clockMs ?? 0,
        );
      }
      const updateClock = this.db.prepare(`
        UPDATE game_plies SET clock_available=1, clock_ms=?
        WHERE game_id=? AND ply=?
      `);
      for (let index = 0; index < common; index += 1) {
        const clockMs = line.plies[index].clockMs;
        if (clockMs !== null
            && (stored[index].clock_available !== 1 || stored[index].clock_ms !== clockMs)) {
          updateClock.run(clockMs, gameId, index);
        }
      }
      this.db.prepare(`
        UPDATE games SET initial_fen=CASE WHEN initial_fen='' THEN ? ELSE initial_fen END,
          variant=?, plies=?, archive_completeness='live', archive_reason=''
        WHERE game_id=? AND finished_at=0
      `).run(line.initialFen, line.variant, line.plies.length, gameId);
      return common !== stored.length || stored.length !== line.plies.length
        || line.plies.some((ply, index) => ply.clockMs !== null
          && (stored[index]?.clock_available !== 1 || stored[index]?.clock_ms !== ply.clockMs));
    });
  }

  listProviderGameBackfillIds(limit = PROVIDER_GAME_BACKFILL_MAXIMUM_IDS) {
    limit = safeInteger(limit, "game backfill id limit", {
      minimum: 1,
      maximum: PROVIDER_GAME_BACKFILL_MAXIMUM_IDS,
    });
    return this.db.prepare(`
      SELECT game_id FROM games
      WHERE archive_completeness IN ('summary_only','live') AND backfill_attempts=0
      ORDER BY archive_cursor LIMIT ?
    `).all(limit).map((row) => row.game_id);
  }

  recordProviderGameBackfillFailure(id, reason, now = Date.now()) {
    const gameId = normalizeProviderGameId(String(id));
    now = safeInteger(now, "game backfill failure timestamp");
    if (typeof reason !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(reason)) {
      throw new Error("game backfill failure reason is invalid");
    }
    this.withImmediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT backfill_attempts FROM games
        WHERE game_id=? AND archive_completeness IN ('summary_only','live')
      `).get(gameId);
      if (!row) return;
      const attempts = safeInteger(
        safeInteger(row.backfill_attempts, "game backfill attempt count") + 1,
        "game backfill attempt count",
      );
      this.db.prepare(`
        UPDATE games SET archive_reason=?, backfill_attempts=?,
          backfill_last_attempted_at=? WHERE game_id=?
      `).run(reason, attempts, now, gameId);
    });
    this.refreshGameArchiveSummary();
  }

  reconcileHistoricalGame(record, now = Date.now()) {
    const gameId = normalizeProviderGameId(record.id);
    const line = normalizeProviderGameLine(record);
    now = safeInteger(now, "historical game reconciliation timestamp");
    const finishedAt = safeInteger(record.finishedAt, "historical game finish timestamp", {
      minimum: 1,
    });
    const changed = this.withImmediateTransaction(() => {
      const game = this.db.prepare("SELECT * FROM games WHERE game_id=?").get(gameId);
      if (!game) throw new Error(`Historical provider game is unavailable: ${gameId}`);
      if (game.initial_fen && game.initial_fen !== line.initialFen) {
        throw new Error(`Historical provider game initial FEN conflicts with ${gameId}`);
      }
      if (game.variant && game.variant !== line.variant) {
        throw new Error(`Historical provider game variant conflicts with ${gameId}`);
      }
      const replaceableStatus = new Set(["started", "activating", "activation_failed", "provider_error"]);
      if (game.status && !replaceableStatus.has(game.status) && game.status !== record.status) {
        throw new Error(`Historical provider game status conflicts with ${gameId}`);
      }
      if (game.winner && game.winner !== record.winner) {
        throw new Error(`Historical provider game winner conflicts with ${gameId}`);
      }
      if (game.plies !== 0 && game.plies !== line.plies.length) {
        throw new Error(`Historical provider game ply count conflicts with ${gameId}`);
      }
      const winner = record.winner;
      const derivedResult = winner && (game.color === "white" || game.color === "black")
        ? winner === game.color ? "win" : "loss"
        : new Set(["draw", "stalemate"]).has(record.status) ? "draw" : "";
      if (game.result && derivedResult && game.result !== derivedResult) {
        throw new Error(`Historical provider game result conflicts with ${gameId}`);
      }
      const result = derivedResult || game.result;
      const archiveSha256 = providerGameArchiveSha256({
        gameId,
        initialFen: line.initialFen,
        variant: line.variant,
        status: record.status,
        result,
        winner,
        plies: line.plies,
      });
      if (game.archive_completeness === "complete" || game.archive_completeness === "reconciled") {
        if (game.archive_sha256 !== archiveSha256) {
          throw new Error(`Historical provider game archive conflicts with ${gameId}`);
        }
        return false;
      }
      const stored = this.gamePlyRows(gameId);
      if (stored.some((entry, index) => {
        const ply = line.plies[index];
        return !ply || entry.uci_move !== ply.uciMove || entry.before_fen !== ply.beforeFen
          || entry.after_fen !== ply.afterFen || entry.actor_color !== ply.actorColor;
      })) {
        throw new Error(`Historical provider game replay conflicts with ${gameId}`);
      }
      const insert = this.db.prepare(`
        INSERT INTO game_plies(
          game_id, ply, uci_move, before_fen, after_fen, actor_color,
          clock_available, clock_ms
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = stored.length; index < line.plies.length; index += 1) {
        const ply = line.plies[index];
        insert.run(
          gameId,
          ply.ply,
          ply.uciMove,
          ply.beforeFen,
          ply.afterFen,
          ply.actorColor,
          ply.clockMs === null ? 0 : 1,
          ply.clockMs ?? 0,
        );
      }
      const updateClock = this.db.prepare(`
        UPDATE game_plies SET clock_available=1, clock_ms=? WHERE game_id=? AND ply=?
      `);
      for (let index = 0; index < stored.length; index += 1) {
        const clockMs = line.plies[index].clockMs;
        if (clockMs !== null && stored[index].clock_available !== 1) {
          updateClock.run(clockMs, gameId, index);
        } else if (clockMs !== null && stored[index].clock_ms !== clockMs) {
          throw new Error(`Historical provider game clock conflicts with ${gameId}`);
        }
      }
      let completionCursor = game.completion_cursor;
      if (completionCursor === 0) {
        const control = this.db.prepare(`
          SELECT next_completion_cursor FROM game_archive_control WHERE id=1
        `).get();
        completionCursor = safeInteger(
          control.next_completion_cursor,
          "next game completion cursor",
          { minimum: 1 },
        );
        this.db.prepare(`
          UPDATE game_archive_control SET next_completion_cursor=?, updated_at=? WHERE id=1
        `).run(safeInteger(completionCursor + 1, "next game completion cursor"), now);
      }
      const backfillAttempts = safeInteger(
        safeInteger(game.backfill_attempts, "game backfill attempt count") + 1,
        "game backfill attempt count",
      );
      this.db.prepare(`
        UPDATE games SET completion_cursor=?, initial_fen=?, variant=?, status=?, result=?,
          winner=?, plies=?, finished_at=?, archive_completeness='reconciled',
          archive_reason='', archive_sha256=?, backfill_attempts=?,
          backfill_last_attempted_at=?
        WHERE game_id=?
      `).run(
        completionCursor,
        line.initialFen,
        line.variant,
        record.status,
        result,
        winner,
        line.plies.length,
        finishedAt,
        archiveSha256,
        backfillAttempts,
        now,
        gameId,
      );
      return true;
    });
    if (changed) {
      this.refreshOpponentProjection();
      this.refreshGameArchiveSummary();
    }
    return changed;
  }

  listProviderGames(request = {}) {
    const normalized = normalizeProviderGamePageRequest(request);
    const cursorColumn = normalized.scope === "live" ? "archive_cursor" : "completion_cursor";
    const statePredicate = normalized.scope === "live" ? "finished_at=0" : "finished_at>0";
    const cursorPredicate = normalized.beforeCursor > 0 ? `AND ${cursorColumn}<?` : "";
    const rows = this.db.prepare(`
      SELECT * FROM games WHERE ${statePredicate} ${cursorPredicate}
      ORDER BY ${cursorColumn} DESC LIMIT ?
    `).all(
      ...(normalized.beforeCursor > 0 ? [normalized.beforeCursor] : []),
      normalized.limit + 1,
    );
    const hasMore = rows.length > normalized.limit;
    return projectProviderGamePage({
      request: normalized,
      rows: rows.slice(0, normalized.limit),
      hasMore,
    });
  }

  getProviderGame(id) {
    const gameId = normalizeProviderGameId(String(id));
    const row = this.db.prepare("SELECT * FROM games WHERE game_id=?").get(gameId);
    return row ? projectProviderGame(row, this.gamePlyRows(gameId)) : null;
  }

  backfillGameProvenance(entries, { apply = false } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("Historical provenance backfill requires at least one evidence entry");
    }
    const reports = [];
    this.storage.assertPaths();
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
        const expectedGames = safeInteger(entry.expected_game_count, "historical expected game count", {
          minimum: 1,
        });
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
            const populated = kind === "integer" ? existing !== 0 : String(existing ?? "") !== "";
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
      this.storage.assertPaths();
      return reports;
    } catch (error) {
      this.failOwnedTransaction(error);
    }
  }

  finishGame({ id, status, result, winner, plies, finishedAt = Date.now() }) {
    const gameId = normalizeProviderGameId(String(id));
    finishedAt = safeInteger(finishedAt, "game finish timestamp");
    const terminal = normalizeProviderGameTerminal({ status, result, winner });
    const terminalStatus = terminal.status;
    const terminalResult = terminal.result;
    const terminalWinner = terminal.winner;
    const terminalPlies = safeInteger(plies, "game plies", {
      defaultValue: 0,
      maximum: 2_048,
    });
    const changed = this.withImmediateTransaction(() => {
      const game = this.db.prepare("SELECT * FROM games WHERE game_id=?").get(gameId);
      if (!game) throw new Error(`Provider game is unavailable: ${gameId}`);
      const replay = this.gamePlyRows(gameId);
      if (!game.initial_fen || replay.length !== terminalPlies) {
        throw new Error(`Provider game replay is incomplete at terminal state: ${gameId}`);
      }
      const line = replay.map((entry) => ({
        ply: entry.ply,
        uciMove: entry.uci_move,
        beforeFen: entry.before_fen,
        afterFen: entry.after_fen,
        actorColor: entry.actor_color,
        clockMs: entry.clock_available === 1 ? entry.clock_ms : null,
      }));
      const archiveSha256 = providerGameArchiveSha256({
        gameId,
        initialFen: game.initial_fen,
        variant: game.variant,
        status: terminalStatus,
        result: terminalResult,
        winner: terminalWinner,
        plies: line,
      });
      if (game.finished_at > 0) {
        if (game.status !== terminalStatus || game.result !== terminalResult
            || game.winner !== terminalWinner || game.plies !== terminalPlies
            || game.archive_sha256 !== archiveSha256) {
          throw new Error(`Terminal provider game metadata is immutable: ${gameId}`);
        }
        return false;
      }
      const control = this.db.prepare(`
        SELECT next_completion_cursor FROM game_archive_control WHERE id=1
      `).get();
      const completionCursor = safeInteger(
        control.next_completion_cursor,
        "next game completion cursor",
        { minimum: 1 },
      );
      this.db.prepare(`
        UPDATE game_archive_control SET next_completion_cursor=?, updated_at=? WHERE id=1
      `).run(safeInteger(completionCursor + 1, "next game completion cursor"), finishedAt);
      this.db.prepare(`
        UPDATE games SET completion_cursor=?, status=?, result=?, winner=?, plies=?,
          finished_at=?, archive_completeness='complete', archive_reason='', archive_sha256=?
        WHERE game_id=? AND finished_at=0
      `).run(
        completionCursor,
        terminalStatus,
        terminalResult,
        terminalWinner,
        terminalPlies,
        finishedAt,
        archiveSha256,
        gameId,
      );
      return true;
    });
    this.refreshOpponentProjection();
    this.refreshGameArchiveSummary();
    return changed;
  }

  opponentAudience(username) {
    if (!username) return null;
    const row = this.db.prepare("SELECT title FROM opponents WHERE username=?")
      .get(normalizedUsername(username));
    return String(row?.title ?? "").toUpperCase() === "BOT" ? "bot" : null;
  }

  opponentStats(limit = 100) {
    const opponents = this.queryOpponentStats(limit);
    if (safeInteger(limit, "opponent statistics limit", {
      minimum: 1, maximum: 100, defaultValue: 100,
    }) === 100) this.statusOpponents = opponents;
    return opponents;
  }

  status(now = Date.now()) {
    now = safeInteger(now, "store status timestamp");
    return {
      schemaVersion: LICHESS_STORAGE_SCHEMA_VERSION,
      control: this.control(now),
      owners: this.listOwners(),
      opponents: this.db.prepare("SELECT COUNT(*) AS count FROM opponents").get().count,
      challenges: this.db.prepare("SELECT COUNT(*) AS count FROM challenge_attempts").get().count,
      games: this.db.prepare("SELECT COUNT(*) AS count FROM games").get().count,
      gameArchive: this.gameArchiveSummary(),
      opponentStats: this.opponentStats(),
      apiSafety: this.listApiSafetyState(),
      apiLeases: this.activeApiLeases(now),
    };
  }
}

export { normalizedUsername };
