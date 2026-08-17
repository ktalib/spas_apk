/**
 * SPAS Mobile — sync engine.
 *
 * Drains the outbox to the server, pulls deltas back, and refreshes reference
 * data. Runs on reconnect, on app resume, and on a manual "Sync Now".
 *
 * Rules it implements (see API_CONTRACT.md §3):
 *   - push order does not matter; the outbox is a flat FIFO
 *   - a replayed push returns 200 {duplicate:true} and counts as success
 *   - 409 is terminal: surface it, stop retrying
 *   - 422 means our own client-side validation let something bad through
 *   - a 404 from /photos means the parent has not synced yet — keep it queued
 *   - the `since` cursor comes from the server's clock, never the device's
 */

import * as api from './api.js';
import * as store from './store.js';

let running = false;
const listeners = new Set();

export function onSyncEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event) {
  listeners.forEach((fn) => {
    try {
      fn(event);
    } catch {
      /* a broken listener must never break a sync */
    }
  });
}

export function isRunning() {
  return running;
}

/** Best-effort network check. Capacitor's plugin is more reliable than navigator. */
export async function isOnline() {
  const plugin = window.Capacitor?.Plugins?.Network;

  if (plugin) {
    try {
      return (await plugin.getStatus()).connected;
    } catch {
      /* fall through */
    }
  }

  return navigator.onLine !== false;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function pushEntry(entry) {
  const payload = entry.payload_json || {};

  if (entry.entity_type === 'spa_applications') {
    const result = await api.pushRecord(payload);
    await store.markRecordSynced(payload.client_uuid, result.id, result.file_number);
    return result;
  }

  if (entry.entity_type === 'spa_field_data') {
    const result = await api.pushFieldData(payload);
    await store.markFieldDataSynced(payload.client_uuid, result.id, result.spa_application_id);
    return result;
  }

  throw new Error(`Unknown outbox entity: ${entry.entity_type}`);
}

/**
 * @returns {{pushed:number, conflicts:number, failed:number, stoppedOffline:boolean}}
 */
export async function drainOutbox() {
  const entries = await store.listOutbox();
  const summary = { pushed: 0, conflicts: 0, failed: 0, stoppedOffline: false };

  for (const entry of entries) {
    try {
      const result = await pushEntry(entry);

      // A duplicate is a success: the row already landed, our response was lost.
      await store.deleteOutboxEntry(entry.id);
      summary.pushed++;

      emit({ type: 'pushed', entry, result });
    } catch (error) {
      if (error.isOffline) {
        // Nothing is wrong with the data — stop the drain and keep everything
        // queued. Burning through the rest would just repeat the same failure.
        summary.stoppedOffline = true;
        break;
      }

      if (error.isAuth) {
        emit({ type: 'auth-expired' });
        summary.stoppedOffline = true;
        break;
      }

      if (error.isConflict) {
        // Terminal. Retrying will never succeed, so park it for the surveyor.
        await store.markOutboxError(entry.id, error.message, { conflict: true });
        summary.conflicts++;
        emit({ type: 'conflict', entry, error });
        continue;
      }

      if (error.isValidation) {
        // Our client-side mirror let something through that the server refuses.
        // Park it rather than retrying forever, and treat it as a client bug.
        await store.markOutboxError(entry.id, error.message, { conflict: true });
        summary.conflicts++;
        emit({ type: 'validation-rejected', entry, error });
        continue;
      }

      await store.markOutboxError(entry.id, error.message);
      summary.failed++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function pullEntity(metaKey, fetchPage, upsert) {
  let cursor = await store.getMeta(metaKey);
  let pulled = 0;
  let guard = 0;

  // `has_more` drives paging; the guard is only there so a server bug cannot
  // spin the device forever on a dying battery.
  while (guard++ < 50) {
    const page = await fetchPage(cursor);

    for (const row of page.data || []) {
      await upsert(row);
      pulled++;
    }

    cursor = page.server_time || cursor;
    await store.setMeta(metaKey, cursor);

    if (!page.has_more) break;
  }

  return pulled;
}

export async function pullDeltas() {
  const records = await pullEntity('last_pull.records', api.pullRecords, store.upsertServerRecord);
  const fieldData = await pullEntity('last_pull.field_data', api.pullFieldData, store.upsertServerFieldData);

  return { records, fieldData };
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * How many indexed files to pre-seed.
 *
 * Kept modest on purpose. The unfiltered lookup sorts across ~133,000 rows
 * server-side and the payload crosses a field connection that is often 2G, so
 * asking for a big page is how a first sign-in ends in a timeout. The cache
 * also grows organically from every lookup the surveyor performs, so this is a
 * starting set and not the whole working set.
 */
const SEED_FILE_INDEX = 250;

/**
 * Refresh the reference caches.
 *
 * Each cache is fetched independently: one slow or failing endpoint must not
 * cost the others. The LGA and district lists are tiny and are what the
 * customary form cannot work without, so they matter more than the file index.
 */
/**
 * @param {object}   options
 * @param {?string}  options.lga
 * @param {?function} options.onStep  (key, state, detail) — drives the setup UI.
 *                                    state is 'active' | 'done' | 'failed'.
 */
export async function refreshLookups({ lga = null, onStep = null } = {}) {
  const failures = [];

  const report = (key, state, detail) => {
    if (onStep) {
      try {
        onStep(key, state, detail);
      } catch {
        /* a broken progress listener must never fail the sync */
      }
    }
  };

  const step = async (key, label, run) => {
    report(key, 'active');

    try {
      const detail = await run();
      report(key, 'done', detail);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
      report(key, 'failed', error.message);
    }
  };

  await step('landuses', 'land uses', async () => {
    const landUses = await api.fetchLandUses();
    await store.seedLandUses(landUses.data, landUses.customary);
    return `${(landUses.data || []).length} types`;
  });

  await step('lgas', 'LGAs', async () => {
    const lgas = await api.fetchLgas();
    await store.seedNameCache('lga_cache', lgas.data);
    return `${(lgas.data || []).length} areas`;
  });

  await step('districts', 'districts', async () => {
    const districts = await api.fetchDistricts();
    await store.seedNameCache('district_cache', districts.data);
    return `${(districts.data || []).length} districts`;
  });

  // The Records tab lists indexed files, so without this the main screen is
  // empty on first run. With an LGA the server also resolves that LGA's
  // spelling variants, which is worth thousands of files (see LgaNormalizer).
  await step('fileindex', 'file index', async () => {
    const index = await api.fetchFileIndex(
      lga ? { lga, limit: SEED_FILE_INDEX } : { limit: SEED_FILE_INDEX }
    );

    await store.cacheFileIndex(index.data);

    if (lga) {
      await store.setMeta('file_index.lga', lga);
    }

    return `${(index.data || []).length} files`;
  });

  await store.setMeta('last_pull.lookups', new Date().toISOString());

  if (failures.length) {
    throw new Error(failures.join('; '));
  }
}

// ---------------------------------------------------------------------------
// The whole cycle
// ---------------------------------------------------------------------------

export async function syncNow({ lga = null, includeLookups = false } = {}) {
  if (running) return { skipped: 'already-running' };

  if (!(await api.isLoggedIn())) return { skipped: 'not-logged-in' };

  if (!(await isOnline())) return { skipped: 'offline' };

  running = true;
  emit({ type: 'start' });

  const report = { pushed: 0, conflicts: 0, failed: 0, pulled: 0, error: null };

  try {
    const push = await drainOutbox();
    report.pushed = push.pushed;
    report.conflicts = push.conflicts;
    report.failed = push.failed;

    if (!push.stoppedOffline) {
      // Stitch any inspection whose parent synced after it did.
      try {
        await api.linkOrphans();
      } catch {
        /* best effort — a failure here self-heals on the next sync */
      }

      const pull = await pullDeltas();
      report.pulled = pull.records + pull.fieldData;

      if (includeLookups) {
        await refreshLookups({ lga: lga || (await store.getMeta('file_index.lga')) });
      }
    }

    await store.setMeta('last_sync_at', new Date().toISOString());
  } catch (error) {
    report.error = error.message || String(error);
  } finally {
    running = false;
    emit({ type: 'done', report });
  }

  return report;
}

/**
 * Wire the automatic triggers.
 *
 * Deliberately no polling timer: a surveyor's battery matters more than a few
 * minutes of staleness, and reconnect plus resume already cover the real cases.
 */
export function startAutoSync(getContext = () => ({})) {
  const plugins = window.Capacitor?.Plugins || {};

  if (plugins.Network?.addListener) {
    plugins.Network.addListener('networkStatusChange', (status) => {
      if (status.connected) syncNow(getContext());
    });
  } else {
    window.addEventListener('online', () => syncNow(getContext()));
  }

  if (plugins.App?.addListener) {
    plugins.App.addListener('resume', () => syncNow(getContext()));
  } else {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncNow(getContext());
    });
  }
}
