# UCI Arena Lichess Adapter

This credential-free Node module owns Lichess transport, capacity admission,
bot discovery, owner reservations, per-opponent evidence, and one isolated UCI
process per game. It does not add Lichess behavior to the chess engine.

Transport, process supervision, and SQLite use Node built-ins. Exact-root move
legality uses the locked `chess.js` dependency. Node 24.15 or newer is required.

Install the adapter dependency once after checkout (and after lockfile changes):

```powershell
npm ci --prefix deploy/lichess
```

Startup fails during module loading with a missing-package error if this step
has not been completed; it never falls back to syntax-only move validation.

Live search authority is MCGS-only. A missing or rejected exact MCGS timing or
capacity profile fails startup before credential access; it never switches to
V2 or another search core.

## Default behavior

The tracked v6 template is enabled for two concurrent games:

- one hard-reserved public-human slot, never loaned to automated bot play;
- one bot slot which the scheduler tries to keep active;
- casual standard `3+2` outbound games;
- online bot discovery through `GET /api/bot/online?nb=512`;
- a two-game-per-opponent rolling daily limit and decline/timeout cooldowns.
- explicit opponent-turn UCI search, with a predicted reply using `go ponder`
  and a no-prediction fallback using `go infinite`;
- foreground search preemption of every other game’s ponder work;
- a 650 ms bootstrap Lichess transport reserve applied through the engine’s
  `Move Overhead` option.

Version 2 through 4 configurations retain their declared legacy reserve. Live
readiness requires the engine to advertise `Ponder`, `Move Overhead`,
`IterativeTimeController`, `TimeProfileProviderReserveUs`, and
`TimeProfileBackupEmitReserveUs`, `TimeProfileIterationForecastScalePermille`,
and `McgsTimePolicy`; the
adapter fails instead of silently disabling opponent-turn search or its clock
reserve.

The distinct `engine.time_profile` / `--time-profile` path may point at a
qualified `uci_time_profile_v3.json`. Every engine child recomputes the exact
engine/model/adapter/provider/hardware/search identity before applying that
profile's provider-batch, backup/emission, and iteration-forecast reserves. The
identity binds `McgsTimePolicy=RelativeClockTemporalV1`; qualification includes
a real two-clock sample proving that opponent-clock surplus and early searched
decision weighting are active. A missing, stale, mismatched, or legacy-policy
profile fails live startup before credential access and never selects V2.

Change `capacity.human.slots`, `capacity.bot.slots`, and
`capacity.bot.target_active` to run a different layout. Their sum must equal
`capacity.total_slots`. A larger layout, including 16 or more slots, is accepted
only after the exact engine/model/provider/hardware combination has a matching
capacity profile qualified at that concurrency.

## Files

- `config.uci_arena.template.yml`: credential-free v6 capacity, timing, and policy.
- `lichess-adapter.mjs`: CLI, Bot API transport, engine sessions, and recovery.
- `lichess-scheduler.mjs`: slot admission, weighted selection, and request queue.
- `lichess-store.mjs`: WAL-mode SQLite reservations, attempts, games, and W/D/L.
- `windows-startup.mjs`: hidden Task Scheduler supervision.
- `native/`: independent Windows GUI-subsystem launcher.
- `smoke-uci-startup.mjs`: local startup smoke; it never contacts Lichess.

## Qualification and run

Build the release engine and verify its UCI surface:

```powershell
cmake --build build --config Release --target flashfork_uci
node deploy\lichess\smoke-uci-startup.mjs --config deploy\lichess\config.uci_arena.template.yml
```

Validate the existing `uci_arena_single_game_profile_v1`. This local command
does not read a Lichess credential. Its telemetry probe temporarily disables
the opening book, then restores the configured/default-on book for live play.
Qualification fails unless the restored runtime reports the book enabled and
active; a successful search with a disabled or unloaded book is not deployable.

```powershell
node deploy\lichess\lichess-adapter.mjs qualify `
  --profile runtime_state\models\<MODEL_ID>\cache\uci_arena_single_game_profile_v1.json `
  --time-profile runtime_state\models\<MODEL_ID>\cache\uci_time_profile_v3.json
```

Measure MCGS simulation-worker scaling before selecting the single-game
topology. `Threads` is the MCGS worker control; `RootWorkers` is compatibility
metadata and is held fixed. The benchmark uses a fresh process per
worker-count trial, tests cold and rerooted warm graphs, verifies every move,
and only writes evidence—it does not edit or deploy a profile.

```powershell
node engine\tools\benchmark_mcgs_workers.mjs `
  --workers 3,4,6,8,10 `
  --movetimes 250,500,1000 `
  --trials 3 `
  --performance-cores 6 `
  --efficiency-cores 4 `
  --output runtime_state\models\<MODEL_ID>\cache\mcgs_worker_scaling.json
```

Qualify the configured concurrency. All requested children are started and
searched concurrently, must retain the selected GPU provider and MCGS telemetry,
and are then closed cleanly. The resulting profile is bound to the executable,
single-game profile, timing-profile identity, model, provider numerics, and
hardware/driver identity.

```powershell
node deploy\lichess\lichess-adapter.mjs capacity-qualify `
  --max-concurrency 2 `
  --capacity-profile runtime_state\models\<MODEL_ID>\cache\uci_arena_lichess_capacity_profile_v2.json
```

Probe the account, then run. Pass the token file by path only.

```powershell
node deploy\lichess\lichess-adapter.mjs probe `
  --token-file secrets\lichess_bot_token.txt `
  --expected-account <LICHESS_ACCOUNT>

node deploy\lichess\lichess-adapter.mjs run `
  --token-file secrets\lichess_bot_token.txt `
  --expected-account <LICHESS_ACCOUNT>
```

`run` validates single-game and capacity evidence before reading the credential,
reconciles `/api/account/playing`, opens one global event stream, and only then
starts scheduling. Active games are never preempted.

Global event-stream reconnects use bounded exponential backoff and trigger a
fresh ongoing-game reconciliation before scheduling resumes. Per-game stream
reconnects stop and drain stale UCI work, then rebuild the position from
Lichess's authoritative move list. A whole process restart performs the same
recovery before admitting new work.

After a move POST is acknowledged, the adapter keeps Lichess’s streamed move
list as canonical state and starts a separate projected ponder line. It sends
`ponderhit` only when the next stream update exactly appends the predicted
opponent move and the UCI runtime generation still matches. Misses, takebacks,
reconnects, terminal states, and generation changes send `stop`, drain and
discard that search’s `bestmove`, reconstruct the authoritative position, and
start a normal timed search from the new root. Stream intake remains live while foreground search
is awaited, so a terminal state, takeback, or root advance cancels that search
before a stale POST. Immediately before every POST, the adapter independently
replays the exact authoritative root with `chess.js`, proves the candidate is
legal, and records replay latency; syntax-only validation is never sufficient.
A move is never submitted before the stream says
it is this bot’s turn.

Per-move NDJSON telemetry separates `state_received_to_go_ms`,
`go_to_bestmove_ms`, `state_validated_to_post_ms`, and `post_to_ack_ms`, and
records ponder mode/hit/miss, stale-result draining, and the active transport
reserve. The runtime snapshot also reports each game’s current UCI timing mode.

## Per-game runtime provenance

SQLite schema v3 binds every new game to immutable, queryable model and runtime
identity: model id and fingerprint, checkpoint hash, adapter id, engine build,
provider/runtime/hardware fingerprints, search core, threads, root workers,
split depth, batch size/wait, timing-profile identity, and book configuration.
The `runtime_provenance_json` document additionally records every UCI option the
adapter applied, effective timing permissions/reserves, and the book state
observed after qualification. Its SHA-256 is logged with `game_ready`.
Idempotent game recovery cannot replace this identity.

Legacy rows remain blank after schema migration unless an explicit historical
evidence manifest can bind an existing engine/model/provider/book fingerprint,
bounded UTC interval, and expected game count. Backfill is dry-run-first,
transactional, refuses an active adapter lease, preserves a timestamped SQLite
backup, never overwrites non-empty identity, and records evidence plus unknown
fields instead of guessing:

```powershell
node deploy\lichess\backfill-game-provenance.mjs `
  --database runtime_state\lichess\matches.sqlite `
  --manifest deploy\lichess\provenance-history.2026-07-20.json

node deploy\lichess\backfill-game-provenance.mjs `
  --database runtime_state\lichess\matches.sqlite `
  --manifest deploy\lichess\provenance-history.2026-07-20.json `
  --apply
```

## Human priority and local controls

Owner handles live only in `runtime_state/lichess/matches.sqlite`; they are not
tracked config. Local control commands do not load the config or token.

```powershell
node deploy\lichess\lichess-adapter.mjs owner add --username <LICHESS_ACCOUNT>
node deploy\lichess\lichess-adapter.mjs owner list
node deploy\lichess\lichess-adapter.mjs reserve --opponent <LICHESS_ACCOUNT> --games 1 --minutes 15
node deploy\lichess\lichess-adapter.mjs reservation status
node deploy\lichess\lichess-adapter.mjs reservation cancel
node deploy\lichess\lichess-adapter.mjs scheduler status
node deploy\lichess\lichess-adapter.mjs scheduler pause
node deploy\lichess\lichess-adapter.mjs scheduler resume
```

A reservation claims the next human slot for its owner and survives restart.
Other human slots remain public. It never interrupts an active game.

## Background service on Windows

Build the independent no-console launcher, then install the hidden logon task.
The launcher supervises the foreground Node process so closing a console cannot
stop the adapter and Task Scheduler can restart genuine failures.

```powershell
cmake -S deploy\lichess\native -B deploy\lichess\native\build -A x64
cmake --build deploy\lichess\native\build --config Release

node deploy\lichess\lichess-adapter.mjs startup install `
  --token-file secrets\lichess_bot_token.txt `
  --expected-account <LICHESS_ACCOUNT>

node deploy\lichess\lichess-adapter.mjs startup status
node deploy\lichess\lichess-adapter.mjs startup uninstall
```

Operational state is under `runtime_state/lichess`: `runtime.json`,
`adapter.ndjson`, `matches.sqlite`, and startup evidence. SQLite is the durable
source for opponent W/D/L, challenge outcomes, owner reservations, and pause
state.

## Guardrails

- Never read, print, inspect, or copy `secrets/lichess_bot_token.txt`; pass its
  path only to the adapter.
- Do not commit credentials, account handles, SQLite/runtime state, logs, model
  artifacts, capacity evidence, or generated native build output.
- Keep Lichess integration outside `engine/src` and `engine/include`.
- A pending accept/challenge owns a slot and qualified engine before any API
  action. Decline, cancellation, timeout, terminal game, or failure releases it
  exactly once.
- Move submissions have priority over discovery and challenge traffic, but no
  request bypasses an HTTP 429 cooldown.
- All finite API exchanges and stream handshakes are started one at a time.
  Established event/game streams stay open while finite move and control calls
  use the same serialized dispatcher.
- Any HTTP 429 pauses every new API request for at least 60 seconds. Consecutive
  responses back off through 60 seconds, 2 minutes, 5 minutes, 15 minutes, and
  60 minutes; a longer valid `Retry-After` wins. The cooldown survives restart,
  cannot be shortened by configuration, and never blindly replays a write.
- A SQLite heartbeat lease rejects a second adapter for the same API origin and
  expected account before credentials are read or Lichess is contacted.
- Opponent-turn calculation is useful speculative work, not canonical game
  state. Only the full Lichess stream can confirm a move or advance history.
