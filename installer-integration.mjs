import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyManagerOptionsPatch,
  editableManagerOptionsProjection,
  loadManagerConfig,
} from './lichess-adapter.mjs';
import {
  admitExactDirectorySync,
  admitExactFileSync,
  readExactJsonSync,
} from './exact-file.mjs';

const MAXIMUM_CONTEXT_BYTES = 1024 * 1024;
const MAXIMUM_EXISTING_CONFIGURATION_BYTES = 1024 * 1024;
const MAXIMUM_BOOK_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_TEMPLATE = fileURLToPath(new URL('./config.uci_arena.template.yml', import.meta.url));

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

function optionalAbsolutePath(value, label) {
  return value === undefined ? undefined : requireAbsolutePath(value, label);
}

function openingBookOptions(locator) {
  if (locator === undefined) return {};
  const selected = requireAbsolutePath(locator, 'locators.opening_book');
  let book = selected;
  let selectedDirectory = null;
  try {
    selectedDirectory = admitExactDirectorySync(selected, { label: 'Opening-book directory' });
  } catch (error) {
    if (error?.code !== 'EXACT_FILE_ANCESTOR_INVALID') throw error;
  }
  if (selectedDirectory) {
    const canonical = path.join(selected, 'strong_rare_v1.bin');
    try {
      admitExactFileSync(canonical, {
        maximumBytes: MAXIMUM_BOOK_BYTES,
        label: 'Canonical opening book',
      });
      book = canonical;
    } catch (error) {
      if (error.code !== 'EXACT_FILE_MISSING') throw error;
      const candidates = readdirSync(selected, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink()
          && ['.bin', '.book'].includes(path.extname(entry.name).toLowerCase()))
        .map((entry) => path.join(selected, entry.name))
        .sort();
      if (candidates.length !== 1) {
        throw new Error('opening-book directory must contain one unambiguous book');
      }
      [book] = candidates;
    }
    const directoryAfter = admitExactDirectorySync(selected, { label: 'Opening-book directory' });
    if (JSON.stringify(directoryAfter.identity) !== JSON.stringify(selectedDirectory.identity)) {
      throw new Error('opening-book directory changed during selection');
    }
  }
  admitExactFileSync(book, { maximumBytes: MAXIMUM_BOOK_BYTES, label: 'Opening book' });
  const options = {
    OwnBook: true,
    BookFile: book,
    BookStatsFile: '',
    BookPolicyFile: '',
  };
  const sidecars = [];
  for (const [suffix, option] of [['.stats', 'BookStatsFile'], ['.policy', 'BookPolicyFile']]) {
    const sidecar = path.join(path.dirname(book), `${path.basename(book, path.extname(book))}${suffix}`);
    try {
      admitExactFileSync(sidecar, {
        maximumBytes: MAXIMUM_BOOK_BYTES,
        label: `Opening-book ${suffix} sidecar`,
      });
      sidecars.push({ option, sidecar });
    } catch (error) {
      if (error.code === 'EXACT_FILE_MISSING') continue;
      throw error;
    }
  }
  if (sidecars.length === 1) {
    throw new Error('opening-book locator has a partial .stats/.policy sidecar pair');
  }
  for (const { option, sidecar } of sidecars) options[option] = sidecar;
  return options;
}

function disabled(configuration) {
  configuration.scheduler.enabled = false;
  configuration.capacity.bot.target_active = 0;
  return configuration;
}

function preserveManagerOptions(configuration, workspace, engineRoot) {
  const existingPath = path.join(workspace, 'manager-config.json');
  try {
    admitExactFileSync(existingPath, {
      maximumBytes: MAXIMUM_EXISTING_CONFIGURATION_BYTES,
      label: 'Existing managed configuration',
    });
  } catch (error) {
    if (error.code === 'EXACT_FILE_MISSING') return configuration;
    throw error;
  }
  const current = loadManagerConfig({ templatePath: existingPath, engineRoot });
  return applyManagerOptionsPatch(configuration, editableManagerOptionsProjection(current));
}

export function renderInstallerConfiguration(context) {
  requireObject(context, 'installer context');
  if (context.schema !== 'arena_provider_install_context_v1'
      || context.schema_version !== 1
      || typeof context.enabled !== 'boolean') {
    throw new Error('unsupported installer context');
  }
  const workspace = requireAbsolutePath(context.workspace, 'workspace');
  const bindings = requireObject(context.bindings ?? {}, 'bindings');
  const locators = requireObject(context.locators ?? {}, 'locators');
  let configuration = readExactJsonSync(DEFAULT_TEMPLATE, {
    maximumBytes: MAXIMUM_EXISTING_CONFIGURATION_BYTES,
    label: 'Default Lichess configuration template',
  }).value;
  const importedEngine = optionalAbsolutePath(locators.uci_engine, 'locators.uci_engine');
  const defaultEngine = optionalAbsolutePath(bindings.default_engine, 'bindings.default_engine');
  const engine = importedEngine ?? defaultEngine;
  if (!engine) throw new Error('no conforming UCI engine binding is available');
  const policyEngineRoot = optionalAbsolutePath(
    bindings.default_engine_root,
    'bindings.default_engine_root',
  ) ?? path.dirname(engine);
  configuration = preserveManagerOptions(configuration, workspace, policyEngineRoot);

  if (importedEngine) {
    configuration.engine.adapter = 'standard_uci_v1';
    configuration.engine.executable = importedEngine;
    configuration.engine.working_directory = path.dirname(importedEngine);
    configuration.engine.uci_options = {};
    delete configuration.engine.single_game_profile;
    delete configuration.engine.time_profile;
    delete configuration.engine.temporal_curve_profile;
    delete configuration.engine.component_manifest;
    delete configuration.engine.fallback_bundle;
    configuration.capacity.total_slots = 1;
    configuration.capacity.startup_parallelism = 1;
    configuration.capacity.human.slots = 1;
    configuration.capacity.bot.slots = 0;
    configuration.capacity.bot.target_active = 0;
    delete configuration.capacity.capacity_profile;
    configuration.timing.opponent_turn_search = false;
    delete configuration.qualification;
  } else {
    const engineRoot = requireAbsolutePath(bindings.default_engine_root, 'bindings.default_engine_root');
    const engineManifest = optionalAbsolutePath(
      bindings.default_engine_manifest,
      'bindings.default_engine_manifest',
    );
    const modelRoot = requireAbsolutePath(bindings.default_model_root, 'bindings.default_model_root');
    const completeGame = optionalAbsolutePath(
      bindings.complete_game_entrypoint,
      'bindings.complete_game_entrypoint',
    );
    const referee = optionalAbsolutePath(bindings.referee, 'bindings.referee');
    const stockfish = optionalAbsolutePath(bindings.stockfish, 'bindings.stockfish');
    const qualificationBindings = [completeGame, referee, stockfish];
    if (qualificationBindings.some(Boolean) && !qualificationBindings.every(Boolean)) {
      throw new Error('installed Lichess qualification bindings are incomplete');
    }
    if (qualificationBindings.every(Boolean)) {
      configuration.qualification = {
        complete_game_entrypoint: completeGame,
        referee,
        stockfish,
      };
    } else {
      delete configuration.qualification;
    }
    configuration.engine.adapter = 'uci_arena_extended_v1';
    configuration.engine.executable = defaultEngine;
    configuration.engine.working_directory = engineRoot;
    if (engineManifest) configuration.engine.component_manifest = engineManifest;
    else delete configuration.engine.component_manifest;
    configuration.engine.uci_options.ModelRoot = modelRoot;
    const timing = optionalAbsolutePath(locators.timing_profile, 'locators.timing_profile');
    const single = optionalAbsolutePath(
      locators.lichess_single_game_profile,
      'locators.lichess_single_game_profile',
    );
    const capacity = optionalAbsolutePath(
      locators.lichess_capacity_profile,
      'locators.lichess_capacity_profile',
    );
    if (timing && single && capacity) {
      configuration.engine.time_profile = timing;
      configuration.engine.single_game_profile = single;
      configuration.capacity.capacity_profile = capacity;
    } else {
      delete configuration.engine.time_profile;
      delete configuration.engine.single_game_profile;
      delete configuration.capacity.capacity_profile;
      disabled(configuration);
    }
    Object.assign(configuration.engine.uci_options, openingBookOptions(locators.opening_book));
    const syzygy = optionalAbsolutePath(locators.syzygy, 'locators.syzygy');
    if (syzygy) configuration.engine.uci_options.SyzygyPath = syzygy;
  }
  const transport = optionalAbsolutePath(
    locators.lichess_transport_profile,
    'locators.lichess_transport_profile',
  );
  if (transport) configuration.timing.transport_profile_path = transport;
  if (!context.enabled) disabled(configuration);
  return {
    schema: 'arena_provider_install_result_v1',
    schema_version: 1,
    configuration,
    generated_documents: [],
  };
}

function readContext(filename) {
  const absolute = requireAbsolutePath(filename, 'context file');
  return readExactJsonSync(absolute, {
    maximumBytes: MAXIMUM_CONTEXT_BYTES,
    label: 'Installer context file',
  }).value;
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--context') {
    throw new Error('usage: installer-integration.mjs --context <absolute-json-file>');
  }
  process.stdout.write(`${JSON.stringify(renderInstallerConfiguration(readContext(argv[1])))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Lichess installer integration failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
