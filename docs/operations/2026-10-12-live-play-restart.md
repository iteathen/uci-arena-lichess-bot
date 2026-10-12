# Live play restart and paused repair handoff

The owner paused broader repairs on 2026-10-12 UTC. Only Lichess operability
work remains authorized until further notice.

Bot 1.0.47 and cuda-js Vector 0.1.5 are installed from the previously reviewed,
officially signed provider archives. All eight installed component inventories
passed validation (990 declared files). The new runtime was observed connected,
ready, scheduler enabled and unpaused, with one active game:
https://lichess.org/fjz2TZyK against sseh-c. The public archive identifies the
new provider and engine versions and records live plies.

The active configuration uses the packaged Vector launch profile with
AutomaticThreefold=true, RequireTimingPolicy=true and the qualified 180+0
control. Capacity is one bot game, zero human slots. Automatic bot discovery
and invitations are enabled; the ten-second eligible decline/cancel retry is
included in 1.0.47. This observation establishes live operability, not playing
strength or general timing qualification outside the admitted control.

The component update left the old Vector 0.1.4 path in the bot configuration.
The operator regenerated configuration through the provider's declared
installer-integration context/result contract using the installed 0.1.5
manifest and launch profile, retained the original configuration, validated
the provider inactive before replacement, then enabled startup through its
public CLI. No credentials were inspected. Archive count advanced from 714
to 715 when the new game began.

Broader Installer and Evidence changes are committed and pushed as unfinished
WIP, without merge, release or deployment:

- Installer: f316f44f1ca9ef8c6970d38f6d0d225ba3e7b184 on
  agent/manager-package-recovery-20261012. The late package failure recovery
  guarantee remains unimplemented; latest edits are unqualified.
- Evidence: fb467719ddf1e262f2023562fa9774ced1443f1c on
  codex/evidence-stop-repair-20261011. The staged lifecycle bridge remains
  unfinished with an intentionally failing test. Earlier tests which escaped
  Task Scheduler isolation are excluded. The installed Evidence startup task
  was restored through its public CLI and its 47 datasets/two targets remained
  present, with collection paused.
- Generic SDK 1.4.0 owned-incarnation stop is independently reviewed and
  merged at ed21a5361b7dc80ac36fa27d66f9f81018b34305. It is not yet deployed
  through a newly signed Evidence payload.

The bot remains running and archives games without an active coding agent.
Do not resume broader repair work, deploy WIP, or revive C++ chess/search work
without new owner direction.
