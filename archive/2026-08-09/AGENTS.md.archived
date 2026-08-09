# AGENTS.md

UCI Arena Lichess Bot is a spec-driven standalone provider that consumes a
conforming UCI executable as an external process.

Before substantive planning, inspection, implementation, or validation run:

```text
node tools/spec-preflight.mjs --task "<description>" --changed-files <paths>
```

Read every returned specification. Public behavior changes update the governing
specification first.

The canonical complete-suite target is
[`UCI_ARENA_COMPLETE_LEGO_ARCHITECTURE.md`](https://github.com/iteathen/uci-arena-installer/blob/main/docs/architecture/UCI_ARENA_COMPLETE_LEGO_ARCHITECTURE.md).
Read `specs/suite_lego_boundaries_v1.yaml` before repository-boundary,
Manager-integration, packaging, startup, persistence, or cross-project work.

Never read, print, hash, copy, validate, package, or commit credential contents.
Agents and tests may handle only an external credential-file path; automated
transport tests use the fabricated loopback API and a documented synthetic
fixture value.

Source imports never escape this repository. Engine behavior enters only
through UCI and immutable engine-owned contracts. Manager uses only the fixed
typed provider operations declared under `contracts/`. Installer consumes only
the immutable component artifact and manifest.

Automatic GitHub CI is disabled. Code changes must be tested locally, committed,
pushed, and opened as a draft pull request.
