# Continuous timing profile v4 adoption implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Root owns independent exact-head review, merge, signed publication, installation and real qualification.

**Goal:** Bot1.0.36 consumes the accepted Engine-owned continuous timing profile v4 and can atomically adopt genuinely qualified operator evidence paths without losing existing policy or rewriting historical v3 truth.

**Architecture:** Keep the current timing, single-game, capacity and configuration owners. Dispatch explicitly by stored timing schema and declared validation scope to the public SDK operation that owns that regime. Extend the existing atomic config-update operation to adopt named evidence paths and validate the complete effective bundle before activation.

**Tech stack:** Node24.15.0, existing public time-profile SDK vendor closure, current exact-file publisher, existing Bot tests and Windows signed helper.

**Spec:** Bot specs/lichess_match_scheduler_v1.yaml and specs/move_submission_timing_boundary_v1.yaml; Engine accepted specs/continuous_time_profile_qualification_v1.yaml and SDK1.5 API. Only reviewed/merged upstream bytes may enter vendor or public-schema provenance snapshots. Root's explicit repair authorization supplies execution and review authority; no additional human design approval is required.

## Global constraints

- PROFILE_SCHEMA and historical searched-regime APIs retain v3 meaning. New CONTINUOUS_TIME_PROFILE_SCHEMA is uci_time_profile_v4; native temporal contract5 only.
- New v4 required gates are continuous_case_population/focus_candidates/publication_fence/live_resource_bounds/joined_completion/normal_close/search_work/async_provider_work/temporal_compatibility_passed. SDK owns their admission truth.
- All five cases, four overheads250/650/700/1500 and at least30 repetitions remain required. Actual non-search resolutions do not enter searched elapsed calibration.
- Permissions remain explicit: no allocation strategy, minimum useful block, adaptive timing, provider default tuning or strength promotion authority is inferred.
- Existing full single-game-v2 canonical/focus/lifetime/knowledge/actual timing and child-close gates remain. Capacity keeps its schema and exact inner profile hash binding. No old artifact retagging, synthetic evidence promotion or new scheduling behavior.
- No GPU/live/credentials/install/runtime-config writes during development. Tests own temporary files only. Original workspaces/history remain unchanged.

## Review focus

- A v3 profile with false historical gates must still reject; v4 never repairs that artifact by reinterpretation.
- Schema4 with historical scope, schema3 with continuous scope, unknown schema/scope or missing applied facts must reject without fallback acceptance.
- Native4, changed provider/model/runtime/options/knowledge and wrong actual applied reserves must reject v4.
- A stale saved evidence bundle must not prevent adopting a complete fresh bundle through the public atomic operation, but invalid replacement paths must never modify the config.
- A concurrent configuration edit must survive a rejected adoption; no overwritten target, lost policy, new process or hidden two-slot admission is allowed.

## Task1: Explicit v4 timing consumer

**Files:** vendor/time-profile-contract closure and vendor lock; tools/verify-vendor-lock.mjs; tools/contract-check.mjs; single-game-profile-validation.mjs; continuous-game-qualification.mjs; lichess-adapter.mjs; publish-single-game-profile.mjs; owning specs; existing timing/publisher/runtime tests. Update accepted public diagnostic schema/source provenance only when its Engine owner merges the new explicit timing binding.

**Consumes:** CONTINUOUS_TIME_PROFILE_SCHEMA; validateContinuousSearchedRegimeRuntimeSnapshot(input); validateAppliedContinuousSearchedRegimeTimeProfileReserve(input). New result schema uci_time_profile_continuous_searched_regime_runtime_status_v1 and scope continuous_searched_regime. Existing v3 API remains distinct.

- [x] Write actual configureTimeProfile v4 fixture control from the public owner's draft conformance fixture; keep historical-v3 gate rejection control.
- [x] Run focused tests under accepted SDK1.4: v4 RED at real Bot runtime boundary with unexpected profile schema; historical false-gate rejection GREEN. This is synthetic test data only.
- [x] Once SDK1.5/public schema are reviewed and merged, copy exact Git blobs through the current vendor-lock workflow and verify complete closure, preserving canonical-LF provenance versus raw artifact bytes.
- [x] Admit v4 only through single-game-v2 continuous qualification routes; retain legacy v1 publisher and v3 gate/API meaning. Enforce repetition/provider/model/search bounds with existing shared validator and the SDK's exact v4 gate owner.
- [x] Dispatch actual configure and every runtime applied-context check by coherent timing schema/scope. Preserve full actual OwnBook/Ponder/overhead/options/provider identity, reserve reset on rejection, and exact applied schema evidence.
- [x] Add false/missing v4 gates/population/authority, native4, mismatched schema/scope, provider identity and applied reserve negatives; replay v3/v3 and native4/4 compatibility controls. Cover real publisher/loader/startup/context paths with synthetic fixtures and loopback only.

## Task2: Atomic evidence-path recovery

**Files:** existing updateManagerOptions and config-update CLI in lichess-adapter.mjs; existing policy/config tests; README and owning config rules.

**Consumes:** Existing public --profile/--time-profile/--capacity-profile flags as explicit named local artifact references plus current --settings input. Uses the current exact-file config publisher, full single-game/time/capacity validation and immutable engine/model/manifest bindings.

- [x] RED: saved obsolete/invalid evidence fails current public update; valid fresh bundle plus capacity1 policy should be adopted through config update. Repeat with unchanged capacity shape to prove adoption still validates.
- [x] Support explicit evidence adoption atomically with policy settings. Normalize paths, reject invalid/missing effective inputs and validate the complete effective evidence/runtime/capacity before activation. Keep the exact original target identity guard. No ambient environment adoption or fabricated Installer locator/receipt.
- [x] GREEN: sixteen controls prove old stale evidence can recover; invalid/missing replacement, wrong executable/model/time/profile/capacity, forbidden paths and a concurrent target edit leave the target unchanged or preserve the concurrent writer. Three existing policy/confirmation controls remain green. Test evidence is synthetic and grants no real qualification authority.
- [x] Document genuine sequence: qualify exactly one child with explicit fresh runtime/evidence CLI overrides while old saved total2 remains unstarted; then atomically adopt fresh paths with honest one-bot capacity1 (human0/borrowingfalse/publicfalse, bot1/target1, parallel1). Startup repeats actual native validation and enforces global max1. Existing Manager update schema stays closed; named adoption is explicit local CLI only. Future Installer rendering still regenerates runtime paths from its real context.

## Task3: Coherent freeze and release handoff

- [x] Reconcile version1.0.36 package/lock/component/service/test surfaces after implementation is complete; service/Manager API majors and scheduler semantics stay unchanged.
- [x] Run meaningful focused tests, all four owning checks, preflight and diffcheck, then full exact Node24 suite with explicit official helper0a. Native rebuild only if native owned closure changes.
- [ ] Report exact diff/tree/results before commit, freeze one coherent PR and request independent exact-head review. Root guards merge; official signed candidate can run only after the approved exact merge.
- [x] New final cohort is Engine0.1.18/Bot1.0.36/Runtime0.3.10/Suite0.3.47, with six other rows unchanged. Retain signed017/135/039/Suite046 media as immutable held recovery evidence.

Accepted upstream pin: Engine40fb4a494b89ce6c90152513e3a8fe8eb549be40, SDK1.5.0 and public schema copied from exact Git blobs; full22-file vendor closure matches. Final diff review restored baseline chess.js1.4.0 lock metadata after an accidental broad version replacement; no dependency upgrade.
