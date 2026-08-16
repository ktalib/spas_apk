/**
 * SPAS Mobile — local data store.
 *
 * Every screen reads and writes here, never the network. That inversion is the
 * whole offline design: the UI is instant and works with no signal, and a
 * separate sync engine (sync.js) reconciles with the server when there is one.
 *
 * Nothing in this file may throw because the device is offline.
 */

import {
  ensureDatabase,
  insertSpaApplication,
  insertSyncOutbox,
  fetchRowByClientUuid
} from './db.js';

function rows(result) {
  return Array.isArray(result?.values) ? result.values : [];
}

function isoNow() {
  return new Date().toISOString();
}

export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    return (char === 'x' ? rand : (rand & 0x3) | 0x8).toString(16);
  });
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// sync_meta
// ---------------------------------------------------------------------------

export async function getMeta(key) {
  const db = await ensureDatabase();
  const result = await db.query('SELECT value FROM sync_meta WHERE key = ?', [key]);
  return rows(result)[0]?.value ?? null;
}

export async function setMeta(key, value) {
  const db = await ensureDatabase();
  await db.run(
    `INSERT INTO sync_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

// ---------------------------------------------------------------------------
// Reference caches — server always wins, straight replace
// ---------------------------------------------------------------------------

export async function seedLandUses(all, customary) {
  const db = await ensureDatabase();
  const customarySet = new Set((customary || []).map((u) => String(u).toUpperCase().trim()));

  await db.execute('DELETE FROM land_use_cache;');

  for (const use of all || []) {
    await db.run(
      'INSERT OR REPLACE INTO land_use_cache (landuse, is_customary) VALUES (?, ?)',
      [use, customarySet.has(String(use).toUpperCase().trim()) ? 1 : 0]
    );
  }
}

export async function seedNameCache(table, names) {
  const db = await ensureDatabase();
  await db.execute(`DELETE FROM ${table};`);

  for (const name of names || []) {
    await db.run(`INSERT OR REPLACE INTO ${table} (name) VALUES (?)`, [name]);
  }
}

export async function listLandUses({ customaryOnly = false } = {}) {
  const db = await ensureDatabase();
  const sql = customaryOnly
    ? 'SELECT landuse FROM land_use_cache WHERE is_customary = 1 ORDER BY landuse'
    : 'SELECT landuse FROM land_use_cache ORDER BY landuse';

  return rows(await db.query(sql)).map((r) => r.landuse);
}

export async function listNames(table) {
  const db = await ensureDatabase();
  return rows(await db.query(`SELECT name FROM ${table} ORDER BY name`)).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// file_index_cache — pre-seeded by LGA, and grown on every lookup
// ---------------------------------------------------------------------------

/**
 * Cache indexed files.
 *
 * Called both by the LGA pre-seed and, crucially, every time the surveyor looks
 * a file up online. That organic half is what covers the ~940 files whose LGA
 * value no alias can safely resolve — missed by the pre-seed, but cached the
 * first time anyone opens them, so the next visit works offline.
 */
export async function cacheFileIndex(entries) {
  const db = await ensureDatabase();

  for (const row of entries || []) {
    if (!row.file_number) continue;

    await db.run('DELETE FROM file_index_cache WHERE file_number = ?', [row.file_number]);
    await db.run(
      `INSERT INTO file_index_cache
        (file_number, file_title, owner_name, land_use_type, location, district, lga, phone, tracking_id, file_indexing_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.file_number,
        row.file_title ?? null,
        row.owner_name ?? null,
        row.land_use_type ?? null,
        row.location ?? null,
        row.district ?? null,
        row.lga ?? null,
        row.phone ?? null,
        row.tracking_id ?? null,
        row.file_indexing_id ?? null
      ]
    );
  }
}

export async function searchFileIndex(term, limit = 25) {
  const db = await ensureDatabase();
  const like = `%${term}%`;

  return rows(await db.query(
    `SELECT * FROM file_index_cache
      WHERE file_number LIKE ? OR file_title LIKE ? OR owner_name LIKE ? OR location LIKE ?
      ORDER BY file_number LIMIT ?`,
    [like, like, like, like, limit]
  ));
}

export async function countFileIndex() {
  const db = await ensureDatabase();
  return rows(await db.query('SELECT COUNT(*) AS n FROM file_index_cache'))[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Land records
// ---------------------------------------------------------------------------

/**
 * Save a land record locally and queue it for the server.
 *
 * The local write and the outbox entry are one unit — a record that saved but
 * never queued would look synced and silently never reach the office.
 */
export async function createLandRecord(data, { createdBy } = {}) {
  const db = await ensureDatabase();
  const clientUuid = uuid();
  const now = isoNow();

  const row = {
    client_uuid: clientUuid,
    file_number: data.land_title_type === 'customary' ? null : data.file_number,
    tracking_id: data.tracking_id ?? null,
    file_indexing_id: data.file_indexing_id ?? null,
    is_indexed: data.land_title_type === 'customary' ? 0 : 1,
    land_title_type: data.land_title_type,
    owner_name: data.owner_name,
    phone: data.phone ?? null,
    location: data.location ?? null,
    district: data.district ?? null,
    lga: data.lga ?? null,
    land_use_type: data.land_use_type ?? null,
    existing_use: data.existing_use,
    proposed_use: data.proposed_use,
    status: 'open',
    created_by: createdBy ?? null,
    photos: data.photos ?? [],
    sync_status: 'pending',
    created_at: now,
    updated_at: now
  };

  await insertSpaApplication(db, row);

  await insertSyncOutbox(db, {
    entity_type: 'spa_applications',
    entity_client_uuid: clientUuid,
    operation: 'create',
    // The server generates a customary file number, so it is omitted here on
    // purpose — whatever comes back in the response is the authoritative one.
    payload_json: {
      client_uuid: clientUuid,
      land_title_type: row.land_title_type,
      file_number: row.file_number,
      tracking_id: row.tracking_id,
      file_indexing_id: row.file_indexing_id,
      is_indexed: row.is_indexed,
      owner_name: row.owner_name,
      phone: row.phone,
      location: row.location,
      district: row.district,
      lga: row.lga,
      land_use_type: row.land_use_type,
      proposed_use: row.proposed_use,
      existing_use: row.existing_use
    },
    photo_paths_json: data.photos ?? null,
    created_at: now
  });

  return clientUuid;
}

export async function listRecords({ search = '', limit = 200 } = {}) {
  const db = await ensureDatabase();
  const like = `%${search}%`;

  const sql = search
    ? `SELECT * FROM spa_applications
        WHERE file_number LIKE ? OR owner_name LIKE ? OR location LIKE ?
        ORDER BY created_at DESC LIMIT ?`
    : 'SELECT * FROM spa_applications ORDER BY created_at DESC LIMIT ?';

  const params = search ? [like, like, like, limit] : [limit];

  return rows(await db.query(sql, params)).map((r) => ({
    ...r,
    photos: parseJson(r.photos, [])
  }));
}

export async function recordStats() {
  const db = await ensureDatabase();
  const result = rows(await db.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN sync_status = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM spa_applications`
  ))[0] || {};

  return {
    total: result.total || 0,
    open: result.open || 0,
    in_progress: result.in_progress || 0,
    pending: result.pending || 0
  };
}

// ---------------------------------------------------------------------------
// Field data
// ---------------------------------------------------------------------------

export async function createFieldData(data, { surveyorId, createdBy } = {}) {
  const db = await ensureDatabase();
  const clientUuid = uuid();
  const now = isoNow();

  const coordinates = data.coordinates ? JSON.stringify(data.coordinates) : null;
  const parcel = data.parcel_geometry ? JSON.stringify(data.parcel_geometry) : null;

  await db.run(
    `INSERT INTO spa_field_data
      (client_uuid, spa_application_id, spa_application_client_uuid, file_number, surveyor_id,
       inspection_date, coordinates, parcel_geometry, findings, photos, status, created_by,
       sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      clientUuid,
      data.spa_application_id ?? null,
      data.spa_application_client_uuid ?? null,
      data.file_number ?? null,
      surveyorId ?? null,
      data.inspection_date,
      coordinates,
      parcel,
      data.findings,
      JSON.stringify(data.photos ?? []),
      'active',
      createdBy ?? null,
      'pending',
      now,
      now
    ]
  );

  await insertSyncOutbox(db, {
    entity_type: 'spa_field_data',
    entity_client_uuid: clientUuid,
    operation: 'create',
    payload_json: {
      client_uuid: clientUuid,
      spa_application_id: data.spa_application_id ?? null,
      spa_application_client_uuid: data.spa_application_client_uuid ?? null,
      file_number: data.file_number ?? null,
      inspection_date: data.inspection_date,
      coordinates: data.coordinates ?? null,
      parcel_geometry: data.parcel_geometry ?? null,
      findings: data.findings
    },
    photo_paths_json: data.photos ?? null,
    created_at: now
  });

  return clientUuid;
}

export async function listFieldData({ search = '', limit = 200 } = {}) {
  const db = await ensureDatabase();
  const like = `%${search}%`;

  const sql = `
    SELECT f.*, a.owner_name, a.location, a.land_use_type, a.proposed_use, a.existing_use, a.lga
      FROM spa_field_data f
      LEFT JOIN spa_applications a
        ON a.client_uuid = f.spa_application_client_uuid
        OR (a.server_id IS NOT NULL AND a.server_id = f.spa_application_id)
     ${search ? 'WHERE f.file_number LIKE ? OR a.owner_name LIKE ?' : ''}
     ORDER BY f.created_at DESC LIMIT ?`;

  const params = search ? [like, like, limit] : [limit];

  return rows(await db.query(sql, params)).map((r) => ({
    ...r,
    coordinates: parseJson(r.coordinates, null),
    parcel_geometry: parseJson(r.parcel_geometry, null),
    photos: parseJson(r.photos, [])
  }));
}

/** Everything with a pin, for the Field Map tab. */
export async function mapPoints() {
  return (await listFieldData({ limit: 500 })).filter((f) => f.coordinates);
}

/** Q5's other half: captured with no pin, so the office can place it later. */
export async function awaitingLocation() {
  return (await listFieldData({ limit: 500 })).filter((f) => !f.coordinates);
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export async function listOutbox(limit = 100) {
  const db = await ensureDatabase();

  return rows(await db.query(
    `SELECT * FROM sync_outbox
      WHERE last_error IS NULL OR last_error NOT LIKE 'CONFLICT:%'
      ORDER BY id ASC LIMIT ?`,
    [limit]
  )).map((r) => ({
    ...r,
    payload_json: parseJson(r.payload_json, {}),
    photo_paths_json: parseJson(r.photo_paths_json, [])
  }));
}

export async function pendingCount() {
  const db = await ensureDatabase();
  return rows(await db.query('SELECT COUNT(*) AS n FROM sync_outbox'))[0]?.n ?? 0;
}

export async function conflictCount() {
  const db = await ensureDatabase();
  return rows(await db.query(
    "SELECT COUNT(*) AS n FROM sync_outbox WHERE last_error LIKE 'CONFLICT:%'"
  ))[0]?.n ?? 0;
}

export async function listConflicts() {
  const db = await ensureDatabase();
  return rows(await db.query(
    "SELECT * FROM sync_outbox WHERE last_error LIKE 'CONFLICT:%' ORDER BY id DESC"
  ));
}

export async function deleteOutboxEntry(id) {
  const db = await ensureDatabase();
  await db.run('DELETE FROM sync_outbox WHERE id = ?', [id]);
}

export async function markOutboxError(id, message, { conflict = false } = {}) {
  const db = await ensureDatabase();
  await db.run(
    'UPDATE sync_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?',
    [`${conflict ? 'CONFLICT:' : ''}${message}`.slice(0, 500), id]
  );
}

// ---------------------------------------------------------------------------
// Applying server results
// ---------------------------------------------------------------------------

export async function markRecordSynced(clientUuid, serverId, fileNumber) {
  const db = await ensureDatabase();

  // The server owns the customary sequence, so whatever it returned replaces
  // the local placeholder.
  await db.run(
    `UPDATE spa_applications
        SET sync_status = 'synced', server_id = ?, file_number = COALESCE(?, file_number)
      WHERE client_uuid = ?`,
    [serverId ?? null, fileNumber ?? null, clientUuid]
  );
}

export async function markFieldDataSynced(clientUuid, serverId, spaApplicationId) {
  const db = await ensureDatabase();
  await db.run(
    `UPDATE spa_field_data
        SET sync_status = 'synced', server_id = ?, spa_application_id = COALESCE(?, spa_application_id)
      WHERE client_uuid = ?`,
    [serverId ?? null, spaApplicationId ?? null, clientUuid]
  );
}

/**
 * Upsert a record pulled from the server.
 *
 * Rows still pending locally are skipped: the device's unsynced edit is newer
 * than anything the server can know about, and overwriting it would silently
 * discard field work.
 */
export async function upsertServerRecord(remote) {
  const db = await ensureDatabase();

  const existing = remote.client_uuid
    ? await fetchRowByClientUuid(db, 'spa_applications', remote.client_uuid)
    : rows(await db.query('SELECT * FROM spa_applications WHERE server_id = ?', [remote.id]))[0];

  if (existing?.sync_status === 'pending') return;

  const clientUuid = remote.client_uuid || existing?.client_uuid || uuid();

  const values = [
    remote.id ?? null,
    remote.file_number ?? null,
    remote.tracking_id ?? null,
    remote.file_indexing_id ?? null,
    remote.is_indexed ? 1 : 0,
    remote.land_title_type ?? null,
    remote.owner_name ?? null,
    remote.phone ?? null,
    remote.location ?? null,
    remote.district ?? null,
    remote.lga ?? null,
    remote.land_use_type ?? null,
    remote.existing_use ?? null,
    remote.proposed_use ?? null,
    remote.scenario ?? null,
    remote.status ?? null,
    remote.created_by ?? null,
    JSON.stringify(remote.photos ?? []),
    remote.created_at ?? isoNow(),
    remote.updated_at ?? isoNow()
  ];

  if (existing) {
    await db.run(
      `UPDATE spa_applications SET
         server_id = ?, file_number = ?, tracking_id = ?, file_indexing_id = ?, is_indexed = ?,
         land_title_type = ?, owner_name = ?, phone = ?, location = ?, district = ?, lga = ?,
         land_use_type = ?, existing_use = ?, proposed_use = ?, scenario = ?, status = ?,
         created_by = ?, photos = ?, created_at = ?, updated_at = ?, sync_status = 'synced'
       WHERE client_uuid = ?`,
      [...values, clientUuid]
    );
    return;
  }

  await db.run(
    `INSERT INTO spa_applications
      (client_uuid, server_id, file_number, tracking_id, file_indexing_id, is_indexed,
       land_title_type, owner_name, phone, location, district, lga, land_use_type,
       existing_use, proposed_use, scenario, status, created_by, photos, created_at,
       updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
    [clientUuid, ...values]
  );
}

export async function upsertServerFieldData(remote) {
  const db = await ensureDatabase();

  const existing = remote.client_uuid
    ? await fetchRowByClientUuid(db, 'spa_field_data', remote.client_uuid)
    : rows(await db.query('SELECT * FROM spa_field_data WHERE server_id = ?', [remote.id]))[0];

  if (existing?.sync_status === 'pending') return;

  const clientUuid = remote.client_uuid || existing?.client_uuid || uuid();

  const values = [
    remote.id ?? null,
    remote.spa_application_id ?? null,
    remote.spa_application_client_uuid ?? null,
    remote.file_number ?? null,
    remote.surveyor_id ?? null,
    remote.inspection_date ?? null,
    remote.coordinates ? JSON.stringify(remote.coordinates) : null,
    remote.parcel_geometry ? JSON.stringify(remote.parcel_geometry) : null,
    remote.findings ?? null,
    JSON.stringify(remote.photos ?? []),
    remote.status ?? null,
    remote.created_at ?? isoNow(),
    remote.updated_at ?? isoNow()
  ];

  if (existing) {
    await db.run(
      `UPDATE spa_field_data SET
         server_id = ?, spa_application_id = ?, spa_application_client_uuid = ?, file_number = ?,
         surveyor_id = ?, inspection_date = ?, coordinates = ?, parcel_geometry = ?, findings = ?,
         photos = ?, status = ?, created_at = ?, updated_at = ?, sync_status = 'synced'
       WHERE client_uuid = ?`,
      [...values, clientUuid]
    );
    return;
  }

  await db.run(
    `INSERT INTO spa_field_data
      (client_uuid, server_id, spa_application_id, spa_application_client_uuid, file_number,
       surveyor_id, inspection_date, coordinates, parcel_geometry, findings, photos, status,
       created_at, updated_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')`,
    [clientUuid, ...values]
  );
}

/** Applications with no inspection yet — the Log Inspection picker. */
export async function selectableApplications() {
  const db = await ensureDatabase();

  return rows(await db.query(
    `SELECT a.client_uuid, a.server_id, a.file_number, a.owner_name
       FROM spa_applications a
      WHERE NOT EXISTS (
        SELECT 1 FROM spa_field_data f
         WHERE f.spa_application_client_uuid = a.client_uuid
            OR (a.server_id IS NOT NULL AND f.spa_application_id = a.server_id)
      )
      ORDER BY a.created_at DESC LIMIT 200`
  ));
}
