import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSingleGameProfile } from "./lichess-adapter.mjs";
import { publishSingleGameProfile } from "./publish-single-game-profile.mjs";

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "uci-single-game-profile-"));
  const engine = path.join(root, "uci_arena_engine.exe");
  const modelRoot = path.join(root, "models", "default");
  const output = path.join(root, "qualification", "profile.json");
  const diagnosticPath = path.join(root, "diagnostic.json");
  const completeGamePath = path.join(root, "complete-game.json");
  mkdirSync(modelRoot, { recursive: true });
  writeFileSync(engine, "exact-engine");
  writeFileSync(path.join(modelRoot, "checkpoint_manifest.json"), JSON.stringify({
    model_id: "model-a",
    checkpoint_hash: "a".repeat(64),
  }));
  const engineSha = sha256("exact-engine");
  const identity = {
    engine: { executable_sha256: engineSha },
    model: {
      model_id: "model-a",
      model_fingerprint: "123",
      adapter_id: "adapter-a",
    },
    provider: {
      provider_numeric_fingerprint: "456",
      hardware_driver_fingerprint: "789",
      onnx_runtime_version: "1.2.3",
    },
    search: {
      search_core: "v2",
      threads: 6,
      root_workers: 6,
      split_depth: 2,
      batch_size_configured: 64,
      batch_size_effective: 64,
      batch_wait_us_configured: 0,
      batch_wait_us_effective: 0,
      provider_requested: "directml",
      provider_effective: "directml",
      background_search: false,
      nn_speculation: false,
    },
  };
  writeFileSync(diagnosticPath, JSON.stringify({
    schema: "uci_time_profile_attempt_v3",
    phase: "diagnostic",
    outcome: "accepted_for_calibration",
    identity,
    gates: {
      legal_moves: true,
      provider_activity_positive: true,
      provider_safety_passed: true,
      p99_deadline_overshoot_passed: true,
      maximum_deadline_overshoot_passed: true,
      passed: true,
    },
  }));
  writeFileSync(completeGamePath, JSON.stringify({
    schema: "uci_arena_complete_game_matrix_v3",
    completed: true,
    config: { executable_sha256: { model_engine: engineSha.slice("sha256:".length) } },
    runtime_contract: {
      expected_parallel_topology: {
        search_core: "v2",
        provider: "directml",
        threads: 6,
        root_workers: 6,
        split_depth: 2,
        batch_size: 64,
      },
      activation_probe: {
        runtime: {
          model_provider: "directml",
          model_id: "model-a",
          model_fingerprint: "123",
          model_input_adapter_id: "adapter-a",
          provider_numeric_fingerprint: "456",
          hardware_driver_fingerprint: "789",
          onnx_runtime_version: "1.2.3",
          actual_active_workers: 6,
          v2_cursor_admissions: 4,
          v2_cursor_async_pending: 2,
          v2_cursor_ready_resumes: 2,
          provider_batches_delta: 3,
          provider_rows_delta: 8,
          stale_publications_delta: 0,
          bestmove_active_tickets: 0,
          bestmove_active_async_leases: 0,
        },
      },
    },
    summary: {
      all_games_complete: true,
      total_complete_games: 2,
      expected_complete_games: 2,
      runtime_qualification: { passed: true },
      diagnostic_qualified: true,
      resource_isolated_diagnostic_qualified: false,
      shared_resource_diagnostic_completed: true,
    },
  }));
  return {
    engine,
    model_root: modelRoot,
    diagnostic_evidence: diagnosticPath,
    complete_game_evidence: completeGamePath,
    output,
    probe_depth: 6,
    probe_timeout_ms: 240_000,
  };
}

test("publishes a self-contained exact local-live-safety profile", () => {
  const options = fixture();
  const result = publishSingleGameProfile({
    ...options,
    qualification_scope: "local_live_safety",
  });
  assert.equal(result.qualified, true);
  assert.equal(result.engine_build_fingerprint, sha256("exact-engine"));
  assert.equal(result.qualification_scope, "local_live_safety");
  const loaded = loadSingleGameProfile(options.output);
  assert.equal(loaded.model_id, "model-a");
  assert.equal(
    JSON.parse(readFileSync(options.output, "utf8")).evidence.complete_game.artifact,
    "evidence/complete-game.json",
  );
});

test("does not promote shared-resource evidence to release authority", () => {
  const options = fixture();
  assert.throws(
    () => publishSingleGameProfile({
      ...options,
      qualification_scope: "release",
    }),
    /resource-isolated/,
  );
});
