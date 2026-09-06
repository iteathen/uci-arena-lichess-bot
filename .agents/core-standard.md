# Shared Agent Operating Standard

Version: `2026-09-06.v4`

This is the reusable operating core for AI coding agents. Project-local `AGENTS.md` files add product identity, authority order, commands, and non-negotiable constraints. A project may strengthen this standard but should not casually fork its language or duplicate it elsewhere.

Synchronization rule: every repository carrying this version must keep this file byte-identical. Project-specific additions belong in the local `AGENTS.md` or routed local specifications. A shared-rule change bumps the version and is propagated as one coordinated cross-repository change.

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

### Archive instead of deleting project evidence

When obsolete tracked guidance, specifications, plans, decisions, reports, migration records, or other potentially useful project evidence must leave an active authority path, archive it instead of deleting it.

The same change that removes material from active use must record:

- `archived_at`: the date of archival;
- `original_path`: where the material lived while active;
- `archive_path`: where the preserved copy now lives;
- `reason`: why it is no longer active;
- `superseded_by`: the current authority or replacement, when one exists;
- `removed_from_active_authority`: what startup route, index, registry, or ownership surface stopped selecting it;
- `change_reference`: the PR, commit, issue, or other durable change reference when available.

Archive locations must be clearly non-authoritative and excluded from normal agent/spec routing. Preserve the original content unless the archive format itself requires a mechanical wrapper or manifest. If content is transformed during archival, preserve the original revision identity and explain the transformation.

Use `.agents/archive-policy.md` for the canonical record shape and archive procedure. This archival rule does not require preservation of secrets, generated caches, disposable build output, corrupted transient files, or other material whose owning policy explicitly requires destruction or regeneration.

## 3. Outcome, ownership, and reuse first

Before substantive work, establish the exact outcome, current and desired state, owner, governing authority/revision, material bounds, expected effect, and cheapest decisive falsifier.

Before creating a new module, registry, adapter, validator, state store, helper system, or workflow:

- search the current architecture/ownership map, system registry, specs, and code for the existing owner;
- reuse or extend the existing owner when it already owns any meaningful part of the responsibility;
- avoid duplicate semantic authority, parallel registries, shadow state, hidden fallback, or task-local substitutes for project infrastructure.

Every important fact, state transition, schema, threshold, identifier, mapping, formula, and lifecycle has one authoritative owner. Derived caches, reports, generated files, UI projections, diagnostics, and tests must not become competing truth owners.

## 4. Shared architecture rule

Use LEGO boundaries: **universally replaceable outside; purpose-built inside; recursively attention-bounded throughout**.

LEGO is the outer architecture discipline. It governs ownership, universality, replaceability, scope containment, damage-limiting encapsulation, supported connection surfaces, and the amount of context required to reason correctly about one brick.

**The application or system itself is the outermost LEGO.** Its supported external inputs, outputs, commands, events, data contracts, and lifecycle entry/exit points are its public **studs/surfaces**. Large application sections, subsystems, services, components, and large objects should preferably be compositions of smaller child LEGOs when that preserves cohesion and keeps each reasoning unit inside full attention. A parent owns its externally visible responsibility and hides child topology; callers connect through deliberate studs/surfaces rather than drilling through a parent to reach private children.

A meaningful LEGO owns one coherent problem, invariant, lifecycle, state, replacement, resource, or failure boundary. A file, class, function, or helper is not automatically a LEGO.

A LEGO must fit one agent's **full-attention envelope**. The complete authoritative working set—public contract/studs/surfaces, implementation, invariants, lifecycle/resource/failure rules, tests/conformance, and the immediate dependency and consumer interfaces needed to understand consequences—must fit comfortably in focused attention with substantial headroom for reasoning, evidence, diff inspection, and review. Merely fitting inside a model's maximum context window is not sufficient.

Choose boundaries using both cohesion and attention fit. Strong real seams include semantic/ontological ownership, lifecycle cohesion, functional cohesion, stable dependency/substitution boundaries, independently owned failure/resource behavior, volatility/change boundaries, and execution locality. When a brick exceeds the full-attention envelope, recursively split at the strongest real seam or narrow its scope. Context pressure is a first-class boundary criterion, but it does not justify arbitrary file splitting, duplicated truth, multiple writers, shared mutable ownership, constant cross-boundary chatter, or neighbors that must understand each other's internals.

At a LEGO boundary:

- inject replaceable external capabilities;
- expose the smallest complete role contract as deliberate studs/surfaces;
- use project-owned, owner-neutral types and schemas;
- declare inputs, outputs, errors, state changes, ordering, cancellation, capacity, precision, compatibility, and performance assumptions when material;
- keep framework, SDK, storage, subprocess, transport, provider-private, and private-child types inside adapters or the owning brick;
- make substitution possible through contract and composition rather than caller branches;
- keep failures, resource pressure, cleanup, and redesign blast radius inside the smallest responsible boundary.

The target is the **smallest coherent, independently comprehensible and replaceable unit**, not the smallest possible module. Very large objects or application sections should preferentially become parent LEGOs composed from smaller private child LEGOs when that preserves one external responsibility while restoring full attention internally.

Inside a valid LEGO, apply the hierarchy in order:

```text
LEGO: choose and contain boundaries, scope, and studs/surfaces
  -> SOLID: structure responsibilities and dependency direction inside the brick
    -> CUPID: make the implementation composable, predictable, idiomatic, and domain-based
      -> KISS: remove remaining unjustified complexity
```

A lower level may not defeat a higher one. A locally simpler implementation is not KISS if it breaks LEGO containment; CUPID does not justify violating SOLID dependency direction; SOLID does not justify putting a responsibility in the wrong LEGO.

Foundational ranges, precision, schemas, IDs, persistence formats, and boundaries must fit the real domain rather than accidental limits from the first example. Future-proof foundations; do not invent speculative features.

### Non-negotiable LEGO isolation, naming, and transient topology

These are architecture gates, not style preferences. They apply to names and local logic as strongly as to imports and dependency injection.

- **Complete module isolation:** every LEGO brick is self-contained. Internal logic, types, state, and names describe only the brick's own domain and contract. Never reference an external module/repository/product/provider name, foreign object type, private child, or neighbor-specific context merely because that neighbor is connected today. External identity belongs in composition or in the adapter that intrinsically owns that integration.
- **Agnostic interface naming:** inputs, outputs, ports, events, properties, commands, queries, DTOs, callbacks, and public types describe local data, intent, or action. They never encode the identity of the current upstream source or downstream target. A domain identity is valid inside the component that actually owns that domain; it is a leak when copied into another generic brick.
- **Transient topology:** architect every external connection as temporary. Replacing, removing, isolating, or rewiring a neighbor must not require changes to the component's internal logic or vocabulary. The composition root owns relationships, selection, and lifecycle wiring; bricks do not discover neighbors or branch on product/repository/provider identity.
- **Stud/surface integrity:** public connection surfaces expose owned contracts, not mutable internals or private child topology. Consumers never drill through one brick's surface to couple directly to an encapsulated child.
- **Rewiring test:** before accepting a boundary, mentally replace the current neighbor with another conforming implementation or remove it entirely. If internal names become false, foreign types surface, or local logic needs topology-specific branches, the boundary leaks and must be redesigned.
- **Full-attention test:** an entering agent must be able to identify what the brick owns and excludes, its studs/surfaces, invariants, lifecycle/resources/failures, immediate dependencies, replacement contract, and decisive tests without repository archaeology across unrelated internals.
- **No abstraction theater:** do not create a port, interface, event bus, registry, generic wrapper, or child LEGO merely to appear modular. A boundary exists only for real ownership, substitution, lifecycle, failure/resource, testing/change, damage-containment, or attention-containment value. Direct private calls inside one attention-bounded brick are preferred when there is no genuine boundary.
- **One owner remains one owner:** neutral naming must never blur semantic authority. Do not replace explicit ownership with `common`, `shared`, `generic`, `manager`, or callback-based dumping grounds.

A violation of these rules is an architecture defect and a stop condition before implementation or acceptance, not a naming nit to defer for cleanup.

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
