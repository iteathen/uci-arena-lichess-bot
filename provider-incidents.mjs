import { createHash } from "node:crypto";

export const PROVIDER_INCIDENT_PAGE_SCHEMA = "uci_arena_provider_incident_page_v1";
export const PROVIDER_INCIDENT_MAXIMUM_ROWS = 2_048;
export const PROVIDER_INCIDENT_RESOLVED_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const PROVIDER_INCIDENT_MAXIMUM_PAGE_SIZE = 100;
export const PROVIDER_INCIDENT_DETAIL_MAXIMUM_CHARACTERS = 512;

export const PROVIDER_INCIDENT_SEVERITIES = Object.freeze([
  "info",
  "warning",
  "error",
  "critical",
]);
export const PROVIDER_INCIDENT_SOURCES = Object.freeze([
  "api",
  "scheduler",
  "stream",
  "startup",
  "engine_child",
  "storage",
  "status_publication",
]);

const SEVERITY_RANK = new Map(PROVIDER_INCIDENT_SEVERITIES.map((value, index) => [value, index]));
const CLOSED_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/u;
const REMOTE_GAME_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const EPISODE_SCOPE = /^[A-Za-z0-9:._-]{1,128}$/u;
const FORBIDDEN_DETAIL = Object.freeze([
  /\b(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|credential)\b/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{4,}/iu,
  /\b(?:sk|ghp|github_pat)-[A-Za-z0-9_-]{8,}\b/iu,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\|\/(?:[^\s/]+\/)+)[^\s]*/u,
  /(?:^|\s)--[a-z][a-z0-9-]*(?:\s|=|$)/iu,
  /\b(?:cmd\.exe|powershell(?:\.exe)?|pwsh(?:\.exe)?|sh\s+-c|bash\s+-c|node(?:\.exe)?\s+)\b/iu,
  /\b(?:uciok|readyok|bestmove|info\s+(?:depth|score|nodes)|id\s+name|option\s+name)\b/iu,
]);

export class ProviderIncidentValidationError extends Error {
  constructor(code, detail) {
    super(String(detail).replaceAll(/[\r\n]/gu, " ").slice(0, 512));
    this.name = "ProviderIncidentValidationError";
    this.code = code;
  }
}

function invalid(code, detail) {
  throw new ProviderIncidentValidationError(code, detail);
}

function exactInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
      || value < minimum || value > maximum) {
    invalid("LICHESS_PROVIDER_INCIDENT_INTEGER_INVALID", `${label} must be an exact safe integer`);
  }
  return value;
}

function nullableInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) return null;
  return exactInteger(value, label, { minimum, maximum });
}

function closedIdentifier(value, label) {
  if (typeof value !== "string" || !CLOSED_IDENTIFIER.test(value)) {
    invalid("LICHESS_PROVIDER_INCIDENT_IDENTITY_INVALID", `${label} is not a closed provider identifier`);
  }
  return value;
}

function optionalGameId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !REMOTE_GAME_ID.test(value)) {
    invalid("LICHESS_PROVIDER_INCIDENT_GAME_ID_INVALID", "incident game id is invalid");
  }
  return value;
}

function optionalEpisodeScope(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !EPISODE_SCOPE.test(value)) {
    invalid("LICHESS_PROVIDER_INCIDENT_EPISODE_INVALID", "incident episode scope is invalid");
  }
  return value;
}

export function sanitizeProviderIncidentDetail(value) {
  if (typeof value !== "string") {
    invalid("LICHESS_PROVIDER_INCIDENT_DETAIL_INVALID", "incident detail must be a provider-authored string");
  }
  if (Array.from(value).length > PROVIDER_INCIDENT_DETAIL_MAXIMUM_CHARACTERS) {
    invalid("LICHESS_PROVIDER_INCIDENT_DETAIL_OVERSIZED", "incident detail exceeds its bound");
  }
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (!normalized) {
    invalid("LICHESS_PROVIDER_INCIDENT_DETAIL_INVALID", "incident detail is empty");
  }
  if ((normalized.startsWith("{") && normalized.endsWith("}"))
      || (normalized.startsWith("[") && normalized.endsWith("]"))
      || FORBIDDEN_DETAIL.some((pattern) => pattern.test(normalized))) {
    invalid("LICHESS_PROVIDER_INCIDENT_DETAIL_UNSAFE", "incident detail contains private diagnostic material");
  }
  return normalized;
}

export function providerIncidentSeverityAtLeast(left, right) {
  if (!SEVERITY_RANK.has(left) || !SEVERITY_RANK.has(right)) {
    invalid("LICHESS_PROVIDER_INCIDENT_SEVERITY_INVALID", "incident severity is invalid");
  }
  return SEVERITY_RANK.get(left) >= SEVERITY_RANK.get(right) ? left : right;
}

export function normalizeProviderIncidentReport(report, now = Date.now()) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    invalid("LICHESS_PROVIDER_INCIDENT_REPORT_INVALID", "incident report must be an object");
  }
  const code = closedIdentifier(report.code, "incident code");
  const source = closedIdentifier(report.source, "incident source");
  if (!PROVIDER_INCIDENT_SOURCES.includes(source)) {
    invalid("LICHESS_PROVIDER_INCIDENT_SOURCE_INVALID", "incident source is unsupported");
  }
  const operation = closedIdentifier(report.operation, "incident operation");
  const severity = String(report.severity ?? "error");
  if (!SEVERITY_RANK.has(severity)) {
    invalid("LICHESS_PROVIDER_INCIDENT_SEVERITY_INVALID", "incident severity is unsupported");
  }
  const occurredAt = exactInteger(report.occurredAt ?? now, "incident occurrence timestamp");
  const httpStatus = nullableInteger(report.httpStatus, "incident HTTP status", {
    minimum: 100,
    maximum: 599,
  });
  const retryDeadline = nullableInteger(report.retryDeadline, "incident retry deadline");
  const gameId = optionalGameId(report.gameId);
  const episodeScope = optionalEpisodeScope(report.episodeScope);
  const idempotent = report.idempotent === true;
  if (report.idempotent !== undefined && typeof report.idempotent !== "boolean") {
    invalid("LICHESS_PROVIDER_INCIDENT_IDEMPOTENCY_INVALID", "incident idempotency must be boolean");
  }
  const detail = sanitizeProviderIncidentDetail(report.detail);
  const identityTuple = [code, source, operation, httpStatus, gameId, episodeScope];
  const identityKey = createHash("sha256").update(JSON.stringify(identityTuple)).digest("hex");
  return Object.freeze({
    identityKey,
    code,
    severity,
    source,
    operation,
    occurredAt,
    httpStatus,
    retryDeadline,
    gameId,
    episodeScope,
    idempotent,
    detail,
  });
}

export function normalizeProviderIncidentResolution(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    invalid("LICHESS_PROVIDER_INCIDENT_RESOLUTION_INVALID", "incident resolution must be an object");
  }
  const normalized = normalizeProviderIncidentReport({
    ...identity,
    severity: identity.severity ?? "info",
    detail: identity.detail ?? "Provider operation recovered",
    occurredAt: identity.occurredAt ?? 0,
  }, 0);
  return Object.freeze({ identityKey: normalized.identityKey });
}

export function normalizeProviderIncidentPageRequest({
  filter = "active",
  afterCursor = 0,
  limit = PROVIDER_INCIDENT_MAXIMUM_PAGE_SIZE,
} = {}) {
  if (!new Set(["active", "all"]).has(filter)) {
    invalid("LICHESS_PROVIDER_INCIDENT_FILTER_INVALID", "incident filter must be active or all");
  }
  return Object.freeze({
    filter,
    afterCursor: exactInteger(afterCursor, "incident page cursor"),
    limit: exactInteger(limit, "incident page limit", {
      minimum: 1,
      maximum: PROVIDER_INCIDENT_MAXIMUM_PAGE_SIZE,
    }),
  });
}

export function projectProviderIncidentRow(row) {
  const state = row.active === 1 ? "active" : row.active === 0 ? "resolved" : null;
  if (!state) invalid("LICHESS_PROVIDER_INCIDENT_ROW_INVALID", "incident row state is invalid");
  const severity = String(row.severity);
  const source = String(row.source);
  if (!SEVERITY_RANK.has(severity) || !PROVIDER_INCIDENT_SOURCES.includes(source)) {
    invalid("LICHESS_PROVIDER_INCIDENT_ROW_INVALID", "incident row enums are invalid");
  }
  return Object.freeze({
    cursor: exactInteger(row.cursor, "incident cursor", { minimum: 1 }),
    code: closedIdentifier(row.code, "incident code"),
    severity,
    source,
    operation: closedIdentifier(row.operation, "incident operation"),
    first_occurrence: exactInteger(row.first_occurrence, "incident first occurrence"),
    last_occurrence: exactInteger(row.last_occurrence, "incident last occurrence"),
    occurrence_count: exactInteger(row.occurrence_count, "incident occurrence count", { minimum: 1 }),
    state,
    resolved_at: row.resolved_at === 0
      ? null
      : exactInteger(row.resolved_at, "incident resolution timestamp"),
    http_status: row.http_status === 0
      ? null
      : exactInteger(row.http_status, "incident HTTP status", { minimum: 100, maximum: 599 }),
    retry_deadline: row.retry_deadline === 0
      ? null
      : exactInteger(row.retry_deadline, "incident retry deadline"),
    game_id: row.game_id === "" ? null : optionalGameId(row.game_id),
    detail: sanitizeProviderIncidentDetail(row.detail),
  });
}

export function providerIncidentSummaryUnavailable() {
  return Object.freeze({
    available: false,
    active_count: null,
    highest_severity: null,
    latest_cursor: null,
    truncated: null,
    truncated_rows: null,
  });
}

export function projectProviderIncidentSummary({
  activeCount,
  severities = [],
  latestCursor,
  truncatedRows,
}) {
  const active = exactInteger(activeCount, "active incident count");
  const latest = exactInteger(latestCursor, "latest incident cursor");
  const truncated = exactInteger(truncatedRows, "truncated incident count");
  let highestSeverity = null;
  for (const severity of severities) {
    if (!SEVERITY_RANK.has(severity)) {
      invalid("LICHESS_PROVIDER_INCIDENT_ROW_INVALID", "active incident severity is invalid");
    }
    highestSeverity = highestSeverity === null
      ? severity
      : providerIncidentSeverityAtLeast(highestSeverity, severity);
  }
  return Object.freeze({
    available: true,
    active_count: active,
    highest_severity: highestSeverity,
    latest_cursor: latest,
    truncated: truncated > 0,
    truncated_rows: truncated,
  });
}
