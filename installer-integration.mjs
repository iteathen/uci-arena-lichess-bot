import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAXIMUM_CONTEXT_BYTES = 1024 * 1024;
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
  const metadata = lstatSync(selected);
  if (metadata.isSymbolicLink()) throw new Error('opening-book locator may not be a link');
  let book = selected;
  if (metadata.isDirectory()) {
    const canonical = path.join(selected, 'strong_rare_v1.bin');
    try {
      const canonicalMetadata = lstatSync(canonical);
      if (canonicalMetadata.isFile() && !canonicalMetadata.isSymbolicLink()) book = canonical;
      else throw new Error('canonical opening book is not a regular file');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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
  } else if (!metadata.isFile()) {
    throw new Error('opening-book locator must be a regular file or directory');
  }
  const options = { OwnBook: true, BookFile: book };
  for (const [suffix, option] of [['.stats', 'BookStatsFile'], ['.policy', 'BookPolicyFile']]) {
    const sidecar = path.join(path.dirname(book), `${path.basename(book, path.extname(book))}${suffix}`);
    try {
      const sidecarMetadata = lstatSync(sidecar);
      if (!sidecarMetadata.isFile() || sidecarMetadata.isSymbolicLink()) {
        throw new Error(`opening-book ${suffix} sidecar is not a regular file`);
      }
      options[option] = sidecar;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`opening-book locator is missing required ${suffix} sidecar`);
      }
      throw error;
    }
  }
  return options;
}

function disabled(configuration) {
  configuration.scheduler.enabled = false;
  configuration.capacity.bot.target_active = 0;
  return configuration;
}

export function renderInstallerConfiguration(context) {
  requireObject(context, 'installer context');
  if (context.schema !== 'arena_provider_install_context_v1'
      || context.schema_version !== 1
      || typeof context.enabled !== 'boolean') {
    throw new Error('unsupported installer context');
  }
  requireAbsolutePath(context.workspace, 'workspace');
  const bindings = requireObject(context.bindings ?? {}, 'bindings');
  const locators = requireObject(context.locators ?? {}, 'locators');
  const configuration = JSON.parse(readFileSync(DEFAULT_TEMPLATE, 'utf8'));
  const importedEngine = optionalAbsolutePath(locators.uci_engine, 'locators.uci_engine');
  const defaultEngine = optionalAbsolutePath(bindings.default_engine, 'bindings.default_engine');
  const engine = importedEngine ?? defaultEngine;
  if (!engine) throw new Error('no conforming UCI engine binding is available');

  if (importedEngine) {
    configuration.engine.adapter = 'standard_uci_v1';
    configuration.engine.executable = importedEngine;
    configuration.engine.working_directory = path.dirname(importedEngine);
    configuration.engine.uci_options = {};
    delete configuration.engine.single_game_profile;
    delete configuration.engine.time_profile;
    delete configuration.engine.temporal_curve_profile;
    delete configuration.engine.fallback_bundle;
    configuration.capacity.total_slots = 1;
    configuration.capacity.startup_parallelism = 1;
    configuration.capacity.human.slots = 1;
    configuration.capacity.bot.slots = 0;
    configuration.capacity.bot.target_active = 0;
    delete configuration.capacity.capacity_profile;
    configuration.timing.opponent_turn_search = false;
  } else {
    const engineRoot = requireAbsolutePath(bindings.default_engine_root, 'bindings.default_engine_root');
    const modelRoot = requireAbsolutePath(bindings.default_model_root, 'bindings.default_model_root');
    configuration.engine.adapter = 'uci_arena_extended_v1';
    configuration.engine.executable = defaultEngine;
    configuration.engine.working_directory = engineRoot;
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
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > MAXIMUM_CONTEXT_BYTES) {
    throw new Error('installer context file is not a bounded regular file');
  }
  return JSON.parse(readFileSync(absolute, 'utf8'));
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
