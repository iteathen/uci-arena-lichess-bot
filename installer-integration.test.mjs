import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderInstallerConfiguration } from './installer-integration.mjs';
import { engineComponentIdentity, UciEngine } from './lichess-adapter.mjs';

const DEFAULT_TEMPLATE = new URL('./config.uci_arena.template.yml', import.meta.url);

function managedStandardEngine(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arena-managed-standard-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'bin'));
  mkdirSync(path.join(root, 'dist'));
  mkdirSync(path.join(root, 'contracts'));
  const profile = {
    schema: 'arena_uci_engine_launch_profile_v1', schema_version: 1,
    component: { id: 'uci_arena.vector', version: '0.1.0', root: '.' },
    engine: {
      adapter: 'standard_uci_v1', executable: 'bin/node.exe',
      arguments: ['--experimental-ffi', 'dist/uci.mjs'], working_directory: '.',
    },
    state: 'conservative', enabled: true, uci_options: { Hash: 128 },
    expected_runtime: null, evidence: {}, knowledge: {}, diagnostics: [],
  };
  function publish() {
    writeFileSync(path.join(root, 'contracts', 'uci-engine-launch-profile.json'), JSON.stringify(profile));
    const files = ['bin/node.exe', 'dist/uci.mjs', 'contracts/uci-engine-launch-profile.json'].map((relative) => {
      const bytes = readFileSync(path.join(root, relative));
      return { path: relative, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    writeFileSync(path.join(root, 'arena-component.json'), JSON.stringify({
      schema: 'arena_install_component_v1', schema_version: 1,
      component_id: 'uci_arena.vector', component_version: '0.1.0',
      entrypoints: { uci_engine: 'bin/node.exe', uci_launch_profile: 'contracts/uci-engine-launch-profile.json' },
      capabilities: ['uci_engine_launch_profile_v1'], files,
    }));
  }
  writeFileSync(path.join(root, 'bin', 'node.exe'), 'independently inventoried runtime fixture');
  writeFileSync(path.join(root, 'dist', 'uci.mjs'), 'independently inventoried UCI program fixture');
  publish();
  const context = {
    schema: 'arena_provider_install_context_v1', schema_version: 1,
    workspace: path.join(root, 'workspace'), enabled: true,
    bindings: {
      default_engine_launch_profile: path.join(root, 'contracts', 'uci-engine-launch-profile.json'),
      default_engine_launch_manifest: path.join(root, 'arena-component.json'),
    }, locators: {},
  };
  return { root, profile, publish, context };
}

test('installed standard engine launch uses its owned runtime and program without legacy model or profiles', (t) => {
  const { root, context } = managedStandardEngine(t);
  const result = renderInstallerConfiguration(context);
  assert.equal(result.configuration.engine.adapter, 'standard_uci_v1');
  assert.equal(result.configuration.engine.executable, path.join(root, 'bin', 'node.exe'));
  assert.deepEqual(result.configuration.engine.arguments, ['--experimental-ffi', path.join(root, 'dist', 'uci.mjs')]);
  assert.equal(result.configuration.engine.working_directory, root);
  assert.deepEqual(result.configuration.engine.uci_options, { Hash: 128 });
  assert.equal(result.configuration.engine.component_manifest, path.join(root, 'arena-component.json'));
  assert.equal(Object.hasOwn(result.configuration.engine, 'time_profile'), false);
  assert.equal(Object.hasOwn(result.configuration.engine, 'single_game_profile'), false);
  assert.equal(Object.hasOwn(result.configuration, 'qualification'), false);
  assert.equal(result.configuration.capacity.total_slots, 1);
  assert.equal(result.configuration.timing.opponent_turn_search, false);
});

test('managed engine identity rejects a program changed after installer configuration admission', (t) => {
  const { root, context } = managedStandardEngine(t);
  const { configuration } = renderInstallerConfiguration(context);
  writeFileSync(path.join(root, 'dist', 'uci.mjs'), 'post-install program replacement');
  assert.throws(() => engineComponentIdentity(configuration), /manifest inventory/i);
});

test('managed UCI launch rejects program inventory drift before creating its child process', async (t) => {
  const { root, context } = managedStandardEngine(t);
  const { configuration } = renderInstallerConfiguration(context);
  writeFileSync(path.join(root, 'dist', 'uci.mjs'), 'post-install program replacement');
  const engine = new UciEngine(configuration.engine);
  await assert.rejects(() => engine.start(), /manifest inventory/i);
  assert.equal(engine.child, undefined);
});

test('a present default launch profile cannot silently fall back to the legacy engine after inventory drift', (t) => {
  const { root, context } = managedStandardEngine(t);
  Object.assign(context.bindings, {
    default_engine: path.join(root, 'legacy.exe'), default_engine_root: root,
    default_model_root: path.join(root, 'models'),
  });
  writeFileSync(path.join(root, 'dist', 'uci.mjs'), 'replaced executable program');
  assert.throws(() => renderInstallerConfiguration(context), /launch.*inventory/i);
});

for (const [label, change] of [
  ['outside executable', (profile) => { profile.engine.executable = '../outside.exe'; }],
  ['absolute argument', (profile) => { profile.engine.arguments = [path.resolve(os.tmpdir(), 'unowned.mjs')]; }],
  ['runtime eval switch', (profile) => { profile.engine.arguments = ['--eval', 'process.exit()']; }],
  ['duplicate runtime flags', (profile) => { profile.engine.arguments = ['--experimental-ffi', '--experimental-ffi', 'dist/uci.mjs']; }],
  ['runtime flag after entrypoint', (profile) => { profile.engine.arguments = ['dist/uci.mjs', '--experimental-ffi']; }],
  ['outside working directory', (profile) => { profile.engine.working_directory = '..'; }],
  ['foreign component identity', (profile) => { profile.component.version = '9.9.9'; }],
  ['unknown adapter', (profile) => { profile.engine.adapter = 'untrusted_adapter'; }],
]) {
  test(`portable managed launch rejects ${label} before configuration composition`, (t) => {
    const { profile, publish, context } = managedStandardEngine(t);
    change(profile);
    publish();
    assert.throws(() => renderInstallerConfiguration(context), /launch profile/i);
  });
}

for (const relative of ['bin/node.exe', 'contracts/uci-engine-launch-profile.json']) {
  test(`managed default launch rejects changed inventoried ${relative}`, (t) => {
    const { root, context } = managedStandardEngine(t);
    writeFileSync(path.join(root, relative), 'changed payload');
    assert.throws(() => renderInstallerConfiguration(context), /launch.*inventory/i);
  });
}

test('an explicit saved UCI locator retains precedence over the optional managed default launch', (t) => {
  const { root, context } = managedStandardEngine(t);
  context.locators.uci_engine = path.join(root, 'operator-engine.exe');
  const result = renderInstallerConfiguration(context);
  assert.equal(result.configuration.engine.executable, path.join(root, 'operator-engine.exe'));
  assert.deepEqual(result.configuration.engine.arguments, []);
  assert.deepEqual(result.configuration.engine.uci_options, {});
});

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
