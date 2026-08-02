import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readAndValidateNativeToolchainReceipt,
  writeNativeToolchainReceipt,
} from "./tools/native-toolchain-receipt.mjs";

function buildIdentity(root, compilerVersion = "19.50.35730.0") {
  const cmake = path.join(root, "CMakeFiles", "4.2.3-msvc3");
  mkdirSync(cmake, { recursive: true });
  writeFileSync(path.join(root, "CMakeCache.txt"), [
    "CMAKE_GENERATOR:INTERNAL=Visual Studio 18 2026",
    "CMAKE_GENERATOR_PLATFORM:INTERNAL=x64",
    "CMAKE_GENERATOR_TOOLSET:INTERNAL=v145",
    "",
  ].join("\n"));
  writeFileSync(path.join(cmake, "CMakeCXXCompiler.cmake"), [
    'set(CMAKE_CXX_COMPILER_ID "MSVC")',
    `set(CMAKE_CXX_COMPILER_VERSION "${compilerVersion}")`,
    'set(CMAKE_CXX_COMPILER_LINKER_ID "MSVC")',
    'set(CMAKE_CXX_COMPILER_LINKER_VERSION "14.50.35730.0")',
    "",
  ].join("\n"));
  writeFileSync(path.join(cmake, "CMakeSystem.cmake"), [
    'set(CMAKE_SYSTEM_NAME "Windows")',
    'set(CMAKE_SYSTEM_VERSION "10.0.26200")',
    "",
  ].join("\n"));
  writeFileSync(path.join(root, "ALL_BUILD.vcxproj"), [
    "<Project>",
    "<WindowsTargetPlatformVersion>10.0.26100.0</WindowsTargetPlatformVersion>",
    "<PlatformToolset>v145</PlatformToolset>",
    "</Project>",
  ].join("\n"));
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "lichess-toolchain-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  const definition = {
    schema: "uci_arena_component_definition_v1",
    component_id: "lichess.adapter",
    native_toolchain_by_target: {
      "windows-x86_64": {
        receipt_schema: "arena_native_toolchain_receipt_v1",
        build_system: "cmake",
        language: "cxx",
      },
    },
  };
  writeFileSync(path.join(root, "definition.json"), JSON.stringify(definition));
  execFileSync("git", ["-C", root, "add", "definition.json"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  buildIdentity(path.join(root, "primary"));
  buildIdentity(path.join(root, "reproduction"));
  return { root, definition };
}

test("native receipt binds exact independent equivalent build identities", () => {
  const { root, definition } = fixture();
  try {
    const output = path.join(root, "receipt.json");
    const receipt = writeNativeToolchainReceipt({
      repositoryRoot: root,
      definitionPath: path.join(root, "definition.json"),
      target: "windows-x86_64",
      workflowIdentity: "test/provider-release",
      primaryBuildRoot: path.join(root, "primary"),
      reproductionBuildRoot: path.join(root, "reproduction"),
      outputPath: output,
    });
    assert.deepEqual(receipt.builds[0].identity, receipt.builds[1].identity);
    const evidence = readAndValidateNativeToolchainReceipt({
      filename: output,
      definition,
      target: "windows-x86_64",
      sourceCommit: receipt.source_commit,
      workflowIdentity: "test/provider-release",
    });
    assert.match(evidence.sha256, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native receipt rejects one reused root and toolchain drift", () => {
  const { root } = fixture();
  try {
    const common = {
      repositoryRoot: root,
      definitionPath: path.join(root, "definition.json"),
      target: "windows-x86_64",
      workflowIdentity: "test/provider-release",
      primaryBuildRoot: path.join(root, "primary"),
      outputPath: path.join(root, "receipt.json"),
    };
    assert.throws(() => writeNativeToolchainReceipt({
      ...common,
      reproductionBuildRoot: common.primaryBuildRoot,
    }), /two independent build roots/u);
    rmSync(path.join(root, "reproduction"), { recursive: true, force: true });
    buildIdentity(path.join(root, "reproduction"), "19.51.0");
    assert.throws(() => writeNativeToolchainReceipt({
      ...common,
      reproductionBuildRoot: path.join(root, "reproduction"),
    }), /different toolchain identities/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
