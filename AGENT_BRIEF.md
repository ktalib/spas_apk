# SPAS Mobile APK — Build Agent Brief

**You are the build agent.** You are running in VS Code on the Android build
machine (`DC-02`). Another agent is working the Laravel/API side on a different
machine at the same time. This file is your complete task. When you finish,
write `BUILD_LOG.md` (template at the end) — that file is carried back to the
other agent and is the only thing it will see, so it must stand alone.

---

## 0. Rules of engagement

1. **Do not touch the Laravel repo.** The Laravel project on this machine
   (`C:\xampp\htdocs\klas`) is read-only to you. You may *read* files there to
   understand the UI. You may not edit, create, delete, or commit anything in
   it. All of your work happens in the SPAS APK folder.
2. **Do not write any backend code** — no controllers, no routes, no
   migrations, no API endpoints. Those are the other agent's deliverable and
   are already in progress. If you find yourself wanting an endpoint that does
   not exist, write it down in the log under "Requests for the backend agent"
   and move on.
3. **Do not run any database migration or SQL script.**
4. If a step fails, do not silently work around it. Record the exact error in
   the log and either stop or take a documented alternative — say which.
5. Windows PowerShell 5.1: no `&&` chaining, no ternary, no `??`. Use `;` and
   `if ($?) { ... }`.

---

## 1. Context — what this app is

SPAS (Special Assignment) is a field-survey module of a Kano State land
administration system (KLAES). Surveyors visit land parcels, record the
parcel's details, log a field inspection with GPS coordinates and photos, and
compare the **approved** land use against the **prevailing** land use on the
ground — a mismatch is a "contravention".

Today it is a **web page only**: `resources/views/special_assignment/mobile.blade.php`,
a self-contained app-like page (fixed topbar, bottom sheets, Leaflet map) that
does every read and write over `fetch()` against a live SQL Server database. No
network means the page is unusable — which is the problem, because field
connectivity in Kano is often 2G or absent entirely.

The end state is a **Capacitor Android app with an on-device SQLite database**,
where the UI reads and writes local SQLite first and a sync engine drains an
outbox to the server when signal returns. The full design lives in
`docs/plans/SPAS_MOBILE_OFFLINE_CAPACITOR_SYNC_PLAN.md` in the Laravel repo —
**read it before starting**, at minimum sections 2, 4.2, and 10.

That plan has 7 phases. **You are doing Phase 1 and Phase 2 only.** Phases 3–6
need the `/api/spas/*` endpoints that the other agent is building right now, so
they are deliberately out of your scope.

---

## 2. This machine's known traps — verified, do not rediscover the hard way

These were confirmed on `DC-02` on 2026-08-15. Each one produces a confusing,
misleading failure if you hit it blind.

| Trap | Symptom if hit | Fix |
|---|---|---|
| `ANDROID_HOME` points at `C:\Android\sdk`, which is **empty** — no adb, no platforms, no build-tools, no licences | "SDK not installed", "adb not found", licence errors | The real SDK is `C:\Users\Administrator.klaes\AppData\Local\Android\Sdk` (this is also what Android Studio shows). Repoint `ANDROID_HOME`. |
| **JDK 26 is on `PATH`**; `JAVA_HOME` was unset, so Gradle picks 26 | AGP rejects the JDK, cryptic Gradle/Kotlin failure | Use Android Studio's bundled JBR (openjdk 21) at `C:\Program Files\Android\Android Studio\jbr`. Set `JAVA_HOME` **and** pin `org.gradle.java.home` in the project. |
| Node v24 / npm v11 — newer than the LTS Capacitor targets | Odd `npm install` behaviour | Fine so far. But it is the **first suspect** if npm misbehaves; note the versions in your log. |
| **A Capacitor project may already exist on this machine** — a screenshot showed `capacitor.build.gradle` open in Android Studio with camera, community-sqlite, filesystem, geolocation, network, splash-screen and `cordova-android-plugins` already wired | You scaffold a second app, and the two drift to different plugin versions | **Task A below resolves this before anything else.** |

---

## 3. Your tasks

### TASK A — Resolve the existing Capacitor project (do this first)

Someone previously set up a Capacitor project on this machine. Its location,
provenance, `webDir` contents, and whether it has ever built are all unknown.
Find out before you create anything.

```powershell
Get-ChildItem C:\ -Recurse -Filter capacitor.config.* -ErrorAction SilentlyContinue |
    Select-Object FullName, LastWriteTime
```

Then decide, and **state the decision and its reason in the log**:

- **If a usable project is found** — record its path, its `package.json`
  dependencies with versions, its `capacitor.config.*` contents (appId, appName,
  webDir), what is actually in its `webDir`, whether an `android/` folder
  exists, and whether any APK was ever produced
  (`Get-ChildItem <proj> -Recurse -Filter *.apk`). **Adopt it** — continue the
  remaining tasks in that folder rather than scaffolding a new one. Say so
  clearly in the log, including the path, because the other agent's notes
  currently assume `C:\wamp64\spas_apk`.
- **If nothing is found, or what is found is an unrelated/broken stub** — say
  which, and proceed with the fresh scaffold in Task C.

Do not delete the existing project either way. If you adopt it, leave it where
it is. If you abandon it, leave it alone and say why it was unusable.

### TASK B — Environment check and fix

The SPAS APK folder (copied from the other machine) contains
`check-build-env.ps1`. Run it and paste the **full** output block into your log.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\check-build-env.ps1
```

Then fix whatever it flags, using section 2 above. Typically:

```powershell
setx JAVA_HOME "C:\Program Files\Android\Android Studio\jbr"
setx ANDROID_HOME "C:\Users\Administrator.klaes\AppData\Local\Android\Sdk"
```

`setx` does not affect the current session — **open a new PowerShell** and
re-run `check-build-env.ps1` to confirm it now passes. Log both the before and
after output.

### TASK C — Install Capacitor and build a debug APK

If you scaffolded fresh, `install-capacitor.ps1` in the SPAS APK folder does the
npm side. Read it first — do not run a script you have not read.

```powershell
.\install-capacitor.ps1
```

It installs Capacitor 7 core/cli/android plus these plugins, all of which the
plan requires:

| Plugin | Plan section | Why |
|---|---|---|
| `@capacitor-community/sqlite` | §4.2 | on-device DB — the whole point |
| `@capacitor/preferences` | §7 | Sanctum token storage |
| `@capacitor/network` | §6.1 | `networkStatusChange` triggers sync |
| `@capacitor/geolocation` | §9 | native GPS, works fully offline |
| `@capacitor/camera` + `@capacitor/filesystem` | §8 | photo capture to app-private storage |
| `@capacitor/app` | §6.1 | resume event, another sync trigger |
| `@capacitor/splash-screen` | — | launch screen |

Then add the Android platform and build:

```powershell
npx cap add android
npx cap sync
Add-Content android\gradle.properties "org.gradle.java.home=C:\\Program Files\\Android\\Android Studio\\jbr"
cd android
.\gradlew assembleDebug
```

The APK lands at `android\app\build\outputs\apk\debug\app-debug.apk`.

**Deliverable: an APK that installs on a real Android device and opens.** Not a
green Gradle log — an actual install. Use `adb install -r <apk>` or copy the
file to the phone. If you have no device available, say so explicitly in the
log; do not imply it was tested when it was not.

#### What the app should show in this phase

Phase 1 in the plan is "installable debug build running against the existing
live-DB endpoints — **no offline yet**". The simplest honest way to get there is
a WebView pointing at the already-working server page, rather than trying to
convert the Blade template to static HTML (that conversion is Phase 3 work and
depends on the API the other agent is building).

So set, in `capacitor.config.json`:

```json
{
  "server": {
    "url": "http://<SERVER_HOST>:<PORT>/special-assignment/mobile",
    "cleartext": true
  }
}
```

**`<SERVER_HOST>` is not known to the other agent** — its `.env` only has
`http://127.0.0.1:8000`, which is that machine's own loopback and useless from a
phone. You must determine the right value on this machine and **record it in the
log**. It is whichever of these actually serves the SPAS page to a device on the
same network: this machine's LAN IP with the XAMPP port (find it with
`ipconfig`), or a real deployed hostname if one exists. `127.0.0.1` and
`localhost` will **not** work from a phone — inside the app's WebView they mean
the phone itself.

Two things to be explicit about in the log, because they are temporary
compromises and the next phase removes them:

- `cleartext: true` permits plain HTTP. Acceptable for a debug build on a LAN.
  It must not survive into anything distributed — flag it.
- A `server.url` shell is **online-only**. It is a scaffolding step that proves
  the toolchain, signing, and plugins work. It is not the offline app.

### TASK D — Local SQLite schema (Phase 2)

This is independent of the backend work, which is why it is in your scope.
Create a `src/db.js` (plain ES module, no framework — the existing UI is vanilla
JS with no bundler) exposing a small data-access layer over
`@capacitor-community/sqlite`, and create the schema below on first run.

From plan §4.2, the tables are:

```
spa_applications    -- mirrors server columns + client_uuid (local PK),
                       sync_status, server_id (nullable until synced)
spa_field_data      -- same pattern; links to spa_applications by
                       client_uuid or server_id
file_index_cache    -- read-only: file_number, file_title, land_use_type,
                       location, district, lga, tracking_id, file_indexing_id
land_use_cache      -- read-only: landuse
lga_cache           -- read-only: name (45 rows, full pull)
district_cache      -- read-only: name (1,818 rows, ~40KB, full pull)
sync_outbox         -- id, entity_type, entity_client_uuid,
                       operation(create/update), payload_json,
                       photo_paths_json, attempts, last_error, created_at
sync_meta           -- key/value: last_pull_at per entity
```

Requirements and the reasoning behind each — these are not arbitrary:

- `sync_status` is one of `pending` | `synced` | `error`.
- **`client_uuid` is the local primary key**, generated on device. The server
  now has a matching `client_uuid` column with a unique index on both tables, so
  a create can be retried after a dropped connection without duplicating the
  row.
- **The outbox drains as a flat FIFO.** The server's
  `spa_field_data.spa_application_id` has been relaxed to nullable and a
  `spa_application_client_uuid` column added, so a field-data row no longer has
  to wait for its parent to get a server id. Do not build dependency ordering —
  it was designed away.
- Server column types `photos`, `coordinates`, `parcel_geometry` are JSON in
  `NVARCHAR(MAX)`; they map to SQLite `TEXT` with no conversion.
- Mirror `spa_applications.scenario` (`NVARCHAR(1)`) as a column for
  completeness, but **build no UI for it** — no form captures it today and its
  purpose is unconfirmed.
- Store `last_pull_at` cursors as ISO timestamp strings.

Write a smoke test you can actually run (a debug button in the placeholder page
is fine) that opens the DB, creates the schema, inserts one `spa_applications`
row plus its `sync_outbox` entry, reads them back, and prints the result.
**Run it on the device and put the output in the log.** A schema that has never
been executed is not a deliverable.

Do **not** implement the sync engine, the API client, or offline CRUD rewiring.
Those are Phases 3–4 and they need endpoints that do not exist yet.

---

## 4. What to hand back — `BUILD_LOG.md`

Write this file in the SPAS APK folder root. It is the entire handoff: the other
agent sees this file and nothing else — not your terminal, not your reasoning,
not the repo state. Anything you leave out is lost.

Be accurate over positive. A blocker reported plainly is far more useful than a
success that has to be walked back later. If you did not verify something, say
"not verified" rather than describing the expected outcome.

````markdown
# SPAS APK — Build Log

**Date:**
**Machine:** (hostname, Windows version)
**Agent:** (which model/tool wrote this)
**Outcome:** COMPLETE / PARTIAL / BLOCKED

## 1. Summary
Three or four sentences: what now exists, what works, what does not.

## 2. Existing Capacitor project (Task A)
- Search result: found at <path> / none found
- If found: appId, appName, webDir, plugin list with versions, android/ present?, APK ever built?
- Decision: adopted / abandoned — and why
- **Final project path used for all work below:**

## 3. Environment (Task B)
- Node / npm versions:
- JAVA_HOME before / after:
- ANDROID_HOME before / after:
- check-build-env.ps1 output BEFORE fixes:
```
(paste the full block)
```
- check-build-env.ps1 output AFTER fixes:
```
(paste the full block)
```

## 4. Capacitor install (Task C)
- Capacitor version:
- appId / appName / webDir actually used:
- Installed plugins with exact versions (`npm ls --depth=0` output):
```
(paste)
```
- server.url value used, and how the host was determined:
- Any dependency that would not install, or that resolved to an unexpected version:

## 5. Build result (Task C)
- `gradlew assembleDebug` result: SUCCESS / FAILURE
- Build time, APK path, APK size:
- Installed on a physical device? YES (device model, Android version) / NO (why not)
- App opens and shows: (what you actually saw — describe the screen)
- Does the SPAS page load in the WebView? Could you log in?
- Full error output for any failure:
```
(paste)
```

## 6. Local SQLite layer (Task D)
- File(s) created, with paths:
- Tables created (list):
- Smoke test run on device? YES / NO
- Smoke test output:
```
(paste)
```
- Anything in plan §4.2 you could not implement, and why:

## 7. Deviations from this brief
Anything you did differently, and the reason. If none, say "none".

## 8. Blockers
Anything that stopped you. Exact error text, not a paraphrase.

## 9. Requests for the backend agent
Endpoints, fields, or behaviours you needed that do not exist yet. Be specific:
what you would call, what you would send, what you expect back. This directly
shapes the API being written right now, so an incomplete list here means
rework later.

## 10. Files changed
Every file you created or modified, with a one-line description each.
Confirm explicitly that nothing in the Laravel repo was touched.
````

---

## 5. Definition of done

- [ ] The existing-Capacitor-project question is resolved and documented
- [ ] `check-build-env.ps1` passes with no `[FAIL]` lines
- [ ] `gradlew assembleDebug` succeeds
- [ ] The APK is installed on a real device and opens
- [ ] The SQLite schema is created and the smoke test has actually run on device
- [ ] `BUILD_LOG.md` is written and is complete enough to stand alone
- [ ] Nothing in the Laravel repo was modified
