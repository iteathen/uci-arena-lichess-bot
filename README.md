# UCI Arena Lichess Adapter

This credential-free Node module owns Lichess transport, capacity admission,
bot discovery, owner reservations, per-opponent evidence, and one isolated UCI
process per game. It does not add Lichess behavior to the chess engine.

The module uses Node built-ins only. Node 24.15 or newer is required for the
built-in SQLite store.

## Default behavior

The tracked v3 template is enabled for two concurrent games:

- one hard-reserved public-human slot, never loaned to automated bot play;
- one bot slot which the scheduler tries to keep active;
- casual standard `3+2` outbound games;
- online bot discovery through `GET /api/bot/online?nb=512`;
- a two-game-per-opponent rolling daily limit and decline/timeout cooldowns.

Change `capacity.human.slots`, `capacity.bot.slots`, and
`capacity.bot.target_active` to run a different layout. Their sum must equal
`capacity.total_slots`. A larger layout, including 16 or more slots, is accepted
only after the exact engine/model/provider/hardware combination has a matching
capacity profile qualified at that concurrency.

## Files

- `config.uci_arena.template.yml`: credential-free v3 capacity and policy.
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

```powershell
node deploy\lichess\lichess-adapter.mjs qualify `
  --profile runtime_state\models\<MODEL_ID>\cache\uci_arena_single_game_profile_v1.json
```

Qualify the configured concurrency. All requested children are started and
searched concurrently, must retain the selected GPU provider and V2 telemetry,
and are then closed cleanly. The resulting profile is bound to the executable,
single-game profile, model, provider numerics, and hardware/driver identity.

```powershell
node deploy\lichess\lichess-adapter.mjs capacity-qualify `
  --max-concurrency 2 `
  --capacity-profile runtime_state\models\<MODEL_ID>\cache\uci_arena_lichess_capacity_profile_v1.json
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
reconnects rebuild the position from Lichess's authoritative move list. A whole
process restart performs the same recovery before admitting new work.

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
- Move submissions have priority over discovery and challenge traffic. HTTP 429
  responses pause non-move traffic for at least 60 seconds.
