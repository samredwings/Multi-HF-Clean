# Multi-HF v0.2.0 — Recheck report

Rechecked on 2026-11-10 with Node.js 22.16.0 and npm 10.9.2.

## Results

- `npm ci --ignore-scripts --no-audit --no-fund` — passed after generating the missing npm lockfile.
- `npm run check` — passed; syntax check covered 12 first-party JavaScript modules.
- `npm test` — passed; 54 tests, 0 failures.
- `npm run build` — passed; generated the static app in `dist/` (12 files; build id `2d16afe4e06d`).
- `npm run build:android-assets` — passed; synchronized 12 web asset files into the Android app assets directory.
- `npm audit --json` — 0 reported vulnerabilities; 0 declared production or development dependencies.
- `npm audit --omit=dev --json` — 0 reported vulnerabilities; 0 declared production or development dependencies.
- `npm ls --omit=dev --all` — empty production dependency tree.
- ZIP archive test — passed; all packaged entries validated without CRC errors.

## Android build limitation

The Android Gradle wrapper properties pin Gradle 8.9 and the `gradlew` shell/Windows scripts are included. The binary `android/gradle/wrapper/gradle-wrapper.jar` is not in this bundle. The local validation environment also has no Android SDK or installed Gradle. Therefore `assembleDebug` and `lintDebug` have **not** been verified here. The README in `android/gradle/wrapper/` documents how to restore the official wrapper JAR and verify its SHA-256 before running Gradle.

## Scope

This recheck covers the JavaScript syntax, unit/integration/smoke tests, static build, Android asset synchronization, npm dependency inventory/audit, and archive integrity. It is not a substitute for an Android SDK-backed APK build on CI or a device-level acceptance test.
