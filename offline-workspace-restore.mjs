import path from 'node:path';
import { linkSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { admitExactDirectorySync, admitExactFileSync, classifyExactPathSync, createExactTemporaryDirectorySync,
  hashExactFileSync, removeExactDirectorySync, removeExactPublishedFileSync } from './exact-file.mjs';
import { copyOfflineWorkspaceRows, inspectOfflineWorkspaceRows, openLichessStorage } from './lichess-storage.mjs';
import { processIdentityFromJson, validProcessIdentity, sameProcessInstance } from './process-instance-identity.mjs';
export const WORKSPACE_RESTORE_SCHEMA = 'uci_arena_lichess_workspace_restore_v1';
const MAXIMUM_BYTES = 1_099_511_627_776;
class Deferred extends Error { constructor(reason) { super('Workspace restore deferred'); this.reason = reason; } }
const defer = reason => { throw new Deferred(reason); };
const sameFile = (a,b) => a.dev === b.dev && a.ino === b.ino;
export async function restoreOfflineWorkspace({ sourceWorkspace, destinationWorkspace, observeStartup,
  ownerProcessProbe, priorProcessIdentity, maximumMilliseconds = 60000 }) {
  const started = performance.now(); let stage = null, targetStorage = null, published = false, completion = 'not_attempted';
  const check = () => { if (performance.now() - started >= maximumMilliseconds) defer('cancelled_or_timeout'); };
  const query = async () => {
    check(); const observed = await observeStartup(); check();
    if (!observed || (observed.installed !== false && !(observed.installed === true
        && observed.active === false && observed.enabled === false))) defer('startup_not_quiescent');
  };
  const guard = authority => {
    check(); if (!authority?.control || authority.control.active_work !== 0 || authority.control.admission_blocked !== 0) defer('source_not_quiescent');
    const identities = authority.leases.map(lease => processIdentityFromJson(lease.process_identity_json, lease.pid));
    if (authority.control.owner_id && !authority.leases.some(lease => lease.owner_id === authority.control.owner_id)) identities.push(priorProcessIdentity);
    for (const identity of identities) {
      if (!validProcessIdentity(identity)) defer('source_process_unverifiable');
      check(); let current; try { current = ownerProcessProbe(identity.pid); } catch { defer('source_process_unverifiable'); }
      check(); if (!(current?.state === 'absent' || current?.state === 'present'
          && validProcessIdentity(current.identity, identity.pid) && !sameProcessInstance(identity, current.identity))) defer('source_process_unverifiable');
    }
  };
  let result;
  try {
    if (!Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < 1 || maximumMilliseconds > 60000
        || typeof sourceWorkspace !== 'string' || !path.isAbsolute(sourceWorkspace)
        || typeof destinationWorkspace !== 'string' || !path.isAbsolute(destinationWorkspace)
        || typeof observeStartup !== 'function' || typeof ownerProcessProbe !== 'function') defer('invalid_request');
    const source = path.resolve(sourceWorkspace), destination = path.resolve(destinationWorkspace);
    const nested = (a,b) => { const relative = path.relative(a,b); return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
    if (nested(source,destination) || nested(destination,source)) defer('invalid_request');
    admitExactDirectorySync(source); admitExactDirectorySync(destination);
    const sourceFile = path.join(source,'matches.sqlite'), targetFile = path.join(destination,'matches.sqlite');
    const sourceIdentity = admitExactFileSync(sourceFile, { maximumBytes: MAXIMUM_BYTES }).identity;
    for (const suffix of ['', '-wal', '-shm']) if (classifyExactPathSync(targetFile + suffix).kind !== 'missing') defer('destination_exists');
    await query();
    stage = createExactTemporaryDirectorySync(destination, 'offline-restore');
    const stagedFile = path.join(stage.directory,'matches.sqlite');
    targetStorage = openLichessStorage(stagedFile);
    const copied = copyOfflineWorkspaceRows(sourceFile, targetStorage, { check, validateAuthority: guard });
    if (copied?.state === 'unavailable') defer('restore_unavailable');
    targetStorage.close(); targetStorage = null;
    const restored = inspectOfflineWorkspaceRows(stagedFile, check);
    if (restored.projectionSha256 !== copied.projectionSha256 || restored.authority.leases.length
        || restored.authority.control.owner_id || restored.authority.control.active_work || restored.authority.control.admission_blocked) defer('restore_unavailable');
    await query();
    const current = inspectOfflineWorkspaceRows(sourceFile, check); guard(current.authority);
    if (current.projectionSha256 !== copied.projectionSha256 || JSON.stringify(current.authority) !== JSON.stringify(copied.authority)
        || !sameFile(sourceIdentity, admitExactFileSync(sourceFile, { maximumBytes: MAXIMUM_BYTES }).identity)) defer('source_changed');
    const bytes = hashExactFileSync(stagedFile, { maximumBytes: MAXIMUM_BYTES });
    const descriptor = openSync(stagedFile, 'r+'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    check(); for (const suffix of ['', '-wal', '-shm']) if (classifyExactPathSync(targetFile + suffix).kind !== 'missing') defer('destination_exists');
    completion = 'unconfirmed'; linkSync(stagedFile,targetFile); published = true;
    const committed = hashExactFileSync(targetFile, { maximumBytes: MAXIMUM_BYTES });
    if (!sameFile(bytes.identity,committed.identity) || bytes.sha256 !== committed.sha256) defer('restore_unavailable');
    if (process.platform !== 'win32') {
      const parent = openSync(destination,'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    completion = 'confirmed';
    result = { schema: WORKSPACE_RESTORE_SCHEMA, status: 'restored', completion,
      games: copied.counts.games, plies: copied.counts.game_plies, safetyRows: copied.counts.api_safety_state,
      challengeRows: copied.counts.challenge_attempts, projectionSha256: copied.projectionSha256 };
  } catch (error) {
    result = { schema: WORKSPACE_RESTORE_SCHEMA, status: published || completion === 'unconfirmed' ? 'failed' : 'deferred', completion,
      reason: error instanceof Deferred ? error.reason : error?.code === 'resource_limit' ? 'resource_limit' : 'restore_unavailable' };
  } finally {
    let cleanupFailed = false;
    if (targetStorage) { try { targetStorage.close(); } catch { cleanupFailed = true; } }
    if (stage && !cleanupFailed) {
      try {
        admitExactDirectorySync(stage.directory);
        for (const suffix of ['', '-wal', '-shm']) {
          const file = path.join(stage.directory,'matches.sqlite' + suffix);
          if (classifyExactPathSync(file).kind !== 'missing') {
            const exact = admitExactFileSync(file, { maximumBytes: MAXIMUM_BYTES });
            removeExactPublishedFileSync(file, exact.identity);
          }
        }
        removeExactDirectorySync(stage.directory,stage.identity);
      } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) result = { schema: WORKSPACE_RESTORE_SCHEMA, status: 'failed', completion,
      reason: result?.reason ?? 'restore_unavailable', cleanup: 'cleanup_failed' };
  }
  return Object.freeze(result);
}
