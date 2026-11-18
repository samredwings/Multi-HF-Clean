// Pure helpers. No DOM, no network: everything here is unit-testable in Node.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for use in text AND attribute position. Always applied to untrusted data. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** True when a string is safe to place in href/src without escaping surprises. */
export function isSafeMediaUrl(raw) {
  const value = String(raw ?? "").trim();
  if (/^https:\/\/[^\s"'<>]+$/i.test(value)) return true;
  // Inline SVG and non-base64 data URLs are intentionally excluded. This keeps
  // untrusted Space output from becoming active content inside the app.
  return /^data:(?:image\/(?:png|jpeg|webp|gif|avif)|video\/(?:mp4|webm|ogg)|audio\/(?:mpeg|mp3|wav|ogg|mp4|webm));base64,[a-z0-9+/=\s]+$/i.test(value);
}

export function safeId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function clampText(value, max = 500) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function toFinite(value, fallback = 0) {
  return isFiniteNumber(value) ? value : fallback;
}

export function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Strip emoji from labels coming out of Gradio configs; they break narrow layouts. */
export function stripEmoji(value) {
  return String(value ?? "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u200d\ufe0f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function fmtDate(value) {
  const date = new Date(value);
  if (Number.isNaN(+date)) return "-";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function timeAgo(value, now = Date.now()) {
  const mins = Math.max(0, Math.floor((now - toFinite(value, 0)) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

/** Deterministic 32-bit hash, used for stable session ids without Math.random. */
export function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}



/** Create a keyed reservation gate. Concurrent callers reserve distinct slots. */
export function createRateGate(intervalMs, { now = () => Date.now(), delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const nextAt = new Map();
  return async (key = "default") => {
    const current = now();
    const slot = Math.max(current, nextAt.get(key) ?? current);
    nextAt.set(key, slot + Math.max(0, intervalMs));
    const wait = slot - current;
    if (wait > 0) await delay(wait);
  };
}

// Hugging Face Hub metadata calls are spaced at no more than five per second.
export const waitForHubRequest = createRateGate(200);
// A Space's /config schema is never probed more than once in any five-second window.
export const waitForSpaceConfigProbe = createRateGate(5_000);
