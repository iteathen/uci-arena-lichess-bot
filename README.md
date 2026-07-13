# UCI Arena Lichess Bot Bridge

This directory contains the Lichess deployment adapter surface for UCI Arena.
It targets the existing `lichess-bot` UCI bridge and does not implement a
custom Lichess API client.

## Files

- `config.uci_arena.template.yml`: engine block/template values to merge into a
  local `lichess-bot` `config.yml`.
- `smoke_uci_startup.py`: local readiness smoke for the engine command in the
  template. It does not contact Lichess and does not read any token file.

## Setup

1. Build the release engine:

   ```powershell
   cmake --build build --config Release --target flashfork_uci
   ```

2. Copy or merge `config.uci_arena.template.yml` into your local
   `lichess-bot` `config.yml`.

3. Replace placeholders outside Git:

   - `<UCI_ARENA_REPO>`: absolute path to this repository.
   - `<LICHESS_OAUTH_TOKEN>`: Lichess OAuth token value in the local
     `lichess-bot` config only.

4. Keep live configs untracked. `deploy/lichess/config.yml`,
   `deploy/lichess/config.local.yml`, `*.local.yml`, and `*.token` are ignored.

## Local Readiness Smoke

Run this before attempting live bot play:

```powershell
python deploy\lichess\smoke_uci_startup.py --config deploy\lichess\config.uci_arena.template.yml
```

The smoke replaces `<UCI_ARENA_REPO>` in memory with the current repository
root, starts `build/Release/flashfork_uci.exe`, applies the template UCI
options, waits for `uciok` and `readyok`, then asks for `go depth 1` from the
starting position.

## Guardrails

- Do not commit a live `lichess-bot` config containing credentials.
- Do not read, print, validate, or summarize `secrets/lichess_bot_token.txt`.
- Keep Lichess integration outside `engine/src` and `engine/include`.
- Only list UCI options that `flashfork_uci.exe` advertises during startup.
- Do not copy model binaries into this directory; the template references the
  existing `engine/runtime/models` layout through the engine working directory.
