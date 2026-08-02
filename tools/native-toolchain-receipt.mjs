#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const RECEIPT_SCHEMA = "arena_native_toolchain_receipt_v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error(`invalid argument near ${argv[index] ?? "<end>"}`);
    }
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

function findFiles(root, name) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...findFiles(absolute, name));
    else if (entry.isFile() && entry.name === name) result.push(absolute);
  }
  return result.sort();
}

function assignments(filename, cache = false) {
  const result = new Map();
  for (const raw of readFileSync(filename, "utf8").split(/\r?\n/u)) {
    const line = raw.trim();
    const match = cache
      ? /^([^#/:=][^:=]*)(?::[^=]+)?=(.*)$/u.exec(line)
      : /^set\(([A-Za-z0-9_]+)\s+(?:"([^"]*)"|([^)]*))\)$/u.exec(line);
    if (match) result.set(match[1], (cache ? match[2] : (match[2] ?? match[3])).trim());
  }
  return result;
}

function required(values, name, source) {
  const value = values.get(name);
  if (!value) throw new Error(`${source} does not report ${name}`);
  return value;
}

function executable(value) {
  if (!value || value.endsWith("-NOTFOUND")) return undefined;
  const resolved = path.resolve(value);
  return {
    name: path.basename(value),
    ...(existsSync(resolved) && statSync(resolved).isFile()
      ? { sha256: sha256(readFileSync(resolved)) }
      : {}),
  };
}

function projectValue(buildRoot, name) {
  const values = new Set();
  const expression = new RegExp(`<${name}>([^<]+)</${name}>`, "gu");
  for (const filename of findFiles(buildRoot, "ALL_BUILD.vcxproj")) {
    for (const match of readFileSync(filename, "utf8").matchAll(expression)) {
      values.add(match[1]);
    }
  }
  if (values.size > 1) throw new Error(`CMake build reports multiple ${name} values`);
  return [...values][0];
}

export function inspectNativeToolchain(buildRoot) {
  const root = path.resolve(buildRoot);
  const cachePath = path.join(root, "CMakeCache.txt");
  if (!existsSync(cachePath) || !statSync(cachePath).isFile()) {
    throw new Error(`CMake build cache is missing: ${root}`);
  }
  const compilerFiles = findFiles(path.join(root, "CMakeFiles"), "CMakeCXXCompiler.cmake");
  const systemFiles = findFiles(path.join(root, "CMakeFiles"), "CMakeSystem.cmake");
  if (compilerFiles.length !== 1 || systemFiles.length !== 1) {
    throw new Error(`CMake build identity is incomplete: ${root}`);
  }
  const cache = assignments(cachePath, true);
  const compiler = assignments(compilerFiles[0]);
  const system = assignments(systemFiles[0]);
  const compilerExecutable = executable(compiler.get("CMAKE_CXX_COMPILER"));
  const linkerExecutable = executable(
    compiler.get("CMAKE_CXX_COMPILER_LINKER")
      || compiler.get("CMAKE_LINKER")
      || cache.get("CMAKE_LINKER"),
  );
  const generatorExecutable = executable(cache.get("CMAKE_MAKE_PROGRAM"));
  const generatorPlatform = cache.get("CMAKE_GENERATOR_PLATFORM") || undefined;
  const generatorToolset = cache.get("CMAKE_GENERATOR_TOOLSET") || undefined;
  const windowsSdk = projectValue(root, "WindowsTargetPlatformVersion");
  const platformToolset = projectValue(root, "PlatformToolset");
  return {
    build_system: {
      name: "cmake",
      version: path.basename(path.dirname(compilerFiles[0])),
      generator: required(cache, "CMAKE_GENERATOR", cachePath),
      ...(generatorPlatform ? { generator_platform: generatorPlatform } : {}),
      ...(generatorToolset ? { generator_toolset: generatorToolset } : {}),
      ...(generatorExecutable ? { generator_executable: generatorExecutable } : {}),
    },
    compiler: {
      language: "cxx",
      id: required(compiler, "CMAKE_CXX_COMPILER_ID", compilerFiles[0]),
      version: required(compiler, "CMAKE_CXX_COMPILER_VERSION", compilerFiles[0]),
      ...(compiler.get("CMAKE_CXX_COMPILER_FRONTEND_VARIANT")
        ? { frontend_variant: compiler.get("CMAKE_CXX_COMPILER_FRONTEND_VARIANT") }
        : {}),
      ...(compiler.get("CMAKE_CXX_COMPILER_ARCHITECTURE_ID")
        ? { architecture: compiler.get("CMAKE_CXX_COMPILER_ARCHITECTURE_ID") }
        : {}),
      ...(compilerExecutable ? { executable: compilerExecutable } : {}),
    },
    linker: {
      id: compiler.get("CMAKE_CXX_COMPILER_LINKER_ID") ?? "not_reported_by_cmake",
      version: compiler.get("CMAKE_CXX_COMPILER_LINKER_VERSION")
        ?? "not_reported_by_cmake",
      ...(linkerExecutable ? { executable: linkerExecutable } : {}),
    },
    target_system: {
      name: required(system, "CMAKE_SYSTEM_NAME", systemFiles[0]),
      version: required(system, "CMAKE_SYSTEM_VERSION", systemFiles[0]),
    },
    ...(windowsSdk ? { windows_sdk_version: windowsSdk } : {}),
    ...(platformToolset ? { platform_toolset: platformToolset } : {}),
  };
}

function validateDefinition(definition, target) {
  const contract = definition.native_toolchain_by_target?.[target];
  if (definition.schema !== "uci_arena_component_definition_v1"
      || !/^[A-Za-z0-9._-]+$/u.test(definition.component_id ?? "")
      || contract?.receipt_schema !== RECEIPT_SCHEMA
      || contract?.build_system !== "cmake"
      || contract?.language !== "cxx") {
    throw new Error("component definition does not declare a supported native toolchain");
  }
}

function validText(value) {
  return typeof value === "string" && value.length > 0;
}

function validExecutable(value) {
  return value === undefined
    || (value && typeof value === "object" && !Array.isArray(value)
      && validText(value.name)
      && (value.sha256 === undefined || /^[0-9a-f]{64}$/u.test(value.sha256)));
}

function validIdentity(identity) {
  return identity && typeof identity === "object" && !Array.isArray(identity)
    && identity.build_system?.name === "cmake"
    && validText(identity.build_system.version)
    && validText(identity.build_system.generator)
    && validExecutable(identity.build_system.generator_executable)
    && identity.compiler?.language === "cxx"
    && validText(identity.compiler.id)
    && validText(identity.compiler.version)
    && validExecutable(identity.compiler.executable)
    && validText(identity.linker?.id)
    && validText(identity.linker?.version)
    && validExecutable(identity.linker.executable)
    && validText(identity.target_system?.name)
    && validText(identity.target_system?.version);
}

export function writeNativeToolchainReceipt({
  repositoryRoot,
  definitionPath,
  target,
  workflowIdentity,
  primaryBuildRoot,
  reproductionBuildRoot,
  outputPath,
}) {
  const definition = JSON.parse(readFileSync(definitionPath, "utf8"));
  validateDefinition(definition, target);
  const primaryRoot = path.resolve(primaryBuildRoot);
  const reproductionRoot = path.resolve(reproductionBuildRoot);
  if (primaryRoot === reproductionRoot) {
    throw new Error("native reproducibility evidence requires two independent build roots");
  }
  const primary = inspectNativeToolchain(primaryRoot);
  const reproduction = inspectNativeToolchain(reproductionRoot);
  if (JSON.stringify(primary) !== JSON.stringify(reproduction)) {
    throw new Error("independent native builds used different toolchain identities");
  }
  const receipt = {
    schema: RECEIPT_SCHEMA,
    component_id: definition.component_id,
    target_triple: target,
    source_commit: execFileSync(
      "git",
      ["-C", repositoryRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", windowsHide: true },
    ).trim(),
    workflow_identity: workflowIdentity,
    builds: [
      { role: "primary", identity: primary },
      { role: "reproduction", identity: reproduction },
    ],
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function readAndValidateNativeToolchainReceipt({
  filename,
  definition,
  target,
  sourceCommit,
  workflowIdentity,
}) {
  const bytes = readFileSync(filename);
  const receipt = JSON.parse(bytes);
  const roles = receipt.builds?.map((build) => build.role);
  if (receipt.schema !== RECEIPT_SCHEMA
      || receipt.component_id !== definition.component_id
      || receipt.target_triple !== target
      || receipt.source_commit !== sourceCommit
      || receipt.workflow_identity !== workflowIdentity
      || JSON.stringify(roles) !== JSON.stringify(["primary", "reproduction"])
      || receipt.builds?.some((build) => !validIdentity(build.identity))
      || JSON.stringify(receipt.builds?.[0]?.identity)
        !== JSON.stringify(receipt.builds?.[1]?.identity)) {
    throw new Error("native toolchain receipt does not match the exact component build");
  }
  return { receipt, sha256: sha256(bytes) };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  for (const name of [
    "definition", "target", "workflow-identity", "primary-build-root",
    "reproduction-build-root", "output",
  ]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const receipt = writeNativeToolchainReceipt({
    repositoryRoot: path.resolve(args["repository-root"] ?? process.cwd()),
    definitionPath: path.resolve(args.definition),
    target: args.target,
    workflowIdentity: args["workflow-identity"],
    primaryBuildRoot: args["primary-build-root"],
    reproductionBuildRoot: args["reproduction-build-root"],
    outputPath: path.resolve(args.output),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`native-toolchain-receipt: ${error.message}\n`);
    process.exitCode = 1;
  }
}
