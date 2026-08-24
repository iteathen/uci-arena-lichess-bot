import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderInstallerConfiguration } from './installer-integration.mjs';

const DEFAULT_TEMPLATE = new URL('./config.uci_arena.template.yml', import.meta.url);

test('installer integration preserves validated Manager policy while refreshing bindings', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-lichess-policy-preservation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const existing = JSON.parse(readFileSync(DEFAULT_TEMPLATE, 'utf8'));
  existing.outbound_challenge.rated = true;
  existing.outbound_challenge.color = 'black';
  existing.scheduler.max_games_per_opponent_per_day = 1;
  existing.engine.executable = path.join(root, 'old-engine', 'engine.exe');
  writeFileSync(
    path.join(workspace, 'manager-config.json'),
    `${JSON.stringify(existing, null, 2)}\n`,
    'utf8',
  );

  const engineRoot = path.join(root, 'new-engine');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace,
    enabled: true,
    bindings: {
      default_engine: path.join(engineRoot, 'bin', 'uci_arena_engine.exe'),
      default_engine_root: engineRoot,
      default_model_root: path.join(engineRoot, 'models', 'default'),
    },
    locators: {
      timing_profile: path.join(root, 'profiles', 'timing.json'),
      lichess_single_game_profile: path.join(root, 'profiles', 'single.json'),
      lichess_capacity_profile: path.join(root, 'profiles', 'capacity.json'),
    },
  });

  assert.equal(result.configuration.outbound_challenge.rated, true);
  assert.equal(result.configuration.outbound_challenge.color, 'black');
  assert.equal(result.configuration.scheduler.max_games_per_opponent_per_day, 1);
  assert.equal(
    result.configuration.engine.executable,
    path.join(engineRoot, 'bin', 'uci_arena_engine.exe'),
  );
  assert.equal(
    result.configuration.engine.uci_options.ModelRoot,
    path.join(engineRoot, 'models', 'default'),
  );
});

test('installer integration rejects an invalid existing policy instead of resetting it', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-lichess-invalid-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'manager-config.json'), '{}', 'utf8');

  assert.throws(() => renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace,
    enabled: false,
    bindings: {
      default_engine: path.join(root, 'engine', 'uci_arena_engine.exe'),
      default_engine_root: path.join(root, 'engine'),
      default_model_root: path.join(root, 'engine', 'models', 'default'),
    },
    locators: {},
  }), /Unsupported Lichess adapter config schema/);
});

test('installer integration prefers a discovered conforming UCI engine without suite assumptions', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-lichess-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const external = path.join(root, 'External Engine', 'engine.exe');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace: path.join(root, 'workspace'),
    enabled: false,
    bindings: {
      default_engine: path.join(root, 'suite', 'engine.exe'),
      default_engine_root: path.join(root, 'suite'),
      default_model_root: path.join(root, 'suite', 'models', 'default'),
    },
    locators: { uci_engine: external },
  });

  assert.equal(result.configuration.engine.adapter, 'standard_uci_v1');
  assert.equal(result.configuration.engine.executable, external);
  assert.deepEqual(result.configuration.engine.uci_options, {});
  assert.equal(result.configuration.capacity.total_slots, 1);
  assert.equal(result.configuration.scheduler.enabled, false);
  assert.equal(result.configuration.capacity.bot.target_active, 0);
});

test('installer integration binds complete suite evidence and bounded knowledge locators', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-lichess-suite-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const books = path.join(root, 'books');
  mkdirSync(books, { recursive: true });
  writeFileSync(path.join(books, 'strong_rare_v1.bin'), 'book', 'utf8');
  writeFileSync(path.join(books, 'strong_rare_v1.stats'), 'stats', 'utf8');
  writeFileSync(path.join(books, 'strong_rare_v1.policy'), 'policy', 'utf8');
  const engineRoot = path.join(root, 'engine');
  const engineManifest = path.join(engineRoot, 'arena-component.json');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace: path.join(root, 'workspace'),
    enabled: true,
    bindings: {
      default_engine: path.join(engineRoot, 'bin', 'uci_arena_engine.exe'),
      default_engine_root: engineRoot,
      default_engine_manifest: engineManifest,
      default_model_root: path.join(engineRoot, 'models', 'default'),
      complete_game_entrypoint: path.join(root, 'evidence', 'arena', 'run_complete_game_matrix.mjs'),
      referee: path.join(root, 'evidence', 'bin', 'referee.exe'),
      stockfish: path.join(root, 'stockfish', 'bin', 'stockfish.exe'),
    },
    locators: {
      timing_profile: path.join(root, 'profiles', 'timing.json'),
      lichess_single_game_profile: path.join(root, 'profiles', 'single.json'),
      lichess_capacity_profile: path.join(root, 'profiles', 'capacity.json'),
      lichess_transport_profile: path.join(root, 'profiles', 'transport.json'),
      opening_book: books,
      syzygy: path.join(root, 'tablebases'),
    },
  });

  assert.equal(result.configuration.engine.adapter, 'uci_arena_extended_v1');
  assert.equal(result.configuration.engine.component_manifest, engineManifest);
  assert.equal(result.configuration.engine.uci_options.ModelRoot,
    path.join(engineRoot, 'models', 'default'));
  assert.equal(result.configuration.engine.uci_options.BookFile,
    path.join(books, 'strong_rare_v1.bin'));
  assert.equal(result.configuration.engine.uci_options.BookStatsFile,
    path.join(books, 'strong_rare_v1.stats'));
  assert.equal(result.configuration.engine.uci_options.BookPolicyFile,
    path.join(books, 'strong_rare_v1.policy'));
  assert.equal(result.configuration.engine.uci_options.SyzygyPath,
    path.join(root, 'tablebases'));
  assert.deepEqual(result.configuration.qualification, {
    complete_game_entrypoint: path.join(root, 'evidence', 'arena', 'run_complete_game_matrix.mjs'),
    referee: path.join(root, 'evidence', 'bin', 'referee.exe'),
    stockfish: path.join(root, 'stockfish', 'bin', 'stockfish.exe'),
  });
  assert.equal(result.configuration.scheduler.enabled, true);
});

test('installer integration rejects partial installed qualification bindings', () => {
  const root = path.resolve(os.tmpdir(), 'arena-lichess-partial-qualification');
  assert.throws(() => renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace: path.join(root, 'workspace'),
    enabled: false,
    bindings: {
      default_engine: path.join(root, 'engine', 'uci_arena_engine.exe'),
      default_engine_root: path.join(root, 'engine'),
      default_model_root: path.join(root, 'engine', 'models', 'default'),
      complete_game_entrypoint: path.join(root, 'evidence', 'run_complete_game_matrix.mjs'),
    },
    locators: {},
  }), /qualification bindings are incomplete/);
});

test('installer integration binds a base Polyglot book without fabricating sidecars', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-lichess-base-book-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const book = path.join(root, 'books', 'external.bin');
  mkdirSync(path.dirname(book), { recursive: true });
  writeFileSync(book, 'book', 'utf8');
  const engineRoot = path.join(root, 'engine');
  const result = renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace: path.join(root, 'workspace'),
    enabled: false,
    bindings: {
      default_engine: path.join(engineRoot, 'uci_arena_engine.exe'),
      default_engine_root: engineRoot,
      default_model_root: path.join(engineRoot, 'models', 'default'),
    },
    locators: { opening_book: book },
  });

  assert.equal(result.configuration.engine.uci_options.OwnBook, true);
  assert.equal(result.configuration.engine.uci_options.BookFile, book);
  assert.equal(result.configuration.engine.uci_options.BookStatsFile, '');
  assert.equal(result.configuration.engine.uci_options.BookPolicyFile, '');
});

test('installer integration rejects a partial opening-book locator', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-lichess-partial-book-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const books = path.join(root, 'books');
  mkdirSync(books, { recursive: true });
  writeFileSync(path.join(books, 'strong_rare_v1.bin'), 'book', 'utf8');
  writeFileSync(path.join(books, 'strong_rare_v1.policy'), 'policy', 'utf8');
  assert.throws(() => renderInstallerConfiguration({
    schema: 'arena_provider_install_context_v1',
    schema_version: 1,
    workspace: path.join(root, 'workspace'),
    enabled: false,
    bindings: {
      default_engine: path.join(root, 'engine', 'uci_arena_engine.exe'),
      default_engine_root: path.join(root, 'engine'),
      default_model_root: path.join(root, 'engine', 'models', 'default'),
    },
    locators: { opening_book: books },
  }), /partial \.stats\/\.policy sidecar pair/);
});
