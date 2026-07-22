#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LichessStore } from "./lichess-store.mjs";

function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (!token.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${token}`);
    }
    args[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function backupPath(database) {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  return `${database}.pre-provenance-backfill-${stamp}.sqlite`;
}

function mergeObjects(base, override) {
  const result = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeObjects(result[key], value)
      : value;
  }
  return result;
}

export function expandManifestEntries(manifest) {
  const defaults = manifest.defaults ?? {};
  return (manifest.entries ?? []).map((entry) => ({
    ...defaults,
    ...entry,
    match: { ...(defaults.match ?? {}), ...(entry.match ?? {}) },
    values: { ...(defaults.values ?? {}), ...(entry.values ?? {}) },
    provenance: mergeObjects(defaults.provenance, entry.provenance),
    evidence_sources: [...(defaults.evidence_sources ?? []), ...(entry.evidence_sources ?? [])],
    unknown_fields: [...new Set([...(defaults.unknown_fields ?? []), ...(entry.unknown_fields ?? [])])],
  }));
}

export function runBackfill({ database, manifest, apply = false, backup } = {}) {
  if (!database) throw new Error("--database is required");
  if (!manifest) throw new Error("--manifest is required");
  const databasePath = path.resolve(database);
  const manifestPath = path.resolve(manifest);
  const manifestContent = readFileSync(manifestPath);
  const evidence = JSON.parse(manifestContent);
  if (evidence.schema !== "uci_arena_game_provenance_backfill_v1") {
    throw new Error(`Unsupported provenance backfill manifest schema: ${evidence.schema}`);
  }
  const store = new LichessStore(databasePath);
  let resolvedBackup = "";
  try {
    if (apply) {
      const activeLease = store.db.prepare(
        "SELECT owner_id, pid, expires_at FROM api_client_leases WHERE expires_at>? LIMIT 1",
      ).get(Date.now());
      if (activeLease) {
        throw new Error(`Refusing provenance backfill while Lichess API lease is active (pid ${activeLease.pid})`);
      }
      store.db.exec("PRAGMA wal_checkpoint(FULL)");
      resolvedBackup = path.resolve(backup ?? backupPath(databasePath));
      if (existsSync(resolvedBackup)) throw new Error(`Backup path already exists: ${resolvedBackup}`);
      copyFileSync(databasePath, resolvedBackup);
    }
    const reports = store.backfillGameProvenance(expandManifestEntries(evidence), { apply });
    return {
      schema: "uci_arena_game_provenance_backfill_report_v1",
      mode: apply ? "applied" : "dry_run",
      database: databasePath,
      manifest: manifestPath,
      manifest_sha256: sha256(manifestContent),
      backup: resolvedBackup,
      matched: reports.reduce((sum, report) => sum + report.matched, 0),
      updated: reports.reduce((sum, report) => sum + report.updated, 0),
      would_update: reports.reduce((sum, report) => sum + report.would_update, 0),
      skipped_existing: reports.reduce((sum, report) => sum + report.skipped_existing, 0),
      conflicts: reports.reduce((sum, report) => sum + report.conflicts.length, 0),
      deployments: reports,
    };
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArguments(process.argv.slice(2));
    console.log(JSON.stringify(runBackfill({
      database: args.database,
      manifest: args.manifest,
      apply: Boolean(args.apply),
      backup: args.backup,
    }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      schema: "uci_arena_game_provenance_backfill_error_v1",
      error: error.message,
      deployments: error.reports ?? [],
    }, null, 2));
    process.exitCode = 1;
  }
}
