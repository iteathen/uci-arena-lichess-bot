# Shared Agent Operating Standard

Version: `2026-08-09.v1`

This is the reusable operating core for AI coding agents. Project-local `AGENTS.md` files add product identity, authority order, commands, and non-negotiable constraints. A project may strengthen this standard but should not casually fork its language or duplicate it elsewhere.

## 1. Load only current authority

At session start:

1. Read the repository `AGENTS.md`.
2. Read this file.
3. Use the repository's context/spec router when one exists.
4. Read only the active specifications, contracts, ADRs, and doctrine selected by the task and likely touched paths.
5. Load deeper doctrine only when a real consequence, ambiguity, ownership crossing, or failure mode triggers it.

Do not preload broad spec catalogs, historical reports, retired plans, archived material, or unrelated doctrine "just in case." Context, reasoning attention, CI minutes, and operator attention are engineering resources.

## 2. Prevent stale-authority drift

Current active authority beats historical explanation. Archived, retired, superseded, transitional, progress-report, handoff, prototype, research, and unclear material is evidence or history unless a current authority explicitly promotes it for the present task.

When code, specs, tests, plans, or history disagree, classify the disagreement before editing:

- implementation defect;
- outdated or superseded specification;
- intentional transition state;
- unclear intent or authority;
- missing coverage;
- design conflict.

Do not silently obey stale prose. Do not silently ignore an active contract. Resolve the authority question or stop at the smallest safe boundary when it cannot be resolved.

Deleting stale active guidance is preferred to keeping a second "legacy instruction" copy in the live tree; Git history already preserves history. If historical material must remain in-tree, mark it non-authoritative and keep it out of startup routes.

## 3. Outcome, ownership, and reuse first

Before substantive work, establish the exact outcome, current and desired state, owner, governing authority/revision, material bounds, expected effect, and cheapest decisive falsifier.

Before creating a new module, registry, adapter, validator, state store, helper system, or workflow:

- search the current architecture/ownership map, system registry, specs, and code for the existing owner;
- reuse or extend the existing owner when it already owns any meaningful part of the responsibility;
- avoid duplicate semantic authority, parallel registries, shadow state, hidden fallback, or task-local substitutes for project infrastructure.

Every important fact, state transition, schema, threshold, identifier, mapping, formula, and lifecycle has one authoritative owner. Derived caches, reports, generated files, UI projections, diagnostics, and tests must not become competing truth owners.

## 4. Shared architecture rule

Use LEGO boundaries: **universally replaceable outside; purpose-built inside**.

A meaningful component owns one coherent problem, lifecycle, state, replacement, or failure boundary. A file, class, function, or helper is not automatically a component.

At a component boundary:

- inject replaceable external capabilities;
- expose the smallest complete role contract;
- use project-owned, owner-neutral types and schemas;
- declare inputs, outputs, errors, state changes, ordering, cancellation, capacity, precision, compatibility, and performance assumptions when material;
- keep framework, SDK, storage, subprocess, transport, and provider-private types inside adapters;
- make substitution possible through contract and composition rather than caller branches.

Inside a valid boundary, prefer simple idiomatic code, SOLID/CUPID responsibilities, concrete private helpers, and direct hot-path implementation. Do not add abstraction without real variation, ownership, testing, lifecycle, or clarity value.

Foundational ranges, precision, schemas, IDs, persistence formats, and boundaries must fit the real domain rather than accidental limits from the first example. Future-proof foundations; do not invent speculative features.

## 5. Execute in coherent steps and inspect reality

Perform one coherent ownership-sized operation at a time. Before acting, state the expected local effect and material wider effects plus the cheapest observation that could prove the assumption wrong.

Immediately after the operation:

1. inspect the actual result;
2. compare expected and actual;
3. reconcile affected callers, contracts, state, and lifecycle;
4. continue, revise, rollback, or stop based on evidence.

Do not build dependent work on top of a material unexplained divergence.

## 6. Debug from raw evidence

For ambiguous failures, define the original failure signature before changing code. Rank likely boundaries, then trace one real sample through the most plausible boundary first.

Write the expected raw result before observing the actual result. A useful probe either clears a specific boundary with strong evidence or exposes a specific inconsistency near the cause. Preserve sample identity and contradictory evidence rather than averaging it away.

Prove that diagnostics, tests, logs, and metrics are attached to the real path and can expose the known-bad case before trusting them as proof. Question both implementation and expectation when they disagree. Apply one targeted fix per proven cause and retest the original failure signature.

## 7. Validation is proportional and owner-aligned

Run the smallest complete validation set that protects the touched behavior and its real failure modes. Prefer focused local owner/contract checks before broad CI. A tool or file named `gate`, `audit`, `check`, `smoke`, or `validation` is not automatically blocking authority.

Do not weaken tests, thresholds, contracts, success criteria, or diagnostics merely to make a change pass. Do not create broad permanent governance to compensate for a local design defect when a direct correction and narrow regression check are sufficient.

Independent review, broad matrices, migration/recovery proof, packaging, performance qualification, or release evidence are triggered by project phase or objective consequence, not by file count.

## 8. Keep process state singular and useful

Use durable records only when they have a real consumer:

- an issue may own cross-session current work truth;
- a branch owns the implementation lineage;
- a PR owns the proposed diff and integration summary;
- a formal plan is for real dependencies, invalid intermediate states, ownership crossings, rollback requirements, or coordinated high-consequence work;
- specialist records own only their unique evidence.

Do not maintain duplicate histories or accounting about accounting. Update durable state when durable truth changes, not after every command.

## 9. Triggered safeguards never become optional

Always preserve project-specific safeguards for credentials and secrets, hostile input, security boundaries, provenance/licensing, persisted meaning and migrations, destructive operations, user/pre-existing state, recovery, and honest evidence claims.

Never expose secret contents merely to validate their presence. Never trade correctness, safety, recoverability, or legal provenance for convenience or context savings.

## 10. Review, integrate, and finish on exact evidence

Before integration, inspect the complete intended diff, test the simplest credible failure, remove temporary state, state checks and limits honestly, and freeze the reviewed head.

Merge is a separate transaction: revalidate the exact head, target, required checks/reviews, unresolved findings, and merge method. Use an expected-head guard when supported and verify the target result after integration.

Work is complete when the requested outcome is evidenced at the applicable depth, triggered safeguards pass, durable current truth is accurate, stale temporary claims are absent, and no material invalid partial state remains.
