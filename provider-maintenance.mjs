import { processIdentityFromJson, validProcessIdentity, sameProcessInstance } from './process-instance-identity.mjs';
import { performance } from 'node:perf_hooks';

export const MAINTENANCE_RECOVERY_SCHEMA = 'uci_arena_lichess_maintenance_recovery_v1';
class Deferred extends Error { constructor(reason) { super('Maintenance deferred'); this.reason = reason; } }
const defer = (reason) => { throw new Deferred(reason); };

export async function recoverProviderMaintenance({ store, client, authority, expectedAccount,
  ownerId, pid, processIdentity, ownerProcessProbe, priorProcessIdentity,
  startupObservation, signal, now = Date.now, maximumMilliseconds = 15000 }) {
  const started = performance.now();
  const controller = new AbortController();
  const boundedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer = null;
  let heartbeat = null;
  let acquired = false;
  let leaseClaimUnconfirmed = false;
  let completion = 'not_attempted';
  let result;
  const check = () => {
    if (boundedSignal.aborted || performance.now() - started >= maximumMilliseconds) defer('cancelled_or_timeout');
  };
  try {
    if (!Number.isSafeInteger(maximumMilliseconds) || maximumMilliseconds < 1 || maximumMilliseconds > 60000
        || typeof expectedAccount !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(expectedAccount)
        || !validProcessIdentity(processIdentity, pid)) {
      defer('invalid_request');
    }
    timer = setTimeout(() => controller.abort(), maximumMilliseconds);
    check();
    if (!startupObservation || (startupObservation.installed !== false
        && !(startupObservation.installed === true && startupObservation.active === false
          && startupObservation.enabled === false))) defer('startup_not_quiescent');
    const baseline = store.captureMaintenanceRecovery(authority);
    const old = baseline.ownerLease;
    const oldIdentity = old ? processIdentityFromJson(old.process_identity_json, old.pid)
      : validProcessIdentity(priorProcessIdentity) ? priorProcessIdentity : null;
    if (baseline.control.admission_blocked) defer('admission_blocked');
    if (!baseline.control.owner_id || (old && old.owner_id !== baseline.control.owner_id) || !oldIdentity) {
      defer('prior_ownership_unavailable');
    }
    if (baseline.ambiguous) defer('durable_work_ambiguous');
    const priorGone = () => {
      check();
      let observed;
      try { observed = ownerProcessProbe(oldIdentity.pid); } catch { return false; }
      check();
      const state = observed?.state;
      const currentIdentity = observed?.identity;
      return state === 'absent' || (state === 'present'
        && validProcessIdentity(currentIdentity, oldIdentity.pid) && !sameProcessInstance(oldIdentity, currentIdentity));
    };
    if (!priorGone()) defer('prior_process_not_proven_absent');
    // A thrown post-commit check can leave our exact lease committed. Own the
    // possible claim before calling storage so final cleanup cannot skip it.
    acquired = true;
    leaseClaimUnconfirmed = true;
    store.acquireApiLease(authority, ownerId, pid, now(), 60000, ownerProcessProbe, processIdentity);
    leaseClaimUnconfirmed = false;
    const refresh = () => {
      check();
      store.heartbeatApiLease(authority, ownerId, pid, now(), 60000, processIdentity);
      if (!store.maintenanceLeaseAuthoritative(authority, ownerId, pid, processIdentity, now())) {
        defer('exclusive_lease_unavailable');
      }
    };
    refresh();
    heartbeat = setInterval(() => { try { refresh(); } catch { controller.abort(); } }, 10000);
    const requestOptions = { signal: boundedSignal, beforeDispatch: refresh };
    const profile = await client.json('api/account', requestOptions);
    check();
    if (typeof profile?.username !== 'string' || profile.username.toLowerCase() !== expectedAccount.toLowerCase()
        || profile.title !== 'BOT') defer('account_identity_rejected');
    refresh();
    const challenges = await client.json('api/challenge', requestOptions);
    check();
    if (!Array.isArray(challenges?.in) || !Array.isArray(challenges?.out)) defer('remote_facts_malformed');
    if (challenges.in.length || challenges.out.length) defer('remote_work_pending');
    refresh();
    const playing = await client.json('api/account/playing?nb=50', requestOptions);
    check();
    if (!Array.isArray(playing?.nowPlaying) || !Number.isSafeInteger(playing.nbMyTurn)
        || playing.nbMyTurn < 0 || (!playing.nowPlaying.length && playing.nbMyTurn !== 0)) defer('remote_facts_malformed');
    if (playing.nowPlaying.length) defer('remote_work_pending');
    refresh();
    completion = 'unconfirmed';
    const facts = store.completeMaintenanceRecovery(authority, ownerId, pid, processIdentity, baseline, priorGone, now());
    completion = 'confirmed';
    acquired = false; // Exact API lease was released by the completion transaction.
    result = { schema: MAINTENANCE_RECOVERY_SCHEMA, status: 'recovered', completion, ...facts };
  } catch (error) {
    let code; let status;
    try { code = error?.code; status = error?.status; } catch {}
    const knownRejection = code === 'LICHESS_MAINTENANCE_AUTHORITY_CHANGED';
    result = { schema: MAINTENANCE_RECOVERY_SCHEMA,
      status: leaseClaimUnconfirmed || (completion === 'unconfirmed' && !knownRejection) ? 'failed' : 'deferred', completion,
      reason: error instanceof Deferred ? error.reason : boundedSignal.aborted
        ? 'cancelled_or_timeout' : knownRejection ? 'authority_changed'
          : status === 401 || status === 403 ? 'remote_scope_unavailable' : 'recovery_unavailable' };
  } finally {
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    if (acquired) {
      try {
        if (!store.releaseApiLease(authority, ownerId)) throw new Error('Unobserved lease release');
      } catch {
        result = { schema: MAINTENANCE_RECOVERY_SCHEMA, status: 'failed',
          reason: result?.reason ?? 'recovery_unavailable', cleanup: 'lease_release_failed', completion };
      }
    }
  }
  return Object.freeze(result);
}
