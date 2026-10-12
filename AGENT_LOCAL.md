# Repository context: uci-arena-lichess-bot

Universal engineering and design guidance comes from the account-global `AGENTS.md`.

## Mission and ownership

UCI Arena Lichess Bot is the standalone Lichess provider product. It owns Lichess API transport, event/game streams, reconnect/recovery, challenge policy, game reconstruction/move submission, bot scheduling/capacity, account state, token-file access, bot telemetry, and provider packaging. It consumes a conforming UCI executable as an external process.

## Decision reasoning

Before a substantive architecture, design, implementation-selection, or cross-component
decision, read `reasoning/component_graph_v1.yaml` and the canonical suite graph at
`iteathen/uci-arena-installer/reasoning/suite_graph_v1.yaml`.

Lichess is the suite's principal uncontrolled external-validation environment, but provider
transport reasoning must not absorb engine chess semantics. Accepted Bot specs/contracts
remain behavior authority; contradictions trigger review rather than silent override.

## Local routing

Before substantive work run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <likely paths>
```

Read the active specs returned by preflight. Timing handoff/submission work follows `specs/move_submission_timing_boundary_v1.yaml`. Repository-boundary/Manager/packaging/startup/persistence work also follows `specs/suite_lego_boundaries_v1.yaml` and the canonical suite architecture in `iteathen/uci-arena-installer`.

## Local constraints

Current bot specs/contracts own provider behavior. Old engine-integrated bot paths are historical evidence. Keep provider tokens secret and never expose token contents in logs, commits, patches, diagnostics, or chat.
