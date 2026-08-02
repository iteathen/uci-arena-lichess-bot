#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflowRoot = path.join(root, ".github", "workflows");
const forbidden = new Set(["push", "pull_request", "merge_group", "schedule"]);
const errors = [];

for (const name of readdirSync(workflowRoot).filter((value) => /\.ya?ml$/u.test(value)).sort()) {
  const source = readFileSync(path.join(workflowRoot, name), "utf8");
  const lines = source.split(/\r?\n/u);
  const onIndex = lines.findIndex((line) => /^on:\s*$/u.test(line));
  if (onIndex < 0) {
    errors.push(`${name}: missing block-form on declaration`);
    continue;
  }
  const triggers = [];
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    if (!/^\s/u.test(lines[index])) break;
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):/u.exec(lines[index]);
    if (match) triggers.push(match[1]);
  }
  if (!triggers.includes("workflow_dispatch")) errors.push(`${name}: manual dispatch is required`);
  for (const trigger of triggers.filter((value) => forbidden.has(value))) {
    errors.push(`${name}: automatic trigger is forbidden: ${trigger}`);
  }
  if (/actions\/attest-build-provenance|attestations:\s*write/u.test(source)) {
    errors.push(`${name}: paid private-repository attestation features are forbidden`);
  }
  if (!/cosign attest-blob[\s\S]*cosign verify-blob-attestation/u.test(source)) {
    errors.push(`${name}: exact Cosign signing and verification are required`);
  }
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("github automation: manual-only, free OIDC provenance path\n");
