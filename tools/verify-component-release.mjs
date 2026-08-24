#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { readAndValidateNativeToolchainReceipt } from "./native-toolchain-receipt.mjs";

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

function sha256File(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(root, relative = "") {
  const rows = [];
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const entry = lstatSync(path.join(root, child));
    if (entry.isSymbolicLink()) throw new Error(`release symlink is forbidden: ${child}`);
    if (entry.isDirectory()) rows.push(...listFiles(root, child));
    else if (entry.isFile()) rows.push(child.replaceAll("\\", "/"));
    else throw new Error(`unsupported release entry: ${child}`);
  }
  return rows;
}

function verify(args) {
  const root = path.resolve(args.root ?? "");
  const artifact = path.resolve(args.artifact ?? "");
  const result = JSON.parse(readFileSync(path.resolve(args.result ?? ""), "utf8"));
  if (result.schema !== "arena_provider_release_result_v1"
      || result.component_id !== "lichess.adapter"
      || result.release_authority !== "provider_component_only"
      || result.suite_installer_authority !== "iteathen/uci-arena-installer"
      || result.artifact_sha256 !== sha256File(artifact)
      || result.artifact_size_bytes !== statSync(artifact).size) {
    throw new Error("release result does not bind the exact component artifact");
  }
  const manifest = JSON.parse(readFileSync(path.join(root, "contracts", "component-manifest.json"), "utf8"));
  if (manifest.component?.id !== result.component_id
      || manifest.component?.version !== result.component_version
      || manifest.component?.repository !== result.source_repository
      || manifest.runtime?.entrypoint !== "lichess-adapter.mjs") {
    throw new Error("payload component manifest does not match release result");
  }
  const installManifestPath = path.join(root, "arena-component.json");
  const installManifest = JSON.parse(readFileSync(installManifestPath, "utf8"));
  if (installManifest.schema !== "arena_install_component_v1"
      || installManifest.schema_version !== 1
      || installManifest.component_id !== result.component_id
      || installManifest.component_version !== result.component_version
      || installManifest.target_triple !== result.target_triple
      || installManifest.contract_manifest !== "contracts/service-contract.json"
      || installManifest.configuration_template !== "config.uci_arena.template.yml"
      || installManifest.workspace_name !== "lichess-adapter"
      || installManifest.startup?.credential_gated !== true
      || result.component_manifest_sha256 !== sha256File(installManifestPath)) {
    throw new Error("Installer component manifest does not match release result");
  }
  const definitionPath = path.join(root, "release", "component-definition.json");
  const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
  if (definition.schema !== "uci_arena_component_definition_v1"
      || definition.component_id !== result.component_id
      || definition.component_manifest !== "contracts/component-manifest.json") {
    throw new Error("payload component definition is incompatible");
  }
  const nativeReceiptPath = path.join(root, "release", "native-toolchain-receipt.json");
  const nativeToolchainRequired = definition.native_toolchain_by_target?.[result.target_triple]
    !== undefined;
  let nativeToolchainEvidence;
  if (nativeToolchainRequired) {
    if (!existsSync(nativeReceiptPath)) {
      throw new Error("native component lacks its exact toolchain receipt");
    }
    nativeToolchainEvidence = readAndValidateNativeToolchainReceipt({
      filename: nativeReceiptPath,
      definition,
      target: result.target_triple,
      sourceCommit: result.source_commit,
      workflowIdentity: result.workflow_identity,
    });
  } else if (existsSync(nativeReceiptPath)) {
    throw new Error("non-native component contains unexpected toolchain evidence");
  }
  const receiptPath = path.join(root, "release", "test-receipt.json");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const provenance = JSON.parse(readFileSync(path.join(root, "release", "provenance.json"), "utf8"));
  if (provenance.schema !== "uci_arena_component_provenance_v1"
      || provenance.component_id !== result.component_id
      || provenance.version !== result.component_version
      || provenance.target !== result.target_triple
      || provenance.source?.commit !== result.source_commit
      || provenance.source?.tree_sha256 !== result.source_tree_sha256
      || provenance.source?.clean !== result.clean_tree
      || provenance.definition_sha256 !== sha256File(definitionPath)
      || provenance.product_component_manifest_sha256
        !== sha256File(path.join(root, definition.component_manifest))
      || provenance.test_receipt_sha256 !== sha256File(receiptPath)
      || result.test_receipt_sha256 !== provenance.test_receipt_sha256
      || (nativeToolchainEvidence
        && (provenance.native_toolchain_receipt_sha256 !== nativeToolchainEvidence.sha256
          || result.toolchain_identity?.native_receipt_sha256 !== nativeToolchainEvidence.sha256
          || JSON.stringify(result.toolchain_identity?.native_builds)
            !== JSON.stringify(nativeToolchainEvidence.receipt.builds)))
      || (!nativeToolchainEvidence
        && (provenance.native_toolchain_receipt_sha256 !== undefined
          || result.toolchain_identity?.native_receipt_sha256 !== undefined
          || result.toolchain_identity?.native_builds !== undefined))) {
    throw new Error("payload provenance does not bind the release inputs and result");
  }
  if (receipt.schema !== "uci_arena_component_test_receipt_v1"
      || receipt.component_id !== result.component_id
      || receipt.component_version !== result.component_version
      || receipt.target !== result.target_triple
      || receipt.source_commit !== result.source_commit
      || receipt.source_tree_sha256 !== result.source_tree_sha256
      || receipt.passed !== true
      || receipt.exit_code !== 0) {
    throw new Error("payload test receipt does not authorize this release result");
  }
  const checksums = JSON.parse(readFileSync(path.join(root, "release", "checksums.json"), "utf8"));
  const actualFiles = listFiles(root)
    .filter((relative) => relative !== "release/checksums.json"
      && relative !== "arena-component.json")
    .sort();
  const expectedFiles = Object.keys(checksums.files ?? {}).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("payload file set differs from checksums");
  }
  for (const relative of actualFiles) {
    if (sha256File(path.join(root, relative)) !== checksums.files[relative]) {
      throw new Error(`payload checksum mismatch: ${relative}`);
    }
  }
  const installFiles = [...(installManifest.files ?? [])]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const installPaths = installFiles.map((file) => file.path);
  const stagedFiles = listFiles(root)
    .filter((relative) => relative !== "arena-component.json")
    .sort();
  if (JSON.stringify(installPaths) !== JSON.stringify(stagedFiles)) {
    throw new Error("Installer component manifest file set differs from payload");
  }
  for (const file of installFiles) {
    const filename = path.join(root, file.path);
    if (file.sha256 !== sha256File(filename)
        || file.size_bytes !== statSync(filename).size) {
      throw new Error(`Installer component manifest mismatch: ${file.path}`);
    }
  }
  const licenseFiles = stagedFiles
    .filter((relative) => /(?:^|\/)(?:LICENSE|COPYING)(?:\.|$)/iu.test(relative));
  const licensesSha256 = sha256(Buffer.concat(
    licenseFiles.map((relative) => readFileSync(path.join(root, relative))),
  ));
  if (licenseFiles.length === 0
      || result.licenses_sha256 !== licensesSha256
      || result.sbom_sha256 !== sha256File(path.join(root, "release", "sbom.spdx.json"))) {
    throw new Error("release result does not bind SBOM and license evidence");
  }
  for (const forbidden of ["fake-api-server.mjs", "fake-api-server.test.mjs", "test-fixtures"] ) {
    if (existsSync(path.join(root, forbidden))) {
      throw new Error(`test-only entry was packaged: ${forbidden}`);
    }
  }
  if (actualFiles.some((relative) => /(?:^|\/)test(?:-fixtures)?\/|\.test\.mjs$/u.test(relative))
      || existsSync(path.join(root, "vendor", "upstream.lock.json"))) {
    throw new Error("repository-only test or vendor provenance content was packaged");
  }
  if (result.target_triple === "windows-x86_64"
      && !existsSync(path.join(root, "native", "lichess_adapter_launcher.exe"))) {
    throw new Error("Windows component lacks its windowless native launcher");
  }
  const runtimeDir = path.join(root, "release", "verification-runtime-missing");
  const output = execFileSync(process.execPath, [
    path.join(root, manifest.runtime.entrypoint),
    "status",
    "--runtime-dir",
    runtimeDir,
  ], {
    cwd: path.parse(root).root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  const status = JSON.parse(output);
  if (status.schema !== "uci_arena_lichess_status_v4"
      || status.installed !== true
      || status.active !== false
      || !status.blockers.includes("provider_process_inactive")
      || !status.blockers.includes("incident_storage_unavailable")
      || status.incidents?.available !== false) {
    throw new Error("packaged provider status smoke failed");
  }
  if (result.target_triple === "windows-x86_64") {
    const probe = execFileSync(path.join(root, "native", "lichess_adapter_launcher.exe"), ["--probe"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (JSON.parse(probe).create_no_window !== true) {
      throw new Error("packaged Windows launcher probe failed");
    }
  }
  process.stdout.write(`verified ${result.artifact_name}\n`);
}

try {
  verify(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`component verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
