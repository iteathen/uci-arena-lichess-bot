# Continuous Local Live Qualification Profile v2 Implementation Plan

> **For agentic workers:** Execute this plan inline with superpowers:executing-plans and test-driven-development. Producer contract coordination and independent review remain separate work packets.

**Goal:** Admit one independently qualified continuous-search Engine child for protected local live play through a new profile contract without changing historical profile, timing or diagnostic meanings.

**Architecture:** Engine owns the immutable continuous complete-game diagnostic and UCI lifecycle/focus evidence. Bot validates those public artifacts, exact local file and process identities, independent legal streamed state, transport constraints and child resource closure. A separate consumer module holds the new versioned qualification rules; existing v1 dispatch retains its historical validation.

**Tech Stack:** Node.js 24.15.0, ESM, built-in node:test, existing exact-file authority and chess-legality adapter, public UCI process boundary.

**Spec:** specs/00_READ_FIRST.yaml, specs/lichess_match_scheduler_v1.yaml and specs/move_submission_timing_boundary_v1.yaml. The Engine-owned uci_continuous_complete_game_diagnostic_v1 closed public schema is a prerequisite still being coordinated; dependent coding starts after that interface is settled.

## Global Constraints

- Scope is local_live_safety only. Timing production, strength, performance, release and installation authority remain false.
- Existing uci_arena_single_game_profile_v1, complete-game v3/v4 and uci_time_profile_v3 retain their declared meanings.
- Bot never imports Engine source. Dependencies cross through immutable public artifacts and UCI.
- Exact executable, model/checkpoint/adapter, requested/effective GPU provider, numeric/runtime/hardware identity, effective options, timing profile and configured book/tablebase identity must agree.
- Publication samples read-only current-focus evidence while continuous search remains active; no global inference drain or requirement that every eligible legal move has completed work.
- Actual native final search receipt and actual unsignalled zero-code child exit plus stdio close are separate required facts. Receipt zeros do not assert evaluator/provider destruction.
- Original provider workspace, API leases, cooldowns and SQLite history are preserved. Tests use owned temporary directories, fake engines and loopback API only.
- No live launch, credential access, release or installation in this work packet. Root later authorized one coherent 1.0.32 candidate version in the final review/CI source.

## Review Focus

- Missing/unknown/contradictory new-schema facts reject without falling back to historical semantics.
- All legal candidates remain eligible despite partial completed seeding; wrong focus rejects even if the resulting move is independently legal.
- Ordinary focus/publication transitions preserve search, worker, evaluator, queue/cache owner identities; replacement or forced close cannot pass.
- Applied timing and knowledge-source runtime facts must match exact immutable files, not merely loaded hashes.
- Empty, all-NUL, malformed, oversized or substituted evidence rejects before mutable authority or credentials are used.

## Tasks

### Task 1: Pin public producer and scoped timing contracts

Validate the final Engine-owned public schema and time-profile-contract 1.3 operations, copy the reviewed snapshot only after root accepts it, and record canonical LF Git blob provenance. Keep actual producer source_files verification on raw file bytes. Expected: exact snapshot checks pass; no Git execution or external source imports in Bot.

### Task 2: Validate completed diagnostic semantics

Protect canonical replay, full legal candidate eligibility, actual accepted history, owner continuity/capacities, truthful resolved publication sources, declared movetime bounds and true final receipt/process closure. Command: exact Node24 `--test publish-single-game-profile.test.mjs`; expected all publisher legacy and v2 controls pass.

### Task 3: Publish and load the closed local profile

Dispatch v2 explicitly, retain v1 semantics, validate private-path boundaries before IO and bind the exact current file closures. Copy immutable evidence only after all gates pass. Expected: rejected source/model/focus/authority evidence never replaces prior profile; NUL and unknown schema reject.

### Task 4: Qualify one continuous runtime child

Require exact launch context/effective options/current knowledge and actual accepted/applied scoped timing status. Use one go movetime500, one public read-only full candidate query and bounded lossless runtime observation, with no drain or OwnBook alteration. Command: exact Node24 `--test continuous-uci-observation.test.mjs`; expected startup and focus/candidate negatives pass.

### Task 5: Bind child cleanup and capacity evidence

Require actual native join receipt separately from zero unsignalled child exit and stdio close. Capture actual OS instance; compare resource owner IDs only within each child game. New inner continuous capacity schema remains bound by outer capacityv2's exact profile hash. Expected: missing receipt, failed execution, wrong lineage, nonzero/forced/unobserved close and duplicate child instances reject before capacity publication.

### Task 6: Verify actual game and packaged public boundary

Actual publication remains independently legal, current-history/focus fenced and governed by existing timing telemetry with score optional. Run real protocol child plus GameSession/LichessClient loopback move POST and normal cleanup. Stage only declared component closure and explicit qualified public helper; never overwrite the source helper. Command: exact Node24 `--test continuous-uci-observation.test.mjs component-closure.test.mjs`; expected loopback and real OS child capture pass.

### Task 7: Reconcile documentation and freeze for review

Run spec preflight and every routed authority, four owning checks and full exact Node24 suite. Inspect full diff/new files; pin final schema/package closure; commit one coherent implementation and attach frozen draft PR for independent root/reviewer review. Root authorized one coherent candidate version 1.0.32 in the final reviewed source; no release, install or live launch by this implementer. Expected: exact head checks are green and limitations are stated without claiming actual Engine/model qualification.

### Completion checklist

- [x] Confirm and pin the Engine-owned public closed schema, evidence bounds, actual lifecycle receipt and public focus/owner UCI fields with producer and reviewer.
- [x] Add separate continuous-game-qualification.mjs consumer validation and negative/positive contract fixtures; prove RED then GREEN. Avoid generic framework or duplicated chess truth.
- [x] Add v2 publication and closed load/apply dispatch in publish-single-game-profile.mjs and lichess-adapter.mjs. Restrict to local_live_safety, reuse exact immutable publication, preserve v1 behavior, and test authority drift/NUL/unknown fields/unchanged prior profiles.
- [x] Add bounded v2 runtime qualification through legal publication and continuity sampling. Preserve actual partial seeding and all-candidate eligibility. Test wrong focus, candidate omission, owner replacement, resource overflow and bounded ongoing work.
- [x] Join native shutdown receipt with actual child process/stdout closure in qualification/capacity flow. Keep outer capacity v2 exact profile/timing bindings and reject missing/failed/forced shutdown proof before artifact replacement.
- [x] Validate real game publication against current canonical legal state and native focus, existing timing applicability and optional scores. Run complete fake extended child plus loopback API move POST/normal cleanup and stale-generation negative cases.
- [ ] Update owning spec/README to the implemented contract, run exact Node24 full tests and owning checks, inspect full diff, freeze a draft PR and hand exact head to root for independent review.

## Current Boundary

The public diagnostic schema and nine-file source manifest are pinned from accepted Engine 770099de00427ab800ea1b1d203205fe89c47e26 as canonical UTF8 LF Git blobs. Their raw producer source hashes remain distinct observations. Public time-profile contract 1.3 and all 22 vendor Git blobs are pinned from accepted f72d6da36973f136117c29394e06392f8094e13d. Original Bot base is e219d149ecb9237c35f9261fca5b757f43863774; isolated candidate branch is codex/continuous-local-live-profile-v2, version 1.0.32.

Completed checks cover canonical repetition prefixes (including the base position), raw en-passant FEN, selected publication ply, full candidate eligibility with partial/unexpanded seeds, fixed-container ownership/capacities, first natural terminal transition, declared startup/model/opponent movetime bounds, exact source membership/bytes, native selected/required model asset declaration, public metadata extras and private-path rejection before IO. Actual native receipt and child exit/stdio close are separate proofs; bounded nonzero final tickets remain honest telemetry.

Startup/current game runtime validation executes the public scoped timing owner, full actual declarations/options, model inputs and book/tablebase activation. A scoreless legal move was posted through GameSession/LichessClient to loopback. Fresh actual game baselines reset only at genuine ucinewgame, including opponent-only admission. Capacity v2 round-trips require the new continuous inner schema, native model declaration, applied timing scope/envelope and actual child cleanup; drift rejects before replacement and when loading retained evidence.

Final exact Node24 suite: 509 passed, zero failed, two existing optional skips (511 total). All four owning checks passed. Staged declared component closure used explicit signed public helper SHA0a0449e584211c136f7db45029f0aaa5545f975c71703db2f857f6dc013287fc without replacing the source helper. These are conformance checks, not actual Engine/model safety qualification or a release receipt.

Ready to freeze a draft PR for independent root review. The actual 650ms-overhead/500ms urgent native publication currently lacks its emitted focus fence and is correctly rejected by a focused Bot control; its independent Engine-owned repair remains necessary before the final actual pair/profile/capacity/live proof. No failed pair, fixture evidence or installed receipt is promoted.

Review follow-up to frozen 0009a306: known protected filename/directory forms and every colon in relative model declarations now reject before all fileAuthority operations, while absolute Windows drive context remains valid. Capacity cohort uniqueness delegates to sameProcessInstance, so Windows case/separator aliases cannot count one child twice; a distinct start token remains a different instance. Synthetic controls were RED then GREEN without private files or real child launches. Follow-up exact Node24 suite: 522 passed, zero failed, two existing optional skips (524 total); all four owning checks passed. Candidate version and public provenance pins remain unchanged.

Narrow absolute-role follow-up to f599a73: safePublicPath now allows only the sole leading Windows drive colon and rejects every other colon for all filesystem roles. Literal C:/public/model.onnx:auth.json controls in producer runtime, executable and configured-book roles reproduced hash reachability, then rejected with zero fileAuthority calls. Generic exact-file behavior, private-name policy, version and pins remain unchanged. Exact Node24: 525 passed, zero failed, two existing optional skips (527 total); all four owning checks passed.
