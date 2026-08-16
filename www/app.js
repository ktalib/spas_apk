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
  validateLandRecord, validateFieldData, warnFieldData,
  parseCoordinates, hasErrors, firstError
} from './validate.js';

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

    toast('Signed in. Downloading reference data...', 'success');

    // First run needs the lookups before the form is usable offline.
    await sync.refreshLookups({});
    await sync.syncNow({});

    await enterApp();
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

async function renderRecords() {
  const search = el.searchRecords.value.trim();
  const [list, stats] = await Promise.all([store.listRecords({ search }), store.recordStats()]);

  el.statTotal.textContent = stats.total;
  el.statOpen.textContent = stats.open;
  el.statProgress.textContent = stats.in_progress;
  el.statPending.textContent = stats.pending;

  el.listRecords.innerHTML = list.length ? list.map((r) => `
    <article class="card">
      <div class="card__top">
        <strong>${esc(r.file_number || 'Pending file number')}</strong>
        ${syncBadge(r)}
      </div>
      <div class="card__owner">${esc(r.owner_name || '—')}</div>
      <div class="card__meta">${esc(r.location || r.lga || '—')}</div>
      <div class="card__uses">
        <span class="chip">${esc(r.proposed_use || '—')}</span>
        <span class="chip">${esc(r.existing_use || '—')}</span>
        ${contravenes(r) ? '<span class="chip chip--danger">Contravention</span>' : ''}
      </div>
    </article>
  `).join('') : '<p class="empty">No records yet. Tap “Add Land Record”.</p>';
}

async function renderVerify() {
  const search = el.searchVerify.value.trim();
  const list = await store.listFieldData({ search });

  el.listVerify.innerHTML = list.length ? list.map((f) => `
    <article class="card">
      <div class="card__top">
        <strong>${esc(f.file_number || '—')}</strong>
        ${syncBadge(f)}
      </div>
      <div class="card__owner">${esc(f.owner_name || '—')}</div>
      <div class="card__meta">${esc(f.inspection_date || '—')}</div>
      <div class="card__uses">
        <span class="chip chip--ok">Inspected</span>
        ${f.coordinates ? '' : '<span class="chip chip--warn">No pin</span>'}
        ${contravenes(f) ? '<span class="chip chip--danger">Contravention</span>' : ''}
      </div>
      <p class="card__findings">${esc((f.findings || '').slice(0, 120))}</p>
    </article>
  `).join('') : '<p class="empty">No inspections recorded yet.</p>';
}

async function renderMap() {
  const [plotted, awaiting] = await Promise.all([store.mapPoints(), store.awaitingLocation()]);

  el.countPlotted.textContent = plotted.length;
  el.countAwaiting.textContent = awaiting.length;

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

// ---------------------------------------------------------------------------
// Add Land Record
// ---------------------------------------------------------------------------

function fillSelect(select, values, { placeholder = '— select —' } = {}) {
  select.innerHTML = `<option value="">${placeholder}</option>`
    + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

async function openAddRecord() {
  state.titleType = 'statutory';
  state.selectedFile = null;

  document.querySelectorAll('[data-title-type]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.titleType === 'statutory'));

  el.grpStatutory.classList.remove('hidden');
  el.grpCustomary.classList.add('hidden');

  ['arFileSearch', 'arOwner', 'arPhone', 'arLocation'].forEach((k) => { el[k].value = ''; });
  el.arError.classList.add('hidden');
  el.arContravention.classList.add('hidden');
  el.arFileResults.classList.add('hidden');

  const [uses, lgas, districts, cached] = await Promise.all([
    store.listLandUses(), store.listNames('lga_cache'),
    store.listNames('district_cache'), store.countFileIndex()
  ]);

  fillSelect(el.arLandUse, uses);
  fillSelect(el.arProposed, uses);
  fillSelect(el.arExisting, uses);
  fillSelect(el.arLga, lgas);
  fillSelect(el.arDistrict, districts, { placeholder: '— optional —' });

  el.arFileHint.textContent = cached
    ? `${cached} file(s) cached on this device.`
    : 'No files cached yet — sync while online to search offline.';

  el.sheetAdd.classList.remove('hidden');
}

function setTitleType(type) {
  state.titleType = type;

  document.querySelectorAll('[data-title-type]').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.titleType === type));

  el.grpStatutory.classList.toggle('hidden', type !== 'statutory');
  el.grpCustomary.classList.toggle('hidden', type !== 'customary');

  // Customary land is only held for three uses — Industrial is excluded.
  store.listLandUses({ customaryOnly: type === 'customary' })
    .then((uses) => fillSelect(el.arLandUse, uses));
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

  el.arFileSearch.value = row.file_number;
  el.arOwner.value = row.file_title || row.owner_name || '';
  el.arPhone.value = row.phone || '';
  el.arLocation.value = row.location || '';
  if (row.land_use_type) el.arLandUse.value = row.land_use_type;

  el.arFileResults.classList.add('hidden');
}

function updateContravention() {
  const a = el.arProposed.value.toUpperCase().trim();
  const b = el.arExisting.value.toUpperCase().trim();
  el.arContravention.classList.toggle('hidden', !(a && b && a !== b));
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
    proposed_use: el.arProposed.value,
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

  el.arSave.disabled = true;

  try {
    await store.createLandRecord(data, { createdBy: state.user?.name });
    el.sheetAdd.classList.add('hidden');
    toast('Saved on device. It will sync when you have signal.', 'success');
    await renderAll();
    sync.syncNow({});
  } catch (error) {
    fatal('Save failed', error);
  } finally {
    el.arSave.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Log Field Inspection
// ---------------------------------------------------------------------------

async function openLogInspection() {
  const apps = await store.selectableApplications();

  el.liApplication.innerHTML = '<option value="">— select —</option>'
    + apps.map((a) => `<option value="${esc(a.client_uuid)}">${esc(a.file_number || 'Pending')} — ${esc(a.owner_name || '')}</option>`).join('');

  el.liDate.value = new Date().toISOString().slice(0, 10);
  el.liCoords.value = '';
  el.liFindings.value = '';
  el.liError.classList.add('hidden');
  el.liWarn.classList.add('hidden');
  el.liCoordNote.textContent = isNative()
    ? 'Tap GPS while standing on the plot — it needs no connection.'
    : 'GPS needs the installed app.';

  el.sheetLog.classList.remove('hidden');
}

async function captureGps() {
  const plugin = window.Capacitor?.Plugins?.Geolocation;

  el.liGps.disabled = true;
  el.liGps.textContent = '...';

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

    el.liCoords.value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    el.liCoordNote.textContent = `Accurate to about ${Math.round(accuracy)} m.`;
  } catch (error) {
    el.liCoordNote.textContent = `GPS failed: ${error.message}. You can type coordinates or save without a pin.`;
  } finally {
    el.liGps.disabled = false;
    el.liGps.textContent = 'GPS';
  }
}

async function saveInspection() {
  const parentUuid = el.liApplication.value;
  const coords = parseCoordinates(el.liCoords.value.trim());

  const data = {
    spa_application_client_uuid: parentUuid || null,
    inspection_date: el.liDate.value,
    findings: el.liFindings.value.trim(),
    coordinates: coords
  };

  if (!parentUuid) {
    el.liError.textContent = 'Choose the application this inspection belongs to.';
    el.liError.classList.remove('hidden');
    return;
  }

  const errors = validateFieldData({ ...data, coordinates: el.liCoords.value.trim() });

  if (hasErrors(errors)) {
    el.liError.textContent = firstError(errors);
    el.liError.classList.remove('hidden');
    return;
  }

  // A missing pin warns once, then saves. Losing the record entirely would be
  // worse than losing the location (product decision Q5).
  const warnings = warnFieldData({ coordinates: el.liCoords.value.trim() });

  if (warnings.length && el.liWarn.classList.contains('hidden')) {
    el.liWarn.textContent = `${warnings[0]} Tap “Save inspection” again to save without it.`;
    el.liWarn.classList.remove('hidden');
    return;
  }

  const [parent] = (await store.listRecords({ limit: 500 })).filter((r) => r.client_uuid === parentUuid);

  el.liSave.disabled = true;

  try {
    await store.createFieldData({
      ...data,
      spa_application_id: parent?.server_id ?? null,
      file_number: parent?.file_number ?? null
    }, { createdBy: state.user?.name, surveyorId: state.user?.id });

    el.sheetLog.classList.add('hidden');
    toast('Inspection saved on device.', 'success');
    await renderAll();
    sync.syncNow({});
  } catch (error) {
    fatal('Save failed', error);
  } finally {
    el.liSave.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function cacheElements() {
  Object.assign(el, {
    login: $('#screen-login'), app: $('#screen-app'), toast: $('#toast'),
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
    fab: $('#fab'),
    sheetAdd: $('#sheet-add-record'), sheetLog: $('#sheet-log-inspect'),
    grpStatutory: $('#grp-statutory'), grpCustomary: $('#grp-customary'),
    arFileSearch: $('#ar-file-search'), arFileResults: $('#ar-file-results'),
    arFileHint: $('#ar-file-hint'), arOwner: $('#ar-owner'), arPhone: $('#ar-phone'),
    arLga: $('#ar-lga'), arDistrict: $('#ar-district'), arLocation: $('#ar-location'),
    arLandUse: $('#ar-land-use'), arProposed: $('#ar-proposed'), arExisting: $('#ar-existing'),
    arContravention: $('#ar-contravention'), arError: $('#ar-error'), arSave: $('#ar-save'),
    liApplication: $('#li-application'), liDate: $('#li-date'), liCoords: $('#li-coords'),
    liGps: $('#li-gps'), liCoordNote: $('#li-coord-note'), liFindings: $('#li-findings'),
    liError: $('#li-error'), liWarn: $('#li-warn'), liSave: $('#li-save')
  });
}

function wireEvents() {
  el.btnLogin.addEventListener('click', () => doLogin().catch((e) => fatal('Login', e)));
  el.btnLogout.addEventListener('click', () => doLogout().catch((e) => fatal('Logout', e)));

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');

      ['records', 'verify', 'map'].forEach((name) =>
        $(`#page-${name}`).classList.toggle('hidden', name !== tab.dataset.tab));

      // The floating action only makes sense on the Records tab.
      el.fab.classList.toggle('hidden', tab.dataset.tab === 'map');
      el.fab.textContent = tab.dataset.tab === 'verify' ? '+ Log Inspection' : '+ Add Land Record';
    });
  });

  el.fab.addEventListener('click', () => {
    const active = document.querySelector('.tab.is-active').dataset.tab;
    (active === 'verify' ? openLogInspection() : openAddRecord()).catch((e) => fatal('Open form', e));
  });

  document.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => btn.closest('.sheet').classList.add('hidden')));

  document.querySelectorAll('[data-title-type]').forEach((btn) =>
    btn.addEventListener('click', () => setTitleType(btn.dataset.titleType)));

  el.arFileSearch.addEventListener('input', () => searchFiles().catch(() => {}));
  el.arFileResults.addEventListener('click', (e) => {
    const button = e.target.closest('[data-file]');
    if (button) pickFile(button.dataset.file).catch((err) => fatal('Pick file', err));
  });

  el.arProposed.addEventListener('change', updateContravention);
  el.arExisting.addEventListener('change', updateContravention);
  el.arSave.addEventListener('click', () => saveLandRecord().catch((e) => fatal('Save', e)));

  el.liGps.addEventListener('click', () => captureGps().catch((e) => fatal('GPS', e)));
  el.liSave.addEventListener('click', () => saveInspection().catch((e) => fatal('Save', e)));
  // Re-typing coordinates clears the "save anyway" prompt.
  el.liCoords.addEventListener('input', () => el.liWarn.classList.add('hidden'));

  el.searchRecords.addEventListener('input', () => renderRecords().catch(() => {}));
  el.searchVerify.addEventListener('input', () => renderVerify().catch(() => {}));

  el.btnSync.addEventListener('click', async () => {
    el.btnSync.disabled = true;
    const report = await sync.syncNow({ includeLookups: true });

    if (report.skipped === 'offline') toast('Still offline. Nothing sent.', 'warn');
    else if (report.error) toast(report.error, 'error');
    else toast(`Sent ${report.pushed}, received ${report.pulled}.`, 'success');

    await renderAll();
    el.btnSync.disabled = false;
  });

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
