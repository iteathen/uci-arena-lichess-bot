import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROVIDER_INCIDENT_MAXIMUM_ROWS,
  PROVIDER_INCIDENT_RESOLVED_RETENTION_MS,
  ProviderIncidentValidationError,
  normalizeProviderIncidentPageRequest,
  normalizeProviderIncidentReport,
  sanitizeProviderIncidentDetail,
} from "./provider-incidents.mjs";
import { LichessStore } from "./lichess-store.mjs";

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-provider-incidents-"));
  return { directory, file: path.join(directory, "matches.sqlite") };
}

function streamIncident(overrides = {}) {
  return {
    code: "event_stream_disconnected",
    severity: "warning",
    source: "stream",
    operation: "event_stream",
    detail: "Lichess provider event stream disconnected",
    ...overrides,
  };
}

test("incident domain rejects secret, path, command, JSON, engine, and oversized detail", () => {
  assert.equal(sanitizeProviderIncidentDetail("Provider\noperation   recovered"), "Provider operation recovered");
  for (const detail of [
    "Authorization header rejected",
    "Bearer abcd1234",
    "failed near C:\\private\\runtime",
    "failed with --token-file hidden",
    "powershell.exe launched worker",
    '{"raw":"response"}',
    "info depth 9 score cp 12",
    "x".repeat(513),
  ]) {
    assert.throws(
      () => normalizeProviderIncidentReport(streamIncident({ detail }), 100),
      ProviderIncidentValidationError,
    );
  }
  assert.throws(
    () => normalizeProviderIncidentPageRequest({ afterCursor: "1" }),
    ProviderIncidentValidationError,
  );
  assert.throws(
    () => normalizeProviderIncidentPageRequest({ filter: "recent" }),
    ProviderIncidentValidationError,
  );
});

test("active identities aggregate, escalate, resolve, and begin later episodes with new cursors", () => {
  const { file } = fixture();
  const first = new LichessStore(file);
  const second = new LichessStore(file);
  try {
    assert.equal(first.recordProviderIncident(streamIncident({ occurredAt: 100 })), 1);
    assert.equal(second.recordProviderIncident(streamIncident({
      severity: "critical",
      occurredAt: 120,
      retryDeadline: 500,
      detail: "Lichess provider event stream repeatedly disconnected",
    })), 1);
    const active = first.listProviderIncidents({ filter: "active", limit: 10 });
    assert.equal(active.incidents.length, 1);
    assert.deepEqual(active.incidents[0], {
      cursor: 1,
      code: "event_stream_disconnected",
      severity: "critical",
      source: "stream",
      operation: "event_stream",
      first_occurrence: 100,
      last_occurrence: 120,
      occurrence_count: 2,
      state: "active",
      resolved_at: null,
      http_status: null,
      retry_deadline: 500,
      game_id: null,
      detail: "Lichess provider event stream repeatedly disconnected",
    });
    assert.equal(first.resolveProviderIncident(streamIncident(), 140), true);
    assert.equal(first.resolveProviderIncident(streamIncident(), 150), false);
    assert.equal(second.recordProviderIncident(streamIncident({ occurredAt: 160 })), 2);
    const page = first.listProviderIncidents({ filter: "all", afterCursor: 0, limit: 1 });
    assert.equal(page.has_more, true);
    assert.equal(page.next_cursor, 1);
    assert.equal(page.incidents[0].state, "resolved");
    const next = first.listProviderIncidents({ filter: "all", afterCursor: page.next_cursor, limit: 1 });
    assert.equal(next.has_more, false);
    assert.equal(next.incidents[0].cursor, 2);
  } finally {
    second.close();
    first.close();
  }
});

test("idempotent startup evidence never duplicates or reopens one receipt episode", () => {
  const { file } = fixture();
  const store = new LichessStore(file);
  const report = {
    code: "provider_unexpected_exit",
    severity: "critical",
    source: "startup",
    operation: "provider_supervision",
    episodeScope: "a".repeat(64),
    idempotent: true,
    detail: "Provider supervision observed an unexpected prior process exit",
  };
  try {
    assert.equal(store.recordProviderIncident(report, 100), 1);
    assert.equal(store.recordProviderIncident(report, 110), 1);
    assert.equal(store.resolveProviderIncident(report, 120), true);
    assert.equal(store.recordProviderIncident(report, 130), 1);
    const page = store.listProviderIncidents({ filter: "all" });
    assert.equal(page.incidents.length, 1);
    assert.equal(page.incidents[0].occurrence_count, 1);
    assert.equal(page.incidents[0].state, "resolved");
  } finally {
    store.close();
  }
});

test("hard retention removes resolved rows before oldest active rows and exposes truncation", () => {
  const { file } = fixture();
  const store = new LichessStore(file);
  try {
    store.db.exec("BEGIN IMMEDIATE");
    const insert = store.db.prepare(`
      INSERT INTO provider_incidents(
        cursor, identity_key, code, severity, source, operation,
        first_occurrence, last_occurrence, occurrence_count, active,
        resolved_at, http_status, retry_deadline, game_id, detail
      ) VALUES(?, ?, 'seed_failure', 'error', 'storage', 'retention_test',
        1, 1, 1, ?, ?, 0, 0, '', 'Seeded provider failure')
    `);
    for (let cursor = 1; cursor <= PROVIDER_INCIDENT_MAXIMUM_ROWS + 2; cursor += 1) {
      const resolved = cursor > PROVIDER_INCIDENT_MAXIMUM_ROWS;
      const identity = createHash("sha256").update(String(cursor)).digest("hex");
      insert.run(cursor, identity, resolved ? 0 : 1, resolved ? 2 : 0);
    }
    store.db.prepare(`
      UPDATE provider_incident_control SET next_cursor=? WHERE id=1
    `).run(PROVIDER_INCIDENT_MAXIMUM_ROWS + 3);
    store.db.exec("COMMIT");

    const inserted = store.recordProviderIncident(streamIncident({ occurredAt: 100 }), 100);
    assert.equal(inserted, PROVIDER_INCIDENT_MAXIMUM_ROWS + 3);
    const control = store.db.prepare("SELECT * FROM provider_incident_control WHERE id=1").get();
    assert.equal(control.truncated_rows, 3);
    assert.equal(control.truncated_active_rows, 1);
    assert.equal(control.last_truncated_cursor, PROVIDER_INCIDENT_MAXIMUM_ROWS + 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM provider_incidents").get().count,
      PROVIDER_INCIDENT_MAXIMUM_ROWS);
    assert.equal(store.db.prepare("SELECT 1 AS found FROM provider_incidents WHERE cursor=1").get(), undefined);
    const page = store.listProviderIncidents({ filter: "all", limit: 1 });
    assert.equal(page.incidents[0].cursor, 2);
    assert.deepEqual(page.retention, {
      maximum_rows: PROVIDER_INCIDENT_MAXIMUM_ROWS,
      resolved_retention_ms: PROVIDER_INCIDENT_RESOLVED_RETENTION_MS,
      last_truncated_cursor: PROVIDER_INCIDENT_MAXIMUM_ROWS + 2,
      truncated_rows: 3,
      truncated_active_rows: 1,
    });
  } finally {
    store.close();
  }
});

test("ninety-day resolved retention is strict and reports history loss", () => {
  const { file } = fixture();
  const store = new LichessStore(file);
  try {
    store.recordProviderIncident(streamIncident({ occurredAt: 1 }), 1);
    store.resolveProviderIncident(streamIncident(), 2);
    store.recordProviderIncident(
      streamIncident({ code: "scheduler_tick_failed", source: "scheduler", operation: "scheduler_tick" }),
      PROVIDER_INCIDENT_RESOLVED_RETENTION_MS + 2,
    );
    const page = store.listProviderIncidents({ filter: "all" });
    assert.equal(page.incidents.length, 1);
    assert.equal(page.incidents[0].code, "scheduler_tick_failed");
    assert.equal(page.retention.truncated_rows, 1);
    assert.equal(page.retention.last_truncated_cursor, 1);
  } finally {
    store.close();
  }
});

test("incident recovery never mutates the API cooldown authority", () => {
  const { file } = fixture();
  const store = new LichessStore(file);
  const authority = "https://lichess.org|arena-bot";
  try {
    store.saveApiSafetyState(authority, {
      cooldownUntil: 5_000,
      strikeCount: 2,
      last429At: 100,
      lastRetryAfterMs: 4_900,
      challengeBlockedUntil: 0,
      challengeStrikeCount: 0,
      challengeLast429At: 0,
      challengeRecoveredAt: 0,
      challengeHalfOpen: false,
    }, 100);
    const incident = {
      code: "api_rate_limited",
      severity: "warning",
      source: "api",
      operation: "request_dispatch",
      httpStatus: 429,
      retryDeadline: 5_000,
      detail: "Lichess API request dispatch entered a provider cooldown",
    };
    store.recordProviderIncident(incident, 100);
    store.resolveProviderIncident(incident, 200);
    assert.deepEqual(store.apiSafetyState(authority), {
      cooldownUntil: 5_000,
      strikeCount: 2,
      last429At: 100,
      lastRetryAfterMs: 4_900,
      challengeBlockedUntil: 0,
      challengeStrikeCount: 0,
      challengeLast429At: 0,
      challengeRecoveredAt: 0,
      challengeHalfOpen: false,
    });
  } finally {
    store.close();
  }
});
