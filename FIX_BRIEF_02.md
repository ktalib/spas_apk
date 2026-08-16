# SPAS APK — Fix Brief 02 (rebuild and verify on device)

Read this **instead of** re-running `AGENT_BRIEF.md`. Tasks A–C from that brief
are done: the Capacitor project exists, the Android platform is added, and a
debug APK builds and installs. This brief covers only what was broken and what
must now be proven on hardware.

Your previous `BUILD_LOG.md` was accurate — it said `Outcome: PARTIAL`,
"Installed on a physical device? NO", and "Smoke test run on device? NO". That
honesty is why the bug below was findable. Keep reporting that way.

---

## 1. What was broken

The APK installed and rendered, but **every button was dead** and the status
never left "Booting...", with `Platform: unknown`.

Cause: `www/app.js` and `www/db.js` both began with **bare module specifiers**:

```js
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
```

There is **no bundler in this project** — `package.json` has no build step and
no Vite/webpack dependency. A browser cannot resolve a bare specifier, so the
module threw `Failed to resolve module specifier "@capacitor/core"` the moment
it loaded. Everything below the imports never executed, so no click listeners
were ever attached. It looked like broken buttons; it was a script that never
ran.

This is the failure mode the brief's "run the smoke test on device" step existed
to catch. A schema that has never been executed is not a deliverable — and
neither is a UI that has never been tapped.

## 2. What was changed for you

| File | Change |
|---|---|
| `www/db.js` | Rewritten to use the `window.Capacitor` global the native bridge injects, and the **raw** `Capacitor.Plugins.CapacitorSQLite` API instead of the `SQLiteConnection` wrapper class (that class only exists in the npm package, which needs a bundler). A small `makeHandle()` wrapper binds the database name so call sites stay readable. |
| `www/app.js` | Same import fix, plus `window.onerror` / `unhandledrejection` handlers that print failures **into the page**. On a handset there is no console, so a silent script death must never happen again. Also degrades honestly in a desktop browser instead of failing on first tap. |
| `src/db.js` | **Deleted.** It was an unreferenced byte-identical copy of the broken `www/db.js`. Two hand-maintained copies of the same logic is the exact trap that has already caused a production bug in this project — keep `www/` as the single source. |
| schema | Added `owner_name`/`phone` to `file_index_cache` (the lookup API returns them), `is_customary` to `land_use_cache`, and indexes on `file_index_cache (lga)` / `(district)` — see §4 below for why. |

Both files pass `node --check` as ES modules. **Neither has been run on a
device — that is your job.**

## 3. What to do

```powershell
# from the project root on the build machine
npx cap sync
cd android
.\gradlew assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Then **on a physical device**:

1. Open the app. `Platform:` must read **`android`**, not `unknown`. If it still
   says `unknown`, the script is still failing — see §5.
2. Tap **Initialize DB**. Expect `Database ready - N tables.` and a JSON list of
   the 8 tables.
3. Tap **Run smoke test**. Expect `Smoke test complete. Created SPAS-SMOKE-...`
   and JSON containing the inserted `application` row plus its `outbox` row.
4. Tap **Close DB**, then **Initialize DB** again. This must work — it exercises
   the `createConnection` "already exists" path that the old code got wrong.

Copy the **actual on-screen JSON** into the log. Not a description of it.

## 4. Product decisions that landed (2026-08-16)

These are now settled and are reflected in the schema you have:

- **Q1 — `file_index_cache` is HYBRID: pre-seed by LGA/district *and* grow
  organically on every lookup.** Amended after measuring it against live data.
  Hence the two new indexes.

  Pre-seeding alone has a real blind spot: `file_indexings.lga` is free text —
  196 distinct values against 45 canonical LGAs — so a surveyor scoped to
  "Nasarawa" silently missed the 3,388 files recorded as "NASSARAWA". Offline
  that is the worst failure mode there is: the file just is not present, with
  nothing to explain why. About 7.6% of files were unreachable that way.

  The server now resolves LGA aliases for you (`?lga=Nasarawa` also returns the
  `NASSARAWA` rows — +4,458 files recovered across 15 LGAs), but **you must also
  implement the organic half**: every file the surveyor looks up or opens gets
  written into `file_index_cache` permanently. That is what makes the residue
  survivable — a file missed by the pre-seed works offline on the second visit.
  `GET /api/spas/lookup/file-index` already returns the full cacheable row
  (`?q=` to search, `?file_numbers[]=` to fetch specific ones), so this is
  client-side only.

  There is still no assignment column on `users`, so the app passes
  LGA/district explicitly — surveyor picks it once, stored in
  `@capacitor/preferences`.
- **Q2 — no per-surveyor ownership.** Everyone sees the full record list, exactly
  as the web page does today. Q1's scoping is a **bandwidth optimisation, not a
  security boundary** — do not treat the cached subset as an access rule.
- **Q5 — a record may sync with no coordinates.** The offline form must **warn**
  about a missing pin but **must not block the save**. The surveyor is on the
  plot and GPS is one tap, but a record with no pin still beats a record that
  never gets captured.

## 5. If the buttons are still dead

Do not guess — read the actual error. Connect the device by USB and open
`chrome://inspect/#devices` in desktop Chrome; the WebView appears there and
gives you a real console. The rewritten `app.js` should also print the error
into the page's output panel, so a screenshot of the screen is usually enough.

Report the exact message. "Still not working" is not a finding.

## 6. Hand back

Append to `BUILD_LOG.md` (do not start a new file) a section:

```markdown
## 11. Fix Brief 02 — device verification (<date>)

- Device: model, Android version
- Platform reads: android / unknown
- Initialize DB: PASS/FAIL - paste the on-screen JSON
- Run smoke test: PASS/FAIL - paste the on-screen JSON
- Close DB then Initialize again: PASS/FAIL
- Any error text, verbatim
- Anything you changed, and why
```

Then the same **Requests for the backend agent** section as before — the
`/api/spas/*` endpoints are live and tested (49 passing tests) on the Laravel
side, so Phase 3 wiring can start as soon as this shell is proven on hardware.
