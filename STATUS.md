# SPAS Mobile — Status Tracker

**Updated:** 2026-08-16
**Design doc:** [SPAS_MOBILE_OFFLINE_CAPACITOR_SYNC_PLAN.md](SPAS_MOBILE_OFFLINE_CAPACITOR_SYNC_PLAN.md)
**Client contract:** `C:\wamp64\spas_apk\API_CONTRACT.md`

Two workstreams, two machines:

- **Backend** — this repo (`c:\wamp64\www\klaes`, WAMP).
- **App** — `C:\wamp64\spas_apk`, built on `DC-02` (Android Studio + Codex).

---

## 1. At a glance

| Phase | Scope | State | Owner |
|---|---|---|---|
| 0 | API foundation | ✅ **Done** | backend |
| 1 | Capacitor shell | ✅ **Done** — APK installed and ran on a device | app |
| 2 | Local SQLite layer | ✅ **Written**, awaiting device run | app |
| 3 | Offline-first CRUD | ✅ **Written**, awaiting device run | app |
| 4 | Sync engine | ✅ **Written**, awaiting device run | app |
| 5 | Auth & security | ✅ **Done** — one decision open (§7.2) | both |
| 6 | QA & rollout | ⬜ Not started | both |

**Test suite: 120 passing.**

**Roughly:** backend finished, app written end-to-end. Everything now hinges on
one thing — **none of Phases 2–4 has run on a handset yet.** Until the
aeroplane-mode round trip in `FIX_BRIEF_03.md` §4 passes, treat them as unproven.

> **The WebView-vs-local-build question is settled.** The `server.url` shell
> installed and worked online, then showed `ERR_INTERNET_DISCONNECTED` with no
> signal — which is the problem this project exists to solve. The app is now a
> real local build; `server.url` has been removed.

---

## 2. Phase 0 — API foundation ✅ DONE

| Item | State |
|---|---|
| `SpaMobileService` — one validation/write path for desktop form, mobile form, API | ✅ |
| 15 `/api/spas/*` routes | ✅ |
| Schema DDL (`client_uuid`, nullable parent FK, 4 unique indexes) | ✅ dev **and production**, verified 11/11 |
| Delta pull with inclusive `>=` cursor | ✅ |
| Idempotent create on `client_uuid` | ✅ |
| Edit endpoints with `base_updated_at` optimistic concurrency | ✅ |
| Photo upload keyed by `client_uuid` | ✅ |
| Orphan linking (`/link-orphans`) | ✅ |
| LGA alias resolution at query time (+4,458 files recovered) | ✅ |
| "Awaiting location" panel on the desktop Field Map | ✅ |
| Test suite | ✅ **110 passing** |

Nothing here blocks the app.

---

## 3. Phase 1 — Capacitor shell 🟡

| Item | State | Note |
|---|---|---|
| Capacitor 7 + 8 plugins installed | ✅ | |
| Android platform added, debug APK builds | ✅ | |
| APK installs and renders | ✅ | confirmed by screenshot |
| **Buttons work** | ❌ → 🟡 | were dead (bare ES imports, no bundler); **fixed, not re-verified** |
| Verified on a physical device | ❌ | build agent logged "no device connected" |
| `server.url` production shell pointing at the live SPAS page | ⬜ | host never determined |

**Next action:** rebuild per `FIX_BRIEF_02.md` and confirm on hardware —
`Platform:` must read `android`, and Initialize DB / Run smoke test / Close DB
must all respond.

---

## 4. Phase 2 — Local SQLite layer 🟡

| Item | State |
|---|---|
| 8-table schema per plan §4.2 | ✅ written |
| Rewritten to the `window.Capacitor` global (no bundler) | ✅ |
| Passes `node --check` as ES modules | ✅ |
| **Smoke test executed on a device** | ❌ **never run** |
| Cache seeding from `/lookup/*` on login | ⬜ not started |
| Organic cache growth on every file lookup | ⬜ not started |

> A schema that has never been executed is not a deliverable. Everything in
> Phase 2 is unproven until the smoke test runs on hardware.

---

## 5. Phase 3 — Offline-first CRUD ⬜ NOT STARTED

The biggest remaining chunk, and the one with a real unknown in it.

| Item | Note |
|---|---|
| Port the SPAS Mobile UI into the app's `www/` | `mobile.blade.php` is a Blade template — Records tab, Field Records tab, Field Map tab, two bottom sheets. Converting it to static assets is unscoped work. |
| Read/write local SQLite first | every `fetch()` becomes a local read/write |
| Enqueue `sync_outbox` on every create/edit | |
| Mirror server validation client-side | table in `API_CONTRACT.md` §4 |
| Pending / synced badges on cards | |
| Preserve the enable/disable discipline on `land_use_type` / `lga` / `district` | only the active control carries each `name`, or the outbox payload posts two values for one field |
| Warn (do not block) on a missing GPS pin | product decision Q5 |
| Photo capture via `@capacitor/camera` + `@capacitor/filesystem` | write to app-private storage, keep local URIs |
| Client-side image compression | field connectivity is often 2G |

**Decide before starting:** does the app keep the `server.url` WebView (online
only, no offline value) or become a real local build? Phase 3 only means
anything if it is the latter. This is the single biggest open question left.

---

## 6. Phase 4 — Sync engine ⬜ NOT STARTED

| Item | Note |
|---|---|
| Outbox drain, FIFO oldest first | pseudocode in `API_CONTRACT.md` §6 |
| Response handling: 200 / 201 / duplicate / 409 / 422 / 404-photos / 5xx | each behaves differently — see contract §3 |
| Delta pull + local upsert, skipping locally-pending rows | |
| `Network` plugin `networkStatusChange` trigger | |
| App-resume trigger + manual "Sync Now" | |
| Retry with backoff, `attempts` / `last_error` | |
| "N records pending sync" indicator | reuse the existing `toast()` helper |
| Conflicts list for 409s | |
| Adopt the server's customary `file_number` from the push response | |
| Honour `429` + `Retry-After` | throttle is 60/min; a big drain will hit it |

---

## 7. Phase 5 — Auth & security ✅ (one decision outstanding)

| Item | State |
|---|---|
| Sanctum token login/logout, `spas-mobile` ability | ✅ |
| **Ability actually enforced** (`ability:spas-mobile` on the route group) | ✅ **was decorative — see below** |
| Login rate limited to 5/min | ✅ |
| Token storage on device (`@capacitor/preferences`) | ✅ |
| Usable offline; no forced re-auth without network | ✅ |
| 401 → re-login **without discarding unsynced local data** | ✅ |
| Revocation tooling (`php artisan spas:devices`) | ✅ |
| Real login round-trip tested (not just `actingAs`) | ✅ 7 tests |
| **Encrypted at-rest storage** (SQLCipher, Keystore-backed) | ✅ **decided and implemented — §7.2** |
| App lock (gate on launch/resume) | ⬜ before wider rollout |

### 7.1 The ability was doing nothing

`createToken($name, ['spas-mobile'])` records an ability, but **Sanctum never
checks it unless the `ability` middleware is applied — and Sanctum does not
register the alias.** It was absent from `app/Http/Kernel.php`, so the group was
guarded by `auth:sanctum` alone.

Effect: any valid token in the system opened every endpoint. A React Native app
token (`mobile-api`) would have worked against `/api/spas/*`, and a surveyor's
device token against the React Native API. Now aliased and applied, with a test
asserting a `mobile-api` token gets a 403.

**Tokens do not expire** (`config/sanctum.php` `expiration => null`) and that is
deliberate: a surveyor may be offline for days, and a token expiring mid-survey
would lock them out of an app holding unsynced work. The trade is that
**revocation is the only control**, hence `spas:devices`.

```
php artisan spas:devices                      # list SPAS device tokens
php artisan spas:devices --ability=any        # every token in the system
php artisan spas:devices --stale=90           # unused for 90 days
php artisan spas:devices --revoke=<id>        # cut off a lost handset
php artisan spas:devices --revoke-user=<who>  # all of one user's devices
```

Revoking is safe: the surveyor signs in again and **unsynced local work is not
discarded**, by either logout or a 401.

> **7 stale tokens exist** — `postman`, `api-test`, `postman-test-device` and
> similar, all `mobile-api`, all from Nov 2025, **all `last_used = never`**.
> They are dev artifacts. Nothing depends on them and I have **not** revoked
> them; `php artisan spas:devices --ability=any --revoke-stale=90` clears them
> when you want.

### 7.2 Encryption at rest — decided 2026-08-16

Every handset holds **every** land record, including owner names and phone
numbers (Q2: no per-surveyor filtering), so a lost phone would otherwise be the
whole dataset.

**Decision: encrypt the database with SQLCipher, key held in the Android
Keystore. No user PIN in the key path.**

`@capacitor-community/sqlite` already bundles **SQLCipher 4.10.0** and stores its
passphrase in `EncryptedSharedPreferences` behind a `MasterKey` (AES256_GCM) —
hardware-backed and non-extractable. So there is no new dependency and, more
importantly, **no human keyholder**. `db.js` generates a 256-bit passphrase once
per install, hands it to the plugin, and keeps no copy.

Deriving the key from a user PIN was rejected: a forgotten PIN would destroy
unsynced field work — a day of survey with no other copy. The Keystore holds a
key better than a person can.

**Encryption does not cover the most likely threat.** A phone found unlocked
with the app installed decrypts automatically. That case needs the OS lock
screen plus an app lock — a **gate**, kept strictly decoupled from the
encryption key, so forgetting it costs a re-login and never data. That lock is
the remaining item before wider rollout.

Also set: `android:allowBackup="false"`. A Keystore key does not survive
backup/restore, so a restored app would meet a database it cannot open and look
corrupted. The server is the system of record; backup buys nothing.

> **Separately, a real bug this uncovered.** The merged manifest of the previous
> build had **no location permissions at all** — `@capacitor/geolocation` ships
> an empty manifest and declares none itself. The GPS button would have failed
> on every device. `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` are now
> declared, and `captureGps()` requests them at runtime. Offline, GPS is the
> only way to place a plot, so this would have broken the core capture path.

---

## 8. Phase 6 — QA & rollout ⬜ NOT STARTED

- Airplane-mode round trip: create offline → reconnect → row + photos land in SQL Server.
- Two devices pushing the same file number → one wins, other gets a 409.
- Kill the app mid-drain → outbox resumes, nothing duplicated.
- Pilot on a handful of surveyor devices.
- Monitor `sync_outbox` failure rate before wider rollout.

---

## 9. Open decisions

**Settled 2026-08-16**

| Question | Answer |
|---|---|
| Server host | `http://app.klaes.ng` — confirmed working from a handset |
| WebView shell or local build? | **Local build.** The shell died offline, which is the whole problem |
| Field Map when offline | Cached points listed with coordinates; no tiles, no tap-to-pin. GPS is the capture method (plan §9) |

**Still open**

| # | Question | Blocks |
|---|---|---|
| 1 | **Is `/api/spas/*` deployed to `app.klaes.ng`?** Committed ≠ deployed | **everything** — the app cannot log in without it |
| 2 | **iOS as well as Android?** | signing setup, plugin choices |
| 3 | **`Kunchi`** — 16 files reference it but it is not in the `lgas` table. Missing reference row, or mis-filed files? | `lga:normalize` |
| 4 | **Run `lga:normalize --apply`?** Would change 4,682 rows, 943 unresolved | optional clean-up only |
| 5 | **Deletions don't sync.** A record deleted in the office never disappears from a device | accept, or build it |
| 6 | **API throttle 60/min** — raise it for `/api/spas/*`, or have the client back off? | first big outbox drain |

---

## 10. Backend backlog — optional, nothing depends on it

| Item | Why it is not urgent |
|---|---|
| `users.assigned_lga` / `assigned_district` | app passes LGA explicitly for now |
| Run `lga:normalize --apply` | aliases already resolve at query time |
| Delete/tombstone sync | deletion is rare in this workflow |
| Raise throttle for `/api/spas/*` | only matters once a real drain is tested |

---

## 11. Uncommitted right now

```
M app/Http/Controllers/Api/Spas/SpasSyncController.php
M app/Http/Controllers/SpecialAssignmentController.php
M app/Services/SpaMobileService.php
M docs/plans/SPAS_MOBILE_OFFLINE_CAPACITOR_SYNC_PLAN.md
M resources/views/special_assignment/field_data/index.blade.php
M routes/api.php
M tests/Feature/Spas/SpasSyncApiTest.php
M tests/Feature/Spas/SpasWebFormTest.php
?? app/Console/Commands/NormalizeFileIndexingLga.php
?? docs/plans/SPAS_MOBILE_STATUS.md
```

Housekeeping: `C:\wamp64\spas_apk` now holds `app-debug.apk` (28 MB) and
`spas_apk.zip` (92 MB). Both are gitignored, but delete the zip once it has been
moved between machines.

---

## 12. Critical path

```
1. Confirm /api/spas/* is deployed to app.klaes.ng   (you)  <- gates everything
2. Build the APK from the new www/                   (app, DC-02)
3. Aeroplane-mode round trip per FIX_BRIEF_03 §4     (app)  <- proves Phases 2-4
4. Photo capture + edit UI                           (app)  <- remaining features
5. Secure token storage                              (app)  <- Phase 5
6. Pilot on surveyor devices                         (both) <- Phase 6
```

Step 1 is the immediate blocker: the app talks only to `/api/spas/*`, and if
that is not live on `app.klaes.ng` nothing past the login screen works. Check it
by opening `http://app.klaes.ng/api/spas/lookup/lgas` in any browser — a
`401 Unauthenticated` means the route exists and is guarded, which is what you
want. A `404` or an HTML error page means it has not been deployed.

## 13. What was written for the app (2026-08-16)

All in `C:\wamp64\spas_apk\www\`, verified to parse as ES modules, with a
consistent import graph and every DOM selector resolving against `index.html`.
**None of it has run on a device.**

| File | Role |
|---|---|
| `index.html` | Login, 3 tabs, 2 bottom sheets |
| `styles.css` | Dark field UI |
| `db.js` | SQLite schema, 8 tables |
| `store.js` | Every local read/write; the UI never touches the network |
| `api.js` | The only network module |
| `validate.js` | Client mirror of the server rules — refuses bad rows at capture time rather than queuing them to fail forever |
| `sync.js` | Outbox drain, delta pull, reconnect/resume triggers |
| `app.js` | UI wiring, bootstrap, on-screen error reporting |
