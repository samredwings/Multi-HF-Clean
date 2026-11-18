// Host parsing and the token-egress policy. One place decides where a bearer token may go.

const HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);

// A Space subdomain is a single DNS label under hf.space. Multi-label hosts are
// rejected so `a.b.hf.space` can never be treated as a Space host.
const SPACE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.hf\.space$/;
const SPACE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const SPACE_ID = /^[\w.-]+\/[\w.-]+$/;

export function isSpaceHost(host) {
  return SPACE_HOST.test(String(host ?? "").toLowerCase());
}

export function isSpaceId(value) {
  const text = String(value ?? "").trim();
  return SPACE_ID.test(text) && !text.split("/").some((part) => part.includes(".."));
}

/** Accepts `owner/name`, a hub Space URL, or a direct *.hf.space host. */
export function parseSpaceInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) throw new Error("Enter a Space ID (owner/name) or a Hugging Face URL.");
  if (isSpaceId(input)) return { id: input, host: null };

  let url;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new Error("That URL is not valid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Only public HTTPS Hugging Face URLs are supported.");
  }
  const host = url.hostname.toLowerCase();
  if (HF_HOSTS.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts[0] === "spaces" ? 1 : 0;
    if (isSpaceId(`${parts[index] ?? ""}/${parts[index + 1] ?? ""}`)) {
      return { id: `${parts[index]}/${parts[index + 1]}`, host: null };
    }
    throw new Error("Use a Space page URL (huggingface.co/spaces/owner/name) or an owner/name ID.");
  }
  if (!isSpaceHost(host)) {
    throw new Error("This app only connects to huggingface.co, hf.co, or a *.hf.space host.");
  }
  return { id: null, host: `https://${host}` };
}

/** Canonical `https://<label>.hf.space` origin, or "" when the value is not a Space host. */
export function normalizeHost(hostValue) {
  const raw = String(hostValue ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let host = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return "";
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/") return "";
    host = url.hostname;
  } else if (raw.includes("/")) {
    return "";
  }
  host = host.toLowerCase();
  return isSpaceHost(host) ? `https://${host}` : "";
}

export function hostForSubdomain(subdomain) {
  const label = String(subdomain ?? "").trim().toLowerCase();
  return SPACE_LABEL.test(label) && !label.includes(".") ? `https://${label}.hf.space` : "";
}

export function spaceIdFromHost(host) {
  const normalized = normalizeHost(host);
  return normalized ? normalized.slice("https://".length, -".hf.space".length) : "";
}

/**
 * Headers for a request to `url`.
 * A token goes to the Hub API, and to a Space host only when the caller says the
 * Space is private. `private` is only ever set from a fresh Hub response, never
 * from an imported workspace, so an imported file cannot redirect a token.
 */
export function tokenHeaders(token, url, { privateSpace = false } = {}) {
  if (!token) return {};
  let target;
  try {
    target = new URL(url);
  } catch {
    return {};
  }
  if (target.protocol !== "https:" || target.username || target.password || target.port) return {};
  const host = target.hostname.toLowerCase();
  if (HF_HOSTS.has(host) && host !== "hf.co") return { Authorization: `Bearer ${token}` };
  if (privateSpace === true && isSpaceHost(host)) return { Authorization: `Bearer ${token}` };
  return {};
}

