// Workspace shape, persistence serialization, and the import trust boundary.
//
// Everything a Space needs in order to run lives on the Space record. Two of
// those facts decide whether a bearer token is transmitted:
//   - `host`      (re-derived from the Hub, never trusted from a file)
//   - `private`   (re-derived from the Hub, never trusted from a file)
// `sanitizeWorkspace` therefore strips both trust flags and marks the Space as
// needing a fresh probe. An imported file can describe work; it cannot grant a
// Space the right to receive your token.

import { normalizeHost, spaceIdFromHost } from "./hosts.js";
import { clampText, isFiniteNumber, isRecord, isSafeMediaUrl, safeId, stripEmoji } from "./util.js";

export const WORKSPACE_VERSION = 2;
export const STORAGE_KEY = "multi-hf.workspace.v2";
export const MAX_INLINE_STORED = 32_000;

export const JOB_STATUSES = new Set(["ready", "running", "done", "failed", "paused"]);
export const RESULT_KINDS = new Set(["image", "video", "audio", "file", "text"]);
const FIELD_TYPES = new Set([
  "text", "textarea", "number", "slider", "checkbox", "checkboxgroup",
  "select", "radio", "image", "video", "audio", "file",
]);
const TASKS = new Set(["image", "video", "audio", "other"]);
const KEY_PATTERN = /^c\d+$/;

export function emptyWorkspace() {
  return {
    version: WORKSPACE_VERSION,
    spaces: [],
    profiles: [],
    jobs: [],
    accounts: [],
    settings: { lastAccountId: "", maxParallelSpaces: 2 },
  };
}

export function cleanEndpoint(raw) {
  const endpoint = isRecord(raw) ? raw : null;
  if (!endpoint || typeof endpoint.apiName !== "string" || !/^[\w.-]+$/.test(endpoint.apiName)) return null;
  const fields = (Array.isArray(endpoint.fields) ? endpoint.fields : [])
    .map((item) => (isRecord(item) ? item : null))
    .filter((field) => field && typeof field.key === "string" && KEY_PATTERN.test(field.key) && FIELD_TYPES.has(field.type))
    .map((field) => ({
      key: field.key,
      label: clampText(field.label, 120) || "Input",
      type: field.type,
      hidden: field.hidden === true,
      hint: clampText(field.hint, 180),
      placeholder: clampText(field.placeholder, 120),
      min: isFiniteNumber(field.min) ? field.min : undefined,
      max: isFiniteNumber(field.max) ? field.max : undefined,
      step: isFiniteNumber(field.step) ? field.step : undefined,
      choices: (Array.isArray(field.choices) ? field.choices : [])
        .map((choice) => (isRecord(choice) && typeof choice.value === "string"
          ? { label: clampText(choice.label, 120) || choice.value, value: clampText(choice.value, 400) }
          : null))
        .filter(Boolean),
      allowCustom: field.allowCustom === true,
      defaultValue: Array.isArray(field.defaultValue)
        ? field.defaultValue.filter((item) => typeof item === "string" || isFiniteNumber(item)).slice(0, 100)
        : typeof field.defaultValue === "string" || isFiniteNumber(field.defaultValue) || typeof field.defaultValue === "boolean" || field.defaultValue === null
          ? field.defaultValue
          : null,
      ...(field.passthrough !== undefined ? { passthrough: field.passthrough } : {}),
    }));
  const outputs = (Array.isArray(endpoint.outputs) ? endpoint.outputs : [])
    .map((item) => (isRecord(item) ? item : null))
    .filter((output) => output && typeof output.key === "string" && /^o\d+$/.test(output.key))
    .map((output) => ({
      key: output.key,
      label: clampText(output.label, 120) || "Output",
      type: clampText(output.type, 40) || "text",
    }));
  return { apiName: endpoint.apiName, fields, outputs };
}

export function cleanResult(raw) {
  const item = isRecord(raw) ? raw : null;
  if (!item || !RESULT_KINDS.has(item.kind)) return null;
  if (item.kind === "text") {
    return { kind: "text", text: clampText(item.text, 5000), label: clampText(item.label, 120) || "Output" };
  }
  const url = clampText(item.url, 2_000_000);
  if (!isSafeMediaUrl(url)) return null;
  return { kind: item.kind, url, label: clampText(item.label, 120) || "Output" };
}

export function cleanProtocol(raw) {
  const protocol = isRecord(raw) ? raw : null;
  if (!protocol) return null;
  if (typeof protocol.base !== "string" || (protocol.base !== "" && !/^\/[\w./-]*$/.test(protocol.base))) return null;
  if (protocol.mode !== "queue" && protocol.mode !== "predict" && protocol.mode !== "legacy") return null;
  return {
    base: protocol.base,
    mode: protocol.mode,
    version: clampText(protocol.version, 20),
    verified: protocol.verified === true,
    source: clampText(protocol.source, 20),
    configPath: /^\/(?:config|gradio_api\/config|api\/config)$/.test(protocol.configPath ?? "") ? protocol.configPath : "/config",
    uploadPath: clampText(protocol.uploadPath, 60) || `${protocol.base}/upload`,
    callPath: clampText(protocol.callPath, 60) || (protocol.mode === "queue" ? `${protocol.base}/call` : protocol.mode === "legacy" ? "/api/predict" : `${protocol.base}/run`),
    streamEvents: {
      complete: (Array.isArray(protocol.streamEvents?.complete) ? protocol.streamEvents.complete : [])
        .map((name) => clampText(name, 40)).filter(Boolean),
      progress: (Array.isArray(protocol.streamEvents?.progress) ? protocol.streamEvents.progress : [])
        .map((name) => clampText(name, 40)).filter(Boolean),
    },
  };
}

/** A Space as produced by a live probe. These fields are already authoritative. */
export function makeSpace(raw) {
  const host = normalizeHost(raw?.host);
  if (!host) throw new Error("A Space needs a *.hf.space host.");
  const endpoints = (Array.isArray(raw.endpoints) ? raw.endpoints : []).map(cleanEndpoint).filter(Boolean);
  return {
    id: clampText(raw.id, 200) || spaceIdFromHost(host) || host,
    kind: "space",
    ref: clampText(raw.ref, 200),
    host,
    title: stripEmoji(raw.title) || host,
    note: clampText(raw.note, 200),
    task: TASKS.has(raw.task) ? raw.task : "other",
    accountId: clampText(raw.accountId, 100),
    private: raw.private === true,
    sendToken: raw.sendToken === true,
    endpoints,
    activeApi: clampText(raw.activeApi, 120) || endpoints[0]?.apiName || "",
    protocol: cleanProtocol(raw.protocol),
    needsProbe: raw.needsProbe === true || !cleanProtocol(raw.protocol),
    probedAt: isFiniteNumber(raw.probedAt) ? raw.probedAt : 0,
    fetchedAt: isFiniteNumber(raw.fetchedAt) ? raw.fetchedAt : Date.now(),
  };
}

export function upsertSpace(spaces, space) {
  const next = spaces.slice();
  const index = next.findIndex((item) => item.id === space.id || item.host === space.host);
  if (index >= 0) next.splice(index, 1, { ...next[index], ...space });
  else next.push(space);
  return next;
}

/** A job left `running` by a closed tab must not silently re-spend quota. */
export function recoverRunningJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => (
    job?.status === "running"
      ? { ...job, status: "paused", error: "The page was closed while this job was running. Review the Space, then retry." }
      : job
  ));
}

export function cleanJob(raw) {
  const job = isRecord(raw) ? raw : null;
  if (!job) return null;
  const spaceId = clampText(job.spaceId, 200);
  if (!spaceId) return null;
  const values = {};
  for (const [key, value] of Object.entries(isRecord(job.values) ? job.values : {})) {
    if (!KEY_PATTERN.test(key)) continue;
    if (typeof value === "string") values[key] = clampText(value, 20_000);
    else if (Array.isArray(value)) values[key] = value.filter((item) => typeof item === "string" || isFiniteNumber(item)).slice(0, 100).map((item) => typeof item === "string" ? clampText(item, 400) : item);
    else if (isFiniteNumber(value) || typeof value === "boolean" || value === null) values[key] = value;
  }
  return {
    id: clampText(job.id, 100) || safeId("job"),
    name: clampText(job.name, 120) || "Generation job",
    spaceId,
    apiName: clampText(job.apiName, 120),
    accountId: clampText(job.accountId, 100),
    values,
    files: (Array.isArray(job.files) ? job.files : []).filter((key) => typeof key === "string" && KEY_PATTERN.test(key)),
    status: JOB_STATUSES.has(job.status) ? job.status : "failed",
    error: clampText(job.error, 2000),
    attempts: isFiniteNumber(job.attempts) ? job.attempts : 0,
    progress: isFiniteNumber(job.progress) ? job.progress : undefined,
    result: (Array.isArray(job.result) ? job.result : []).map(cleanResult).filter(Boolean),
    createdAt: isFiniteNumber(job.createdAt) ? job.createdAt : 0,
    updatedAt: isFiniteNumber(job.updatedAt) ? job.updatedAt : 0,
    startedAt: isFiniteNumber(job.startedAt) ? job.startedAt : undefined,
    finishedAt: isFiniteNumber(job.finishedAt) ? job.finishedAt : undefined,
  };
}

export function persistableResult(result) {
  if (!Array.isArray(result)) return [];
  return result.map((item) => (
    typeof item?.url === "string" && item.url.startsWith("data:") && item.url.length > MAX_INLINE_STORED
      ? {
        kind: "text",
        label: item.label || "Output",
        text: "Inline media was too large to store in this browser. Re-run the job to regenerate it.",
      }
      : item
  ));
}

/**
 * Import boundary. Rebuilds a workspace from untrusted JSON:
 * every host is re-validated, every media URL is re-validated, tokens and trust
 * flags are dropped, and each Space is flagged for a fresh probe.
 */
export function sanitizeWorkspace(data) {
  const root = isRecord(data?.workspace) ? data.workspace : isRecord(data) ? data : null;
  if (!root || !Array.isArray(root.spaces) || !Array.isArray(root.jobs) || !Array.isArray(root.profiles)) {
    throw new Error("This file is not a Multi-HF workspace export (expected `spaces`, `jobs` and `profiles`).");
  }

  const spaces = [];
  for (const raw of root.spaces) {
    const candidate = isRecord(raw) ? raw : null;
    if (!candidate) continue;
    const host = normalizeHost(candidate.host);
    if (!host) continue;
    const endpoints = (Array.isArray(candidate.endpoints) ? candidate.endpoints : []).map(cleanEndpoint).filter(Boolean);
    spaces.push({
      id: clampText(candidate.id, 200) || spaceIdFromHost(host),
      kind: "space",
      ref: /^[\w.-]+\/[\w.-]+$/.test(candidate.ref ?? "") ? candidate.ref : "",
      host,
      title: stripEmoji(candidate.title).slice(0, 200) || host,
      note: clampText(candidate.note, 200),
      task: TASKS.has(candidate.task) ? candidate.task : "other",
      accountId: "",
      // Trust flags are never imported: they are re-derived from the Hub on probe.
      private: false,
      sendToken: false,
      endpoints,
      activeApi: endpoints[0]?.apiName ?? "",
      protocol: null,
      needsProbe: true,
      probedAt: 0,
      fetchedAt: isFiniteNumber(candidate.fetchedAt) ? candidate.fetchedAt : 0,
    });
  }

  const known = new Set(spaces.map((space) => space.id));
  const jobs = [];
  for (const raw of root.jobs) {
    const job = cleanJob(raw);
    if (!job) continue;
    if (!known.has(job.spaceId)) continue;
    jobs.push({
      ...job,
      // An imported job always starts paused: it needs a live Space and, for
      // file inputs, freshly attached local files.
      status: "paused",
      error: job.error || "Imported job. Review the Space, reconnect an account if needed, then retry.",
      accountId: "",
      progress: undefined,
    });
  }

  const profiles = [];
  for (const raw of root.profiles) {
    const profile = isRecord(raw) ? raw : null;
    if (!profile || !known.has(clampText(profile.spaceId, 200))) continue;
    profiles.push({
      id: clampText(profile.id, 100) || safeId("profile"),
      name: clampText(profile.name, 120) || "Profile",
      spaceId: clampText(profile.spaceId, 200),
      apiName: clampText(profile.apiName, 120),
      values: cleanJob({ spaceId: profile.spaceId, values: profile.values })?.values ?? {},
      createdAt: isFiniteNumber(profile.createdAt) ? profile.createdAt : 0,
      updatedAt: isFiniteNumber(profile.updatedAt) ? profile.updatedAt : 0,
    });
  }

  const accounts = (Array.isArray(root.accounts) ? root.accounts : [])
    .map((item) => (isRecord(item) ? item : null))
    .filter((account) => account && typeof account.id === "string")
    .map((account) => ({
      id: clampText(account.id, 100),
      label: clampText(account.label, 60) || "Account",
      username: clampText(account.username, 80),
      enabled: account.enabled !== false,
      connected: false,
      createdAt: isFiniteNumber(account.createdAt) ? account.createdAt : 0,
    }));

  return {
    version: WORKSPACE_VERSION,
    spaces,
    profiles,
    jobs: recoverRunningJobs(jobs),
    accounts,
    settings: {
      lastAccountId: "",
      maxParallelSpaces: clampConcurrency((isRecord(root.settings) ? root.settings : {}).maxParallelSpaces),
    },
  };
}

export function clampConcurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 2;
  return Math.min(4, Math.max(1, Math.round(number)));
}

/** What actually goes into localStorage: no tokens, no transient health, bounded media. */
export function serializeWorkspace(state) {
  return {
    version: WORKSPACE_VERSION,
    spaces: (state.spaces ?? []).map(({ health, ...space }) => space),
    profiles: state.profiles ?? [],
    jobs: (state.jobs ?? []).map(({ result, progress, ...job }) => ({
      ...job,
      result: persistableResult(result),
    })),
    accounts: (state.accounts ?? []).map(({ token, connected, ...account }) => ({ ...account, connected: false })),
    settings: state.settings ?? { lastAccountId: "", maxParallelSpaces: 2 },
  };
}

export function exportWorkspace(state) {
  return {
    version: WORKSPACE_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: {
      ...serializeWorkspace(state),
      // Exports never carry tokens; the account list is metadata only.
      accounts: (state.accounts ?? []).map(({ token, connected, ...account }) => ({ ...account, connected: false })),
    },
  };
}

