# Bounded provider maintenance recovery

**Goal:** Recover abandoned lifecycle work only after exact process/API ownership and authenticated empty remote-work proofs, without starting engines or issuing account mutations.

**Architecture:** A separate provider maintenance command runs before engine qualification. Existing store lease/cooldown owners remain authoritative. A non-migrating, non-pruning store mode and one exact guarded transaction preserve prior work/history on rejected admission. Startup lifecycle remains credential-free; replacement compensation is a separate subsequent slice using the canonical scheduler capability.

**Spec:** `specs/lichess_match_scheduler_v1.yaml`, `specs/suite_lego_boundaries_v1.yaml`, and the owner-approved maintenance clarification. Existing Installer transactional convergence governs the later compensation slice.

**Tech:** Maintained Node SQLite, existing provider LichessClient/ApiSafetyCoordinator and public exact process-instance query; no engine, C++, GPU, event stream or scheduler.

- [x] TDD storage admission and guarded completion: no migration/pruning; reject gate/count/owner/lease/process drift; preserve history; atomic claim/release after proofs.
- [x] TDD bounded recovery orchestration: dead/reused identity only, exclusive current lease, account identity, challenges then playing empty, pending/ambiguous/scope/network/cancel deferral, truthful cleanup.
- [x] Add the explicit credentialed maintenance CLI/contract before engine preflight. Return only closed recovered/deferred/failed facts; no private IDs or raw errors. Include runtime module in release closure.
- [ ] Run focused tests and full checks, freeze a draft PR, request independent review. No installed or real API operation before review.

Review focus: expired leases do not prove dead processes; incomplete remote facts do not prove absence; deferred work must not reset counts; final commit must reject races; cleanup/commit uncertainty must not be called recovered. Credentials are read only inside Bot through the external blind locator and never enter diagnostics.

Observed RED→GREEN: ordinary construction pruned an expired reservation; maintenance mode preserves it. Constructor projection failure leaked a database; maintenance now closes it. Lease loss allowed a subsequent authenticated request; authority refresh now precedes each read. Post-commit lease-claim failure skipped cleanup and reported deferred; tentative exact ownership is now retained and uncertain claim remains failed. A fresh ambiguous challenge after remote reads now rejects reclamation. Guarded CLI fixtures prove no engine/child or account mutation and retain confirmed completion when final storage close fails.

The existing schema validators admit both current storage and an intact schema-five lifecycle extension without migration. Missing database creates nothing. Manager327 public service catalog at source `3b970b96c5da995f77e6c2a5be8fe04647c6d328` accepts numeric major-1 contract versions and a generic operation map with minimum required operations; service and operations versions therefore evolve together to 1.2. Historical 1.1 contracts remain compatible; no Manager UI change is part of this slice.

Final source verification: focused 32/32 and `npm run check` 709 total / 703 pass / 6 explicit artifact skips, zero failures, on Node26.11.1. Existing public tests reuse unchanged qualified native helpers where available; this slice creates no new native qualification. Dispatch-time lease loss was separately observed RED→GREEN through the existing request queue's beforeDispatch capability. No installed provider query/mutation, real API, credential-content inspection or GPU operation was performed.
