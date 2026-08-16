/**
 * SPAS Mobile — API client.
 *
 * The ONLY module that talks to the network. Everything else reads and writes
 * local SQLite, which is what makes the app work with no signal.
 *
 * No bare imports anywhere in this project — there is no bundler. See db.js.
 */

const DEFAULT_BASE = 'http://app.klaes.ng';

const KEY_TOKEN = 'spas.token';
const KEY_BASE  = 'spas.base_url';
const KEY_USER  = 'spas.user';

/** Capacitor Preferences, with a localStorage fallback for browser testing. */
function prefs() {
  const plugin = window.Capacitor?.Plugins?.Preferences;

  if (plugin) {
    return {
      get: async (key) => (await plugin.get({ key })).value,
      set: (key, value) => plugin.set({ key, value }),
      remove: (key) => plugin.remove({ key })
    };
  }

  return {
    get: async (key) => window.localStorage.getItem(key),
    set: async (key, value) => window.localStorage.setItem(key, value),
    remove: async (key) => window.localStorage.removeItem(key)
  };
}

export async function getBaseUrl() {
  return (await prefs().get(KEY_BASE)) || DEFAULT_BASE;
}

export async function setBaseUrl(url) {
  await prefs().set(KEY_BASE, String(url).replace(/\/+$/, ''));
}

export async function getToken() {
  return prefs().get(KEY_TOKEN);
}

export async function getUser() {
  const raw = await prefs().get(KEY_USER);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function isLoggedIn() {
  return !!(await getToken());
}

/**
 * Thrown for anything the caller may want to branch on.
 * `status` 0 means the request never reached the server — offline, DNS, timeout.
 */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body || {};
  }

  /** True when this failed for lack of network, not because the server said no. */
  get isOffline() {
    return this.status === 0;
  }

  /** A conflict the server will never accept — surface it, stop retrying. */
  get isConflict() {
    return this.status === 409;
  }

  get isValidation() {
    return this.status === 422;
  }

  get isAuth() {
    return this.status === 401;
  }
}

async function request(method, path, { body, formData, timeout = 30000 } = {}) {
  const base = await getBaseUrl();
  const token = await getToken();

  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload;
  if (formData) {
    payload = formData;                       // browser sets its own boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(`${base}/api/spas${path}`, {
      method,
      headers,
      body: payload,
      signal: controller.signal
    });
  } catch (error) {
    // fetch() throwing means the request never reached the server. That is not
    // proof the device is offline: a blocked cleartext call, a mixed-content
    // block, a wrong host or bad DNS all land here too, and saying "no
    // connection" when the phone has full signal sends everyone hunting the
    // wrong problem. Name the host so the message is actionable.
    // Name the endpoint, not just the host. "Timed out reaching
    // http://app.klaes.ng" cannot tell you whether sign-in itself failed or a
    // reference-data download did, which are very different problems.
    throw new ApiError(
      controller.signal.aborted
        ? `Timed out after ${Math.round(timeout / 1000)}s on ${method} ${path}.`
        : `Could not reach ${base}${path}. Check the server address, or your connection.`,
      0
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // A proxy or error page rather than the API. Say so plainly — this is what
    // a missing deployment looks like from the handset.
    throw new ApiError(
      `Server returned ${response.status} but not JSON. Is /api/spas deployed at ${base}?`,
      response.status,
      { raw: text.slice(0, 200) }
    );
  }

  if (!response.ok) {
    throw new ApiError(json.message || `Request failed (${response.status}).`, response.status, json);
  }

  return json;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function login(identifier, password, deviceName = 'spas-mobile') {
  const result = await request('POST', '/auth/login', {
    body: { identifier, password, device_name: deviceName }
  });

  await prefs().set(KEY_TOKEN, result.token);
  await prefs().set(KEY_USER, JSON.stringify(result.user || {}));

  return result;
}

/**
 * Clear the local session.
 *
 * Deliberately does NOT touch local records or the outbox: a token can expire
 * while a surveyor still holds unsynced work, and throwing that away would lose
 * a day in the field.
 */
export async function logout({ callServer = true } = {}) {
  if (callServer) {
    try {
      await request('POST', '/auth/logout');
    } catch {
      // Offline logout is still a logout locally.
    }
  }

  await prefs().remove(KEY_TOKEN);
  await prefs().remove(KEY_USER);
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export function pullRecords(since) {
  return request('GET', `/records${since ? `?since=${encodeURIComponent(since)}` : ''}`);
}

export function pullFieldData(since) {
  return request('GET', `/field-data${since ? `?since=${encodeURIComponent(since)}` : ''}`);
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export function pushRecord(payload) {
  return request('POST', '/records', { body: payload });
}

export function pushFieldData(payload) {
  return request('POST', '/field-data', { body: payload });
}

export function updateRecord(clientUuid, payload) {
  return request('PUT', `/records/${clientUuid}`, { body: payload });
}

export function updateFieldData(clientUuid, payload) {
  return request('PUT', `/field-data/${clientUuid}`, { body: payload });
}

export function linkOrphans() {
  return request('POST', '/link-orphans');
}

/**
 * @param {Blob[]} blobs
 */
export function uploadPhotos(entityType, clientUuid, blobs) {
  const form = new FormData();
  form.append('entity_type', entityType);
  form.append('client_uuid', clientUuid);
  blobs.forEach((blob, i) => form.append('photos[]', blob, `photo-${i + 1}.jpg`));

  return request('POST', '/photos', { formData: form, timeout: 120000 });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function fetchLandUses() {
  return request('GET', '/lookup/land-uses');
}

export function fetchLgas() {
  return request('GET', '/lookup/lgas');
}

export function fetchDistricts() {
  return request('GET', '/lookup/districts');
}

/**
 * The heaviest lookup: a few hundred rows over a field connection. Given a
 * longer budget than the default because timing out here should be rare and is
 * never fatal — the caller treats it as best-effort.
 */
export function fetchFileIndex(params = {}) {
  const qs = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((v) => qs.append(`${key}[]`, v));
    } else {
      qs.append(key, value);
    }
  });

  return request('GET', `/lookup/file-index?${qs.toString()}`, { timeout: 60000 });
}

export function nextCustomaryFileNumber() {
  return request('GET', '/lookup/next-customary-fileno');
}
