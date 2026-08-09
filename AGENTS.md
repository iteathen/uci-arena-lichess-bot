# UCI Arena Lichess Bot Agent Contract

UCI Arena Lichess Bot is a standalone provider product. It owns Lichess API transport, event/game streams, reconnect/recovery, challenge policy, game reconstruction and move submission, bot scheduling/capacity, account state, token-file access, bot telemetry, and provider packaging. It consumes a conforming UCI executable as an external process.

## Required start

1. Read `.agents/core-standard.md`.
2. Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

3. Read every active specification returned by preflight and rerun when touched paths change materially.
4. For repository-boundary, Manager integration, packaging, startup, persistence, or cross-project work, also read `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

Do not preload old in-engine Lichess implementation, extracted deployment paths, historical plans, or unrelated provider specs.

## Ownership and reuse

Current bot specs/contracts own bot behavior; suite architecture owns cross-repository responsibility. The old engine-integrated bot path is historical evidence, not current authority.

Before adding a new API client, scheduling path, game-state reconstruction path, UCI process controller, token mechanism, provider operation, status store, or recovery flow, search the current bot owners/specs first and reuse or extend the existing owner.

Source imports never escape this repository. Engine behavior enters only through UCI and immutable engine-owned public contracts. Manager uses only the fixed typed provider operations declared under `contracts/`. Installer consumes only immutable component artifacts/manifests/provenance.

## Credential hard rule

Never read, print, summarize, hash, copy, validate, package, log, return, or commit credential contents. Agents, Manager, Installer, tests, and diagnostics may handle only the external credential-file path/status allowed by contract. Automated transport tests use documented synthetic/fabricated credentials only.

Credential convenience never overrides this rule.

## Runtime and failure handling

Network/API behavior must be bounded, recoverable, rate-limit aware, and explicit about retry/terminal failure. One admitted game owns one conforming UCI process as declared by current contracts. External/provider output is hostile input until parsed and validated at the owning boundary.

For ambiguous reconnect, stream, scheduling, token-status, or game-state failures, preserve the original failure signature and trace raw expected-vs-actual evidence through the owning boundary before patching.

## Validation and integration

Run the smallest complete preflight-selected local owner/contract tests first. Security/credentials, persisted account/game meaning, rate limiting, recovery, public provider compatibility, and packaging retain stronger safeguards regardless of diff size.

Automatic GitHub CI remains disabled. Code changes are tested locally, committed and pushed on a branch, and opened as a draft PR.

Before integration, inspect the complete diff, freeze the exact intended head, revalidate required checks/contracts, use guarded exact-head integration where supported, and verify the target result.

## Completion

Complete when the requested bot outcome is evidenced, credential contents remain inaccessible outside the owning runtime boundary, engine/Manager/Installer ownership remains clean, and no material invalid partial game/provider state remains.
