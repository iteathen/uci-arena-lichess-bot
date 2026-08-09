# Project Evidence Archive Policy

Version: `2026-08-09.v1`

This policy governs removal of obsolete tracked guidance, specifications, plans, decisions, reports, migrations, and other potentially useful project evidence from active authority.

## Rule

Archive instead of deleting project evidence.

Removing material from active authority means that current startup routes, indexes, registries, ownership maps, or normal implementation paths no longer select it. It does **not** mean destroying the historical material.

## Archive location

Use the repository's existing canonical archive root when one exists. Otherwise use `archive/`.

For a newly archived file, preserve the old path beneath a dated archive directory when practical:

```text
archive/YYYY-MM-DD/<original/path>.archived
```

The `.archived` suffix prevents archived `AGENTS.md`, scripts, schemas, or other special filenames from being mistaken for live instructions or executable authority.

Archived content is non-authoritative by default and must be excluded from normal agent/spec routing.

## Archive ledger

Maintain `archive/INDEX.yaml` as the compact repository-wide archive ledger. Append one record for each file or coherent archived set.

Required record shape:

```yaml
- archived_at: YYYY-MM-DD
  original_path: path/while/active
  archive_path: archive/YYYY-MM-DD/path/while/active.archived
  reason: why the material left active authority
  superseded_by: current/spec/or/path-or-null
  removed_from_active_authority: router/index/registry/startup/path change
  source_revision: exact pre-archive commit when known
  source_blob: exact pre-archive blob when known
  change_reference: PR/commit/issue when available
```

For a coherent multi-file archive, `original_path` and `archive_path` may be lists or a directory mapping, but each source must remain unambiguous.

## Preservation requirements

- Preserve the original bytes whenever possible.
- Do not rewrite stale content to make it look current before archiving it.
- If a mechanical wrapper, suffix, compression, or format conversion is necessary, record the transformation and preserve the original revision/blob identity.
- Preserve enough context to understand what superseded the material and why it stopped being authoritative.
- Removing an archived item from a live index/router and creating its archive record belong to the same coherent change whenever practical.

## Reuse and restoration

Archived material may be consulted as evidence or history, but it does not regain authority merely because it contains useful language. Reuse useful ideas by deliberately promoting them into a current owned specification or shared standard.

Restoring an archived file to active authority requires an explicit current decision, current owner, current path, and validation against the present architecture. Do not simply move an old file back.

## Exceptions

This policy does not require archival preservation of credentials/secrets, generated caches, disposable build output, temporary files, corrupted transient artifacts, or material whose owning security/cleanup policy explicitly requires destruction or regeneration.
