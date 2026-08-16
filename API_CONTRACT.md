# SPAS Mobile — Backend API Contract

Everything the offline app talks to. The backend for Phases 0–2 is **complete
and tested** (110 passing tests); this document is what you build the client
against.

Companion docs: `AGENT_BRIEF.md` (original scope), `FIX_BRIEF_02.md` (the
module-resolution fix and device verification).

---

## 1. Basics

**Base URL:** `<server>/api/spas`
**Auth:** Sanctum bearer token on every call except login.

```
Authorization: Bearer <token>
Accept: application/json
```

**Throttle:** the `api` middleware group applies — 60 requests/minute. A device
draining a large outbox after a day offline *will* hit this. Honour `429` +
`Retry-After` rather than hammering; if that proves too tight in the field, say
so and the limit can be raised for this prefix.

---

## 2. Endpoints

### Auth

```
POST /auth/login      { identifier, password, device_name? }  -> { token, user, server_time }
POST /auth/logout     revokes the current token
```

`identifier` is username, email, or phone. One token per `device_name`, so
logging in again from the same handset replaces the old one. `401` bad
credentials, `423` account disabled.

### Pull (server -> device)

```
GET /records?since=<iso>
GET /field-data?since=<iso>
```

Both return:

```json
{
  "success": true,
  "count": 12,
  "server_time": "2026-08-16T09:14:03+00:00",
  "has_more": false,
  "data": [ ... ]
}
```

- 200 rows per page.
- `has_more: true` means **pull again immediately**, don't wait for the next tick.
- Store `server_time` as your next cursor — never the device clock.

### Push (device -> server)

```
POST /records                      create   (client_uuid required)
POST /field-data                   create   (client_uuid required)
PUT  /records/{client_uuid}        edit
PUT  /field-data/{client_uuid}     edit
POST /photos                       { entity_type, client_uuid, photos[] }
POST /link-orphans                 stitch inspections to late parents
```

### Lookups (reference data to cache)

```
GET /lookup/file-index?lga=&district=&file_numbers[]=&q=&limit=
GET /lookup/land-uses                 -> { data: [...], customary: [...] }
GET /lookup/lgas                      -> 45 rows
GET /lookup/districts                 -> 1,818 rows
GET /lookup/next-customary-fileno
```

---

## 3. The eleven rules that actually matter

1. **`client_uuid` is required on every create** and is what makes a retry safe.
   Generate it on the device before the row is written locally.

2. **A replayed create returns `200 {duplicate:true}`** with the existing row —
   not an error, not a second record. Treat it as success.

3. **`409` is not `422`.** `422` = validation, fix the payload. `409` with a
   `conflict` key = a real conflict that retrying will never resolve; route it
   to a Conflicts list for the surveyor.

4. **A customary `file_number` returned by the server replaces your local one.**
   The sequence is server-authoritative. Whatever placeholder the device
   invented offline must be overwritten from the push response.

5. **Push order does not matter.** `spa_field_data.spa_application_id` is
   nullable and an inspection may name its parent by
   `spa_application_client_uuid`. The outbox drains as a **flat FIFO** — do not
   build dependency ordering. Call `POST /link-orphans` after a drain to stitch
   any inspection whose parent arrived later.

6. **`POST /photos` returning `404` means the parent has not synced yet.** Keep
   the upload queued and retry — do not discard the photos. Text syncs first and
   photos follow, because a record that reaches the office without images beats
   one that never syncs because a 3 MB upload keeps timing out.

7. **The `since` cursor is inclusive (`>=`).** `updated_at` is `DATETIME2(0)` —
   whole seconds — so a strict `>` would permanently skip any row written in the
   same second as the last row of a page. Expect up to one second of overlap and
   dedupe locally by `id`/`client_uuid`.

8. **Send `base_updated_at` on edits** — the `updated_at` you last saw. If the
   office changed the row since, you get `409 {conflict:'stale_write'}` with
   `server_row` attached so you can show both versions. Omit it for
   last-write-wins.

9. **A replayed identical edit returns `200 {duplicate:true}`, not `409`.** The
   server compares the payload field-by-field first, so a lost response does not
   raise a phantom conflict about the surveyor's own edit.

10. **`file_number`, `land_title_type` and `status` cannot be changed by the
    app.** The first two are the record's identity; `status` is office workflow,
    so a handset cannot approve its own record. Sending them is ignored, not
    rejected.

11. **Coordinates are JSON numbers.** A whole degree (`12.0`) comes back as
    `12` — JSON has one number type. Parse as float.

---

## 4. Validation the client must mirror

Validate **before** the row enters the outbox. A record queued offline that
fails server validation sits there failing forever, long after the surveyor has
left the site and can no longer supply the answer.

**Land record**

| Field | Rule |
|---|---|
| `land_title_type` | required, `statutory` or `customary` |
| `file_number` | required **if statutory** |
| `owner_name` | required, max 255 |
| `proposed_use` | required (approved land use) |
| `existing_use` | required (prevailing on the ground) |
| `lga` | **required if customary** |
| `district` | optional |
| `phone` | optional, max 20 |

**Field inspection**

| Field | Rule |
|---|---|
| `inspection_date` | required, a date |
| `findings` | required |
| `coordinates` | **optional** — see §5 |
| `spa_application_id` / `spa_application_client_uuid` | either, or neither |

The server rules live in one place (`app/Services/SpaMobileService.php`) and are
shared by the desktop form, the mobile web form and this API. If they change,
this table changes — ask before assuming.

---

## 5. Product decisions baked into the contract

**Coordinates may be null.** The form must **warn** about a missing pin but
**must not block the save**. The surveyor is standing on the plot and GPS is one
tap, but a record with no pin beats a record never captured. Records arriving
unplaced now appear in an "awaiting location" panel on the desktop Field Map so
the office can place them.

**No per-surveyor ownership.** Everyone sees every record, exactly as the web
page does. No filtering by user.

**`file_index_cache` is hybrid**: pre-seed by LGA/district *and* grow
organically. Every file the surveyor looks up or opens must be written into the
cache permanently. `GET /lookup/file-index` returns the full cacheable row
(`?q=` to search, `?file_numbers[]=` to fetch specific ones).

Pre-seeding alone has a blind spot: `file_indexings.lga` is free text, 196
distinct values against 45 canonical LGAs. The **server resolves aliases for
you** — `?lga=Nasarawa` also returns the 3,388 rows stored as `NASSARAWA`
(+4,458 files recovered across 15 LGAs) — but ~940 rows still hold values no
alias can safely place (other states' LGAs, ward names, junk). Organic growth is
what makes that residue survivable: a file missed by the pre-seed works offline
on the second visit.

There is no assignment column on `users`, so the app passes LGA/district
explicitly — surveyor picks it once, store in `@capacitor/preferences`.

---

## 6. Suggested sync loop

```
onOnline() || onResume() || tap "Sync Now":
    drainOutbox()          # FIFO, oldest first
    POST /link-orphans
    pullDeltas()
    refreshLookups()       # land-uses, lgas, districts — cheap, full replace

drainOutbox():
    for entry in outbox order by created_at:
        response = push(entry)
        200/201        -> mark synced, store server_id, adopt returned file_number, delete entry
        200 duplicate  -> same as above (it already landed)
        409            -> mark conflict, surface to the surveyor, STOP retrying
        422            -> mark error with the message; this is a bug in local validation
        404 on /photos -> leave queued, retry after the next drain
        5xx / network  -> increment attempts, back off, keep it queued

pullDeltas():
    for entity in [records, field-data]:
        loop:
            r = GET /{entity}?since={sync_meta[entity]}
            upsert r.data          # skip rows still pending locally in the outbox
            sync_meta[entity] = r.server_time
            break unless r.has_more
```

Server is authoritative for anything **not** sitting unsynced in your outbox.
Reference data is always a straight overwrite.

---

## 7. Backend status

| Area | State |
|---|---|
| Schema (`client_uuid`, nullable FK, unique indexes) | Applied and verified 11/11 on **dev and production** |
| `/api/spas/*` — 15 routes | Built, tested |
| Shared validation service | Built, tested |
| Test suite | 110 passing |
| LGA alias resolution at query time | Live |
| LGA data backfill (`php artisan lga:normalize`) | Written, **dry-run only, not applied** — optional clean-up, not a dependency |

Nothing on the backend blocks the app work.
