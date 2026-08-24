# UCI Arena Lichess Bot Agent Contract

UCI Arena Lichess Bot is a standalone provider product. It owns Lichess API transport, event/game streams, reconnect/recovery, challenge policy, game reconstruction and move submission, bot scheduling/capacity, account state, token-file access, bot telemetry, and provider packaging. It consumes a conforming UCI executable as an external process.

## Required start

1. Read `.agents/core-standard.md`.
2. Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

3. Read every active specification returned by preflight and rerun when touched paths change materially.
4. `specs/move_submission_timing_boundary_v1.yaml` is mandatory authority for clock handoff, transport reserve, timing-profile consumption, bestmove-to-submit timing, or extended timing telemetry.
5. For repository-boundary, Manager integration, packaging, startup, persistence, or cross-project work, also read `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

Do not preload old in-engine Lichess implementation, extracted deployment paths, historical plans, or unrelated provider specs.

## Ownership and reuse

Current bot specs/contracts own bot behavior; suite architecture owns cross-repository responsibility. The old engine-integrated bot path is historical evidence, not current authority.

Before adding a new API client, scheduling path, game-state reconstruction path, UCI process controller, token mechanism, provider operation, status store, timing path, or recovery flow, search the current bot owners/specs first and reuse or extend the existing owner.

Source imports never escape this repository. Engine behavior enters only through UCI and immutable engine-owned public contracts. Manager uses only the fixed typed provider operations declared under `contracts/`. Installer consumes only immutable component artifacts/manifests/provenance.

## Move-time and transport hard rule

The attached UCI engine owns chess-thinking time. The provider owns Lichess/API transport time.

- Supply authoritative streamed game clocks and increments through the selected UCI contract.
- Provider-measured local/transport reserve may be supplied through the engine's declared overhead/safety input, but the provider does not invent a chess-thinking duration or reinterpret timing blocks/allocation strategy.
- Current game-clock pressure belongs in Engine move-time allocation when the engine supports it; it must not be converted into provider commands over search attention, depth, topology, batching, queues, or workers.
- After a legal authoritative `bestmove` is received for the current state, add no chess-thinking delay. Submit as soon as provider-owned state revalidation, request priority/serialization, rate-limit/cooldown, and transport safety permit.
- A provider transport delay is not a chess timing block. Keep transport evidence and Engine timing evidence semantically separate.
- For the extended adapter, normal search-derived moves may require versioned Engine timing telemetry. An explicit Engine-owned `timing not applicable` outcome may use a different versioned validation path when a non-search authority actually resolved the move.
- Never infer timing bypass merely because a book or tablebase exists. Hints, priors, safety constraints, or other advisory evidence do not transfer move-resolution authority to this provider.
- Standard UCI engines remain supported without UCI Arena timing artifacts; their own UCI timing behavior remains authoritative.

## Credential hard rule

Never read, print, summarize, hash, copy, validate, package, log, return, or commit credential contents. Agents, Manager, Installer, tests, and diagnostics may handle only the external credential-file path/status allowed by contract. Automated transport tests use documented synthetic/fabricated credentials only.

Credential convenience never overrides this rule.

## Runtime and failure handling

Network/API behavior must be bounded, recoverable, rate-limit aware, and explicit about retry/terminal failure. One admitted game owns one conforming UCI process as declared by current contracts. External/provider output is hostile input until parsed and validated at the owning boundary.

For ambiguous reconnect, stream, scheduling, token-status, game-state, timing, or move-submission failures, preserve the original failure signature and trace raw expected-vs-actual evidence through the owning boundary before patching.

## Validation and integration

Run the smallest complete preflight-selected local owner/contract tests first. Security/credentials, persisted account/game meaning, rate limiting, timing/transport authority, recovery, public provider compatibility, and packaging retain stronger safeguards regardless of diff size.

Automatic GitHub CI remains disabled. Code changes are tested locally, committed and pushed on a branch, and opened as a draft PR.

Before integration, inspect the complete diff, freeze the exact intended head, revalidate required checks/contracts, use guarded exact-head integration where supported, and verify the target result.

## Completion

Complete when the requested bot outcome is evidenced, credential contents remain inaccessible outside the owning runtime boundary, Engine chess-time and provider transport-time ownership remain clean, engine/Manager/Installer ownership remains clean, and no material invalid partial game/provider state remains.
