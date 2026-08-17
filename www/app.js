/**
 * SPAS Mobile — app bootstrap and UI wiring.
 *
 * Reads and writes local SQLite only. The network is touched exclusively by
 * sync.js, on reconnect / resume / manual sync.
 *
 * No bare module specifiers — there is no bundler here. See db.js.
 */

import { ensureDatabase, getPlatform, isNative } from './db.js';
import * as api from './api.js';
import * as store from './store.js';
import * as sync from './sync.js';
import {
  validateLandRecord, validateFieldData,
  parseCoordinates, hasErrors, firstError
} from './validate.js';
import { resolveLandUse, resolveOwner } from './landuse.js';
import { mountPinMap } from './map.js';

const $ = (sel) => document.querySelector(sel);
const el = {};

let state = {
  titleType: 'statutory',
  selectedFile: null,
  user: null
};

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function toast(message, tone = 'neutral') {
  el.toast.textContent = message;
  el.toast.dataset.tone = tone;
  el.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), 3600);
}

/**
 * Show failures on screen. On a handset there is no console, so a silent error
 * reads as "the buttons are broken" — which is exactly how this project's first
 * build failed.
 */
function fatal(source, error) {
  const message = error?.message || String(error);
  toast(`${source}: ${message}`, 'error');
  console.error(source, error);
}

window.addEventListener('error', (e) => fatal('Script error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal('Unhandled', e.reason));

function show(screen) {
  el.login.classList.toggle('hidden', screen !== 'login');
  el.app.classList.toggle('hidden', screen !== 'app');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function doLogin() {
  const identifier = el.loginId.value.trim();
  const password = el.loginPw.value;

  if (!identifier || !password) {
    el.loginError.textContent = 'Enter your username and password.';
    el.loginError.classList.remove('hidden');
    return;
  }

  if (el.loginBase.value.trim()) {
    await api.setBaseUrl(el.loginBase.value.trim());
  }

  el.btnLogin.disabled = true;
  el.btnLogin.textContent = 'Signing in...';
  el.loginError.classList.add('hidden');

  try {
    await api.login(identifier, password, `spas-${getPlatform()}`);

    // Once a token exists, the surveyor is in. Reference data is downloaded
    // AFTER this point and never blocks entry.
    //
    // It used to be awaited here, which meant a slow file-index pull on a 2G
    // connection failed the whole sign-in — with the token already issued and
    // saved. The surveyor saw "timed out" and could not get in, despite being
    // authenticated. Getting in matters more than having every lookup cached.
    await enterApp();

    // Setup runs on top of the app, so a failure leaves a usable app behind it
    // rather than a dead end.
    runFirstRunSetup().catch((e) => {
      el.boot.classList.add('hidden');
      fatal('Setup', e);
    });
  } catch (error) {
    let message = error.message;

    if (error.isOffline) {
      // Distinguish "no signal" from "signal, but the request was blocked or
      // the address is wrong". Both used to read as "no connection", which is
      // actively misleading when the phone is plainly online.
      const online = await sync.isOnline();

      message = online
        ? `${error.message}\n\nThe device reports a working connection, so this is usually the wrong server address, or the API is not deployed yet.`
        : 'No signal. The first sign-in needs a connection; after that the app works offline.';
    }

    el.loginError.textContent = message;
    el.loginError.classList.remove('hidden');
  } finally {
    el.btnLogin.disabled = false;
    el.btnLogin.textContent = 'Sign in';
  }
}

/**
 * The token was revoked or is no longer accepted (401).
 *
 * Clear the credential but NEVER the local database. A token can be revoked
 * while a surveyor is holding a day of unsynced field work, and discarding that
 * to tidy up the session would destroy the only copy. The outbox survives, and
 * drains automatically once they sign in again.
 *
 * The token must actually be cleared, or the app would return straight to a
 * dead session on next launch and fail the same way with no explanation.
 */
async function handleAuthExpired() {
  await api.logout({ callServer: false });

  const pending = await store.pendingCount();

  el.loginError.textContent = pending > 0
    ? `Session ended. ${pending} record(s) are still saved on this device and will sync once you sign in.`
    : 'Session ended. Please sign in again.';
  el.loginError.classList.remove('hidden');

  show('login');
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

const BOOT_STEPS = [
  ['system',    'Checking system'],
  ['database',  'Preparing encrypted database'],
  ['landuses',  'Land use types'],
  ['lgas',      'Local government areas'],
  ['districts', 'Districts'],
  ['fileindex', 'Indexed land files'],
  ['records',   'Records and inspections']
];

function bootRender() {
  el.bootSteps.innerHTML = BOOT_STEPS.map(([key, label]) => `
    <li class="boot__step" data-step="${key}" data-state="waiting">
      <span class="boot__icon"></span>
      <span class="boot__label">${label}</span>
      <span class="boot__detail"></span>
    </li>`).join('');
}

function bootStep(key, state, detail = '') {
  const row = el.bootSteps.querySelector(`[data-step="${key}"]`);
  if (!row) return;

  row.dataset.state = state;
  row.querySelector('.boot__detail').textContent = detail;

  const done = el.bootSteps.querySelectorAll('[data-state="done"],[data-state="failed"]').length;
  el.bootBar.style.width = `${Math.round((done / BOOT_STEPS.length) * 100)}%`;
}

/**
 * Build the offline store, showing what is happening.
 *
 * This is the only moment the app genuinely needs a connection, and a surveyor
 * who walks off mid-setup reaches the field with an empty file index. Naming
 * each step makes the wait legible and a failure visible — the alternative is a
 * blank screen followed by a mysteriously empty Records tab.
 *
 * Never blocks entry: the "Continue" button appears whatever happens, and every
 * step is retryable later with "Sync now".
 */
async function runFirstRunSetup() {
  el.boot.classList.remove('hidden');
  el.bootContinue.classList.add('hidden');
  el.bootNote.textContent = '';
  bootRender();

  bootStep('system', 'active');
  bootStep('system', 'done', isNative() ? getPlatform() : 'browser preview');

  bootStep('database', 'active');

  try {
    const db = await ensureDatabase();
    const tables = await db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    );
    bootStep('database', 'done', `${(tables.values || []).length} tables, encrypted`);
  } catch (error) {
    bootStep('database', 'failed', error.message);
  }

  let lookupError = null;

  try {
    await sync.refreshLookups({ onStep: bootStep });
  } catch (error) {
    lookupError = error;
  }

  bootStep('records', 'active');

  try {
    const report = await sync.syncNow({});
    bootStep('records', 'done', `${report.pulled ?? 0} received`);
  } catch (error) {
    bootStep('records', 'failed', error.message);
  }

  el.bootNote.textContent = lookupError
    ? 'Some data did not download. You can work offline now and tap “Sync now” when the connection is better.'
    : 'This device is ready to work offline.';

  el.bootContinue.classList.remove('hidden');
  el.bootContinue.textContent = lookupError ? 'Continue anyway' : 'Start';

  await renderAll();
}

async function doLogout() {
  const pending = await store.pendingCount();

  if (pending > 0 && !confirm(
    `${pending} record(s) have not synced yet. They stay on this device and will ` +
    `sync when you sign in again. Log out anyway?`
  )) {
    return;
  }

  await api.logout();
  show('login');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function syncBadge(row) {
  if (row.sync_status === 'pending') return '<span class="chip chip--warn">Pending</span>';
  if (row.sync_status === 'error') return '<span class="chip chip--danger">Error</span>';
  return '<span class="chip chip--ok">Synced</span>';
}

function contravenes(row) {
  const a = String(row.proposed_use ?? '').toUpperCase().trim();
  const b = String(row.existing_use ?? '').toUpperCase().trim();
  return a && b && a !== b;
}

const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In Progress',
  approved: 'Approved',
  certificate_issued: 'Cert. Issued',
  closed: 'Closed',
  not_added: 'Not Added'
};

async function renderRecords() {
  const search = el.searchRecords.value.trim();

  // The indexed-file universe, not just what this device has captured —
  // matching the web page. A surveyor arrives knowing the file number and needs
  // to find it whether or not it has been inspected.
  const [list, stats, cached] = await Promise.all([
    store.listIndexedFiles({ search }),
    store.recordStats(),
    store.countFileIndex()
  ]);

  el.statTotal.textContent = stats.total;
  el.statOpen.textContent = stats.open;
  el.statProgress.textContent = stats.in_progress;
  el.statPending.textContent = stats.pending;

  if (!list.length) {
    el.listRecords.innerHTML = cached
      ? '<p class="empty">No file matches that search.</p>'
      : '<p class="empty">No indexed files cached yet. Tap “Sync now” while online.</p>';
    return;
  }

  el.listRecords.innerHTML = list.map((r) => {
    const status = r.status_raw;

    // The action button only appears on files nobody has inspected yet — the
    // one row a surveyor can actually act on.
    const action = status === 'not_added'
      ? `<button class="rec-add" data-fileno="${esc(r.file_number)}" title="Log inspection">+</button>`
      : '';

    return `
      <article class="rec">
        <header class="rec__head">
          <span class="rec__no">${esc(r.file_number || '—')}</span>
          <span class="rec__right">
            ${action}
            ${r.client_uuid && r.sync_status === 'pending' ? '<span class="chip chip--warn">Pending</span>' : ''}
            <span class="rec__status is-${esc(status)}">${STATUS_LABEL[status] || status}</span>
          </span>
        </header>
        <div class="rec__body">
          <div class="rec__row"><span>Owner</span><b>${esc(resolveOwner(r) || '—')}</b></div>
          <div class="rec__row"><span>Location</span><b>${esc(r.location || r.lga || '—')}</b></div>
          <div class="rec__row"><span>Land use</span><b>${esc(resolveLandUse(r) || '—')}</b></div>
          ${contravenes(r) ? '<div class="rec__row"><span>Status</span><b class="is-danger">Contravention</b></div>' : ''}
        </div>
      </article>`;
  }).join('');
}

/**
 * Field Records: the records that have actually been added.
 *
 * Read-only. Inspections are captured on the record itself now, so there is
 * nothing to create from this tab — it is the register of what has been done,
 * not a second place to do it.
 */
async function renderVerify() {
  const search = el.searchVerify.value.trim();
  const list = await store.listRecords({ search });

  el.listVerify.innerHTML = list.length ? list.map((r) => `
    <article class="rec">
      <header class="rec__head">
        <span class="rec__no">${esc(r.file_number || 'Pending file number')}</span>
        <span class="rec__right">${syncBadge(r)}</span>
      </header>
      <div class="rec__body">
        <div class="rec__row"><span>Owner</span><b>${esc(resolveOwner(r) || '—')}</b></div>
        <div class="rec__row"><span>Location</span><b>${esc(r.location || r.lga || '—')}</b></div>
        <div class="rec__row"><span>Approved</span><b>${esc(r.proposed_use || '—')}</b></div>
        <div class="rec__row"><span>Prevailing</span><b>${esc(r.existing_use || '—')}</b></div>
        ${contravenes(r) ? '<div class="rec__row"><span>Status</span><b class="is-danger">Contravention</b></div>' : ''}
      </div>
    </article>
  `).join('') : '<p class="empty">No records added yet. Add one from the Records tab.</p>';
}

async function renderMap() {
  const [plotted, awaiting] = await Promise.all([store.mapPoints(), store.awaitingLocation()]);

  el.countPlotted.textContent = plotted.length;
  el.countAwaiting.textContent = awaiting.length;

  renderMapCanvas(plotted).catch(() => {});

  el.listMap.innerHTML = plotted.length ? plotted.map((f) => `
    <article class="card card--tight">
      <div class="card__top">
        <strong>${esc(f.file_number || '—')}</strong>
        ${contravenes(f) ? '<span class="chip chip--danger">Contravention</span>' : ''}
      </div>
      <div class="card__meta">${esc(f.owner_name || '—')}</div>
      <code class="coords">${Number(f.coordinates.lat).toFixed(6)}, ${Number(f.coordinates.lng).toFixed(6)}</code>
    </article>
  `).join('') : '<p class="empty">No plotted points yet.</p>';

  el.listAwaiting.innerHTML = awaiting.length ? awaiting.map((f) => `
    <article class="card card--tight">
      <div class="card__top"><strong>${esc(f.file_number || '—')}</strong></div>
      <div class="card__meta">${esc(f.owner_name || '—')} &middot; ${esc(f.inspection_date || '—')}</div>
    </article>
  `).join('') : '<p class="empty">Nothing awaiting a location.</p>';
}

async function renderAll() {
  await Promise.all([renderRecords(), renderVerify(), renderMap()]);
  await refreshSyncBar();
}

async function refreshSyncBar() {
  const [pending, conflicts, online] = await Promise.all([
    store.pendingCount(), store.conflictCount(), sync.isOnline()
  ]);

  el.netDot.dataset.state = online ? 'online' : 'offline';

  const bits = [online ? 'Online' : 'Offline'];
  if (pending) bits.push(`${pending} pending`);
  if (conflicts) bits.push(`${conflicts} conflict${conflicts > 1 ? 's' : ''}`);

  el.syncText.textContent = bits.join(' · ');
}

/**
 * Show what the conflict counter is actually counting.
 *
 * A 409 or 422 is terminal — retrying never clears it — so without somewhere to
 * read the reason, "1 conflict" sits in the status bar forever with no way to
 * find out why or to clear it.
 */
async function showConflicts() {
  const conflicts = await store.listConflicts();

  if (!conflicts.length) return;

  const lines = conflicts.map((c) => {
    const payload = (() => {
      try {
        return JSON.parse(c.payload_json);
      } catch {
        return {};
      }
    })();

    const who = payload.file_number || payload.owner_name || c.entity_client_uuid.slice(0, 8);
    return `• ${who}\n  ${String(c.last_error || '').replace(/^CONFLICT:/, '')}`;
  });

  const discard = confirm(
    `${conflicts.length} record(s) the server refused:\n\n${lines.join('\n\n')}\n\n` +
    `Retrying will not help. Discard them from the queue?\n\n` +
    `(The records stay on this device — only the queued upload is dropped.)`
  );

  if (!discard) return;

  for (const c of conflicts) {
    await store.deleteOutboxEntry(c.id);
  }

  toast('Queue cleared. The records remain on the device.', 'success');
  await renderAll();
}

// ---------------------------------------------------------------------------
// Add Land Record
// ---------------------------------------------------------------------------

function fillSelect(select, values, { placeholder = '— select —' } = {}) {
  select.innerHTML = `<option value="">${placeholder}</option>`
    + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

/**
 * Select an option by loose match.
 *
 * The land-use list is stored upper-case ("AGRICULTURAL") while the prefix
 * mapping yields title case ("Agriculture"), and the two differ in more than
 * case — so an exact assignment silently leaves the select empty. Compare on a
 * common stem instead.
 */
function selectByLabel(select, wanted) {
  const stem = String(wanted).toUpperCase().slice(0, 5);

  const match = Array.from(select.options)
    .find((o) => o.value && o.value.toUpperCase().startsWith(stem));

  if (match) select.value = match.value;
}

/**
 * Open the capture sheet for an indexed file that already exists.
 *
 * Retitled "Log Inspection" on purpose: the land record is already in the
 * index, so the surveyor is recording an inspection of it, not creating land.
 * Calling that "Add Land Record" invited the reading that a second record was
 * being made for a file that already had one.
 */
async function openForIndexedFile(fileNumber) {
  await openAddRecord({ title: 'Log Inspection' });

  const file = await store.findIndexedFile(fileNumber);

  // Statutory: the file exists, so its details are fixed and inherited.
  // Awaited — it rebuilds the land-use options this function then sets.
  await setTitleType('statutory');
  el.arFileSearch.value = fileNumber;
  el.arFileResults.classList.add('hidden');

  if (file) {
    state.selectedFile = file;
    el.arOwner.value = resolveOwner(file) || '';
    el.arPhone.value = file.phone || '';
    el.arLocation.value = file.location || '';

    // Falls back to the file-number prefix when the index has no land use.
    const use = resolveLandUse(file);
    if (use) selectByLabel(el.arLandUse, use);
  }
}

async function openAddRecord({ title = 'Log Inspection' } = {}) {
  el.arTitle.textContent = title;

  state.titleType = 'statutory';
  state.selectedFile = null;

  ['arFileSearch', 'arOwner', 'arPhone', 'arLocation', 'arCoords', 'arFindings'].forEach((k) => {
    el[k].value = '';
  });

  state.photos = [];
  el.arPhotos.value = '';
  el.arPhotoList.innerHTML = '';
  el.arInspDate.value = new Date().toISOString().slice(0, 10);
  el.arCoordNote.textContent = isNative()
    ? 'Tap GPS while standing on the plot — it needs no connection.'
    : 'GPS needs the installed app.';

  el.arError.classList.add('hidden');
  el.arWarn.classList.add('hidden');
  el.arContravention.classList.add('hidden');
  el.arFileResults.classList.add('hidden');

  const [uses, lgas, districts, cached] = await Promise.all([
    store.listLandUses(), store.listNames('lga_cache'),
    store.listNames('district_cache'), store.countFileIndex()
  ]);

  fillSelect(el.arExisting, uses);
  fillSelect(el.arLga, lgas);
  fillSelect(el.arDistrict, districts, { placeholder: '— optional —' });

  el.arFileHint.textContent = cached
    ? `${cached} file(s) cached on this device.`
    : 'No files cached yet — sync while online to search offline.';

  await applyFieldRules();

  el.sheetAdd.classList.remove('hidden');
  mountInspectionMap(null);
}

/**
 * Bring up the pin map, or explain why there isn't one.
 *
 * Never throws into the caller: the map is a convenience, and GPS remains the
 * way to place a plot when it cannot load.
 */
function mountInspectionMap(initial) {
  el.arMapNote.textContent = 'Loading map…';

  mountPinMap(el.arMap, initial, (coords) => {
    el.arCoords.value = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    el.arMapNote.textContent = 'Pin set from the map.';
    el.arWarn.classList.add('hidden');
  })
    .then((handle) => {
      state.map = handle;
      el.arMap.classList.remove('hidden');
      el.arMapNote.textContent = 'Tap the map to drop a pin, or use GPS.';
    })
    .catch(() => {
      state.map = null;
      el.arMap.classList.add('hidden');
      el.arMapNote.textContent = 'Map needs a connection. Use GPS to place this plot — it works offline.';
    });
}

/**
 * Async on purpose. It repopulates the land-use dropdown, so a caller that
 * pre-fills a value immediately after would have it wiped when the rebuild
 * lands. Callers that set a value must await this first.
 */
/** Disable a control and mark it visually read-only. */
function lock(input, locked) {
  input.disabled = locked;
  input.classList.toggle('is-locked', locked);
}

/**
 * Apply the field rules for the current title type and entry mode.
 *
 * Two independent axes:
 *
 *   title type — a statutory file carries its land use in the register, and
 *     that is not the surveyor's to change on site, so it shows read-only and
 *     is labelled "Land use". A customary title has no register entry, so the
 *     surveyor records what they observe around the plot and it is editable.
 *
 *   entry mode — opened from a file in the list, identity is already known:
 *     file number and owner are filled and locked so they cannot drift from the
 *     register. Started fresh, they are the surveyor's to enter.
 */
async function applyFieldRules() {
  const customary = state.titleType === 'customary';
  const fromIndex = !!state.selectedFile;

  document.querySelectorAll('[data-title-type]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.titleType === state.titleType);

    // A file picked from the register is statutory by definition — offering
    // "Customary" there invites a contradiction with the register.
    const disableCustomary = fromIndex && b.dataset.titleType === 'customary';
    b.disabled = disableCustomary;
    b.classList.toggle('is-locked', disableCustomary);
  });

  el.grpStatutory.classList.toggle('hidden', customary);
  el.grpCustomary.classList.toggle('hidden', !customary);

  lock(el.arFileSearch, fromIndex);
  lock(el.arOwner, fromIndex);

  el.arLandUseLabel.textContent = customary
    ? 'General landuse (observed around)'
    : 'Land use';

  lock(el.arLandUse, !customary);

  el.arLandUseNote.textContent = customary
    ? 'What you observe around the plot.'
    : 'From the file register — not editable on site.';

  // Customary land is only held for three uses; Industrial is excluded.
  const current = el.arLandUse.value;
  const uses = await store.listLandUses({ customaryOnly: customary });
  fillSelect(el.arLandUse, uses);
  if (current) selectByLabel(el.arLandUse, current);
}

async function setTitleType(type) {
  // A locked toggle must not respond to a tap.
  if (state.selectedFile && type === 'customary') return;

  state.titleType = type;
  await applyFieldRules();
}

async function searchFiles() {
  const term = el.arFileSearch.value.trim();

  if (term.length < 2) {
    el.arFileResults.classList.add('hidden');
    return;
  }

  let results = await store.searchFileIndex(term);

  // Organic cache growth: if it is not cached and we have signal, fetch and
  // keep it, so the next visit to this plot works offline.
  if (!results.length && await sync.isOnline()) {
    try {
      const remote = await api.fetchFileIndex({ q: term, limit: 25 });
      await store.cacheFileIndex(remote.data);
      results = await store.searchFileIndex(term);
    } catch {
      /* offline mid-typing is fine — the cached results stand */
    }
  }

  el.arFileResults.innerHTML = results.length
    ? results.map((r) => `
        <button class="result" data-file="${esc(r.file_number)}">
          <strong>${esc(r.file_number)}</strong>
          <small>${esc(r.file_title || r.owner_name || '')} · ${esc(r.location || r.lga || '')}</small>
        </button>`).join('')
    : '<p class="empty">No cached file matches. Sync while online to widen the cache.</p>';

  el.arFileResults.classList.remove('hidden');
}

async function pickFile(fileNumber) {
  const [row] = await store.searchFileIndex(fileNumber, 1);
  if (!row) return;

  state.selectedFile = row;
  state.titleType = 'statutory';

  el.arFileResults.classList.add('hidden');

  // Rebuild first: it repopulates the land-use list and locks the identity
  // fields. Filling values before this would have them wiped.
  await applyFieldRules();

  el.arFileSearch.value = row.file_number;
  el.arOwner.value = resolveOwner(row) || '';
  el.arPhone.value = row.phone || '';
  el.arLocation.value = row.location || '';

  // Falls back to the file-number prefix when the register has no land use.
  const use = resolveLandUse(row);
  if (use) selectByLabel(el.arLandUse, use);

  updateContravention();
}

/**
 * The land use IS the approved use. There is no separate "approved" control any
 * more — it held the same answer twice — so a contravention is the file's land
 * use differing from what the surveyor sees prevailing on the ground.
 */
function updateContravention() {
  const approved = el.arLandUse.value.toUpperCase().trim();
  const prevailing = el.arExisting.value.toUpperCase().trim();

  el.arContravention.classList.toggle(
    'hidden',
    !(approved && prevailing && approved !== prevailing)
  );
}

/**
 * Read the picked images as data URLs.
 *
 * A plain file input with `capture="environment"` opens the camera inside a
 * Capacitor WebView, which avoids pulling in the Camera plugin and the extra
 * permissions it needs. Images are held as data URLs in SQLite so they survive
 * offline, and are uploaded on sync.
 */
async function readPhotos(input) {
  const files = Array.from(input.files || []);

  return Promise.all(files.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve({ name: file.name, data: reader.result });
    reader.readAsDataURL(file);
  })));
}

function renderThumbs(photos) {
  el.arPhotoList.innerHTML = photos
    .map((p) => `<img class="thumb" src="${p.data}" alt="">`).join('');
}

async function saveLandRecord() {
  const data = {
    land_title_type: state.titleType,
    file_number: state.titleType === 'statutory' ? el.arFileSearch.value.trim() : null,
    tracking_id: state.selectedFile?.tracking_id ?? null,
    file_indexing_id: state.selectedFile?.file_indexing_id ?? null,
    owner_name: el.arOwner.value.trim(),
    phone: el.arPhone.value.trim(),
    location: el.arLocation.value.trim(),
    // Only the active control carries a value, so the payload never holds two
    // answers for one field.
    lga: state.titleType === 'customary' ? el.arLga.value : (state.selectedFile?.lga ?? null),
    district: state.titleType === 'customary' ? el.arDistrict.value : (state.selectedFile?.district ?? null),
    land_use_type: el.arLandUse.value,
    // The approved use IS the land use. There was a separate "Approved land
    // use" control holding the same answer, which meant two places to get it
    // wrong; the server still wants both fields, so one value feeds both.
    proposed_use: el.arLandUse.value,
    existing_use: el.arExisting.value
  };

  if (state.titleType === 'customary' && data.lga) {
    data.location = data.location || [el.arDistrict.value, el.arLga.value].filter(Boolean).join(', ');
  }

  // Refuse rather than queue. An invalid row would fail on every push attempt,
  // long after the surveyor has left the site.
  const errors = validateLandRecord(data);

  if (hasErrors(errors)) {
    el.arError.textContent = firstError(errors);
    el.arError.classList.remove('hidden');
    return;
  }

  // The inline inspection. Filling in any of it means an inspection is being
  // recorded alongside the record; leaving it all blank records none.
  const rawCoords = el.arCoords.value.trim();
  const findings = el.arFindings.value.trim();
  const inspDate = el.arInspDate.value;
  const wantsInspection = !!(findings || rawCoords || inspDate);

  if (wantsInspection) {
    const inspErrors = validateFieldData({
      inspection_date: inspDate || new Date().toISOString().slice(0, 10),
      findings,
      coordinates: rawCoords
    });

    if (hasErrors(inspErrors)) {
      el.arError.textContent = firstError(inspErrors);
      el.arError.classList.remove('hidden');
      return;
    }

    // Missing pin warns once, then saves — losing the record entirely would be
    // worse than losing the location (Q5).
    if (!rawCoords && el.arWarn.classList.contains('hidden')) {
      el.arWarn.textContent =
        'No location pin. You are on the plot now — tap GPS if you can. Tap “Save record” again to save without it.';
      el.arWarn.classList.remove('hidden');
      return;
    }
  }

  el.arSave.disabled = true;

  try {
    const photos = state.photos || [];
    const clientUuid = await store.createLandRecord({ ...data, photos }, { createdBy: state.user?.name });

    if (wantsInspection) {
      await store.createFieldData({
        spa_application_client_uuid: clientUuid,
        file_number: data.file_number,
        inspection_date: inspDate || new Date().toISOString().slice(0, 10),
        findings: findings || 'Inspected on site.',
        coordinates: parseCoordinates(rawCoords),
        photos
      }, { createdBy: state.user?.name, surveyorId: state.user?.id });
    }

    el.sheetAdd.classList.add('hidden');
    toast(
      wantsInspection
        ? 'Record and inspection saved on device.'
        : 'Saved on device. It will sync when you have signal.',
      'success'
    );

    await renderAll();
    sync.syncNow({});
  } catch (error) {
    fatal('Save failed', error);
  } finally {
    el.arSave.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------

async function captureGps() {
  const plugin = window.Capacitor?.Plugins?.Geolocation;

  el.arGps.disabled = true;
  el.arGps.textContent = '...';

  try {
    if (!plugin) throw new Error('Geolocation needs the installed app.');

    // Declaring the permission in the manifest is not enough on Android 6+ —
    // it must be granted at runtime, and getCurrentPosition throws an opaque
    // error if it was never asked for.
    let status = await plugin.checkPermissions();

    if (status.location !== 'granted' && status.coarseLocation !== 'granted') {
      status = await plugin.requestPermissions({ permissions: ['location'] });
    }

    if (status.location === 'denied' && status.coarseLocation === 'denied') {
      throw new Error('Location permission was refused. Enable it in Settings, or type coordinates by hand.');
    }

    // Works fully offline — this is the primary way to set a pin in the field.
    const position = await plugin.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000 });
    const { latitude, longitude, accuracy } = position.coords;

    el.arCoords.value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    el.arCoordNote.textContent = `Accurate to about ${Math.round(accuracy)} m.`;
    el.arWarn.classList.add('hidden');

    // Move the pin so the surveyor can see where the fix actually landed — a
    // bad fix on the wrong side of a boundary is otherwise invisible.
    state.map?.setPin({ lat: latitude, lng: longitude });
  } catch (error) {
    el.arCoordNote.textContent = `GPS failed: ${error.message} You can type coordinates, or save without a pin.`;
  } finally {
    el.arGps.disabled = false;
    el.arGps.textContent = 'GPS';
  }
}

// ---------------------------------------------------------------------------
// Field map
// ---------------------------------------------------------------------------

let leafletPromise = null;
let mapInstance = null;

/**
 * Load Leaflet on demand from the network.
 *
 * Not vendored, so the map is online-only — matching the web page, which loads
 * it the same way, and accepting that satellite tiles need a connection
 * regardless. Offline this rejects and the list below carries the same
 * information, which is why capture never depends on the map: GPS does that.
 */
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);

  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);

      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        leafletPromise = null;             // let a later attempt retry
        reject(new Error('Leaflet could not be downloaded.'));
      };
      document.head.appendChild(script);
    });
  }

  return leafletPromise;
}

async function renderMapCanvas(points) {
  if (!points.length) {
    el.mapNotice.textContent = 'No plotted points yet.';
    el.mapNotice.classList.remove('hidden');
    el.mapCanvas.classList.add('hidden');
    return;
  }

  if (!(await sync.isOnline())) {
    el.mapNotice.textContent = 'Offline — satellite tiles need a connection. Points are listed below.';
    el.mapNotice.classList.remove('hidden');
    el.mapCanvas.classList.add('hidden');
    return;
  }

  try {
    const L = await loadLeaflet();

    el.mapCanvas.classList.remove('hidden');
    el.mapNotice.classList.add('hidden');

    if (!mapInstance) {
      mapInstance = L.map(el.mapCanvas).setView([11.9964, 8.5919], 11);   // Kano

      L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { maxZoom: 19, attribution: 'Esri' }
      ).addTo(mapInstance);
    }

    // Redraw markers from scratch — the set is small and this avoids tracking
    // which pins changed between syncs.
    (mapInstance._spasMarkers || []).forEach((m) => mapInstance.removeLayer(m));
    mapInstance._spasMarkers = points.map((f) =>
      L.marker([Number(f.coordinates.lat), Number(f.coordinates.lng)])
        .addTo(mapInstance)
        .bindPopup(
          `<b>${esc(f.file_number || '—')}</b><br>${esc(resolveOwner(f) || '—')}`
          + `<br>${esc(resolveLandUse(f) || '')}`
        ));

    mapInstance.fitBounds(
      L.latLngBounds(points.map((f) => [Number(f.coordinates.lat), Number(f.coordinates.lng)])),
      { padding: [40, 40], maxZoom: 16 }
    );

    // Leaflet mis-measures a container that was display:none when created.
    setTimeout(() => mapInstance.invalidateSize(), 60);
  } catch (error) {
    el.mapNotice.textContent = `Map unavailable: ${error.message} Points are listed below.`;
    el.mapNotice.classList.remove('hidden');
    el.mapCanvas.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function cacheElements() {
  Object.assign(el, {
    login: $('#screen-login'), app: $('#screen-app'), toast: $('#toast'),
    boot: $('#boot'), bootSteps: $('#boot-steps'), bootBar: $('#boot-bar-fill'),
    bootNote: $('#boot-note'), bootContinue: $('#boot-continue'),
    loginId: $('#login-identifier'), loginPw: $('#login-password'),
    loginBase: $('#login-base'), btnLogin: $('#btn-login'), loginError: $('#login-error'),
    who: $('#who'), btnLogout: $('#btn-logout'),
    netDot: $('#net-dot'), syncText: $('#sync-text'), btnSync: $('#btn-sync'),
    statTotal: $('#stat-total'), statOpen: $('#stat-open'),
    statProgress: $('#stat-progress'), statPending: $('#stat-pending'),
    searchRecords: $('#search-records'), listRecords: $('#list-records'),
    searchVerify: $('#search-verify'), listVerify: $('#list-verify'),
    listMap: $('#list-map'), listAwaiting: $('#list-awaiting'),
    countPlotted: $('#count-plotted'), countAwaiting: $('#count-awaiting'),
    mapCanvas: $('#map-canvas'), mapNotice: $('#map-notice'),
    fab: $('#fab'),
    sheetAdd: $('#sheet-add-record'),
    arTitle: $('#ar-title'),
    grpStatutory: $('#grp-statutory'), grpCustomary: $('#grp-customary'),
    arFileSearch: $('#ar-file-search'), arFileResults: $('#ar-file-results'),
    arFileHint: $('#ar-file-hint'), arOwner: $('#ar-owner'), arPhone: $('#ar-phone'),
    arLga: $('#ar-lga'), arDistrict: $('#ar-district'), arLocation: $('#ar-location'),
    arLandUse: $('#ar-land-use'), arExisting: $('#ar-existing'),
    arLandUseLabel: $('#ar-land-use-label'), arLandUseNote: $('#ar-land-use-note'),
    arMap: $('#ar-map'), arMapNote: $('#ar-map-note'),
    arContravention: $('#ar-contravention'), arError: $('#ar-error'),
    arWarn: $('#ar-warn'), arSave: $('#ar-save'),
    arPhotos: $('#ar-photos'), arPhotoList: $('#ar-photo-list'),
    arInspDate: $('#ar-insp-date'), arCoords: $('#ar-coords'),
    arGps: $('#ar-gps'), arCoordNote: $('#ar-coord-note'), arFindings: $('#ar-findings')
  });
}

function wireEvents() {
  el.btnLogin.addEventListener('click', () => doLogin().catch((e) => fatal('Login', e)));
  el.bootContinue.addEventListener('click', () => el.boot.classList.add('hidden'));
  el.btnLogout.addEventListener('click', () => doLogout().catch((e) => fatal('Logout', e)));

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');

      ['records', 'verify', 'map'].forEach((name) =>
        $(`#page-${name}`).classList.toggle('hidden', name !== tab.dataset.tab));

      // Records is the only tab you create from. Field Records is a register of
      // what has been done, and inspections are captured on the record itself.
      el.fab.classList.toggle('hidden', tab.dataset.tab !== 'records');

      if (tab.dataset.tab === 'map') renderMap().catch(() => {});
    });
  });

  el.fab.addEventListener('click', () => openAddRecord().catch((e) => fatal('Open form', e)));

  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => btn.closest('.sheet').classList.add('hidden')));

  document.querySelectorAll('[data-title-type]').forEach((btn) =>
    btn.addEventListener('click', () =>
      setTitleType(btn.dataset.titleType).catch((e) => fatal('Switch title type', e))));

  el.arFileSearch.addEventListener('input', () => searchFiles().catch(() => {}));
  el.arFileResults.addEventListener('click', (e) => {
    const button = e.target.closest('[data-file]');
    if (button) pickFile(button.dataset.file).catch((err) => fatal('Pick file', err));
  });

  el.arLandUse.addEventListener('change', updateContravention);
  el.arExisting.addEventListener('change', updateContravention);
  el.arSave.addEventListener('click', () => saveLandRecord().catch((e) => fatal('Save', e)));

  el.arGps.addEventListener('click', () => captureGps().catch((e) => fatal('GPS', e)));

  // Re-typing coordinates clears the "save anyway" prompt.
  el.arCoords.addEventListener('input', () => el.arWarn.classList.add('hidden'));

  el.arPhotos.addEventListener('change', async () => {
    try {
      state.photos = await readPhotos(el.arPhotos);
      renderThumbs(state.photos);
    } catch (error) {
      fatal('Photos', error);
    }
  });

  // "+" on a Not Added file opens the sheet pre-filled for that file.
  el.listRecords.addEventListener('click', (e) => {
    const button = e.target.closest('.rec-add');
    if (button) openForIndexedFile(button.dataset.fileno).catch((err) => fatal('Open', err));
  });

  el.searchRecords.addEventListener('input', () => renderRecords().catch(() => {}));
  el.searchVerify.addEventListener('input', () => renderVerify().catch(() => {}));

  el.btnSync.addEventListener('click', async () => {
    el.btnSync.disabled = true;

    try {
      const report = await sync.syncNow({ includeLookups: true });

      // syncNow returns {skipped} with no counters when it declines to run.
      // Reading report.pushed regardless produced "Sent undefined, received
      // undefined" on screen — handle every shape it can return.
      if (report.skipped === 'offline') {
        toast('Still offline. Nothing sent — your work is saved on the device.', 'warn');
      } else if (report.skipped === 'already-running') {
        toast('A sync is already running.', 'warn');
      } else if (report.skipped === 'not-logged-in') {
        toast('Sign in to sync.', 'warn');
      } else if (report.error) {
        toast(report.error, 'error');
      } else {
        const bits = [`Sent ${report.pushed ?? 0}`, `received ${report.pulled ?? 0}`];
        if (report.conflicts) bits.push(`${report.conflicts} conflict(s)`);
        if (report.failed) bits.push(`${report.failed} failed`);
        toast(bits.join(', ') + '.', report.conflicts || report.failed ? 'warn' : 'success');
      }
    } catch (error) {
      fatal('Sync', error);
    } finally {
      await renderAll();
      el.btnSync.disabled = false;
    }
  });

  // The conflict counter is the only route to what actually went wrong.
  el.syncText.addEventListener('click', () => showConflicts().catch((e) => fatal('Conflicts', e)));

  sync.onSyncEvent((event) => {
    if (event.type === 'start') el.syncText.textContent = 'Syncing...';
    if (event.type === 'done') renderAll().catch(() => {});
    if (event.type === 'auth-expired') handleAuthExpired().catch(() => show('login'));
    if (event.type === 'conflict') toast(`Conflict: ${event.error.message}`, 'error');
  });
}

async function enterApp() {
  state.user = await api.getUser();
  el.who.textContent = state.user?.name || 'Special Assignment';

  show('app');
  await renderAll();

  sync.startAutoSync(() => ({}));
}

async function boot() {
  cacheElements();
  wireEvents();

  el.loginBase.value = await api.getBaseUrl();

  try {
    await ensureDatabase();
  } catch (error) {
    // Without SQLite there is no app. Say so rather than failing per-tap.
    fatal('Database', error);
    el.loginError.textContent = `Local database unavailable: ${error.message}`;
    el.loginError.classList.remove('hidden');
    return;
  }

  if (await api.isLoggedIn()) {
    await enterApp();
    sync.syncNow({});
    return;
  }

  // Signed out but still holding work — say so, so nobody reinstalls the app
  // thinking their day was lost.
  const pending = await store.pendingCount();

  if (pending > 0) {
    el.loginError.textContent =
      `${pending} record(s) are saved on this device and will sync once you sign in.`;
    el.loginError.classList.remove('hidden');
  }

  show('login');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot().catch((e) => fatal('Boot', e)));
} else {
  boot().catch((e) => fatal('Boot', e));
}

