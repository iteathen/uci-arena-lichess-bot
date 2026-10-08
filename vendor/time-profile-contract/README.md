# UCI Arena Time Profile Contract

This package provides the shared validation/identity contract for the **existing** UCI Arena timing-profile artifacts consumed across the suite.

## Current authority

`uci_time_profile_v3` retains its existing meaning: it is an identity-bound timing/search execution qualification artifact covering the provider/runtime/topology/deadline and related calibration evidence declared by that schema.

It is **not** silently redefined as the future population-derived move-time policy described by `specs/move_time_applicability_v1.yaml`.

In particular, `uci_time_profile_v3` does not gain new implicit authority for:

- minimum useful timing blocks;
- allocation-strategy identity or parameters;
- current-game clock composition;
- timing applicability for non-search-resolved moves;
- book or tablebase move-resolution semantics;
- search attention, depth, graph topology, queues, batching, or work allocation.

## Explicit historical searched regime (1.3.0)

`validateHistoricalSearchedRegimeRuntimeSnapshot(input)` and
`validateAppliedSearchedRegimeTimeProfileReserve(input)` accept the existing
runtime validator input shape, including the actual `configuration` and native
`status`. They return `uci_time_profile_searched_regime_runtime_status_v1`.
The original exact validator and every v3 profile retain their meanings.

This narrow operation supports a v3 MCGS searched regime qualified with
`ownBook=false` while the actual runtime enables downstream book resolution.
Both configured and native book prior weights must be zero. The operation checks
the actual book flag against native `opening_book_enabled`, preserves every
material model/provider/tablebase/search option, and projects only the declared
downstream book-resolution fields internally. A hint or constraint still leaves
the final choice search-derived. Only an actual resolved move bypasses timing.

The caller must provide truthful `ponderOption=true` and `moveOverheadMs` matching
native `ponder_option_configured` and `move_overhead_ms_configured`. Ponder must
match the historical true publication compatibility declaration. Actual transport
overhead must lie in the profile's existing qualified envelope; the operation
returns the actual value and the declared minimum, maximum and tested values.
It creates no transport substitution policy or new timing qualification.

Results distinguish `searched_regime_timing_authority_match` from
`whole_runtime_timing_authority_match`; the latter is false when the actual book
flag differs. They do not expose the old ambiguous `timing_authority_match` field.
Applied reserve validation takes the same actual inputs and revalidates this
scope before checking provider/emit reserves and forecast scale. Neither operation
mutates its inputs or grants adaptive timing, strength or deployment authority.

## Native timing identity support (1.4.0)

The SDK recognizes `persistent_mcgs_relative_clock_temporal_v4` and
`persistent_mcgs_relative_clock_temporal_v5`. `TIME_POLICY_VERSION` identifies
the current version 5; `SUPPORTED_TIME_POLICY_VERSIONS` lists the exact supported
versions. Profile construction records the captured native version and includes
it in the search-contract fingerprint. Version 5 identifies the changed graph
retention and evaluation-admission regime; it does not redefine profile schema v3.

A version 4 profile remains valid for an otherwise matching version 4 runtime.
It cannot authorize a version 5 runtime, and the converse also fails. Runtime
snapshot validation and v3 applied-reserve validation require matching native
and profile versions. Missing or unknown versions fail closed. New version 5
profiles require their own qualification; SDK support grants no new evidence,
allocation-policy, adaptive-play, strength, or deployment authority. Existing
schema v1/v2 stored-profile compatibility remains unchanged.

## Explicit continuous execution qualification (1.5.0)

`CONTINUOUS_TIME_PROFILE_SCHEMA` identifies `uci_time_profile_v4` under the exact
`continuous_mcgs_provider_deadline_v1` regime and native timing version 5.
`PROFILE_SCHEMA` remains version 3. The producer opts in with
`--qualification-contract continuous-v4 --referee <native executable>`; existing
version-3-only consumers keep their declared defaults.

Version 4 requires every declared continuous gate and actual coverage of all five
cases, four qualified overheads, and at least 30 repetitions per cell with one
cold and the remaining warm process samples. It observes complete canonical legal
candidates, current native publication fences, bounded live resources, positive
aggregate searched execution/provider work, genuine joined completion, and normal
child close. It does not require short publication waits to stop neural admission
or execution-lifetime root evaluation totals to remain at one. Actual non-search
resolutions are classified separately and excluded from searched calibration.

`validateContinuousSearchedRegimeRuntimeSnapshot(input)` and
`validateAppliedContinuousSearchedRegimeTimeProfileReserve(input)` accept version
4 only and return `uci_time_profile_continuous_searched_regime_runtime_status_v1`
with `validation_scope=continuous_searched_regime`. Historical searched-regime
operations remain version 3 only. Actual downstream book resolution composes with
zero book prior and unchanged exact material/runtime/overhead identity in both
operations; it grants no new move-allocation semantics.

Permissions remain provider safety and forecast shadow only. Version 4 explicitly
declares false adaptive timing, allocation strategy, minimum useful blocks,
predictive-controller promotion, default tuning, and strength authority. It is
implemented compatibility support until an actual native probe qualifies a target;
unit fixtures, release signatures and this SDK do not establish that evidence.

## Future policy evolution

The future timing-policy artifact must be introduced through an explicit versioned contract after its owning Evidence/Engine specifications are implemented and qualified.

That policy is expected to preserve three distinct authorities:

1. current game time remains runtime authority over feasibility and opportunity cost;
2. qualified minimum useful timing blocks are evidence authority over supported additional elapsed-search purchases;
3. the allocation strategy that composes those and other material timing pressures is a versioned evidence-qualified policy result.

Existing v3 profiles may remain supporting execution/provider/deadline evidence for a later policy, but they do not become that policy merely because the artifacts are related.

## Consumer rule

Consumers must validate the exact declared schema/version and use only the authority that schema publishes. Do not infer compatibility or new semantics from filenames, structurally similar JSON fields, UCI option names, or an older artifact's successful qualification.

A new timing-policy major/schema requires explicit support in each consuming boundary. Standard UCI engines remain independent of UCI Arena timing-policy artifacts.
