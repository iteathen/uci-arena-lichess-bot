import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { safeWorkspaceRelative } from "./tools/build-component-release.mjs";
import { LichessStore } from "./lichess-store.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

test("component definition packages runtime contracts without test or source-tree coupling", () => {
  const definition = JSON.parse(readFileSync(path.join(root, "packaging", "component-definition.json"), "utf8"));
  assert.equal(definition.schema, "uci_arena_component_definition_v1");
  assert.equal(definition.component_id, "lichess.adapter");
  const sources = definition.include.map((entry) => entry.source);
  assert.equal(sources.includes("contracts"), true);
  assert.equal(sources.includes("vendor"), false);
  assert.equal(sources.includes("vendor/time-profile-contract/package.json"), true);
  assert.equal(sources.includes("vendor/time-profile-contract/src"), true);
  assert.equal(sources.includes("vendor/background-service-runtime/package.json"), true);
  assert.equal(sources.includes("vendor/background-service-runtime/src"), true);
  assert.equal(sources.includes("lichess-adapter.mjs"), true);
  assert.equal(sources.includes("provider-incidents.mjs"), true);
  assert.equal(sources.includes("provider-games.mjs"), true);
  assert.equal(sources.includes("process-instance-identity.mjs"), true);
  assert.equal(sources.some((source) => source.includes("fake-api")
    || source.includes("test-fixtures")
    || source.includes("/test")), false);
  assert.equal(JSON.stringify(definition).includes("../"), false);
  assert.equal(definition.native_launcher["windows-x86_64"].required, true);
  assert.equal(definition.native_launcher["linux-x86_64"].required, false);
  assert.deepEqual(definition.native_process_query["windows-x86_64"], {
    required: true, target: "native/uci_arena_background_guard.exe",
  });
  assert.equal(definition.native_process_query["linux-x86_64"].required, false);
  assert.deepEqual(Object.keys(definition.native_toolchain_by_target), ["windows-x86_64"]);
});

test("component manifest separates operator engine overrides from managed suite defaults", () => {
  const manifest = JSON.parse(readFileSync(
    path.join(root, "contracts", "component-manifest.json"), "utf8"));
  const bindings = Object.fromEntries(
    manifest.installation.installer_integration.locator_bindings
      .map((binding) => [binding.name, binding.accepted_sources]),
  );
  assert.deepEqual(bindings.uci_engine, ["saved_locator"]);
  assert.deepEqual(bindings.timing_profile, ["saved_locator"]);
  assert.deepEqual(bindings.lichess_single_game_profile, ["saved_locator"]);
  assert.deepEqual(bindings.lichess_capacity_profile, ["saved_locator"]);
  assert.deepEqual(bindings.lichess_transport_profile, ["saved_locator"]);
  assert.deepEqual(bindings.opening_book, ["saved_locator", "install_receipt"]);
  assert.deepEqual(bindings.syzygy, ["saved_locator", "install_receipt"]);
  assert.equal(
    manifest.installation.installer_integration.startup_control
      .workspace_argument.relative_path,
    ".",
  );
  assert.equal(
    manifest.installation.installer_integration.startup_control.schema,
    "arena_provider_startup_control_v3",
  );
  assert.deepEqual(
    manifest.installation.installer_integration.startup_control
      .operations.pre_replace.arguments,
    ["startup", "prepare_replace", "--lifecycle-result", "typed_v1"],
  );
  assert.deepEqual(
    manifest.installation.installer_integration.startup_control
      .operations.post_replace.arguments,
    ["startup", "complete_replace", "--lifecycle-result", "typed_v1"],
  );
  assert.deepEqual(
    manifest.installation.installer_integration.startup_control.replacement_arguments,
    { previous_root: "--previous-root", replacement_root: "--replacement-root" },
  );
  assert.deepEqual(
    manifest.installation.installer_integration.startup_control
      .operations.post_replace.success_dispositions,
    ["ready", "safe_inactive"],
  );
  assert.deepEqual(manifest.installation.external_user_data, ["provider_workspace"]);
  assert.deepEqual(
    manifest.installation.installer_integration.dependency_bindings.find(
      (binding) => binding.name === "default_engine_manifest",
    ),
    {
      name: "default_engine_manifest",
      component_id: "uci_arena.engine",
      source: "component_path",
      path: "arena-component.json",
      required: false,
    },
  );
});

test("component release accepts safe declarative workspace mappings", () => {
  assert.equal(safeWorkspaceRelative("."), ".");
  assert.equal(safeWorkspaceRelative("runtime"), "runtime");
  assert.equal(safeWorkspaceRelative("provider/runtime"), "provider/runtime");
  assert.throws(() => safeWorkspaceRelative(".."), /unsafe component path/);
  for (const value of ["C:\\provider", "C:provider", "/provider", "\\provider", "\\\\server\\share"]) {
    assert.throws(() => safeWorkspaceRelative(value), /unsafe component path/);
  }
});

test("Manager configuration and status contracts are closed and separate requests from responses", () => {
  const configuration = JSON.parse(readFileSync(path.join(root, "contracts", "configuration-schema.json"), "utf8"));
  const update = JSON.parse(readFileSync(path.join(root, "contracts", "configuration-update-schema.json"), "utf8"));
  const status = JSON.parse(readFileSync(path.join(root, "contracts", "status-schema.json"), "utf8"));
  const incidents = JSON.parse(readFileSync(path.join(root, "contracts", "incident-page-schema.json"), "utf8"));
  const gamePage = JSON.parse(readFileSync(path.join(root, "contracts", "game-page-schema.json"), "utf8"));
  const gameDetail = JSON.parse(readFileSync(path.join(root, "contracts", "game-detail-schema.json"), "utf8"));
  assert.deepEqual(configuration.required, [
    "schema",
    "capacity",
    "inbound_challenges",
    "outbound_challenge",
    "scheduler",
    "opponent_selection",
  ]);
  assert.equal(configuration.properties.groups, undefined);
  assert.equal(configuration.properties.capacity.additionalProperties, false);
  assert.equal(update.required.includes("settings"), true);
  assert.equal(update.properties.settings.additionalProperties, false);
  assert.equal(update.properties.settings.properties.scheduler.required, undefined);
  assert.equal(status.properties.capacity.additionalProperties, false);
  assert.equal(status.$defs.slot_counts.required.includes("cancelling"), true);
  assert.equal(status.properties.games.required.includes("cancelling"), true);
  assert.equal(status.properties.schema.const, "uci_arena_lichess_status_v5");
  assert.equal(status.properties.games.required.includes("archive_available"), true);
  assert.equal(status.properties.games.required.includes("storage_bytes"), true);
  assert.equal(status.properties.supervision.additionalProperties, false);
  assert.equal(status.properties.incidents.additionalProperties, false);
  assert.equal(incidents.$id, "uci_arena_provider_incident_page_v1");
  assert.equal(incidents.additionalProperties, false);
  assert.equal(incidents.$defs.incident.additionalProperties, false);
  assert.equal(incidents.$defs.incident.properties.detail.maxLength, 512);
  assert.equal(gamePage.$id, "uci_arena_provider_game_page_v1");
  assert.equal(gamePage.$defs.game_summary.additionalProperties, false);
  assert.equal(gameDetail.$id, "uci_arena_provider_game_v1");
  assert.equal(gameDetail.additionalProperties, false);
});

test("fake Manager invokes incident and game DTOs only through declared runtime and provider ports", () => {
  const service = JSON.parse(readFileSync(
    path.join(root, "contracts", "service-contract.json"), "utf8"));
  const operations = JSON.parse(readFileSync(
    path.join(root, "contracts", "manager-operations-schema.json"), "utf8"));
  const runtimeBindings = new Map([
    [`${service.invocation.runtime_component_id}:${service.invocation.runtime_entrypoint}`, process.execPath],
  ]);
  const runtime = runtimeBindings.get(
    `${service.invocation.runtime_component_id}:${service.invocation.runtime_entrypoint}`,
  );
  const operation = operations.operations.incidents_list;
  assert.equal(operations.transport.entrypoint, service.service.entrypoint);
  const workspace = mkdtempSync(path.join(os.tmpdir(), "uci-arena-fake-manager-incidents-"));
  const providerFixture = new LichessStore(path.join(workspace, "matches.sqlite"));
  providerFixture.beginGame({
    id: "manager-game",
    opponent: "fixture-bot",
    audience: "bot",
    color: "white",
    startedAt: 100,
    initialFen: "startpos",
    variant: "standard",
    providerComponent: {
      componentId: "lichess.adapter",
      version: "1.0.24",
      manifestSha256: `sha256:${"a".repeat(64)}`,
    },
  });
  providerFixture.finishGame({
    id: "manager-game",
    status: "aborted",
    result: "",
    winner: "",
    plies: 0,
    finishedAt: 200,
  });
  providerFixture.close();
  const output = execFileSync(runtime, [
    path.join(root, operations.transport.entrypoint),
    ...operation.arguments,
    "--filter", "all",
    "--after-cursor", "0",
    "--limit", "10",
    "--runtime-dir", workspace,
  ], {
    cwd: path.parse(root).root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  const page = JSON.parse(output);
  assert.equal(page.schema, operation.response);
  assert.deepEqual(page.incidents, []);
  assert.equal(page.filter, "all");
  assert.equal(page.retention.maximum_rows, 2048);

  const gamePageOperation = operations.operations.games_list;
  const gamePage = JSON.parse(execFileSync(runtime, [
    path.join(root, operations.transport.entrypoint),
    ...gamePageOperation.arguments,
    "--scope", "history",
    "--limit", "10",
    "--runtime-dir", workspace,
  ], {
    cwd: path.parse(root).root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  }));
  assert.equal(gamePage.schema, gamePageOperation.response);
  assert.deepEqual(gamePage.games.map((game) => game.game_id), ["manager-game"]);

  const gameGetOperation = operations.operations.game_get;
  const game = JSON.parse(execFileSync(runtime, [
    path.join(root, operations.transport.entrypoint),
    ...gameGetOperation.arguments,
    "--game-id", "manager-game",
    "--runtime-dir", workspace,
  ], {
    cwd: path.parse(root).root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  }));
  assert.equal(game.schema, gameGetOperation.response);
  assert.equal(game.game_id, "manager-game");
  assert.deepEqual(game.replay, []);
});

test("installed qualification contract separates authoritative success from bounded failure", () => {
  const operations = JSON.parse(readFileSync(
    path.join(root, "contracts", "manager-operations-schema.json"), "utf8"));
  const schema = JSON.parse(readFileSync(
    path.join(root, "contracts", "qualification-result-schema.json"), "utf8"));
  assert.equal(
    operations.operations.qualification_run.response_schema,
    "contracts/qualification-result-schema.json",
  );
  assert.equal(schema.$id, "uci_arena_lichess_qualification_result_v1");
  assert.equal(schema.oneOf.length, 2);
  const failure = schema.oneOf.find((variant) =>
    variant.properties?.status?.const === "failed");
  assert.deepEqual(failure.required, ["schema", "status", "failure"]);
  assert.equal(failure.additionalProperties, false);
  assert.equal(failure.properties.failure.additionalProperties, false);
  assert.equal(failure.properties.failure.properties.detail.maxLength, 1024);
  assert.equal(failure.properties.failure.properties.detail.pattern, undefined);
});

test("manual workflow uses free OIDC Cosign provenance and no automatic trigger", () => {
  const workflow = readFileSync(path.join(root, ".github", "workflows", "component-release.yml"), "utf8");
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|merge_group|schedule):/m);
  assert.match(workflow, /^  id-token: write$/m);
  assert.match(
    workflow,
    /RELEASE_WORKFLOW_IDENTITY: \$\{\{ github\.workflow_ref \}\}#\$\{\{ github\.run_id \}\}\.\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /--workflow-identity ["']\$\{\{ github\.workflow_ref \}\}["']/u,
  );
  assert.match(workflow, /cosign attest-blob[\s\S]*cosign verify-blob-attestation/u);
  assert.match(workflow, /--certificate-github-workflow-repository/u);
  assert.match(workflow, /provider-attestation\.mjs verify-bundle/u);
  assert.match(workflow, /native\/build-repro/u);
  assert.match(workflow, /Destination native\/lichess_adapter_launcher\.exe/u);
  assert.match(workflow, /native-toolchain-receipt\.mjs/u);
  assert.match(workflow, /dist\/provider-repro/u);
  assert.match(workflow, /Independent component builds differ:/u);
  assert.match(workflow, /first_path=/u);
  assert.match(workflow, /Independent component provider results differ/u);
  assert.match(workflow, /contents:\s*write/u);
  assert.match(workflow, /ephemeral-self-hosted-windows/u);
  for (const label of [
    "self-hosted", "Windows", "X64", "ephemeral", "uci-suite", "lichess-release",
  ]) {
    assert.equal(workflow.includes(`"${label}"`), true);
  }
  assert.doesNotMatch(workflow, /actions\/(?:upload|download)-artifact/u);
  assert.match(workflow, /Expected exactly three candidate assets/u);
  assert.match(workflow, /gh release view[\s\S]*?targetCommitish/u);
  assert.match(workflow, /targetCommitish -ne \$env:GITHUB_SHA/u);
  assert.match(workflow, /assets\)\.Count -ne 0/u);
  assert.match(workflow, /gh release upload/u);
  assert.doesNotMatch(workflow, /gh release create/u);
  assert.ok(workflow.indexOf("provider-attestation.mjs verify-bundle")
    < workflow.indexOf("gh release upload"));
  const nativeCmake = readFileSync(path.join(root, "native", "CMakeLists.txt"), "utf8");
  assert.match(nativeCmake, /target_link_options\(lichess_adapter_launcher PRIVATE \/Brepro\)/u);
  assert.doesNotMatch(workflow, /actions\/attest-build-provenance|attestations:\s*write/u);
});

test("provider attestation binds and verifies the exact in-toto payload", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "uci-arena-lichess-attestation-"));
  const output = path.join(directory, "output");
  const statements = path.join(directory, "statements");
  mkdirSync(output);
  const artifactName = "lichess.adapter-1.0.3-windows-x86_64.tar.gz";
  const artifact = Buffer.from("exact-provider-artifact");
  writeFileSync(path.join(output, artifactName), artifact);
  writeFileSync(path.join(output, `${artifactName}.provider-result.json`), JSON.stringify({
    schema: "arena_provider_release_result_v1",
    component_id: "lichess.adapter",
    component_version: "1.0.3",
    target_triple: "windows-x86_64",
    artifact_name: artifactName,
    artifact_sha256: createHash("sha256").update(artifact).digest("hex"),
  }));
  const prepared = JSON.parse(execFileSync(process.execPath, [
    path.join(root, "tools", "provider-attestation.mjs"),
    "prepare",
    "--output-dir",
    output,
    "--statement-dir",
    statements,
  ], { encoding: "utf8", windowsHide: true }));
  const statement = readFileSync(prepared.statement_path);
  writeFileSync(prepared.bundle_path, JSON.stringify({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: statement.toString("base64"),
      signatures: [{ sig: "synthetic-signature-for-payload-test" }],
    },
  }));
  assert.match(execFileSync(process.execPath, [
    path.join(root, "tools", "provider-attestation.mjs"),
    "verify-bundle",
    "--bundle",
    prepared.bundle_path,
    "--statement",
    prepared.statement_path,
  ], { encoding: "utf8", windowsHide: true }), /verified/);
  const tampered = JSON.parse(statement);
  tampered.subject[0].digest.sha256 = "0".repeat(64);
  writeFileSync(prepared.statement_path, JSON.stringify(tampered));
  const rejected = spawnSync(process.execPath, [
    path.join(root, "tools", "provider-attestation.mjs"),
    "verify-bundle",
    "--bundle",
    prepared.bundle_path,
    "--statement",
    prepared.statement_path,
  ], { encoding: "utf8", windowsHide: true });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /signed payload differs/);
});
