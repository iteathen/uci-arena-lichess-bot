#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

const predicateType = "https://uci-arena.example/attestations/provider-release-result/v1";
const statementType = "https://in-toto.io/Statement/v1";

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

function safeName(value) {
  if (typeof value !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value)
      || path.basename(value) !== value) {
    throw new Error("unsafe release asset name");
  }
  return value;
}

function sha256File(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function providerStatement(result) {
  if (result?.schema !== "arena_provider_release_result_v1"
      || !/^[0-9a-f]{64}$/u.test(result.artifact_sha256 ?? "")) {
    throw new Error("invalid provider release result");
  }
  return {
    _type: statementType,
    subject: [{ name: safeName(result.artifact_name), digest: { sha256: result.artifact_sha256 } }],
    predicateType,
    predicate: result,
  };
}

function githubOutputs(filename, values) {
  for (const [key, value] of Object.entries(values)) {
    if (/[\u0000-\u001f\u007f]/u.test(String(value))) throw new Error(`unsafe output ${key}`);
    appendFileSync(filename, `${key}=${value}\n`, "utf8");
  }
}

function prepare(args) {
  const output = path.resolve(args["output-dir"] ?? "");
  const names = readdirSync(output).filter((name) => name.endsWith(".provider-result.json"));
  if (names.length !== 1) throw new Error(`expected one provider result; found ${names.length}`);
  const resultPath = path.join(output, safeName(names[0]));
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  const statement = providerStatement(result);
  const artifactPath = path.join(output, statement.subject[0].name);
  if (sha256File(artifactPath) !== result.artifact_sha256) {
    throw new Error("provider result artifact digest mismatch");
  }
  const statementDirectory = path.resolve(args["statement-dir"] ?? "");
  mkdirSync(statementDirectory, { recursive: true });
  const statementPath = path.join(statementDirectory, `${result.artifact_name}.intoto.json`);
  const bundlePath = path.join(output, `${result.artifact_name}.sigstore.json`);
  writeFileSync(statementPath, `${JSON.stringify(statement, null, 2)}\n`, { flag: "wx" });
  const values = { artifact_path: artifactPath, bundle_path: bundlePath, predicate_type: predicateType, statement_path: statementPath };
  if (args["github-output"]) githubOutputs(args["github-output"], values);
  else process.stdout.write(`${JSON.stringify(values)}\n`);
}

function canonicalBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new Error("Sigstore payload is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Sigstore payload is not canonical base64");
  return bytes;
}

function verifyBundle(args) {
  const bundle = JSON.parse(readFileSync(path.resolve(args.bundle ?? ""), "utf8"));
  if (bundle?.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json"
      || bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json"
      || bundle?.dsseEnvelope?.signatures?.length !== 1) {
    throw new Error("invalid Sigstore DSSE bundle");
  }
  const actual = JSON.parse(canonicalBase64(bundle.dsseEnvelope.payload).toString("utf8"));
  const expected = JSON.parse(readFileSync(path.resolve(args.statement ?? ""), "utf8"));
  if (!isDeepStrictEqual(actual, expected)) throw new Error("signed payload differs from statement");
  process.stdout.write("provider attestation payload: verified\n");
}

try {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArguments(rest);
  if (command === "prepare") prepare(args);
  else if (command === "verify-bundle") verifyBundle(args);
  else throw new Error("usage: provider-attestation <prepare|verify-bundle>");
} catch (error) {
  process.stderr.write(`provider attestation failed: ${error.message}\n`);
  process.exitCode = 1;
}
