#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { readAndValidateNativeToolchainReceipt } from "./native-toolchain-receipt.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const forbiddenParts = new Set([".git", "secrets", "runtime_state", "node_modules", "dist"]);

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${flag ?? "<end>"}`);
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filename) {
  return sha256(readFileSync(filename));
}

function safeRelative(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || path.isAbsolute(value)
      || parts.some((part) => !part || part === "." || part === ".." || forbiddenParts.has(part))) {
    throw new Error(`unsafe component path: ${value}`);
  }
  return normalized;
}

function listFiles(directory, relative = "") {
  const rows = [];
  for (const name of readdirSync(path.join(directory, relative)).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const absolute = path.join(directory, child);
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new Error(`component symlink is forbidden: ${child}`);
    if (entry.isDirectory()) rows.push(...listFiles(directory, child));
    else if (entry.isFile()) rows.push(child.replaceAll("\\", "/"));
    else throw new Error(`unsupported component entry: ${child}`);
  }
  return rows;
}

function copyTree(source, destination) {
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) throw new Error(`source symlink is forbidden: ${source}`);
  if (entry.isFile()) {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return;
  }
  if (!entry.isDirectory()) throw new Error(`unsupported source entry: ${source}`);
  for (const relative of listFiles(source)) {
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(source, relative), target);
  }
}

function git(args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function sourceIdentity() {
  const tree = git(["ls-tree", "-r", "--full-tree", "HEAD"]);
  return {
    commit: git(["rev-parse", "HEAD"]),
    clean: git(["status", "--porcelain"]).length === 0,
    tree_sha256: sha256(Buffer.from(tree, "utf8")),
  };
}

function writeOctal(buffer, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`tar numeric field overflow: ${value}`);
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function splitTarPath(relative) {
  if (Buffer.byteLength(relative) <= 100) return { name: relative, prefix: "" };
  for (let index = relative.lastIndexOf("/"); index > 0;
    index = relative.lastIndexOf("/", index - 1)) {
    const prefix = relative.slice(0, index);
    const name = relative.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`component path is too long for ustar: ${relative}`);
}

function tarHeader(relative, size, mode, epoch) {
  const { name, prefix } = splitTarPath(relative);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, epoch);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function deterministicTarGz(staging, epoch) {
  const chunks = [];
  for (const relative of listFiles(staging)) {
    const bytes = readFileSync(path.join(staging, relative));
    const mode = relative.endsWith(".mjs") || relative.endsWith(".exe") ? 0o755 : 0o644;
    chunks.push(tarHeader(relative, bytes.length, mode, epoch), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function integrityChecksum(value) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(value ?? "");
  return match ? Buffer.from(match[1], "base64").toString("hex") : null;
}

function spdxFromLock(lock, component, epoch) {
  const packages = [];
  for (const [location, details] of Object.entries(lock.packages ?? {})) {
    if (!location || !details?.name || !details?.version) continue;
    const checksum = integrityChecksum(details.integrity);
    packages.push({
      SPDXID: `SPDXRef-Package-${packages.length + 1}`,
      name: details.name,
      versionInfo: details.version,
      downloadLocation: details.resolved ?? "NOASSERTION",
      checksums: checksum ? [{ algorithm: "SHA512", checksumValue: checksum }] : [],
      licenseConcluded: details.license ?? "NOASSERTION",
    });
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${component.component_id}-${component.version}`,
    documentNamespace: `https://uci-arena.example/sbom/${component.component_id}/${component.version}`,
    creationInfo: {
      created: new Date(epoch * 1000).toISOString().replace(".000Z", "Z"),
      creators: ["Tool: uci-arena-lichess-bot-release-v1"],
    },
    packages,
  };
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${label} must be an array of nonempty strings`);
  }
  return [...value];
}

function installerManifest(componentContract, version, target, staging) {
  const installation = componentContract.installation;
  if (componentContract.schema !== "uci_arena_component_manifest_v1"
      || componentContract.component?.id !== "lichess.adapter"
      || componentContract.component?.version !== version
      || componentContract.component?.repository !== "iteathen/uci-arena-lichess-bot"
      || installation?.install_manifest_schema !== "arena_install_component_v1"
      || typeof installation.contract_manifest !== "string"
      || typeof installation.configuration_template !== "string"
      || typeof installation.workspace_name !== "string"
      || !/^[A-Za-z0-9._-]+$/u.test(installation.workspace_name)
      || installation.startup?.credential_gated !== true) {
    throw new Error("component contract cannot produce an Installer manifest");
  }
  const entrypoints = Object.fromEntries(Object.entries(installation.entrypoints ?? {})
    .map(([name, relative]) => [name, safeRelative(relative)]));
  if (!entrypoints.cli || !entrypoints.adapter || !entrypoints.startup
      || !entrypoints.installer_integration) {
    throw new Error("component contract is missing required Installer entrypoints");
  }
  const dependencies = stringArray(installation.dependencies, "installation.dependencies");
  const installerIntegration = structuredClone(installation.installer_integration);
  if (installerIntegration?.schema !== "arena_provider_installer_integration_v1"
      || installerIntegration.schema_version !== 1
      || installerIntegration.entrypoint !== "installer_integration"
      || JSON.stringify(installerIntegration.arguments) !== JSON.stringify(["--context"])
      || installerIntegration.workspace_name !== installation.workspace_name
      || installerIntegration.configure_when_disabled !== true
      || installerIntegration.invocation?.kind !== "dependency_runtime"
      || !dependencies.includes(installerIntegration.invocation.runtime_component_id)
      || !/^[A-Za-z0-9._-]+$/u.test(
        installerIntegration.invocation.runtime_entrypoint ?? "",
      )
      || !Array.isArray(installerIntegration.dependency_bindings)
      || !Array.isArray(installerIntegration.locator_bindings)) {
    throw new Error("component installer-integration contract is invalid");
  }
  const contractManifest = safeRelative(installation.contract_manifest);
  const configurationTemplate = safeRelative(installation.configuration_template);
  const files = listFiles(staging).map((relative) => {
    const absolute = path.join(staging, relative);
    return {
      path: relative,
      sha256: sha256File(absolute),
      size_bytes: statSync(absolute).size,
    };
  });
  const owned = new Set(files.map((file) => file.path));
  for (const relative of [...Object.values(entrypoints), contractManifest, configurationTemplate]) {
    if (!owned.has(relative)) throw new Error(`Installer contract path is absent: ${relative}`);
  }
  return {
    schema: "arena_install_component_v1",
    schema_version: 1,
    component_id: componentContract.component.id,
    component_version: version,
    target_triple: target,
    entrypoints,
    contract_manifest: contractManifest,
    capabilities: stringArray(installation.capabilities, "installation.capabilities"),
    dependencies,
    installer_integration: installerIntegration,
    startup: installation.startup,
    data_paths: stringArray(installation.data_paths, "installation.data_paths"),
    workspace_name: installation.workspace_name,
    configuration_template: configurationTemplate,
    files,
  };
}

function build(args) {
  const definitionPath = path.resolve(args.definition ?? path.join(root, "packaging/component-definition.json"));
  const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
  const packageManifest = JSON.parse(readFileSync(path.join(root, definition.package_json), "utf8"));
  const componentContractPath = path.join(root, definition.component_manifest);
  const componentContract = JSON.parse(readFileSync(componentContractPath, "utf8"));
  const version = args.version ?? packageManifest.version;
  const target = args.target;
  if (definition.schema !== "uci_arena_component_definition_v1"
      || definition.component_id !== "lichess.adapter"
      || version !== packageManifest.version
      || !/^(?:windows|linux)-x86_64$/u.test(target ?? "")) {
    throw new Error("invalid component definition, version, or target");
  }
  const identity = sourceIdentity();
  if (!identity.clean && args["allow-dirty"] !== "true") {
    throw new Error("official component release requires a clean worktree");
  }
  const receiptPath = path.resolve(args["test-receipt"] ?? "");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.schema !== "uci_arena_component_test_receipt_v1"
      || receipt.component_id !== definition.component_id
      || receipt.component_version !== version
      || receipt.target !== target
      || receipt.source_commit !== identity.commit
      || receipt.source_tree_sha256 !== identity.tree_sha256
      || receipt.passed !== true) {
    throw new Error("test receipt does not authorize this exact component source and target");
  }
  const workflowIdentity = args["workflow-identity"] ?? "local-development";
  const nativeToolchainRequired = definition.native_toolchain_by_target?.[target] !== undefined;
  let nativeToolchainEvidence;
  let nativeReceiptPath;
  if (nativeToolchainRequired) {
    if (!args["native-toolchain-receipt"]) {
      throw new Error("native provider components require an exact toolchain receipt");
    }
    nativeReceiptPath = path.resolve(args["native-toolchain-receipt"]);
    nativeToolchainEvidence = readAndValidateNativeToolchainReceipt({
      filename: nativeReceiptPath,
      definition,
      target,
      sourceCommit: identity.commit,
      workflowIdentity,
    });
  } else if (args["native-toolchain-receipt"]) {
    throw new Error("non-native provider component received a native toolchain receipt");
  }
  const output = path.resolve(args["output-dir"] ?? path.join(root, "dist"));
  if (output === root || !output.startsWith(`${root}${path.sep}`)) {
    throw new Error("component output must be a contained repository directory");
  }
  const basename = `${definition.component_id}-${version}-${target}`;
  const staging = path.join(output, basename);
  const artifact = path.join(output, `${basename}.tar.gz`);
  rmSync(staging, { recursive: true, force: true });
  rmSync(artifact, { force: true });
  mkdirSync(staging, { recursive: true });
  for (const mapping of definition.include) {
    const sourceRelative = safeRelative(mapping.source);
    const targetRelative = safeRelative(mapping.target);
    const source = path.join(root, sourceRelative);
    if (!existsSync(source)) throw new Error(`required component source is missing: ${sourceRelative}`);
    copyTree(source, path.join(staging, targetRelative));
  }
  const native = definition.native_launcher?.[target];
  if (native?.required) {
    if (!args["native-launcher"] || !existsSync(path.resolve(args["native-launcher"]))) {
      throw new Error(`${target} requires --native-launcher`);
    }
    copyTree(path.resolve(args["native-launcher"]), path.join(staging, safeRelative(native.target)));
  }
  const runtimePackage = {
    name: packageManifest.name,
    version,
    private: true,
    type: "module",
    engines: packageManifest.engines,
    dependencies: packageManifest.dependencies,
  };
  writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  copyFileSync(path.join(root, "package-lock.json"), path.join(staging, "package-lock.json"));
  const adjacentNpmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const npmArguments = ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"];
  execFileSync(existsSync(adjacentNpmCli) ? process.execPath : "npm", [
    ...(existsSync(adjacentNpmCli) ? [adjacentNpmCli] : []),
    ...npmArguments,
  ], { cwd: staging, stdio: "inherit", windowsHide: true });
  const linkedContract = path.join(staging, "node_modules", "@uci-arena", "time-profile-contract");
  if (existsSync(linkedContract) && lstatSync(linkedContract).isSymbolicLink()) {
    rmSync(linkedContract, { recursive: true, force: true });
    copyTree(path.join(staging, "vendor", "time-profile-contract"), linkedContract);
  }
  const releaseDirectory = path.join(staging, "release");
  mkdirSync(releaseDirectory, { recursive: true });
  copyFileSync(definitionPath, path.join(releaseDirectory, "component-definition.json"));
  copyFileSync(receiptPath, path.join(releaseDirectory, "test-receipt.json"));
  if (nativeReceiptPath) {
    copyFileSync(nativeReceiptPath, path.join(releaseDirectory, "native-toolchain-receipt.json"));
  }
  const lock = JSON.parse(readFileSync(path.join(staging, "package-lock.json"), "utf8"));
  const epoch = Number(args["source-date-epoch"] ?? git(["show", "-s", "--format=%ct", "HEAD"]));
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error("invalid source-date-epoch");
  writeFileSync(path.join(releaseDirectory, "sbom.spdx.json"), `${JSON.stringify(
    spdxFromLock(lock, { component_id: definition.component_id, version }, epoch), null, 2,
  )}\n`);
  const provenance = {
    schema: "uci_arena_component_provenance_v1",
    component_id: definition.component_id,
    version,
    target,
    source: identity,
    definition_sha256: sha256File(definitionPath),
    product_component_manifest_sha256: sha256File(componentContractPath),
    test_receipt_sha256: sha256File(receiptPath),
    ...(nativeToolchainEvidence
      ? { native_toolchain_receipt_sha256: nativeToolchainEvidence.sha256 }
      : {}),
    workflow_identity: workflowIdentity,
  };
  writeFileSync(path.join(releaseDirectory, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  const checksums = Object.fromEntries(listFiles(staging)
    .filter((relative) => relative !== "release/checksums.json")
    .map((relative) => [relative, sha256File(path.join(staging, relative))]));
  writeFileSync(path.join(releaseDirectory, "checksums.json"), `${JSON.stringify({
    schema: "uci_arena_component_checksums_v1",
    files: checksums,
  }, null, 2)}\n`);
  const installManifest = installerManifest(componentContract, version, target, staging);
  writeFileSync(
    path.join(staging, "arena-component.json"),
    `${JSON.stringify(installManifest, null, 2)}\n`,
  );
  listFiles(staging);
  writeFileSync(artifact, deterministicTarGz(staging, epoch));
  const licenseFiles = listFiles(staging)
    .filter((relative) => /(?:^|\/)(?:LICENSE|COPYING)(?:\.|$)/iu.test(relative));
  if (licenseFiles.length === 0) throw new Error("component payload has no license evidence");
  const licensesSha256 = sha256(Buffer.concat(
    licenseFiles.map((relative) => readFileSync(path.join(staging, relative))),
  ));
  const result = {
    schema: "arena_provider_release_result_v1",
    component_id: definition.component_id,
    component_version: version,
    target_triple: target,
    artifact_name: path.basename(artifact),
    artifact_sha256: sha256File(artifact),
    artifact_size_bytes: statSync(artifact).size,
    component_manifest_sha256: sha256File(path.join(staging, "arena-component.json")),
    source_repository: definition.source_repository,
    source_commit: identity.commit,
    source_tree_sha256: identity.tree_sha256,
    clean_tree: identity.clean,
    release_authority: "provider_component_only",
    suite_installer_authority: "iteathen/uci-arena-installer",
    workflow_identity: workflowIdentity,
    toolchain_identity: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      ...(nativeToolchainEvidence ? {
        native_receipt_sha256: nativeToolchainEvidence.sha256,
        native_builds: nativeToolchainEvidence.receipt.builds,
      } : {}),
    },
    dependency_lock_identities: {
      package_lock_sha256: sha256File(path.join(staging, "package-lock.json")),
      time_profile_contract_sha256: sha256File(
        path.join(staging, "vendor", "time-profile-contract", "package.json"),
      ),
    },
    build_flags: ["npm ci --ignore-scripts --omit=dev --no-audit --no-fund"],
    sbom_sha256: sha256File(path.join(releaseDirectory, "sbom.spdx.json")),
    licenses_sha256: licensesSha256,
    test_receipt_sha256: sha256File(receiptPath),
    tests: Array.isArray(receipt.tests) && receipt.tests.length > 0
      ? receipt.tests
      : [{ command: receipt.command, passed: receipt.passed, exit_code: receipt.exit_code }],
  };
  const resultPath = path.join(output, `${basename}.provider-result.json`);
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ artifact, result: resultPath, ...result })}\n`);
}

try {
  build(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`component release failed: ${error.message}\n`);
  process.exitCode = 1;
}
