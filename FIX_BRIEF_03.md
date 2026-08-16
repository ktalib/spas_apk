# SPAS APK — Brief 03: build the offline app

Supersedes `FIX_BRIEF_02.md`. The app is now a **real local build**, not a
WebView pointing at the live site. Your job is to build it and verify it on a
device.

---

## 1. What changed and why

Your last APK worked, and that is what settled the design question. It loaded
`http://app.klaes.ng/special-assignment/mobile` through `server.url` — fine
online, but with no signal it showed `ERR_INTERNET_DISCONNECTED` and the app was
useless. That is precisely the problem this project exists to solve, so the
shell has been replaced with a local offline-first build.

**`server.url` is gone from `capacitor.config.json`.** The app now loads
`www/index.html` from the device. It reaches the network only through
`/api/spas/*`, and only when there is a connection.

### New files in `www/`

| File | Role |
|---|---|
| `index.html` | Login screen, 3 tabs (Records / Field Records / Field Map), 2 bottom sheets |
| `styles.css` | Dark field UI, matching the existing SPAS mobile page |
| `db.js` | SQLite schema + connection (8 tables, plan §4.2) |
| `store.js` | All local reads/writes. Every screen goes through here, never the network |
| `api.js` | The only module that talks to the server |
| `validate.js` | Client mirror of the server's validation rules |
| `sync.js` | Outbox drain, delta pull, reconnect/resume triggers |
| `app.js` | UI wiring and bootstrap |

`src/` was deleted — it was an unreferenced stale copy.

---

## 2. Before you build — one hard dependency

**The `/api/spas/*` endpoints must be live on `app.klaes.ng`.** They were
written and committed, but committing is not deploying. If they are not there,
login fails with a message naming the problem — that is deliberate, so you get a
diagnosis instead of a mystery.

Check from any browser:

```
http://app.klaes.ng/api/spas/lookup/lgas
```

- `401 Unauthenticated` — **correct.** The route exists and is guarded.
- `404` or an HTML error page — the backend is not deployed. Stop and report it;
  nothing past login will work.

---

## 3. Build

```powershell
npx cap sync
cd android
.\gradlew assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

If `JAVA_HOME` / `ANDROID_HOME` still bite, see `FIX_BRIEF_02.md` §2 — the empty
`C:\Android\sdk` decoy and JDK 26 on `PATH` are the two traps on this machine.

### Two manifest changes you must not revert

`android/app/src/main/AndroidManifest.xml` was edited by hand. `npx cap sync`
does **not** overwrite it, but if you ever regenerate the Android project these
must go back:

1. **`android:allowBackup="false"`** — the database is encrypted and its key
   lives in the Android Keystore, which does not survive backup/restore. A
   restored app would meet a database it cannot open and look corrupted.
2. **`ACCESS_COARSE_LOCATION` + `ACCESS_FINE_LOCATION`** — `@capacitor/geolocation`
   ships an **empty** manifest and declares nothing itself. These were absent
   from the previous build's merged manifest, so the GPS button would simply
   have failed. Offline, GPS is the only way to place a plot.

### Encryption at rest

The SQLite database is now encrypted with **SQLCipher**, which is already inside
`@capacitor-community/sqlite` — no new dependency. A 256-bit passphrase is
generated once per install and handed to the plugin, which stores it in
`EncryptedSharedPreferences` behind an Android Keystore `MasterKey` (AES256_GCM).
The app never keeps a copy.

This matters because every handset holds the **full** record list including
owner names and phone numbers — there is no per-surveyor filtering — so a lost
phone would otherwise be the whole dataset.

The key is **not** derived from any user PIN, deliberately: a forgotten PIN
would destroy unsynced field work. An app lock, when it is added, is a gate and
never a key.

If a device already holds data from the earlier unencrypted build, `db.js`
detects it and converts in place (`mode: 'encryption'`). A fresh install just
starts encrypted.

### Cleartext HTTP

`capacitor.config.json` sets `"cleartext": true` because the API is served over
**http**, and Android 9+ blocks cleartext by default — without it every API call
fails with a confusing network error. If `app.klaes.ng` ever gets HTTPS, remove
that flag.

---

## 4. Verify on a device — in this order

**A. Login (needs a connection)**
1. Open the app. The login screen appears.
2. The Server section under "Server" should read `http://app.klaes.ng`. Change it
   only if the API lives elsewhere.
3. Sign in with a real SPAS user.
4. It downloads land uses, 45 LGAs, 1,818 districts, then syncs. Expect a toast.

**B. Records tab**
5. The stat row and any existing records appear.

**C. Create offline — the whole point**
6. **Turn on aeroplane mode.**
7. Tap "+ Add Land Record" → choose **Customary** → fill owner, LGA, approved
   and prevailing land use → Save.
8. It must save and show "Saved on device". The card shows a **Pending** chip and
   "Pending sync" increments. **No network error.**
9. Try saving a customary record with **no LGA** → it must be refused with
   "Select the LGA for this customary title." That refusal offline is the point:
   a bad row queued now fails forever after you have left the site.

**D. Inspection offline**
10. Field Records tab → "+ Log Inspection" → pick the record you just made.
11. Tap **GPS** (works offline). If there is no fix, leave coordinates empty:
    saving must **warn once**, then save on a second tap.
12. Findings are required.

**E. Sync**
13. **Turn aeroplane mode off.**
14. It should sync automatically on reconnect; otherwise tap "Sync now".
15. Chips flip Pending → **Synced**. "Pending sync" returns to 0.
16. Confirm in the office web UI that the record and inspection arrived.

**F. Restart**
17. Force-close and reopen. It goes straight to the app — no re-login — and all
    data is still there. (This also proves the encrypted database reopens with
    the stored key.)

**G. GPS permission**
18. On the very first tap of **GPS**, Android must show a location permission
    prompt. If no prompt appears and it fails instead, the manifest permissions
    did not merge — report it.

**H. Encryption actually on**
19. Confirm the database is really encrypted rather than silently falling back.
    With the app installed and USB debugging on:

    ```
    adb shell run-as ng.gov.kanostate.klaes.spas ls -l databases/
    ```

    Then check the file header — an unencrypted SQLite file begins with the
    ASCII text `SQLite format 3`, an SQLCipher one is random bytes:

    ```
    adb shell run-as ng.gov.kanostate.klaes.spas head -c 16 databases/spas_mobileSQLite.db
    ```

    Readable `SQLite format 3` means encryption is **not** in effect — report it.
    Unreadable bytes are what you want.

---

## 5. Known gaps — do not report these as bugs

| Gap | Why |
|---|---|
| **No map, no tap-to-pin** | Leaflet is not vendored, and tiles need a network anyway. Plan §9 makes GPS-on-site the primary method offline — the surveyor is standing on the plot. The Field Map tab lists cached points with coordinates. To add a map later, drop `leaflet.js`/`leaflet.css` into `www/vendor/` and reference them locally — never from a CDN. |
| **No photo capture yet** | The schema, outbox column and `POST /photos` endpoint all exist; the camera UI does not. Text-first sync is the intended order anyway. |
| **No edit/delete in the app** | `PUT /api/spas/records/{client_uuid}` exists server-side and handles conflicts; no UI is wired to it. |
| **Field index needs a sync to be searchable** | Statutory file lookup reads the local cache. It is seeded on demand as you search online and grows permanently from there. |

---

## 6. Report back

Append to `BUILD_LOG.md` — do not start a new file:

```markdown
## 12. Brief 03 — offline build (<date>)

- API reachable at http://app.klaes.ng/api/spas/lookup/lgas? (401 = good):
- Build: SUCCESS / FAILURE + APK size
- Device: model, Android version
- A. Login:                          PASS / FAIL
- B. Records tab renders:            PASS / FAIL
- C. Create record in aeroplane mode:PASS / FAIL
- C. Customary with no LGA refused:  PASS / FAIL
- D. Inspection + GPS offline:       PASS / FAIL
- D. Save with no pin warns once:    PASS / FAIL
- E. Auto-sync on reconnect:         PASS / FAIL
- E. Record visible in the web UI:   PASS / FAIL
- F. Survives restart, no re-login:  PASS / FAIL
- G. Location prompt on first GPS:   PASS / FAIL
- H. DB header is NOT "SQLite format 3": PASS / FAIL
- Exact error text for anything that failed:
- Screenshots of each tab:
```

Errors are printed **into the page** as a toast, so a screenshot usually
carries the message. For a real console, connect USB and open
`chrome://inspect/#devices` in desktop Chrome.

Report what you actually observed. "Should work" is not a result.
