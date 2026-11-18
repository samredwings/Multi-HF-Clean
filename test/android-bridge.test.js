import test from "node:test";
import assert from "node:assert/strict";
import { createAndroidBridgeClient } from "../src/lib/android-bridge.js";

function fakeTarget() {
  return { MultiHFAndroid: {
    requestStoragePermission(id) { queueMicrotask(() => target.MultiHFAndroidCallbacks.onPermissionResult(id, true, "")); },
    saveBase64(name, mime, data, id) { queueMicrotask(() => target.MultiHFAndroidCallbacks.onSaveResult(id, true, `Saved ${name}`)); },
    saveUrl(name, mime, url, id) { queueMicrotask(() => target.MultiHFAndroidCallbacks.onSaveResult(id, true, `Saved ${name}`)); },
    getLastCrashReport() { return "sample crash"; },
    clearCrashReport() { return ""; },
    shareCrashReport() {},
  } };
}

let target;
test("Android bridge wraps permission and save callbacks as promises", async () => {
  target = fakeTarget();
  const client = createAndroidBridgeClient({ target });
  assert.equal(client.available, true);
  assert.equal((await client.requestStoragePermission()).ok, true);
  assert.equal((await client.saveBase64("workspace.json", "application/json", "e30=")).message, "Saved workspace.json");
  assert.equal((await client.saveUrl("result.png", "image/png", "https://example.test/a.png")).ok, true);
});

test("Android bridge safely reports unavailable in a browser", async () => {
  const client = createAndroidBridgeClient({ target: {} });
  assert.equal(client.available, false);
  assert.equal((await client.saveBase64("a", "text/plain", "YQ==")).ok, false);
  assert.equal(client.getLastCrashReport(), "");
});
