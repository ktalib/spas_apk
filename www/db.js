/**
 * Local SQLite data layer for SPAS Mobile (plan §4.2).
 *
 * NO BARE IMPORTS IN THIS PROJECT.
 * -------------------------------
 * This file previously began with:
 *
 *     import { Capacitor } from '@capacitor/core';
 *     import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
 *
 * There is no bundler here — no Vite, no webpack, no build step in package.json —
 * and a browser cannot resolve a bare specifier like '@capacitor/core'. The
 * module threw "Failed to resolve module specifier" the instant it loaded, so
 * nothing below ever ran: no click handlers were attached and the UI sat at
 * "Booting..." with Platform: unknown, looking like dead buttons rather than a
 * script error.
 *
 * Capacitor injects a `window.Capacitor` global into the WebView at runtime,
 * with every installed plugin under `window.Capacitor.Plugins`. That is what we
 * use. Relative imports ('./db.js') are fine and still used by app.js — only
 * BARE specifiers are unresolvable.
 *
 * If a bundler is ever added (Phase 3 may want one), this can go back to real
 * imports — but then the build step becomes mandatory before every `cap sync`.
 */

const DB_NAME = 'spas_mobile';
const DB_VERSION = 1;

/**
 * ENCRYPTION AT REST
 * -----------------
 * The database is encrypted with SQLCipher (shipped inside
 * @capacitor-community/sqlite — no extra dependency). Every handset holds the
 * FULL record list including owner names and phone numbers, because there is no
 * per-surveyor filtering, so a lost phone is otherwise the whole dataset.
 *
 * The passphrase is generated once on this device, handed to the plugin, and
 * never kept by us. The plugin stores it in EncryptedSharedPreferences behind
 * an Android Keystore MasterKey (AES256_GCM) — hardware-backed and not
 * extractable.
 *
 * WHY NOT DERIVE THE KEY FROM A USER PIN
 * Because a forgotten PIN would then destroy unsynced field work — a day of
 * survey with no other copy. The Keystore holds the key better than a person
 * can, and an app lock (planned separately) is a GATE, never a key. Keep those
 * two decoupled.
 *
 * WHAT ENCRYPTION DOES NOT COVER
 * A phone found unlocked with the app open. The app decrypts automatically, so
 * that case needs the OS lock screen plus an app lock — not this.
 *
 * NOTE: `android:allowBackup` must stay "false". A Keystore key does not travel
 * through an Android backup/restore, so a restored app would meet an encrypted
 * database it cannot open and look corrupted. The server is the system of
 * record, so backup buys nothing here.
 */
const USE_ENCRYPTION = true;

let connectionPromise = null;

/** The Capacitor runtime global, or null in a plain browser. */
function capacitor() {
  return typeof window !== 'undefined' ? window.Capacitor : undefined;
}

export function getPlatform() {
  const cap = capacitor();
  return cap && typeof cap.getPlatform === 'function' ? cap.getPlatform() : 'web';
}

export function isNative() {
  const cap = capacitor();
  return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
}

function sqlitePlugin() {
  const cap = capacitor();
  const plugin = cap && cap.Plugins ? cap.Plugins.CapacitorSQLite : undefined;

  if (!plugin) {
    throw new Error(
      'CapacitorSQLite plugin is not available. This screen must run inside the ' +
      'installed Android app — a desktop browser has no native SQLite bridge.'
    );
  }

  return plugin;
}

/*
 * PRAGMA foreign_keys is deliberately NOT in this list. The plugin manages that
 * pragma itself, and including it in an execute() batch fails on some versions.
 */
const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS spa_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uuid TEXT NOT NULL UNIQUE,
    server_id INTEGER,
    file_number TEXT,
    tracking_id TEXT,
    file_indexing_id INTEGER,
    is_indexed INTEGER,
    land_title_type TEXT,
    owner_name TEXT,
    phone TEXT,
    location TEXT,
    district TEXT,
    lga TEXT,
    land_use_type TEXT,
    existing_use TEXT,
    proposed_use TEXT,
    scenario TEXT,
    status TEXT,
    created_by TEXT,
    photos TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spa_applications_server_id
    ON spa_applications (server_id)`,
  `CREATE INDEX IF NOT EXISTS idx_spa_applications_sync_status
    ON spa_applications (sync_status)`,
  `CREATE TABLE IF NOT EXISTS spa_field_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uuid TEXT NOT NULL UNIQUE,
    server_id INTEGER,
    spa_application_id INTEGER,
    spa_application_client_uuid TEXT,
    file_number TEXT,
    surveyor_id INTEGER,
    inspection_date TEXT,
    coordinates TEXT,
    parcel_geometry TEXT,
    findings TEXT,
    photos TEXT,
    status TEXT,
    created_by TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    FOREIGN KEY (spa_application_client_uuid) REFERENCES spa_applications (client_uuid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spa_field_data_server_id
    ON spa_field_data (server_id)`,
  `CREATE INDEX IF NOT EXISTS idx_spa_field_data_application_client_uuid
    ON spa_field_data (spa_application_client_uuid)`,
  `CREATE INDEX IF NOT EXISTS idx_spa_field_data_sync_status
    ON spa_field_data (sync_status)`,
  `CREATE TABLE IF NOT EXISTS file_index_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_number TEXT,
    file_title TEXT,
    owner_name TEXT,
    land_use_type TEXT,
    location TEXT,
    district TEXT,
    lga TEXT,
    phone TEXT,
    tracking_id TEXT,
    file_indexing_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_file_index_cache_file_number
    ON file_index_cache (file_number)`,
  /* The cache is seeded per surveyor by LGA/district (product decision,
     2026-08-16), so lookups filter on those two columns constantly. */
  `CREATE INDEX IF NOT EXISTS idx_file_index_cache_lga
    ON file_index_cache (lga)`,
  `CREATE INDEX IF NOT EXISTS idx_file_index_cache_district
    ON file_index_cache (district)`,
  `CREATE TABLE IF NOT EXISTS land_use_cache (
    landuse TEXT PRIMARY KEY,
    is_customary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,
  `CREATE TABLE IF NOT EXISTS lga_cache (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,
  `CREATE TABLE IF NOT EXISTS district_cache (
    name TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_client_uuid TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update')),
    payload_json TEXT NOT NULL,
    photo_paths_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_outbox_entity_client_uuid
    ON sync_outbox (entity_client_uuid)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at
    ON sync_outbox (created_at)`,
  `CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`
];

function rowsFrom(result) {
  return Array.isArray(result && result.values) ? result.values : [];
}

function isoNow() {
  return new Date().toISOString();
}

function generateUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return template.replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Thin handle over the raw plugin.
 *
 * The SQLiteConnection/SQLiteDBConnection wrapper classes this file used before
 * only exist in the npm package, which needs a bundler. The raw plugin takes the
 * database name on every call instead, so this wrapper binds it once and keeps
 * the call sites readable.
 */
function makeHandle(plugin) {
  const base = { database: DB_NAME, readonly: false };

  return {
    execute: (statements, transaction = true) =>
      plugin.execute({ ...base, statements, transaction }),
    run: (statement, values = [], transaction = true) =>
      plugin.run({ ...base, statement, values, transaction }),
    query: (statement, values = []) =>
      plugin.query({ ...base, statement, values }),
    /**
     * Run many parameterised statements inside ONE transaction.
     *
     * Seeding the file index row by row means two statements and two
     * transactions per row — hundreds of disk syncs, which is slow enough on a
     * handset to look like a hang. `set` is a list of {statement, values}.
     */
    executeSet: (set, transaction = true) =>
      plugin.executeSet({ ...base, set, transaction }),
    close: () => plugin.close(base),
    closeConnection: () => plugin.closeConnection(base)
  };
}

/** A 256-bit passphrase from the platform CSPRNG, hex encoded. */
function generatePassphrase() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Make sure a passphrase exists in the Keystore-backed store.
 *
 * Generated once per install and handed straight to the plugin — we never keep
 * a copy, because a copy in JS or Preferences would be the weakest link.
 */
async function ensureEncryptionSecret(plugin) {
  const stored = await plugin.isSecretStored();

  if (stored?.result) return;

  await plugin.setEncryptionSecret({ passphrase: generatePassphrase() });
}

async function getConnection() {
  if (!isNative()) {
    throw new Error('SQLite requires the native Android runtime — install and open the APK.');
  }

  if (!connectionPromise) {
    connectionPromise = (async () => {
      const plugin = sqlitePlugin();

      if (USE_ENCRYPTION) {
        await ensureEncryptionSecret(plugin);
      }

      // "secret" opens a database already encrypted with the stored passphrase.
      // "encryption" converts an existing plaintext database in place — needed
      // only for a handset that already holds data from a pre-encryption build.
      let mode = USE_ENCRYPTION ? 'secret' : 'no-encryption';

      if (USE_ENCRYPTION) {
        try {
          const existing = await plugin.isDatabaseEncrypted({ database: DB_NAME });

          // A database file that exists but is NOT yet encrypted must be
          // converted, or opening it in "secret" mode fails as "file is not a
          // database". This is the upgrade path for any device that installed
          // an earlier build.
          if (existing && existing.result === false) {
            mode = 'encryption';
          }
        } catch {
          // No database yet — "secret" creates a fresh encrypted one.
        }
      }

      // createConnection throws if a connection of this name already exists
      // (e.g. after a WebView reload). That is recoverable, not fatal.
      try {
        await plugin.createConnection({
          database: DB_NAME,
          encrypted: USE_ENCRYPTION,
          mode,
          version: DB_VERSION,
          readonly: false
        });
      } catch (error) {
        const message = String((error && error.message) || error);
        if (!message.toLowerCase().includes('already exists')) {
          throw error;
        }
      }

      const open = await plugin.isDBOpen({ database: DB_NAME, readonly: false });
      if (!open || !open.result) {
        await plugin.open({ database: DB_NAME, readonly: false });
      }

      return makeHandle(plugin);
    })();

    // Never cache a failed connection, or every later attempt replays the error.
    connectionPromise.catch(() => {
      connectionPromise = null;
    });
  }

  return connectionPromise;
}

export async function ensureDatabase() {
  const db = await getConnection();
  await db.execute(schemaStatements.join(';\n') + ';');
  return db;
}

export async function insertSpaApplication(db, row) {
  const statement = `
    INSERT INTO spa_applications (
      client_uuid, server_id, file_number, tracking_id, file_indexing_id,
      is_indexed, land_title_type, owner_name, phone, location, district, lga,
      land_use_type, existing_use, proposed_use, scenario, status, created_by,
      photos, sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  return db.run(statement, [
    row.client_uuid,
    row.server_id ?? null,
    row.file_number ?? null,
    row.tracking_id ?? null,
    row.file_indexing_id ?? null,
    row.is_indexed ?? null,
    row.land_title_type ?? null,
    row.owner_name ?? null,
    row.phone ?? null,
    row.location ?? null,
    row.district ?? null,
    row.lga ?? null,
    row.land_use_type ?? null,
    row.existing_use ?? null,
    row.proposed_use ?? null,
    row.scenario ?? null,
    row.status ?? null,
    row.created_by ?? null,
    JSON.stringify(row.photos ?? []),
    row.sync_status ?? 'pending',
    row.created_at ?? isoNow(),
    row.updated_at ?? isoNow()
  ]);
}

export async function insertSyncOutbox(db, row) {
  const statement = `
    INSERT INTO sync_outbox (
      entity_type, entity_client_uuid, operation, payload_json,
      photo_paths_json, attempts, last_error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  return db.run(statement, [
    row.entity_type,
    row.entity_client_uuid,
    row.operation,
    JSON.stringify(row.payload_json),
    row.photo_paths_json ? JSON.stringify(row.photo_paths_json) : null,
    row.attempts ?? 0,
    row.last_error ?? null,
    row.created_at ?? isoNow()
  ]);
}

export async function fetchRowByClientUuid(db, table, clientUuid) {
  const result = await db.query(`SELECT * FROM ${table} WHERE client_uuid = ?`, [clientUuid]);
  return rowsFrom(result)[0] || null;
}

export async function fetchOutboxByClientUuid(db, clientUuid) {
  const result = await db.query(
    'SELECT * FROM sync_outbox WHERE entity_client_uuid = ? ORDER BY id DESC',
    [clientUuid]
  );
  return rowsFrom(result);
}

export async function listTables(db) {
  const result = await db.query(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  );

  return rowsFrom(result).map((row) => row.name);
}

export async function runSmokeTest() {
  const db = await ensureDatabase();
  const clientUuid = generateUuid();
  const createdAt = isoNow();
  const fileNumber = `SPAS-SMOKE-${createdAt.replace(/[-:TZ.]/g, '').slice(0, 14)}`;

  await insertSpaApplication(db, {
    client_uuid: clientUuid,
    file_number: fileNumber,
    tracking_id: `TRK-${fileNumber.slice(-6)}`,
    file_indexing_id: 1001,
    is_indexed: 1,
    land_title_type: 'customary',
    owner_name: 'Smoke Test Parcel',
    phone: '08000000000',
    location: 'Smoke Test Ward, Kano',
    district: 'Smoke Test District',
    lga: 'Smoke Test LGA',
    land_use_type: 'Residential',
    existing_use: 'Residential',
    proposed_use: 'Residential',
    scenario: null,
    status: 'open',
    created_by: 'smoke-test',
    photos: ['local://smoke/photo-1.jpg'],
    sync_status: 'pending',
    created_at: createdAt,
    updated_at: createdAt
  });

  await insertSyncOutbox(db, {
    entity_type: 'spa_applications',
    entity_client_uuid: clientUuid,
    operation: 'create',
    payload_json: {
      client_uuid: clientUuid,
      file_number: fileNumber,
      owner_name: 'Smoke Test Parcel',
      sync_status: 'pending'
    },
    photo_paths_json: ['local://smoke/photo-1.jpg'],
    attempts: 0,
    last_error: null,
    created_at: createdAt
  });

  const application = await fetchRowByClientUuid(db, 'spa_applications', clientUuid);
  const outboxRows = await fetchOutboxByClientUuid(db, clientUuid);
  const tables = await listTables(db);

  return {
    database: DB_NAME,
    platform: getPlatform(),
    tables,
    client_uuid: clientUuid,
    file_number: fileNumber,
    application,
    outbox: outboxRows
  };
}

export async function closeDatabase() {
  if (!connectionPromise) {
    return;
  }

  const db = await connectionPromise;
  await db.close();
  // Release the connection too, otherwise the next createConnection reports
  // "already exists" against a database that is no longer open.
  await db.closeConnection();
  connectionPromise = null;
}
