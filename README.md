# UCI Arena Lichess Bot

`uci-arena-lichess-bot` is the independently released Lichess BOT provider for
the UCI Arena suite. It owns Lichess transport, challenge policy, scheduling,
capacity admission, game reconstruction, move submission, persistent bot state,
startup integration, and its typed Manager projection.

It consumes any conforming UCI executable as an external process. It does not
import UCI Arena Engine source and does not require the UCI Arena Engine in
particular. UCI Arena suite compositions select the LatticeKnight model by
default, while Stockfish, LCZero, and other conforming UCI engines remain valid
substitutions through the provider-neutral `standard_uci_v1` adapter.

The complete product architecture is governed by
[`UCI_ARENA_COMPLETE_LEGO_ARCHITECTURE.md`](https://github.com/iteathen/uci-arena-installer/blob/main/docs/architecture/UCI_ARENA_COMPLETE_LEGO_ARCHITECTURE.md).
Repository-specific mandatory boundaries are in
[`specs/suite_lego_boundaries_v1.yaml`](specs/suite_lego_boundaries_v1.yaml).

## Credential boundary

The Lichess token is always an operator-owned file outside the repository and
outside the installed component directory.

- The provider transport reads the file only when `probe` or `run` needs it.
- Manager receives only the external path and redacted status.
- Installer never packages, copies, reads, validates, or logs the token.
- Tracked configuration never contains a token or a default token path.
- Automated tests use the fabricated loopback API and a synthetic fixture value.

Pass the credential by path:

```powershell
node .\lichess-adapter.mjs probe `
  --token-file C:\operator-secrets\lichess-bot.token `
  --config C:\ProgramData\UCI Arena\lichess\config.json
```

`probe` loads only provider policy and the external token path; it does not
require an engine executable, model, timing profile, or capacity qualification.

Do not put the token in an argument, environment variable, configuration file,
log, test fixture, or release artifact.

## Preferred installation

Install the complete suite with `uci-arena-installer`. The Installer resolves a
compatible Engine, Manager, Lichess Bot, Book Forge, Evidence Service, and
Evidence Runtime composition, then supplies immutable component roots and
external data locations through declared manifests.

The provider release artifact contains:

- root-level provider runtime modules with `lichess-adapter.mjs` as the entrypoint;
- `contracts/` — component, service, configuration, status, and Manager API contracts;
- `native/` — platform launcher when required;
- `vendor/` — digest-locked engine-owned contract packages;
- Node runtime dependency metadata;
- checksums, test receipt, and release provenance.

The provider manifest requires the neutral `uci.engine.process` capability.
`uci_arena.engine` is the suite composition's compatible default, not a hard
provider dependency.

The component owns installed program files. Manager-owned persistent data,
including SQLite state, runtime status, logs, reservations, opponent history,
and cooldown state, remains outside that immutable component root and is
preserved across upgrade, repair, and removal unless the operator explicitly
requests data deletion.

## Development setup

Requirements:

- Node.js 24.15.0 or newer;
- CMake and a Windows C++ toolchain to build the windowless Windows launcher;
- a conforming UCI engine only for real qualification or live execution.

From any working directory:

```powershell
npm ci --prefix C:\chess_engine\uci-arena-lichess-bot
npm run check --prefix C:\chess_engine\uci-arena-lichess-bot
```

The test suite does not contact Lichess or read a credential file. It covers the
loopback HTTP API, BOT account probes, event and game streams, challenges, move
submission, scheduling, rate limiting, SQLite recovery, legal move gating,
timing contracts, startup definitions, and Manager controls.

## Configuration

`config.uci_arena.template.yml` is JSON syntax with the current
`uci_arena_lichess_adapter_v7` schema. The `.yml` name is retained for installed
compatibility.

`<UCI_ARENA_ENGINE_ROOT>` is an explicit installed component binding. It is not
the provider repository, caller working directory, or an assumed source tree.
Installer or Manager should resolve it from the installed Engine component
receipt. The tracked suite default uses `models/latticeknight`.

`engine.adapter` selects one of two explicit contracts:

- `standard_uci_v1` requires an executable, optional literal argument array,
  working directory, successful `uci`/`isready` interrogation, and a fresh legal
  depth-one move from the initial position. A freshly qualified engine owns one
  game slot; greater concurrency requires a matching capacity artifact.
- `uci_arena_extended_v1` additionally binds the UCI Arena Engine model,
  runtime-status, timing, and capacity evidence described below.

Extended live execution remains fail-closed until these exact bindings are present:

- engine executable and working directory;
- model root;
- single-game qualification profile;
- timing profile or explicitly visible conservative fallback where permitted;
- capacity profile for the requested concurrency;
- optional adaptive temporal curve with a matching immutable identity;
- optional shared knowledge root supplied explicitly by Manager.

Common path flags:

```text
--config <provider-config>
--engine-root <installed-engine-component-root>
--engine <uci-executable>
--working-directory <engine-working-directory>
--model-root <model-root>
--profile <single-game-profile>
--time-profile <timing-profile>
--temporal-curve-profile <adaptive-curve-profile>
--capacity-profile <capacity-profile>
--runtime-dir <external-provider-data-directory>
```

Explicit flags override template values. Paths are normalized to absolute paths
at the process boundary; stored path values never contain embedded quotes.

## Status and health

The credential-free status operation is the authoritative Manager health
projection:

```powershell
node .\lichess-adapter.mjs status `
  --runtime-dir C:\ProgramData\UCI Arena\lichess
```

It returns `uci_arena_lichess_status_v3` with explicit values for installed,
registered, active, ready, stream connectivity, capacity, active/pending games,
scheduler state, API cooldown, and blockers. A stale or missing `runtime.json`
never claims that the provider is active. Status never returns raw config,
credential data, logs, SQLite rows, or engine command lines.

## Qualification and execution

Validate the exact engine package before using credentials:

```powershell
node .\lichess-adapter.mjs qualify `
  --config .\config.uci_arena.template.yml `
  --engine-root C:\Program Files\UCI Arena\components\engine `
  --engine C:\Program Files\UCI Arena\components\engine\bin\uci_arena_engine.exe `
  --working-directory C:\Program Files\UCI Arena\components\engine `
  --model-root C:\Program Files\UCI Arena\components\engine\models\latticeknight `
  --profile C:\ProgramData\UCI Arena\profiles\single-game.json `
  --time-profile C:\ProgramData\UCI Arena\profiles\time.json
```

The packaged engine smoke uses the same selected adapter and literal process
argument array as live games:

```powershell
node .\smoke-uci-startup.mjs `
  --config C:\ProgramData\UCI Arena\lichess\config.json `
  --engine-root C:\Program Files\UCI Arena\components\engine
```

Run after qualification and capacity validation:

```powershell
node .\lichess-adapter.mjs run `
  --config C:\ProgramData\UCI Arena\lichess\config.json `
  --token-file C:\operator-secrets\lichess-bot.token `
  --expected-account operator-bot `
  --runtime-dir C:\ProgramData\UCI Arena\lichess
```

One admitted game owns one isolated qualified UCI child. One global event
stream owns account lifecycle. Each game has one authoritative game stream,
independent legal-state reconstruction, generation-safe cancellation, and
fail-closed move validation.

## Manager operations

The fixed operation catalog is
[`contracts/manager-operations-schema.json`](contracts/manager-operations-schema.json).
Manager must execute these operations without a shell and parse exactly one
bounded JSON response.

Examples:

```powershell
node .\lichess-adapter.mjs config get --config C:\ProgramData\UCI Arena\lichess\config.json
node .\lichess-adapter.mjs owner list --runtime-dir C:\ProgramData\UCI Arena\lichess
node .\lichess-adapter.mjs owner add --username trusted-user --runtime-dir C:\ProgramData\UCI Arena\lichess
node .\lichess-adapter.mjs reserve --opponent trusted-user --games 1 --minutes 15 --runtime-dir C:\ProgramData\UCI Arena\lichess
node .\lichess-adapter.mjs reservation status --runtime-dir C:\ProgramData\UCI Arena\lichess
node .\lichess-adapter.mjs scheduler pause --runtime-dir C:\ProgramData\UCI Arena\lichess
node .\lichess-adapter.mjs scheduler resume --runtime-dir C:\ProgramData\UCI Arena\lichess
```

Manager-editable configuration is restricted to capacity, inbound challenge,
outbound challenge, scheduler, and opponent-selection groups. Engine paths,
model paths, credential paths, storage paths, arbitrary UCI options, shell
commands, and unknown fields are not editable through this projection.

Rated games and automatic outbound scheduling require their distinct explicit
confirmation values. A generic Save action is not sufficient.

## Startup

Windows uses a GUI-subsystem native launcher and a least-privilege, hidden,
single-instance Task Scheduler task. Linux uses a non-root systemd user unit.
Both keep the Node provider in the foreground under supervision and store only
the external token-file path.

Build the Windows launcher:

```powershell
cmake -S .\native -B .\native\build -A x64
cmake --build .\native\build --config Release
```

Install, inspect, or remove startup integration:

```powershell
node .\lichess-adapter.mjs startup install <qualification-and-run-flags>
node .\lichess-adapter.mjs startup status
node .\lichess-adapter.mjs startup uninstall --runtime-dir C:\ProgramData\UCI Arena\lichess
```

Startup installation qualifies the exact engine, model, timing, and capacity
required by the selected adapter before registering anything and before reading
credentials. The packaged Windows launcher is `native/lichess_adapter_launcher.exe`;
`native/build/Release` is only a development build location and is never stored
in installed startup registration.

## Protected live acceptance

Ordinary tests never create a Lichess game. The one-game acceptance harness is
separate, hard-capped, and requires the exact confirmation phrase, expected
operator BOT account, and named online BOT opponent. It accepts only casual
standard play and cannot enable the ordinary scheduler.

```powershell
node .\live-acceptance.mjs `
  --confirm I_ACCEPT_ONE_BOT_GAME `
  --expected-account operator-bot `
  --opponent named-public-bot `
  --token-file C:\operator-secrets\lichess-bot.token `
  --config C:\ProgramData\UCI Arena\lichess\config.json `
  --runtime-dir C:\ProgramData\UCI Arena\lichess\live-acceptance
```

## Persistence and recovery

The provider owns a WAL-mode SQLite store. It persists owners, reservations,
scheduler controls, opponents, challenge attempts, games, API safety state, and
single-client leases. Restart reconciles active games before admitting new work.
Rate-limit cooldowns survive restart and cannot be shortened by local config.
Runtime NDJSON logging retains a bounded current log and one rotated predecessor
inside the persistent provider workspace.

`backfill-game-provenance.mjs` can apply an explicitly supplied historical
evidence manifest in dry-run-first mode. Historical evidence is not committed
to this provider repository; it belongs in qualified Evidence Service output or
operator-controlled data.

## Release and provenance

Component release automation is manual-only. Official artifacts require:

- a clean exact commit;
- a passing local test receipt for that commit and target;
- a deterministic component payload;
- complete file digests and SBOM;
- an in-toto statement for the exact artifact digest;
- keyless Sigstore signing through the manual GitHub workflow;
- fail-closed verification of certificate identity, workflow repository, SHA,
  ref, name, trigger, and predicate type.

The repository stays private. The workflow does not use GitHub private-repo
artifact attestation or another paid feature; signed provenance is produced by
Cosign using GitHub OIDC. Automatic push and pull-request workflows are
forbidden.
