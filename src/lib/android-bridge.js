/** Promise-based client for the Android WebView JavaScript interface. */
export function createAndroidBridgeClient({ target = globalThis.window } = {}) {
  const bridge = target?.MultiHFAndroid ?? null;
  const pending = new Map();
  let nextId = 0;

  const callbacks = target ? (target.MultiHFAndroidCallbacks ?? {}) : {};
  callbacks.onSaveResult = (id, success, message) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve({ ok: success === true, message: String(message ?? "") });
  };
  callbacks.onPermissionResult = (id, granted, message) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve({ ok: granted === true, message: String(message ?? "") });
  };
  if (target) target.MultiHFAndroidCallbacks = callbacks;

  function callAsync(method, args = [], callback = "save") {
    if (!bridge || typeof bridge[method] !== "function") {
      return Promise.resolve({ ok: false, message: "Android file bridge is not available." });
    }
    const id = `multi-hf-${Date.now().toString(36)}-${nextId++}`;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      try {
        bridge[method](...args, id);
      } catch (error) {
        pending.delete(id);
        resolve({ ok: false, message: error?.message || String(error) });
      }
    });
  }

  return {
    available: Boolean(bridge),
    requestStoragePermission: () => callAsync("requestStoragePermission", [], "permission"),
    saveBase64: (fileName, mimeType, base64) => callAsync("saveBase64", [fileName, mimeType, base64]),
    saveUrl: (fileName, mimeType, url) => callAsync("saveUrl", [fileName, mimeType, url]),
    getLastCrashReport() {
      if (!bridge || typeof bridge.getLastCrashReport !== "function") return "";
      try { return String(bridge.getLastCrashReport() ?? ""); } catch { return ""; }
    },
    clearCrashReport() {
      if (!bridge || typeof bridge.clearCrashReport !== "function") return { ok: false, message: "Android crash reporting is not available." };
      try {
        const message = String(bridge.clearCrashReport() ?? "");
        return { ok: !message, message };
      } catch (error) { return { ok: false, message: error?.message || String(error) }; }
    },
    shareCrashReport() {
      if (!bridge || typeof bridge.shareCrashReport !== "function") return false;
      try { bridge.shareCrashReport(); return true; } catch { return false; }
    },
  };
}
