# Multi-HF correction implementation notes

This bundle is based on the uploaded Multi-HF v0.2.0 modular source snapshot. It is not based on the older v0.1.2 source currently present on the repository's `main` branch.

## Implemented

1. Added Gradle 8.9 wrapper shell and Windows scripts plus wrapper properties. The binary `gradle-wrapper.jar` is not included; see `android/gradle/wrapper/README.md` for restore and checksum instructions.
2. Added adaptive launcher icon XML, editable foreground SVG/vector artwork, and legacy launcher PNGs for mdpi through xxxhdpi.
3. Added the legacy Android storage permission (limited to API 28 and below) and an Activity Result runtime permission flow.
4. Connected Android workspace export and media downloads to a Promise-based WebView bridge.
5. Integrated an uncaught-exception crash report handler and a Debug screen with view/share/clear actions.
6. Added Android `lintDebug` to GitHub Actions and artifact upload for the HTML report.
7. Expanded release ProGuard keep rules for WebKit, Kotlin and Activity Result APIs.
8. Added Android build, diagnostic, queue-recovery, shortcut and theme documentation to README.
9. Added an explicit cleartext-disabled network security config.
10. Moved Android file writes and HTTPS downloads to a background executor using OkHttp; added a non-blocking saving toast.
11. Added Ctrl/Cmd keyboard shortcuts and Escape dialog close handling.
12. Added a persisted dark/light theme toggle.
13. Added transient retry backoff of 2s, 4s, then 8s, with a 60s cap; the existing three-retry limit is preserved explicitly.
14. Added a shared 5-requests-per-second Hub gate, one config probe per Space per five seconds, and a 200ms queue dispatch pause.
15. Added a mock Gradio job-lifecycle smoke test and mock Android bridge tests.
16. Added `.gitattributes` for line-ending and binary normalization.

The uploaded v0.2.0 baseline already persisted Spaces, profiles, queue jobs, history and settings, and recovered jobs left `running` as `paused`; that behavior is retained and documented rather than replaced.

## Verification

- `npm run check` — passed.
- `npm test` — 54 tests passed.
- `npm run build` — passed.
- Android Gradle compilation and lint were not run in this environment because no Android SDK or local Gradle installation is available. The GitHub Actions workflow is configured to run `assembleDebug` and `lintDebug` after the Gradle wrapper JAR is present.

## Version alignment

The Android `versionName` and `versionCode` are derived from the top-level `package.json` version during Gradle configuration. CI uses Node.js 20.11, matching the declared Node engine minimum.
