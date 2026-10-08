#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadManagerConfig,
  managerOptionsProjection,
  providerStatusProjection,
} from "../lichess-adapter.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const component = readJson("contracts/component-manifest.json");
const service = readJson("contracts/service-contract.json");
const operations = readJson("contracts/manager-operations-schema.json");
const configuration = readJson("contracts/configuration-schema.json");
const configurationUpdate = readJson("contracts/configuration-update-schema.json");
const status = readJson("contracts/status-schema.json");
const incidentPage = readJson("contracts/incident-page-schema.json");
const gamePage = readJson("contracts/game-page-schema.json");
const gameDetail = readJson("contracts/game-detail-schema.json");
const qualificationResult = readJson("contracts/qualification-result-schema.json");
const template = readFileSync(path.join(root, "config.uci_arena.template.yml"), "utf8");
const errors = [];
const launchBindings = component.installation?.installer_integration?.dependency_bindings ?? [];
const launchProfileBinding = launchBindings.find((binding) => binding.name === 'default_engine_launch_profile');
const launchManifestBinding = launchBindings.find((binding) => binding.name === 'default_engine_launch_manifest');
if (!launchProfileBinding || !launchManifestBinding
    || launchProfileBinding.component_id !== launchManifestBinding.component_id
    || launchProfileBinding.source !== 'entrypoint'
    || launchProfileBinding.entrypoint !== 'uci_launch_profile'
    || launchProfileBinding.required !== false
    || launchManifestBinding.source !== 'component_path'
    || launchManifestBinding.path !== 'arena-component.json'
    || launchManifestBinding.required !== false) {
  errors.push('optional managed standard engine launch bindings are incomplete');
}

const diagnosticPin = readJson("contracts/continuous-game-diagnostic.upstream.json");
if (diagnosticPin.schema !== "uci_arena_public_contract_snapshot_v1"
    || diagnosticPin.source_repository !== "iteathen/uci-arena-engine"
    || !/^[0-9a-f]{40}$/.test(diagnosticPin.source_commit)
    || diagnosticPin.encoding !== "utf8_lf_git_blob") {
  errors.push("continuous diagnostic public provenance is invalid");
}
const expectedPublicCopies = ["contracts/continuous-game-diagnostic.schema.json", "contracts/continuous-game-diagnostic-source-closure.v1.json"];
if (JSON.stringify(Object.keys(diagnosticPin.files ?? {}).sort()) !== JSON.stringify([...expectedPublicCopies].sort())) {
  errors.push("continuous diagnostic public snapshot closure differs");
}
for (const file of expectedPublicCopies) {
  const binding = diagnosticPin.files?.[file];
  const canonical = readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n");
  const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (binding?.upstream_path !== file || binding?.sha256 !== sha256) {
    errors.push(`continuous diagnostic public Git blob snapshot differs: ${file}`);
  }
}
const diagnosticSchema = readJson(expectedPublicCopies[0]);
const sourceClosure = readJson(expectedPublicCopies[1]);
if (diagnosticSchema.$id !== "uci_continuous_complete_game_diagnostic_v1"
    || diagnosticSchema.additionalProperties !== false
    || sourceClosure.schema !== "uci_continuous_diagnostic_source_closure_v1"
    || sourceClosure.entrypoint !== "arena/run_complete_game_matrix.mjs"
    || JSON.stringify(Object.keys(sourceClosure).sort()) !== JSON.stringify(["entrypoint", "required_source_paths", "schema"])
    || !Array.isArray(sourceClosure.required_source_paths)
    || new Set(sourceClosure.required_source_paths).size !== sourceClosure.required_source_paths.length
    || JSON.stringify(sourceClosure.required_source_paths) !== JSON.stringify([...sourceClosure.required_source_paths].sort())
    || !sourceClosure.required_source_paths.includes(sourceClosure.entrypoint)
    || !expectedPublicCopies.every((file) => sourceClosure.required_source_paths.includes(file))) {
  errors.push("continuous diagnostic public owner schema/source declaration is incompatible");
}
if (readJson("vendor/time-profile-contract/package.json").version !== "1.5.0") {
  errors.push("continuous searched-regime adapter requires public time-profile contract 1.5.0");
}

function exactKeys(value, schema, label) {
  const expected = [...(schema.required ?? [])].sort();
  const observed = Object.keys(value ?? {}).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    errors.push(`${label} keys differ: expected ${expected.join(",")}; observed ${observed.join(",")}`);
  }
}

function localSchema(document, schema) {
  const reference = schema?.$ref;
  if (!reference?.startsWith("#/$defs/")) return schema;
  return document.$defs?.[reference.slice("#/$defs/".length)];
}

if (component.schema !== "uci_arena_component_manifest_v1") {
  errors.push("component manifest schema is incompatible");
}
if (component.component?.id !== service.service?.component_id) {
  errors.push("component and service ids differ");
}
if (component.component?.version !== readJson("package.json").version) {
  errors.push("component and package versions differ");
}
if (service.service?.component_version !== component.component?.version) {
  errors.push("service and component versions differ");
}
if (component.installation?.install_manifest_schema !== "arena_install_component_v1"
    || component.installation?.contract_manifest !== "contracts/service-contract.json"
    || component.installation?.configuration_template !== "config.uci_arena.template.yml"
    || component.installation?.workspace_name !== "lichess-adapter"
    || component.installation?.startup?.credential_gated !== true
    || component.installation?.entrypoints?.cli !== service.service?.entrypoint
    || !component.installation?.dependencies?.includes("node_runtime.private")
    || component.installation?.dependencies?.includes("uci_arena.engine")
    || !component.compatibility?.required_capabilities?.includes("uci.engine.process")
    || !component.compatibility?.compatible_default_components?.includes("uci_arena.engine")
    || !service.required_capabilities?.includes("uci.engine.process")
    || !service.provided_capabilities?.includes("lichess.provider_games")
    || !component.installation?.capabilities?.includes("provider_games")) {
  errors.push("Installer component projection is incomplete or inconsistent");
}
const startupControl = component.installation?.installer_integration?.startup_control;
const defaultEngineManifestBinding = component.installation?.installer_integration
  ?.dependency_bindings?.find((binding) => binding.name === "default_engine_manifest");
if (defaultEngineManifestBinding?.component_id !== "uci_arena.engine"
    || defaultEngineManifestBinding.source !== "component_path"
    || defaultEngineManifestBinding.path !== "arena-component.json"
    || defaultEngineManifestBinding.required !== false) {
  errors.push("optional Engine component-manifest binding is incomplete");
}
if (startupControl?.schema !== "arena_provider_startup_control_v3"
    || startupControl.schema_version !== 3
    || JSON.stringify(startupControl.operations?.install?.arguments)
      !== JSON.stringify(["startup", "install", "--lifecycle-result", "typed_v1"])
    || JSON.stringify(startupControl.operations?.install?.success_dispositions)
      !== JSON.stringify(["ready"])
    || JSON.stringify(startupControl.operations?.uninstall?.arguments)
      !== JSON.stringify(["startup", "uninstall", "--lifecycle-result", "typed_v1"])
    || JSON.stringify(startupControl.operations?.uninstall?.success_dispositions)
      !== JSON.stringify(["ready"])
    || JSON.stringify(startupControl.operations?.pre_replace?.arguments)
      !== JSON.stringify(["startup", "prepare_replace", "--lifecycle-result", "typed_v1"])
    || JSON.stringify(startupControl.operations?.pre_replace?.success_dispositions)
      !== JSON.stringify(["ready"])
    || JSON.stringify(startupControl.operations?.post_replace?.arguments)
      !== JSON.stringify(["startup", "complete_replace", "--lifecycle-result", "typed_v1"])
    || JSON.stringify(startupControl.operations?.post_replace?.success_dispositions)
      !== JSON.stringify(["ready", "safe_inactive"])
    || startupControl.replacement_arguments?.previous_root !== "--previous-root"
    || startupControl.replacement_arguments?.replacement_root !== "--replacement-root") {
  errors.push("Installer startup-control v3 projection is incomplete");
}
if (service.startup?.credential_gated !== true
    || service.persistence?.upgrade !== "preserve_and_migrate"
    || service.persistence?.repair !== "preserve"
    || service.persistence?.uninstall_default !== "preserve") {
  errors.push("service startup or persistence ownership is incomplete");
}
if (service.invocation?.kind !== "dependency_runtime"
    || service.invocation?.runtime_component_id !== "node_runtime.private"
    || service.invocation?.runtime_entrypoint !== "node"
    || !component.installation?.dependencies?.includes(
      service.invocation.runtime_component_id,
    )) {
  errors.push("service invocation runtime is incomplete or undeclared");
}
const requiredOperations = new Set([
  "account_probe", "config_get", "config_update", "owner_add", "owner_list",
  "owner_remove", "provider_status", "reservation_cancel", "reservation_create",
  "reservation_status", "scheduler_pause", "scheduler_resume", "scheduler_status",
  "startup_install", "startup_recover", "startup_status", "startup_uninstall",
  "game_get", "games_list", "incidents_list",
]);
if (operations.schema !== "uci_arena_lichess_manager_api_v1"
    || operations.version !== "1.1"
    || [...requiredOperations].some((name) => !operations.operations?.[name])) {
  errors.push("Manager operation catalog is missing required operations");
}
for (const [name, operation] of Object.entries(operations.operations ?? {})) {
  if (!Array.isArray(operation.arguments) || operation.arguments.length === 0
      || !["forbidden", "external_file_path_only"].includes(operation.credential)) {
    errors.push(`Manager operation ${name} has an invalid boundary`);
  }
}
if (configuration.properties?.schema?.const !== "uci_arena_lichess_manager_options_v1") {
  errors.push("configuration projection schema is incompatible");
}
const capacityEvidenceStatuses = configuration.properties?.capacity
  ?.properties?.evidence?.properties?.status?.enum ?? [];
for (const expected of [
  "legacy_shared",
  "standard_uci_startup_probe_required",
  "runtime_revalidation_required",
  "missing",
  "qualified",
  "rejected",
]) {
  if (!capacityEvidenceStatuses.includes(expected)) {
    errors.push(`configuration projection omits capacity evidence status ${expected}`);
  }
}
if (configurationUpdate.required?.[0] !== "settings"
    || configurationUpdate.properties?.settings?.additionalProperties !== false) {
  errors.push("configuration update schema is not a closed settings request");
}
if (status.properties?.schema?.const !== "uci_arena_lichess_status_v5") {
  errors.push("status projection schema is incompatible");
}
if (service.service?.contract_version !== "1.1"
    || JSON.stringify(operations.operations?.incidents_list?.arguments)
      !== JSON.stringify(["incidents", "list"])
    || operations.operations?.incidents_list?.mutates !== false
    || operations.operations?.incidents_list?.credential !== "forbidden") {
  errors.push("provider incident operation boundary is incomplete");
}
if (service.incident_page_schema !== "contracts/incident-page-schema.json"
    || component.contracts?.incident_page !== service.incident_page_schema
    || operations.operations?.incidents_list?.response_schema !== service.incident_page_schema
    || operations.operations?.incidents_list?.response !== incidentPage.$id
    || incidentPage.$id !== "uci_arena_provider_incident_page_v1") {
  errors.push("provider incident contract bindings differ");
}
if (service.game_page_schema !== "contracts/game-page-schema.json"
    || service.game_detail_schema !== "contracts/game-detail-schema.json"
    || component.contracts?.game_page !== service.game_page_schema
    || component.contracts?.game_detail !== service.game_detail_schema
    || operations.operations?.games_list?.response_schema !== service.game_page_schema
    || operations.operations?.game_get?.response_schema !== service.game_detail_schema
    || operations.operations?.games_list?.response !== gamePage.$id
    || operations.operations?.game_get?.response !== gameDetail.$id
    || gamePage.$id !== "uci_arena_provider_game_page_v1"
    || gameDetail.$id !== "uci_arena_provider_game_v1"
    || gamePage.additionalProperties !== false
    || gameDetail.additionalProperties !== false
    || gamePage.$defs?.game_summary?.additionalProperties !== false) {
  errors.push("provider game contract bindings differ");
}
if (service.configuration_update_schema !== "contracts/configuration-update-schema.json"
    || component.contracts?.configuration_update !== service.configuration_update_schema
    || operations.operations?.config_update?.request !== service.configuration_update_schema) {
  errors.push("configuration update contract bindings differ");
}
if (service.qualification_result_schema !== "contracts/qualification-result-schema.json"
    || component.contracts?.qualification_result !== service.qualification_result_schema
    || operations.operations?.qualification_run?.response_schema
      !== service.qualification_result_schema
    || qualificationResult.$id !== "uci_arena_lichess_qualification_result_v1"
    || qualificationResult.oneOf?.length !== 2) {
  errors.push("installed qualification result contract bindings differ");
}
const projectedConfiguration = managerOptionsProjection(loadManagerConfig({
  templatePath: path.join(root, "config.uci_arena.template.yml"),
  engineRoot: root,
}));
exactKeys(projectedConfiguration, configuration, "configuration projection");
for (const group of configuration.required.filter((name) => name !== "schema")) {
  exactKeys(
    projectedConfiguration[group],
    localSchema(configuration, configuration.properties[group]),
    `configuration projection ${group}`,
  );
}
const projectedStatus = providerStatusProjection();
exactKeys(projectedStatus, status, "provider status");
for (const group of ["capacity", "games", "scheduler", "rate_limit", "supervision", "incidents"]) {
  exactKeys(projectedStatus[group], status.properties[group], `provider status ${group}`);
}
exactKeys(
  projectedStatus.capacity.slots,
  status.$defs.slot_counts,
  "provider status capacity.slots",
);
if (!component.runtime?.health_checks?.some((check) =>
  check.type === "typed_cli_json"
  && JSON.stringify(check.arguments) === JSON.stringify(["status"])
  && check.credential_required === false)) {
  errors.push("component health check must use credential-free provider status");
}
if (template.includes("<UCI_ARENA_REPO>")
    || template.includes("/build/Release/")
    || template.includes("compact_chessformer_gab_v1")) {
  errors.push("tracked configuration leaks a former source tree or model codename");
}
if (!template.includes("<UCI_ARENA_ENGINE_ROOT>/bin/uci_arena_engine.exe")
    || !template.includes("models/latticeknight")) {
  errors.push("tracked configuration lacks the installed engine contract and LatticeKnight default");
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("lichess-bot contracts: pass\n");
