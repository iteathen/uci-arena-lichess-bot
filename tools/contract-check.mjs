#!/usr/bin/env node

import { readFileSync } from "node:fs";
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
const qualificationResult = readJson("contracts/qualification-result-schema.json");
const template = readFileSync(path.join(root, "config.uci_arena.template.yml"), "utf8");
const errors = [];

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
    || !service.required_capabilities?.includes("uci.engine.process")) {
  errors.push("Installer component projection is incomplete or inconsistent");
}
const startupControl = component.installation?.installer_integration?.startup_control;
if (startupControl?.schema !== "arena_provider_startup_control_v2"
    || startupControl.schema_version !== 2
    || JSON.stringify(startupControl.actions?.install) !== JSON.stringify(["startup", "install"])
    || JSON.stringify(startupControl.actions?.uninstall) !== JSON.stringify(["startup", "uninstall"])
    || JSON.stringify(startupControl.actions?.pre_replace)
      !== JSON.stringify(["startup", "prepare_replace"])
    || JSON.stringify(startupControl.actions?.post_replace)
      !== JSON.stringify(["startup", "complete_replace"])
    || startupControl.replacement_arguments?.previous_root !== "--previous-root"
    || startupControl.replacement_arguments?.replacement_root !== "--replacement-root"
    || startupControl.result?.require_live_on_post_replace !== false
    || startupControl.result?.allow_deferred_requalification_on_post_replace !== true) {
  errors.push("Installer startup-control v2 projection is incomplete");
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
  "startup_install", "startup_status", "startup_uninstall",
]);
if (operations.schema !== "uci_arena_lichess_manager_api_v1"
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
if (status.properties?.schema?.const !== "uci_arena_lichess_status_v3") {
  errors.push("status projection schema is incompatible");
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
for (const group of ["capacity", "games", "scheduler", "rate_limit"]) {
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
