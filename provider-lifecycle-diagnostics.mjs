import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExactJsonSync, hashExactFileSync } from './exact-file.mjs';

const codes = new Map();
for (const suffix of ['EMPTY_CLASSIFICATION_CHANGED', 'INITIALIZATION_FAILED', 'INTEGER_INVALID',
  'INTEGER_UNSAFE', 'INTEGRITY_FAILED', 'NUMBER_INVALID', 'OPERATION_AND_RECOVERY_FAILED',
  'ORPHAN_SIDECAR', 'PATH_FAILED', 'PATH_INVALID', 'PATH_REPLACED', 'PATH_REVALIDATION_FAILED',
  'PATH_TYPE_INVALID', 'PATH_UNSAFE', 'PRAGMA_REFUSED', 'ROW_INVALID', 'SCHEMA_AUTHORITY_INVALID',
  'SCHEMA_AUTHORITY_MISSING', 'SCHEMA_MALFORMED', 'SCHEMA_UNSUPPORTED']) {
  codes.set(`LICHESS_STORAGE_${suffix}`, 'storage');
}
for (const suffix of ['ANCESTOR_INVALID', 'CLOSE_FAILED', 'IDENTITY_CHANGED', 'JSON_INVALID',
  'MISSING', 'OPEN_FAILED', 'PATH_INVALID', 'PATH_UNAVAILABLE', 'POST_READ_FAILED', 'READ_FAILED',
  'SIZE_CHANGED', 'TOO_LARGE', 'TYPE_INVALID']) codes.set(`EXACT_FILE_${suffix}`, 'path');
for (const code of ['provider_owned_work_active', 'provider_lifecycle_interlock_unavailable',
  'LICHESS_PROVIDER_WORK_UNRESOLVED', 'LICHESS_PROVIDER_LIFECYCLE_AUTHORITY_INVALID',
  'LICHESS_PROVIDER_LIFECYCLE_HELD', 'LICHESS_PROVIDER_REPLACEMENT_BLOCKED']) codes.set(code, 'interlock');
for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ERR_SQLITE_ERROR',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) codes.set(code, 'platform');

function verifiedSource(error, root) {
  try {
    const { value: inventory } = readExactJsonSync(path.join(root, 'arena-component.json'),
      { maximumBytes: 1048576, label: 'Lifecycle public source inventory' });
    if (!Array.isArray(inventory.files) || inventory.files.length > 4096) return undefined;
    // Never inspect the message line, arbitrary cause text, or a private filename.
    const frames = typeof error?.stack === 'string' ? error.stack.slice(0, 16384).split('\n').slice(1, 33) : [];
    for (const frame of frames) {
      const location = /\(?((?:file:\/\/\/|[A-Za-z]:[\\/]|\/).+?):(\d{1,10}):(\d{1,10})\)?$/u.exec(frame.trim());
      if (!location) continue;
      const filename = location[1].startsWith('file:') ? fileURLToPath(location[1]) : location[1];
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      if (!relative || relative.startsWith('../') || path.isAbsolute(relative)
          || !/^[A-Za-z0-9_./-]{1,160}\.mjs$/u.test(relative)) continue;
      const rows = inventory.files.filter((row) => row?.path === relative);
      if (rows.length !== 1 || !/^[a-f0-9]{64}$/u.test(rows[0].sha256)
          || !Number.isSafeInteger(rows[0].size_bytes) || rows[0].size_bytes < 0
          || rows[0].size_bytes > 1048576) continue;
      const actual = hashExactFileSync(filename, { maximumBytes: 1048576, label: 'Lifecycle public source' });
      if (actual.sha256.replace(/^sha256:/u, '') !== rows[0].sha256
          || actual.byteLength !== rows[0].size_bytes) continue;
      const line = Number(location[2]);
      const column = Number(location[3]);
      if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) continue;
      return { path: relative, line, column, sha256: rows[0].sha256 };
    }
  } catch { /* Diagnostic admission failure never replaces the primary failure. */ }
  return undefined;
}

export function startupFailureDiagnostic(error, root) {
  let code = 'STARTUP_OPERATION_FAILED';
  let category = 'operation';
  try {
    if (typeof error?.code === 'string' && codes.has(error.code)) {
      code = error.code;
      category = codes.get(code);
    }
  } catch { /* Unknown exception objects carry no public diagnostic authority. */ }
  const message = JSON.stringify({ code, source: verifiedSource(error, root) });
  return { id: `startup.${category}_failed`,
    message: Buffer.byteLength(message) <= 512 ? message : JSON.stringify({ code }) };
}

export function typedStartupOperation(argv) {
  if (argv[0] !== 'startup') return null;
  const operations = { install: 'install', uninstall: 'uninstall',
    prepare_replace: 'pre_replace', complete_replace: 'post_replace' };
  const operation = Object.hasOwn(operations, argv[1]) ? operations[argv[1]] : null;
  const indices = argv.flatMap((value, index) => value === '--lifecycle-result' ? [index] : []);
  return operation && indices.length === 1 && argv[indices[0] + 1] === 'typed_v1' ? operation : null;
}
