// The Gradio protocol adapter.
//
// A Space's wire contract (base path, queue vs sync mode, stream event names,
// output shape) is resolved ONCE at discovery time and stored on the Space
// record. The runner never re-guesses it: if the stored contract stops working
// the Space is marked as drifted and the user is asked to re-probe.

import { clampText, isRecord, isSafeMediaUrl, stripEmoji } from "./util.js";

const LAYOUT_TYPES = new Set([
  "state", "browserstate", "button", "markdown", "html", "label", "dataset", "form",
  "column", "row", "group", "accordion", "tabs", "tabitem", "highlightedtext", "gallery",
]);

const MEDIA_TYPES = new Set(["image", "video", "audio", "gallery", "file"]);

export const CONFIG_PATHS = ["/config", "/gradio_api/config", "/api/config"];

export const PROTOCOL_MODES = { queue: "queue", predict: "predict", legacy: "legacy" };

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseChoices(raw) {
  if (!Array.isArray(raw)) return [];
  const choices = [];
  for (const item of raw) {
    if (typeof item === "string" || typeof item === "number") {
      const value = item;
      const label = String(value);
      choices.push({ label: stripEmoji(label) || label, value });
      continue;
    }
    if (Array.isArray(item) && item.length > 1) {
      const value = item[1];
      const label = String(item[0] ?? value);
      choices.push({ label: stripEmoji(label) || String(value), value });
      continue;
    }
    const entry = isRecord(item) ? item : null;
    if (entry && "value" in entry) {
      const value = entry.value;
      const label = String(entry.label ?? value);
      choices.push({ label: stripEmoji(label) || String(value), value });
    }
  }
  return choices;
}

export function typeFor(rawType, props = {}) {
  const type = String(rawType || "textbox").toLowerCase();
  if (LAYOUT_TYPES.has(type)) return "skip";
  if (type === "textbox") {
    const lines = Number(props.lines ?? 1);
    const looksLong = /prompt|caption|description|negative|instruction|question/i.test(String(props.label ?? ""));
    return lines > 1 || looksLong ? "textarea" : "text";
  }
  if (type === "slider") return "slider";
  if (type === "number") return "number";
  if (type === "checkbox") return "checkbox";
  if (type === "checkboxgroup") return "checkboxgroup";
  if (type === "dropdown" || type === "multiselect") return "select";
  if (type === "radio") return "radio";
  if (type === "image" || type === "sketchpad" || type === "imageeditor") return "image";
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  if (type === "file" || type === "uploadbutton") return "file";
  return "text";
}

export function coerceChoiceValue(choices, value) {
  const match = (choices ?? []).find((choice) => String(choice.value) === String(value));
  return match ? match.value : value;
}

export function defaultValueFor(type, value, choices) {
  if (type === "checkbox") return value === true;
  if (type === "checkboxgroup") return Array.isArray(value) ? value.map((item) => coerceChoiceValue(choices, item)) : [];
  if (type === "number" || type === "slider") return number(value) ?? (value ?? null);
  if (type === "select" || type === "radio") {
    return value == null ? (choices[0]?.value ?? "") : coerceChoiceValue(choices, value);
  }
  return typeof value === "string" ? value : "";
}

function toField(component) {
  const props = isRecord(component?.props) ? component.props : {};
  const id = Number.isFinite(component?.id) ? component.id : 0;
  const mapped = typeFor(component?.type, props);
  const hidden = mapped === "skip" || props.visible === false;
  const type = mapped === "skip" ? "text" : mapped;
  const choices = parseChoices(props.choices);
  const label = stripEmoji(typeof props.label === "string" ? props.label : "");
  const field = {
    key: `c${id}`,
    label: label || (hidden ? "" : `Input ${id}`),
    type,
    hidden,
    hint: typeof props.info === "string" ? stripEmoji(props.info).slice(0, 180) : "",
    placeholder: typeof props.placeholder === "string" ? stripEmoji(props.placeholder) : "",
    min: number(props.minimum ?? props.min),
    max: number(props.maximum ?? props.max),
    step: number(props.step),
    choices,
    allowCustom: props.allow_custom_value === true,
    defaultValue: defaultValueFor(type, props.value, choices),
  };
  if (["image", "video", "audio", "file"].includes(type)) field.defaultValue = null;
  if (hidden && props.value != null) field.passthrough = props.value;
  return field;
}

function isExampleLoader(apiName) {
  return /^load_example(?:_(?:input|output))?(?:_\d+)?$/i.test(apiName);
}

function scoreEndpoint(endpoint) {
  const types = endpoint.outputs.map((output) => output.type);
  let score = 0;
  if (types.includes("video")) score += 50;
  if (types.includes("image") || types.includes("gallery")) score += 40;
  if (types.includes("audio")) score += 12;
  if (/^(infer|generate|predict|process)$/i.test(endpoint.apiName)) score += 30;
  else if (/generat|infer|predict|txt2|text_to|image_to|i2v|t2v|run/i.test(endpoint.apiName)) score += 16;
  if (endpoint.fields.some((field) => !field.hidden && ["textarea", "image", "text"].includes(field.type))) score += 6;
  return score;
}

/**
 * Parse a Gradio `/config` document into endpoints.
 * Pure: no network, no clock. Also returns the version and declared api_prefix so
 * `deriveProtocol` can decide the wire contract from the same document.
 */
export function parseSpaceConfig(config) {
  const root = isRecord(config) ? config : null;
  if (!root || !Array.isArray(root.components)) {
    throw new Error("This Space did not return a valid Gradio /config document.");
  }
  const components = new Map();
  for (const item of root.components) {
    if (isRecord(item) && Number.isFinite(item.id)) components.set(item.id, item);
  }

  const endpoints = [];
  for (const rawDep of Array.isArray(root.dependencies) ? root.dependencies : []) {
    const dep = isRecord(rawDep) ? rawDep : null;
    if (!dep) continue;
    const apiName = typeof dep.api_name === "string" ? dep.api_name.replace(/^\//, "") : "";
    if (!apiName || isExampleLoader(apiName)) continue;
    if (["false", "null", "lambda"].includes(apiName)) continue;
    if (apiName.startsWith("_") || apiName.startsWith("js_")) continue;
    if (!/^[\w.-]+$/.test(apiName)) continue;
    if (dep.backend_fn === false || dep.api_visibility === "private") continue;
    const inputs = Array.isArray(dep.inputs) ? dep.inputs.filter((id) => typeof id === "number") : [];
    const outputs = Array.isArray(dep.outputs) ? dep.outputs.filter((id) => typeof id === "number") : [];
    if (!outputs.length) continue;
    endpoints.push({
      apiName,
      fnIndex: Number.isFinite(dep.id) ? dep.id : Number.isFinite(dep.fn_index) ? dep.fn_index : undefined,
      fields: inputs.map((id) => toField(components.get(id) ?? { id, type: "textbox" })),
      outputs: outputs.map((id) => {
        const component = components.get(id);
        const type = String(component?.type ?? "text").toLowerCase();
        return {
          key: `o${id}`,
          label: stripEmoji(component?.props?.label ?? "Output") || "Output",
          type,
        };
      }),
    });
  }

  const media = endpoints.filter((endpoint) => endpoint.outputs.some((output) => MEDIA_TYPES.has(output.type)));
  const ordered = (media.length ? media : endpoints).slice().sort((a, b) => scoreEndpoint(b) - scoreEndpoint(a));
  if (!ordered.length) throw new Error("No runnable API endpoints were found in this Space configuration.");

  return {
    document: root,
    title: stripEmoji(root.title) || "Hugging Face Space",
    version: typeof root.version === "string" ? root.version : "",
    declaredApiPrefix: typeof root.api_prefix === "string" ? root.api_prefix : "",
    endpoints: ordered.slice(0, 12),
  };
}

export function taskFromEndpoints(endpoints) {
  const types = (endpoints ?? []).flatMap((endpoint) => endpoint.outputs.map((output) => output.type));
  if (types.includes("video")) return "video";
  if (types.includes("image") || types.includes("gallery")) return "image";
  if (types.includes("audio")) return "audio";
  return "other";
}

/**
 * Decide the wire contract from the parsed config plus the path it was served
 * from. Deterministic order: declared prefix, then major version, then source.
 * Returns `verified: false` when the answer is an inference rather than a fact,
 * which the discovery probe then confirms with one cheap request.
 */
export function deriveProtocol({ config, configPath = "/config" }) {
  const version = typeof config?.version === "string" ? config.version : "";
  const declared = typeof config?.api_prefix === "string" ? config.api_prefix.trim() : "";
  const sourceBase = configPath.replace(/\/config$/, "");
  const safeDeclared = declared.startsWith("/") && /^\/[\w./-]*$/.test(declared)
    ? declared.replace(/\/+$/, "")
    : "";
  const base = safeDeclared || (sourceBase === "/gradio_api" || sourceBase === "/api" ? sourceBase : "");

  if (/^3\./.test(version)) {
    // Gradio 3's public prediction route is /run/{api_name}; unlike newer
    // queue-based Space APIs it returns JSON synchronously.
    return buildProtocol({ base: "", mode: PROTOCOL_MODES.predict, version, verified: true, source: "version" });
  }
  if (/^4\./.test(version)) {
    return buildProtocol({ base: base || "/gradio_api", mode: PROTOCOL_MODES.queue, version, verified: true, source: safeDeclared ? "declared" : "version" });
  }
  if (/^5\./.test(version)) {
    return buildProtocol({ base: base || "/gradio_api", mode: PROTOCOL_MODES.queue, version, verified: true, source: safeDeclared ? "declared" : "version" });
  }
  if (base === "/api") {
    return buildProtocol({ base, mode: PROTOCOL_MODES.legacy, version, verified: true, source: "config-path" });
  }
  if (base === "/gradio_api") {
    return buildProtocol({ base, mode: PROTOCOL_MODES.queue, version, verified: true, source: "config-path" });
  }
  if (safeDeclared) {
    return buildProtocol({ base: safeDeclared, mode: PROTOCOL_MODES.queue, version, verified: false, source: "declared" });
  }
  return buildProtocol({ base: "", mode: PROTOCOL_MODES.predict, version, verified: false, source: "default" });
}

function buildProtocol({ base, mode, version, verified, source }) {
  const normalizedBase = base.replace(/\/+$/, "");
  return {
    base: normalizedBase,
    mode,
    version,
    verified,
    source,
    uploadPath: `${normalizedBase}/upload`,
    callPath: mode === PROTOCOL_MODES.queue
      ? `${normalizedBase}/call`
      : mode === PROTOCOL_MODES.legacy
        ? "/api/predict"
        : `${normalizedBase}/run`,
    configPath: "",
    streamEvents: mode === PROTOCOL_MODES.queue
      ? { complete: ["complete", "process_completed"], progress: ["generating", "process_generating", "heartbeat", "estimation"] }
      : { complete: [], progress: [] },
  };
}

/** Ordered URLs to try when reading a Space's config. Exported so tests pin the order. */
export function configUrlCandidates(host) {
  return CONFIG_PATHS.map((path) => `${host}${path}`);
}

/** Ordered URLs to confirm an unverified protocol guess. */
export function protocolConfirmUrl(host, protocol) {
  return `${host}${protocol.base}/info`;
}

export function endpointFor(space, apiName, { fallback = true } = {}) {
  const exact = (space?.endpoints ?? []).find((endpoint) => endpoint.apiName === apiName);
  if (exact) return exact;
  return fallback ? space?.endpoints?.[0] : undefined;
}

/**
 * Normalize a Gradio output payload into displayable items.
 * Every URL is validated, so a hostile endpoint cannot inject markup through it.
 */
export function normalizeOutputs(value, label = "Output", baseUrl = "", index = 0) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, position) => normalizeOutputs(item, `${label} ${position + 1}`, baseUrl, position));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (/^data:(image|video|audio)\//i.test(trimmed)) {
      if (!isSafeMediaUrl(trimmed)) return [{ kind: "text", text: "Inline media was rejected as unsafe.", label }];
      return [{ kind: /^data:(image|video|audio)/i.exec(trimmed)[1].toLowerCase(), url: trimmed, label }];
    }
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/file=") || trimmed.startsWith("file=")) {
      const absolute = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `${baseUrl}${trimmed.startsWith("/file=") ? trimmed : `/file=${trimmed.replace(/^\//, "")}`}`;
      if (!isSafeMediaUrl(absolute)) return [{ kind: "text", text: "Output URL was rejected as unsafe.", label }];
      const clean = absolute.split(/[?#]/)[0].toLowerCase();
      const kind = /\.(mp4|webm|mov|m4v)$/.test(clean) ? "video"
        : /\.(mp3|wav|ogg|m4a|flac)$/.test(clean) ? "audio"
        : /\.(png|jpe?g|webp|gif|avif)$/.test(clean) || /\/file=/.test(absolute) ? "image"
        : "file";
      return [{ kind, url: absolute, label }];
    }
    return [{ kind: "text", text: trimmed.slice(0, 5000), label }];
  }
  const record = isRecord(value) ? value : null;
  if (record) {
    const mime = String(record.mime_type ?? record.mime ?? "");
    const url = typeof record.url === "string" ? record.url : typeof record.path === "string" ? record.path : "";
    if (url) {
      const kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio"
        : mime.startsWith("image/") ? "image" : "file";
      const absolute = /^https?:\/\//i.test(url) || url.startsWith("data:")
        ? url
        : `${baseUrl}/file=${url.replace(/^\//, "")}`;
      if (!isSafeMediaUrl(absolute)) return [{ kind: "text", text: "Output URL was rejected as unsafe.", label }];
      return [{ kind, url: absolute, label }];
    }
    if (typeof record.text === "string") return [{ kind: "text", text: record.text.slice(0, 5000), label }];
    if (Array.isArray(record.data)) return normalizeOutputs(record.data, label, baseUrl, index);
    try {
      return [{ kind: "text", text: JSON.stringify(record).slice(0, 5000), label }];
    } catch {
      return [];
    }
  }
  return [{ kind: "text", text: String(value).slice(0, 5000), label }];
}

const AUTH = /invalid token|unauthorized|\b401\b|expired token|not authenticated|authentication required/i;
const QUOTA = /zero\s*gpu|gpu quota|quota exceeded|out of credits|insufficient credit|payment required|monthly (included )?credit|depleted|spend limit|exceeded your (free|gpu|quota)|no gpu quota/i;
const WAKING = /asleep|waking|is starting|space is (sleep|start|build|paused)|currently loading|loading (the )?model|model is loading|building replica/i;
const TRANSIENT = /timeout|timed out|econnreset|socket hang up|network|fetch failed|bad gateway|gateway timeout|connection (closed|reset|dropped|aborted)|runtime (has )?(ended|expired)|upstream|overloaded|rate limit|too many requests|\b429\b|\b502\b|\b503\b|\b504\b|\b524\b|disconnected/i;
const POLICY = /content policy|safety system|blocked by safety|nsfw|moderation|prohibited|violat(e|es|ion)/i;
const PROTOCOL = /HTTP 404|HTTP 405|HTTP 501|not found|no such endpoint|unknown endpoint/i;

export const FAILURE = {
  auth: "auth",
  quota: "quota",
  waking: "waking",
  transient: "transient",
  policy: "policy",
  protocol: "protocol",
  fatal: "fatal",
};

/** Classify a failure into a queue decision. `status` is an HTTP status when known. */
export function classifyFailure(status, message = "") {
  const text = `${status ?? ""} ${message}`;
  if (status === 401 || status === 403 || AUTH.test(text)) return FAILURE.auth;
  if (status === 402 || QUOTA.test(text)) return FAILURE.quota;
  if (WAKING.test(text)) return FAILURE.waking;
  if (status === 404 || status === 405 || status === 501) return FAILURE.protocol;
  if (PROTOCOL.test(text) && !TRANSIENT.test(text)) return FAILURE.protocol;
  if (status === 429 || status === 502 || status === 503 || status === 504 || status === 524 || TRANSIENT.test(text)) return FAILURE.transient;
  if (POLICY.test(text)) return FAILURE.policy;
  return FAILURE.fatal;
}

/** Retry delay for a failure class. Never invents a quota reset time. */
export function retryDelay(kind, { attempts = 0, resetAt = null, now = Date.now() } = {}) {
  if (kind === FAILURE.quota) return resetAt ? Math.max(0, resetAt - now) : null;
  if (kind === FAILURE.waking) return Math.min(5 * 60_000, 8_000 * 2 ** attempts);
  if (kind === FAILURE.transient) return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts));
  return null;
}

/** Which failure classes are worth another automatic attempt. */
export function isRetryable(kind) {
  return kind === FAILURE.waking || kind === FAILURE.transient;
}

export function errorMessage(payload) {
  if (typeof payload === "string") return payload;
  const raw = payload?.message ?? payload?.detail?.message ?? payload?.detail ?? payload?.error?.message
    ?? payload?.error ?? payload?.output?.error ?? payload?.output?.message ?? payload?.data?.error
    ?? payload?.msg ?? (payload?.raw && payload.raw !== "null" ? payload.raw : "");
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 2000);
  if (raw && typeof raw === "object") {
    try {
      return JSON.stringify(raw).slice(0, 2000);
    } catch {
      return "The Space returned an error object that could not be read.";
    }
  }
  return "The Space returned an error with no details.";
}

/**
 * Read a Gradio SSE stream. Text-only and fetch-free so it can be unit tested
 * with a plain ReadableStream; the wire details come from the stored protocol.
 */
export async function readGradioStream(response, { onProgress, events } = {}) {
  if (!response?.body) throw new Error("The Space returned an empty result stream.");
  const complete = new Set(events?.complete ?? ["complete", "process_completed"]);
  const progress = new Set(events?.progress ?? ["generating", "process_generating", "heartbeat", "estimation"]);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastData = null;

  const handle = (block) => {
    let event = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return { done: false };
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") return { done: true, data: lastData };
    let payload;
    try {
      payload = JSON.parse(dataText);
    } catch {
      payload = { raw: dataText };
    }
    if (event === "error" || payload?.msg === "unexpected_error"
      || (payload && !Array.isArray(payload) && payload.success === false)) {
      throw new Error(errorMessage(payload));
    }
    if (complete.has(event)) {
      return { done: true, data: payload?.output?.data ?? payload?.data ?? payload };
    }
    if (event === "message" && payload?.is_generating === false && payload?.data) lastData = payload.data;
    if (progress.has(event)) onProgress?.(payload);
    return { done: false };
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const result = handle(block);
        if (result.done) {
          if (result.data != null) return result.data;
          if (lastData != null) return lastData;
          throw new Error("Gradio stream completed without an output payload.");
        }
      }
    }
    if (buffer.trim()) {
      const result = handle(buffer);
      if (result.done && result.data != null) return result.data;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  if (lastData != null) return lastData;
  throw new Error("Gradio stream ended before a completed output was received.");
}

export function summarise(text, max = 600) {
  return clampText(String(text ?? "").replace(/\s+/g, " ").trim(), max);
}

