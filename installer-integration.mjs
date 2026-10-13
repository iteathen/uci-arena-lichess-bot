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
  hashExactFileSync,
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

function scalarUciOptions(options, label) {
  requireObject(options, label);
  if (Object.keys(options).length > 128 || Object.entries(options).some(([name, value]) =>
    !/^[A-Za-z0-9_ -]{1,128}$/u.test(name)
    || !['string', 'number', 'boolean'].includes(typeof value)
    || (typeof value === 'number' && !Number.isFinite(value))
    || Buffer.byteLength(String(value), 'utf8') > 4096 || /[\u0000\r\n]/u.test(String(value)))) {
    throw new Error(`${label} are invalid`);
  }
  return { ...options };
}

function portableStandardLaunch(bindings) {
  const profilePath = optionalAbsolutePath(bindings.default_engine_launch_profile, 'launch profile binding');
  if (profilePath === undefined) return undefined;
  const manifestPath = requireAbsolutePath(bindings.default_engine_launch_manifest, 'launch profile manifest binding');
  const manifest = readExactJsonSync(manifestPath, {
    maximumBytes: MAXIMUM_CONTEXT_BYTES, label: 'Managed launch component manifest',
  }).value;
  if (manifest?.schema !== 'arena_install_component_v1' || manifest.schema_version !== 1
      || !Array.isArray(manifest.files) || manifest.files.length > 100_000
      || typeof manifest.component_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(manifest.component_id)
      || typeof manifest.component_version !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(manifest.component_version)
      || !manifest.entrypoints || typeof manifest.entrypoints !== 'object'
      || Array.isArray(manifest.entrypoints) || !Array.isArray(manifest.capabilities)
      || !manifest.capabilities.includes('uci_engine_launch_profile_v1')) {
    throw new Error('launch profile component inventory is invalid');
  }
  const root = path.dirname(manifestPath);
  admitExactDirectorySync(root, { label: 'Managed launch component root' });
  function ownedFile(relative) {
    if (typeof relative !== 'string' || !relative || Buffer.byteLength(relative, 'utf8') > 4096
        || relative.startsWith('-') || path.isAbsolute(relative) || path.win32.isAbsolute(relative)
        || /[\u0000\r\n\\:]/u.test(relative)
        || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('launch profile contains an unsafe component-relative path');
    }
    const records = manifest.files.filter((record) => record?.path === relative);
    if (records.length !== 1 || !Number.isSafeInteger(records[0].size_bytes)
        || records[0].size_bytes < 0 || !/^[a-f0-9]{64}$/u.test(records[0].sha256)) {
      throw new Error('launch profile file inventory is invalid');
    }
    const absolute = path.join(root, ...relative.split('/'));
    const exact = hashExactFileSync(absolute, {
      maximumBytes: 16 * 1024 * 1024 * 1024, label: 'Managed launch inventory file',
    });
    if (exact.byteLength !== records[0].size_bytes || exact.sha256 !== `sha256:${records[0].sha256}`) {
      throw new Error('launch profile file does not match its component inventory');
    }
    return { absolute, sha256: exact.sha256 };
  }
  const profileRelative = path.relative(root, profilePath).split(path.sep).join('/');
  if (!Object.values(manifest.entrypoints).includes(profileRelative)) {
    throw new Error('launch profile is not a declared component entrypoint');
  }
  const profileFile = ownedFile(profileRelative);
  const admitted = readExactJsonSync(profileFile.absolute, {
    maximumBytes: MAXIMUM_CONTEXT_BYTES, label: 'Managed engine launch profile',
  });
  if (admitted.sha256 !== profileFile.sha256) throw new Error('launch profile inventory changed during admission');
  const profile = admitted.value;
  if (profile?.schema !== 'arena_uci_engine_launch_profile_v1' || profile.schema_version !== 1
      || profile.component?.id !== manifest.component_id || profile.component?.version !== manifest.component_version
      || profile.component?.root !== '.' || profile.engine?.working_directory !== '.'
      || profile.engine?.adapter !== 'standard_uci_v1' || profile.state !== 'conservative'
      || profile.enabled !== true || profile.expected_runtime !== null) {
    throw new Error('launch profile identity or standard adapter contract is invalid');
  }
  const argumentsList = profile.engine.arguments;
  const offset = argumentsList?.[0] === '--experimental-ffi' ? 1 : 0;
  if (!Array.isArray(argumentsList) || argumentsList.length !== offset + 1
      || typeof argumentsList[offset] !== 'string' || !argumentsList[offset].endsWith('.mjs')) {
    throw new Error('launch profile must declare one program and only the approved leading runtime flag');
  }
  const executable = ownedFile(profile.engine.executable).absolute;
  if (!Object.values(manifest.entrypoints).includes(profile.engine.executable)) {
    throw new Error('launch profile executable is not a declared component entrypoint');
  }
  const program = ownedFile(argumentsList[offset]).absolute;
  const options = scalarUciOptions(profile.uci_options, 'launch profile UCI options');
  const resolvedOptions = { ...options };
  if (Object.hasOwn(options, 'TimingPolicyFile') || Object.hasOwn(options, 'TimingPolicySha256')) {
    // This explicit pair names an opaque pinned artifact, not arbitrary scalar
    // option text. Resolve only through the same component's owned inventory.
    if (typeof options.TimingPolicyFile !== 'string'
        || typeof options.TimingPolicySha256 !== 'string'
        || !/^[a-f0-9]{64}$/u.test(options.TimingPolicySha256)) {
      throw new Error('launch profile timing artifact requires its complete file and digest pair');
    }
    const policy = ownedFile(options.TimingPolicyFile);
    if (policy.sha256 !== `sha256:${options.TimingPolicySha256}`) {
      throw new Error('launch profile timing artifact digest differs from its component inventory');
    }
    resolvedOptions.TimingPolicyFile = policy.absolute;
  }
  return {
    executable, arguments: [...argumentsList.slice(0, offset), program],
    working_directory: root, uci_options: resolvedOptions, component_manifest: manifestPath,
    component: { id: manifest.component_id, version: manifest.component_version, root },
  };
}

function freshStandardLaunch(bindings, immutableLaunch) {
  if (bindings.default_engine_configuration === undefined) return immutableLaunch;
  if (!immutableLaunch) throw new Error('fresh configuration requires its immutable launch profile');
  const profile = requireObject(bindings.default_engine_configuration, 'fresh engine configuration');
  const samePath = (actual, expected) => typeof actual === 'string' && path.isAbsolute(actual)
    && path.normalize(actual) === path.normalize(expected);
  if (profile.schema !== 'arena_uci_engine_launch_profile_v1' || profile.schema_version !== 1
      || profile.component?.id !== immutableLaunch.component.id
      || profile.component?.version !== immutableLaunch.component.version
      || !samePath(profile.component?.root, immutableLaunch.component.root)
      || profile.engine?.adapter !== 'standard_uci_v1'
      || !samePath(profile.engine?.executable, immutableLaunch.executable)
      || !samePath(profile.engine?.working_directory, immutableLaunch.working_directory)
      || JSON.stringify(profile.engine?.arguments) !== JSON.stringify(immutableLaunch.arguments)
      || profile.state !== 'conservative' || profile.enabled !== true || profile.expected_runtime !== null) {
    throw new Error('fresh engine configuration differs from immutable launch authority');
  }
  const options = scalarUciOptions(profile.uci_options, 'fresh configuration UCI options');
  for (const key of ['RequireTimingPolicy', 'TimingPolicyFile', 'TimingPolicySha256']) {
    if (Object.hasOwn(options, key) !== Object.hasOwn(immutableLaunch.uci_options, key)
        || options[key] !== immutableLaunch.uci_options[key]) {
      throw new Error('fresh configuration differs from immutable pinned timing authority');
    }
  }
  // Producer owns every remaining option and generated knowledge binding. The
  // provider forwards bounded scalar inputs without inventing Book semantics.
  return { ...immutableLaunch, uci_options: options };
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
  const standardLaunch = importedEngine ? undefined
    : freshStandardLaunch(bindings, portableStandardLaunch(bindings));
  const defaultEngine = optionalAbsolutePath(bindings.default_engine, 'bindings.default_engine');
  const engine = importedEngine ?? standardLaunch?.executable ?? defaultEngine;
  if (!engine) throw new Error('no conforming UCI engine binding is available');
  const policyEngineRoot = standardLaunch?.working_directory ?? optionalAbsolutePath(
    bindings.default_engine_root,
    'bindings.default_engine_root',
  ) ?? path.dirname(engine);
  if (importedEngine || standardLaunch) {
    configuration.engine.adapter = 'standard_uci_v1';
    configuration.engine.executable = engine;
    configuration.engine.arguments = standardLaunch?.arguments ?? [];
    configuration.engine.working_directory = standardLaunch?.working_directory ?? path.dirname(importedEngine);
    configuration.engine.uci_options = standardLaunch?.uci_options ?? {};
    delete configuration.engine.single_game_profile;
    delete configuration.engine.time_profile;
    delete configuration.engine.temporal_curve_profile;
    delete configuration.engine.component_manifest;
    if (standardLaunch) configuration.engine.component_manifest = standardLaunch.component_manifest;
    delete configuration.engine.fallback_bundle;
    configuration.capacity.total_slots = 1;
    configuration.capacity.startup_parallelism = 1;
    configuration.capacity.human.slots = 1;
    configuration.capacity.bot.slots = 0;
    configuration.capacity.bot.target_active = 0;
    delete configuration.capacity.capacity_profile;
    configuration.timing.opponent_turn_search = false;
    delete configuration.qualification;
    configuration = preserveManagerOptions(configuration, workspace, policyEngineRoot);
    if (configuration.capacity.total_slots !== 1 || configuration.capacity.startup_parallelism !== 1) {
      throw new Error('standard UCI configuration requires a compatible one-slot capacity policy');
    }
  } else {
    configuration = preserveManagerOptions(configuration, workspace, policyEngineRoot);
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
