# UCI Arena Lichess Adapter

This directory owns the Node deployment adapter between the Lichess Bot API
and UCI Arena. The adapter keeps all Lichess transport, challenge filtering,
game reconstruction, and UCI process orchestration outside the C++ engine.

The adapter uses only Node built-ins. It does not require a Python bridge or
third-party runtime package.

## Files

- `config.uci_arena.template.yml`: credential-free JSON-compatible YAML for
  engine paths, UCI options, incoming challenge policy, and the optional
  outbound challenge.
- `lichess-adapter.mjs`: authenticated account probe, NDJSON stream handling,
  challenge lifecycle, game sessions, and persistent UCI engine ownership.
- `smoke-uci-startup.mjs`: local readiness smoke that does not contact Lichess
  and does not read any token file.

## Account Requirement

Lichess Bot API play requires a BOT account. Lichess only permits conversion
before an account has played any game, and conversion is irreversible. Create
a fresh dedicated account if the intended account has already played.

## Setup

1. Build the release engine:

   ```powershell
   cmake --build build --config Release --target flashfork_uci
   ```

2. Verify local UCI startup and configured options:

   ```powershell
   node deploy\lichess\smoke-uci-startup.mjs `
     --config deploy\lichess\config.uci_arena.template.yml
   ```

3. Probe the authenticated BOT account. The adapter reads the token internally
   and never places it in config, argv, logs, or tracked files:

   ```powershell
   node deploy\lichess\lichess-adapter.mjs probe `
     --token-file secrets\lichess_bot_token.txt `
     --expected-account <LICHESS_ACCOUNT>
   ```

4. Start the adapter to accept supported incoming challenges:

   ```powershell
   node deploy\lichess\lichess-adapter.mjs run `
     --token-file secrets\lichess_bot_token.txt `
     --expected-account <LICHESS_ACCOUNT>
   ```

   Add `--opponent <LICHESS_ACCOUNT>` to send one casual standard `3+2`
   challenge after the event stream is connected.

## Runtime Policy

- One casual standard game runs at a time.
- Incoming rapid and classical challenges from humans or bots are accepted
  when their clock is between `3+0` and `30+10`.
- Rated, correspondence, non-standard, and concurrent challenges are declined.
- The adapter starts one persistent UCI process per game, applies only
  advertised options, reconstructs `position startpos moves ...`, forwards the
  live clocks through `go wtime ...`, and submits only a valid UCI `bestmove`.
- Move telemetry is emitted as token-free JSON lines.

## Guardrails

- Do not read, print, validate, or summarize
  `secrets/lichess_bot_token.txt`; pass its path only to the adapter process.
- Do not commit credentials, account handles, generated runtime metadata, or
  game output.
- Keep Lichess integration outside `engine/src` and `engine/include`.
- Keep model artifacts in `engine/runtime/models`; override `ModelRoot` at
  invocation time when needed.
