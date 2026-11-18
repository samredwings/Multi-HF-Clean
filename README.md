# Multi-HF — Batch Studio

A local-first workbench for running batches of jobs against Hugging Face Gradio
Spaces. It reads a Space's `/config`, derives a **verified wire protocol** once,
stores it on the Space, and then runs a queue that is scheduled **per Space**.

No runtime dependencies. Node.js 20.11+ only.

```sh
npm run check     # syntax check every first-party module
npm test          # unit + integration tests (no network)
npm run build     # static build into dist/
npm run preview   # serve dist/ on http://localhost:4173
npm run build:android-assets   # sync dist/ into the APK assets
```

## Why this rewrite

The previous build resolved the Gradio wire contract *per request* by guessing.
That single decision caused most real-world failures:

| Symptom | Cause in the old build |
| --- | --- |
| Space discovered, every job 404s | `apiPrefix` fell back to `/gradio_api` when a Space declared none, and the `/run` fallback reused the same wrong prefix |
| Two automatic retries burned on a request that can never work | a 404 was treated as a transient failure |
| One slow Space stalled the entire batch | a single global queue lock instead of per-Space lanes |
| An imported workspace could aim a token at an attacker's Space | `private` / `sendToken` were trusted from the imported JSON |
| Exported JSON and inline media never saved on the APK | `setDownloadListener` only handled `https:` URLs |
| Tests green, app unusable | the suite fed hand-written configs that matched the parser, not real Space output |

## The two ideas that make it work

### 1. A Space owns a protocol record

`src/lib/protocol.js` turns a Gradio `/config` document plus the path that served
it into a stored contract:

```js
protocol = {
  base: "/gradio_api",        // the prefix that actually answered
  mode: "queue",              // "queue" (/call + SSE) | "predict" (/run) | "legacy" (rare /api/predict)
  version: "5.12.0",
  verified: true,             // false means a guess: the queue refuses to dispatch
  source: "declared",         // declared | version | config-path | default
  configPath: "/config",      // which URL answered, so drift can be re-checked
  callPath: "/gradio_api/call",
  streamEvents: { complete: [...], progress: [...] },
}
```

Resolution order is fixed and testable: declared `api_prefix` → major version →
the path that answered → default. `verified: false` is a hard gate: the queue
will not run a guess.

### 2. The queue is scheduled per Space

`src/lib/queue.js` separates scheduling from running:

- **Lanes.** Each Space has a lane: `idle`, `busy`, or `blocked`. A blocked Space
  (asleep, drifting, quota, auth) never stalls other Spaces.
- **Plan.** `planDispatch()` is pure: oldest job first, at most one job per Space,
  up to `settings.maxParallelSpaces` (1–4). The tests pin this down.
- **Health before dispatch.** Before a job runs, the Space is checked: Hub
  `runtime.stage` → wake if sleeping → re-read `/config` and compare endpoint
  names and protocol. Nothing is dispatched against a stale contract.
- **Failure classes.** `classifyFailure()` returns `auth | quota | waking |
  transient | policy | protocol | fatal`. Only `waking` and `transient` retry
  automatically (max 3, with 2s, 4s, then 8s backoff; capped at 60s). `protocol` marks the Space as needing a re-probe instead
  of burning retries. `quota` blocks the lane, never invents a reset time, and
  never rotates accounts.
- **No hidden tokens.** A token goes to the Hub API, and to a `*.hf.space` host
  only when a *fresh* Hub response says the Space is private, or the user
  explicitly opted that Space in. `private` is never read from an import.

## Layout

```
src/lib/util.js      escaping, safe media URLs, small pure helpers
src/lib/hosts.js     Space id/host parsing + the token egress policy
src/lib/protocol.js  Gradio adapter: config → endpoints, protocol, SSE, outputs, failures
src/lib/state.js     workspace shape, import trust boundary, persistence
src/lib/queue.js     lanes, dispatch planning, runner (injectable fetch)
src/app.js           UI wiring only
test/                unit + integration tests, with real-shaped /config fixtures
```

`src/app.js` contains no protocol logic and no queue policy. That is deliberate:
the parts that were wrong last time are the parts that are now testable without a
browser.

## Migrating an old workspace

Importing a v1 export (`models`/`jobs`) still works: it is routed through
`sanitizeWorkspace()`, which drops every trust flag, discards the stored
protocol, and marks each Space `needsProbe`. Probe each Space once, reconnect an
account if you use private Spaces, then retry the jobs (they arrive paused).

## Security notes

- Tokens live in memory for the tab only; they are never written to
  `localStorage` or an export.
- Imported results must be `https:` or base64 raster/audio/video `data:`. Inline
  SVG and `javascript:` are rejected, and every value is HTML-escaped in both
  text and attribute position.
- The Android shell uses `WebViewAssetLoader` over `https://appassets.androidplatform.net`,
  disables file/content access, and saves `blob:`/`data:` downloads through a
  MediaStore bridge instead of dropping them.
- Quota is never worked around. A quota failure pauses that Space's lane and
  waits for a human decision.

## Limits

- Generation runs in the foreground; closing the tab cancels the request (the
  Space may finish server-side). A job left `running` is recovered as `paused` so
  quota is never silently re-spent.
- File inputs live in memory. After a reload, clone the job and reattach files.
- Spaces with unsupported Gradio components render a reduced form and say so.



## Android build

Prerequisites: Android Studio Hedgehog (2023.1.1) or newer, JDK 17, Android SDK Platform 35, and the Android SDK build tools 35.0.0. The Gradle wrapper pins Gradle 8.9, compatible with Android Gradle Plugin 8.7.3; a local Gradle installation is not required when the wrapper JAR is present.

```sh
npm run check
npm test
npm run build
npm run build:android-assets
cd android
./gradlew assembleDebug
./gradlew lintDebug
```

On Windows, run `gradlew.bat assembleDebug` from `android\`. The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The Android `versionName` and `versionCode` are derived from the top-level `package.json` version at Gradle configuration time.

If `android/gradle/wrapper/gradle-wrapper.jar` is absent in a manual copy of the repository, regenerate it from `android/` with Gradle 8.9 by running `gradle wrapper --gradle-version 8.9 --distribution-type bin`, or restore the checked-in wrapper JAR.

## Queue persistence and recovery

Spaces, profiles, queue jobs, job history, and settings are saved in this browser's local workspace. Access tokens are not persisted. A job that was `running` when the tab or app closed is restored as `paused` with an interruption message; it is not silently re-run, because doing so could spend Hugging Face quota twice. File inputs remain in memory and must be attached again after a reload.

## Android diagnostics and downloads

The Android shell keeps the latest uncaught crash report in the app's private storage. Open the **Debug** tab to review, share, or clear it. Reports are stored only on the device; review them before sharing. Android file saves run off the UI thread. Android 9 and older require the storage permission before writing to the public Downloads folder; Android 10 and newer use MediaStore.

## Keyboard shortcuts and themes

- `Ctrl`/`Cmd` + `Enter`: submit the open job form.
- `Ctrl`/`Cmd` + `Shift` + `R`: start the ready queue.
- `Ctrl`/`Cmd` + `Shift` + `S`: pause or resume the queue.
- `Escape`: close an open dialog.

Use the theme button in the header to switch between dark and light themes. The selection is saved in local storage.
