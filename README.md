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
`uci_arena_lichess_adapter_v8` schema. The `.yml` name is retained for installed
compatibility.

`<UCI_ARENA_ENGINE_ROOT>` is an explicit installed component binding. It is not
the provider repository, caller working directory, or an assumed source tree.
Installer or Manager should resolve it from the installed Engine component
receipt. The tracked suite default uses `models/latticeknight`.

`engine.adapter` selects one of two explicit contracts:

- `standard_uci_v1` requires an executable, optional literal argument array,
  working directory, successful `uci`/`isready` interrogation, and a fresh legal
  move from the initial position using the bounded `go movetime 500` onboarding
  probe. This between-game probe proves protocol/legality and grants one game
  slot; it makes no depth, strength or live timing-policy claim. Greater
  concurrency requires a matching capacity artifact. Explicit fixed-depth smoke
  remains depth-based and requires an engine that supports that command.
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

The local operator can adopt a newly qualified evidence bundle through
`config update --config <saved-config> --settings <editable-settings-json>
--profile <single-game-profile> --time-profile <timing-profile>
--capacity-profile <capacity-profile>`. Supply all three evidence references.
The provider validates the complete effective engine, model, timing and capacity
binding before atomically saving the paths and policy, including when the slot
shape is unchanged. Failure preserves the previous configuration. This operation
does not start the Bot or update Installer locators; startup still performs its
native preflight. Evidence paths persist through normal starts and policy updates,
while a subsequent Installer render regenerates them from its installation context.

For recovery, `capacity-qualify --max-concurrency 1` can qualify one actual child
using explicit fresh evidence paths while the old saved two-slot configuration
remains unstarted. Adopt the resulting bundle and one-slot policy together before
startup. An automated single-bot slot uses human slots0, borrowingfalse,
publicfalse, bot slots1/target1 and startup parallelism1. Existing borrowing is
one-way: bots may borrow an idle human slot; humans cannot borrow a bot slot.

Lichess transport evidence is stored separately from Engine timing evidence.
New collection uses `uci_arena_lichess_transport_profile_v2`, whose reserve
covers the complete bestmove-to-ack tail: legality replay, serialized request
queueing, dispatch, and acknowledgement. Qualified compatible evidence remains
authoritative regardless of age and rolls forward with new completed-game data;
age is provenance, not an invalidation trigger. Qualified v1 dispatch-to-ack
profiles remain readable as read-only legacy authority, while new collection
uses v2. Missing, incompatible, invalid, or unqualified evidence selects the
documented 650 ms bootstrap reserve. Transport evidence never regenerates or
changes the Engine-owned timing authority. Per-move transport observations stay
non-authoritative and isolated by game until authoritative terminal game state
is observed; failed, interrupted, or abandoned games discard their pending
observations rather than changing either profile.

## Status and health

The credential-free status operation is the authoritative Manager health
projection:

```powershell
node .\lichess-adapter.mjs status `
  --runtime-dir C:\ProgramData\UCI Arena\lichess
```

It returns `uci_arena_lichess_status_v5` with explicit values for installed,
registered, active, ready, stream lifecycle, capacity, active/pending games,
scheduler state, global API cooldown, outbound-challenge quarantine, local API
lease health, startup supervision, the bounded active-incident summary, game
archive availability/counts/logical storage, and blockers. A supervised process waiting for a persisted API
cooldown is reported as `waiting_for_api_cooldown`, not as an unexplained stream
disconnect. A stale or missing `runtime.json` never claims that the provider is
active. Status never returns raw config, credential data, logs, SQLite rows,
lease owner ids, process identities, or engine command lines.

Manager can page the Provider-owned sanitized incident ledger through the
declared `incidents_list` operation without opening SQLite or reading logs:

```powershell
node .\lichess-adapter.mjs incidents list `
  --filter active --after-cursor 0 --limit 100 `
  --runtime-dir C:\ProgramData\UCI Arena\lichess
```

The response is `uci_arena_provider_incident_page_v1`. Cursor order is stable,
retention/truncation is explicit, and credential values, paths, command lines,
raw API documents, and engine protocol output are rejected before persistence.

The provider also owns the canonical operational game archive. Manager accesses
only its closed `games_list` and `game_get` DTOs; it never opens SQLite, logs,
runtime files, raw Lichess responses, or engine output:

```powershell
node .\lichess-adapter.mjs games list `
  --scope history --before 0 --limit 100 `
  --runtime-dir C:\ProgramData\UCI Arena\lichess
node .\lichess-adapter.mjs game get `
  --game-id <lichess-game-id> `
  --runtime-dir C:\ProgramData\UCI Arena\lichess
```

History and live pages use immutable keyset cursors. A game detail returns at
most 2,048 canonical UCI plies with pre/post FEN, actor color, and only an exact
observed actor clock. Component identities are nullable and evidence-bound;
public runtime provenance is allowlisted and path-free. Existing summary-only
history remains explicitly incomplete until bounded low-priority Lichess export
evidence reconstructs a legal terminal replay.

## Qualification and execution

Publish a single-game profile only from the exact qualified timing profile and
matching complete-game artifact. Intermediate diagnostic attempts are retained
for investigation but are not deployment authority:

```powershell
node .\publish-single-game-profile.mjs `
  --engine C:\Program Files\UCI Arena\components\engine\bin\uci_arena_engine.exe `
  --model-root C:\Program Files\UCI Arena\components\engine\models\latticeknight `
  --time-profile C:\ProgramData\UCI Arena\profiles\uci_time_profile_v3.json `
  --complete-game-evidence C:\ProgramData\UCI Arena\evidence\complete-game.json `
  --output C:\ProgramData\UCI Arena\profiles\single-game.json
```

The timing profile must contain at least thirty repetitions per declared case.
The complete-game runner must have validated and applied that exact semantic
timing authority before its timed work; a provenance-only engine rebuild is
recorded but does not invalidate compatible timing. The publisher copies both
immutable inputs beside the generated profile and never replaces prior
authority when validation fails.

The additive `uci_arena_single_game_profile_v2` path consumes the Engine-owned
`uci_continuous_complete_game_diagnostic_v1` artifact with
`--qualification-scope local_live_safety`. It requires the genuine completed
opposite-color pair, bounded legal current-focus publications, the complete
canonical candidate set, continuous owner/resource observations, and final
native join plus unsignalled zero process exit and stdio close. Live work may
remain active at publication; actual partial seed counts are retained. Existing
v1/v3/v4 evidence keeps its original gates.

This profile grants local runtime safety only. Timing remains governed by the
immutable qualified timing profile and public application contract; strength,
performance and release authority remain false. The 1.3 historical searched
regime can bind an actual enabled book with zero prior blend while reporting
whole-runtime timing authority separately. It never rewrites the actual
configuration or buys an unaffordable partial useful timing block.

The exact executable/arguments/cwd, complete Engine-owned source manifest,
model owner's selected/required assets, provider/runtime/hardware, options,
book and tablebase assets are checked before publication and startup. Each
fresh child establishes its own process and game-lifetime baseline. The existing
capacity v2 envelope binds the exact new single-game profile hash and retains
its distinct continuous per-child evidence; a failed native/process close
cannot create or replace capacity authority. No fixture or incomplete diagnostic
attempt may be published as completed safety evidence.

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
node .\lichess-adapter.mjs games list --scope live --limit 100 --runtime-dir C:\ProgramData\UCI Arena\lichess
node .\lichess-adapter.mjs game get --game-id <lichess-game-id> --runtime-dir C:\ProgramData\UCI Arena\lichess
```

Manager-editable configuration is restricted to capacity, inbound challenge,
outbound challenge, scheduler, and opponent-selection groups. Engine paths,
model paths, credential paths, storage paths, arbitrary UCI options, shell
commands, and unknown fields are not editable through this projection.

Rated games and automatic outbound scheduling require their distinct explicit
confirmation values. A generic Save action is not sufficient.

The catalog also publishes `qualification_run` for Manager's authenticated
desktop workflow. It is credential-free and accepts only the installer-authored
configuration and provider workspace paths that Manager appends to the fixed
operation. The provider reuses semantically compatible timing authority, runs
the installed Evidence Runtime against the exact installed Engine, publishes
content-addressed single-game and capacity evidence, and removes an incomplete
run. Manager validates the returned files under the provider workspace and
commits their locators through Suite Setup; raw paths never reach the dashboard.

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

Startup installation qualifies the exact engine, model, timing contract, and
capacity required by the selected adapter before registering anything and
before reading credentials. Timing-profile executable drift is reported as
provenance and is accepted only when the Engine-owned semantic timing identity
still matches exactly. Runtime status and per-game provenance retain both that
semantic match and the qualified-versus-current engine provenance comparison.
The packaged Windows launcher is `native/lichess_adapter_launcher.exe`;
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
single-client leases. Schema 6 adds immutable archive and completion cursors,
canonical per-ply replay snapshots, completeness evidence, content identity,
and truthfully nullable component identities. Restart reconciles active games before admitting new work.
Rate-limit cooldowns survive restart and cannot be shortened by local config.
Every 429 stops all new Lichess requests for at least one minute. Repeated
challenge-create 429s additionally open a durable challenge-only circuit up to
six hours, so event and game streams can recover after the global cooldown
without an hourly challenge probe refreshing the limiter. Version-7 configs
migrate challenge spacing below 300 seconds to that version-8 safety floor.
Runtime NDJSON logging retains a bounded current log and one rotated predecessor
inside the persistent provider workspace.

Runtime-path authority is explicit and stable: `--runtime-dir` wins when it is
supplied; otherwise an explicit `--config` path anchors persistence in that
configuration file's parent workspace. Only a development invocation with
neither option uses the component-local `runtime_state/lichess` fallback. An
installed account probe therefore cannot write into the immutable component
root, and Manager never needs to know the provider-private SQLite filename.

`backfill-game-provenance.mjs` can apply an explicitly supplied historical
evidence manifest in dry-run-first mode. Historical evidence is not committed
to this provider repository; it belongs in qualified Evidence Service output or
operator-controlled data.

## Release and provenance

Windows process-instance observations use the component's explicitly packaged
native helper through the public `@uci-arena/background-service-runtime` contract.
The identity deadline remains at most 2000 ms; lifecycle callers can supply a
smaller remaining budget. Access denial and unknown observations remain
unverifiable. There is no PowerShell identity fallback or helper prewarm.
The immutable 1.2.0 snapshot is pinned to Engine source
`a535772f818eba76473e4f931dcfc7b764f0c6c5`; `vendor/upstream.lock.json` binds every
source file. Runtime packages contain the public JavaScript closure and the
Windows helper, while source tests and vendor provenance history remain outside
the payload. Windows builds produce the helper and provider launcher in two
independent roots with the application-local static C++ runtime, then verify
exact native output and packaged current-instance query behavior.

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
