#!/usr/bin/env node

const changedIndex = process.argv.indexOf("--changed-files");
const changedFiles = changedIndex < 0 ? [] : process.argv.slice(changedIndex + 1);
process.stdout.write(`${JSON.stringify({
  schema: "uci_arena_lichess_bot_spec_preflight_v1",
  changed_files: changedFiles,
  required_specs: [
    "specs/00_READ_FIRST.yaml",
    "specs/suite_lego_boundaries_v1.yaml",
    "specs/lichess_match_scheduler_v1.yaml",
    "specs/move_submission_timing_boundary_v1.yaml",
  ],
}, null, 2)}\n`);
