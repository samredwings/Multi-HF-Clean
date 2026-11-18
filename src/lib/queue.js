// The job queue, keyed by Space.
//
// Design rules that fix the failures of the previous build:
//
//  1. A Space is the unit of concurrency, not the job. One job per busy Space at
//     a time (Spaces keep state), but different Spaces run in parallel up to
//     `settings.maxParallelSpaces`. A single global lock made batches of mixed
//     Spaces needlessly serial and hid per-Space failures behind the queue.
//
//  2. Nothing runs until its Space is `ready`. Before a job is dispatched the
//     orchestrator asks the health ladder (asleep -> wake -> probe -> ready). A
//     Space that is asleep, rebuilding, or whose stored protocol has drifted is
//     `blocked`, and blocking a Space never blocks other Spaces.
//
//  3. A Space's protocol is read from storage and used verbatim. A 404/405/501
//     is classified as `protocol`, which marks the Space for a re-probe instead
//     of burning automatic retries on a request shape that cannot work.
//
//  4. Quota is a Space-and-account concern. A quota failure pauses that Space's
//     lane and stops automatic retries; it never invents a reset time and never
//     rotates accounts to work around a limit.

import {
  FAILURE, classifyFailure, endpointFor, errorMessage, isRetryable, parseSpaceConfig, deriveProtocol,
  normalizeOutputs, readGradioStream, retryDelay, summarise,
} from "./protocol.js";
import { isSpaceId, tokenHeaders } from "./hosts.js";
import { safeId, waitForHubRequest, waitForSpaceConfigProbe } from "./util.js";

export const LANE = {
  idle: "idle",
  blocked: "blocked",
  busy: "busy",
};

export const BLOCK_REASON = {
  asleep: "asleep",
  unknown: "unknown",
  drifting: "drifting",
  quota: "quota",
  auth: "auth",
  noSpace: "noSpace",
};

const MAX_AUTO_RETRIES = 3;
export const GEN_TIMEOUT_MS = 15 * 60 * 1000;
const META_TIMEOUT_MS = 30 * 1000;
const WAKE_TIMEOUT_MS = 5 * 60 * 1000;
const WAKE_POLL_MS = 6_000;

export const RUNNABLE = new Set(["ready"]);

/** Jobs are dispatched oldest first so a batch keeps its authoring order. */
export function queueOrder(jobs) {
  return (jobs ?? [])
    .filter((job) => RUNNABLE.has(job.status))
    .slice()
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Pick the next job for each free lane.
 * Returns `[{ spaceId, job }]`. Pure: given the same state it decides the same
 * plan, which is what `test/queue.test.js` pins down.
 */
export function planDispatch({ jobs, lanes, maxParallelSpaces = 2 }) {
  const busy = new Set(
    Object.entries(lanes ?? {})
      .filter(([, lane]) => lane?.status === LANE.busy || lane?.status === LANE.blocked)
      .map(([spaceId]) => spaceId),
  );
  const order = queueOrder(jobs);
  const plan = [];
  for (const job of order) {
    if (plan.length >= Math.max(1, maxParallelSpaces)) break;
    if (busy.has(job.spaceId)) continue;
    if (plan.some((entry) => entry.spaceId === job.spaceId)) continue;
    plan.push({ spaceId: job.spaceId, job });
  }
  return plan;
}

/**
 * Fold a job outcome into lane state.
 * `kind` is a FAILURE value or `null` for success.
 */
export function nextLaneState({ lane, job, kind, now = Date.now() }) {
  const base = { spaceId: job.spaceId, jobId: job.id, updatedAt: now };
  if (!kind) return { ...base, status: LANE.idle, blockedReason: null, consecutiveFailures: 0 };
  const previous = lane?.consecutiveFailures ?? 0;
  if (kind === FAILURE.quota) {
    return { ...base, status: LANE.blocked, blockedReason: BLOCK_REASON.quota, consecutiveFailures: previous + 1 };
  }
  if (kind === FAILURE.auth) {
    return { ...base, status: LANE.blocked, blockedReason: BLOCK_REASON.auth, consecutiveFailures: previous + 1 };
  }
  if (kind === FAILURE.waking) {
    return { ...base, status: LANE.blocked, blockedReason: BLOCK_REASON.asleep, consecutiveFailures: previous + 1 };
  }
  if (kind === FAILURE.protocol) {
    return { ...base, status: LANE.blocked, blockedReason: BLOCK_REASON.drifting, consecutiveFailures: previous + 1 };
  }
  if (isRetryable(kind) && (job.attempts ?? 0) < MAX_AUTO_RETRIES) {
    return { ...base, status: LANE.idle, blockedReason: null, consecutiveFailures: previous + 1 };
  }
  return { ...base, status: LANE.idle, blockedReason: null, consecutiveFailures: 0 };
}

export function blankLanes() {
  return {};
}

export function laneFor(lanes, spaceId) {
  return lanes?.[spaceId] ?? { spaceId, status: LANE.idle, blockedReason: null, consecutiveFailures: 0 };
}

/** Human-readable lane state for the UI. */
export function describeLane(lane) {
  if (!lane || lane.status === LANE.idle) return "Idle";
  if (lane.status === LANE.busy) return "Running";
  const reason = {
    [BLOCK_REASON.asleep]: "Blocked: Space asleep",
    [BLOCK_REASON.unknown]: "Blocked: Space unreachable",
    [BLOCK_REASON.drifting]: "Blocked: protocol changed, re-probe",
    [BLOCK_REASON.quota]: "Blocked: quota exhausted",
    [BLOCK_REASON.auth]: "Blocked: reconnect account",
    [BLOCK_REASON.noSpace]: "Blocked: Space missing",
  }[lane.blockedReason];
  return reason ?? "Blocked";
}

/**
 * Build the request plan for one job from the Space's stored protocol.
 * Pure and exported: the tests assert the exact URLs and headers, so a change in
 * wire shape has to be a deliberate change to this function.
 */
export function buildCallPlan({ space, endpoint, values, protocol, token, privateSpace }) {
  if (!protocol) throw new Error("This Space has no verified protocol. Refresh its schema first.");
  const host = space.host;
  const data = [];
  const fileFields = [];
  for (const field of endpoint.fields) {
    if (field.hidden) {
      data.push(field.passthrough ?? field.defaultValue ?? null);
      continue;
    }
    const value = values[field.key];
    if (["image", "video", "audio", "file"].includes(field.type)) {
      fileFields.push({ key: field.key, type: field.type });
      data.push(value && typeof value === "object" ? value : null);
      continue;
    }
    data.push(value === undefined ? field.defaultValue ?? null : value);
  }
  return {
    host,
    url: protocol.mode === "legacy"
      ? `${host}${protocol.callPath}`
      : `${host}${protocol.callPath}/${encodeURIComponent(endpoint.apiName)}`,
    uploadUrl: `${host}${protocol.uploadPath}`,
    headers: {
      ...tokenHeaders(token, host, { privateSpace }),
      "Content-Type": "application/json",
    },
    uploadHeaders: { ...tokenHeaders(token, host, { privateSpace }) },
    data,
    fileFields,
    streamEvents: protocol.streamEvents,
    mode: protocol.mode,
  };
}

function withTimeout(ms, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

function tagError(error, status) {
  const failure = classifyFailure(status ?? error?.status, error?.message ?? String(error));
  const wrapped = error instanceof Error ? error : new Error(String(error));
  wrapped.failure = failure;
  if (status != null) wrapped.status = status;
  return wrapped;
}

/** Shape a raw Gradio payload into validated display items. */
function toResults(raw, host) {
  const base = raw && typeof raw === "object" && Array.isArray(raw.outputs) ? raw.outputs : raw;
  return normalizeOutputs(base, "Output", host);
}

/**
 * The runner. Constructing one per session keeps the network calls injectable
 * (`fetchImpl`) so the queue logic can be tested without a browser or a Space.
 */
export function createRunner({
  fetchImpl = globalThis.fetch?.bind(globalThis) ?? (() => { throw new Error("no fetch"); }),
  now = () => Date.now(),
  hubRateGate = waitForHubRequest,
  configRateGate = waitForSpaceConfigProbe,
} = {}) {
  const request = (url, options, failureMessage, timeoutMs) => fetchJsonWith(url, options, failureMessage, timeoutMs);

  async function fetchJsonWith(url, options, failureMessage, timeoutMs = META_TIMEOUT_MS) {
    const target = new URL(url);
    if (["huggingface.co", "www.huggingface.co", "hf.co"].includes(target.hostname.toLowerCase())) {
      await hubRateGate("hub");
    }
    const timer = withTimeout(timeoutMs);
    let response;
    try {
      const patched = { ...options, signal: timer.signal };
      response = await fetchImpl(url, patched);
    } catch (error) {
      timer.done();
      if (isAbortError(error)) throw tagError(new Error(`${failureMessage}: the request timed out.`), 408);
      throw tagError(error);
    }
    timer.done();
    if (!response.ok) {
      let detail = "";
      try {
        detail = summarise(errorMessage(await response.json()), 400);
      } catch {
        try {
          detail = summarise(await response.text(), 400);
        } catch {
          detail = "";
        }
      }
      throw tagError(new Error(detail || `${failureMessage} (HTTP ${response.status})`), response.status);
    }
    try {
      return await response.json();
    } catch {
      throw tagError(new Error(`${failureMessage}: the Space did not return JSON.`), response.status);
    }
  }

  /** Ask the Hub what state a named Space is in. `private` comes only from this response. */
  async function hubStatus(space, token) {
    if (!isSpaceId(space.id)) {
      // Direct *.hf.space addresses have no unambiguous Hub id. Keep them public
      // by default and rely on the same-origin Gradio config probe for health.
      return { payload: null, stage: "UNKNOWN", private: false, host: space.host, subdomain: "", hardware: "Unknown", title: space.title, sleeping: false };
    }
    const url = `https://huggingface.co/api/spaces/${space.id.split("/").map(encodeURIComponent).join("/")}`;
    const payload = await request(url, { headers: tokenHeaders(token, url) }, "Space metadata request failed");
    const stage = String(payload?.runtime?.stage ?? "").toUpperCase();
    return {
      payload,
      stage,
      private: payload?.private === true,
      host: typeof payload?.host === "string" ? payload.host : "",
      subdomain: typeof payload?.subdomain === "string" ? payload.subdomain : "",
      hardware: payload?.runtime?.hardware?.current ?? payload?.runtime?.hardware ?? "Unknown",
      title: typeof payload?.cardData?.title === "string" ? payload.cardData.title : "",
      sleeping: Boolean(stage) && ["SLEEPING", "PAUSED", "STOPPED"].includes(stage),
    };
  }

  /** Wake a sleeping Space and wait for RUNNING. Returns true when it is ready. */
  async function wakeSpace(space, token) {
    const url = `https://huggingface.co/api/spaces/${space.id.split("/").map(encodeURIComponent).join("/")}/restart`;
    try {
      await request(url, { method: "POST", headers: tokenHeaders(token, url) }, "Could not request a wake-up");
    } catch (error) {
      // A wake-up call needs a token and rights on the Space; a public Space may
      // simply already be starting. Either way, polling decides.
      if (error.failure === FAILURE.auth) throw error;
    }
    const deadline = now() + WAKE_TIMEOUT_MS;
    while (now() < deadline) {
      const status = await hubStatus(space, token);
      if (!status.sleeping && status.stage === "RUNNING") return true;
      await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
    }
    return false;
  }

  /** Re-read the recorded config and compare API names + protocol without running a job. */
  async function confirmProtocol(space, token) {
    if (!space.protocol) return { ok: false, reason: BLOCK_REASON.drifting };
    const configPath = space.protocol.configPath || "/config";
    await configRateGate(space.id || space.host);
    const url = `${space.host}${configPath}`;
    try {
      const config = await request(url, { headers: tokenHeaders(token, url, { privateSpace: space.private || space.sendToken }) }, "Schema check failed", 15_000);
      const parsed = parseSpaceConfig(config);
      const currentProtocol = deriveProtocol({ config, configPath });
      const apiStillExists = space.activeApi
        ? parsed.endpoints.some((endpoint) => endpoint.apiName === space.activeApi)
        : (space.endpoints ?? []).some((old) => parsed.endpoints.some((endpoint) => endpoint.apiName === old.apiName));
      const protocolMatches = currentProtocol.mode === space.protocol.mode && currentProtocol.base === space.protocol.base;
      if (!apiStillExists || !protocolMatches) return { ok: false, reason: BLOCK_REASON.drifting };
      return { ok: true, config, endpoints: parsed.endpoints };
    } catch (error) {
      if (error.status === 404 || error.status === 405) return { ok: false, reason: BLOCK_REASON.drifting, error };
      return { ok: false, reason: error.failure === FAILURE.waking ? BLOCK_REASON.asleep : BLOCK_REASON.unknown, error };
    }
  }

  /**
   * Health ladder for one Space: hub stage -> wake -> protocol confirm.
   * Returns `{ ready, reason }`, never throws for ordinary conditions.
   */
  async function checkSpace(space, token) {
    if (!space) return { ready: false, reason: BLOCK_REASON.noSpace };
    let status;
    try {
      status = await hubStatus(space, token);
    } catch (error) {
      return { ready: false, reason: BLOCK_REASON.unknown, error };
    }
    const facts = { private: status.private, hardware: status.hardware, title: status.title, stage: status.stage };
    if (status.sleeping) {
      try {
        const woke = await wakeSpace(space, token);
        if (!woke) return { ready: false, reason: BLOCK_REASON.asleep, facts };
      } catch (error) {
        return { ready: false, reason: error.failure === FAILURE.auth ? BLOCK_REASON.auth : BLOCK_REASON.asleep, facts, error };
      }
    }
    const protocol = await confirmProtocol({ ...space, private: status.private, sendToken: space.sendToken === true }, token);
    if (!protocol.ok) return { ready: false, reason: protocol.reason, facts };
    return { ready: true, facts };
  }

  async function uploadFile({ space, plan, file, token }) {
    const form = new FormData();
    form.append("files", file, file.name);
    const attempts = [plan.uploadUrl, `${space.host}/upload`];
    let lastError;
    for (const url of attempts) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: tokenHeaders(token, url, { privateSpace: space.private || space.sendToken }),
          body: form,
        });
        if (!response.ok) throw tagError(new Error(`Upload failed (HTTP ${response.status})`), response.status);
        const body = await response.json();
        const path = Array.isArray(body) ? body[0] : body?.path ?? body?.files?.[0]?.path;
        if (!path) throw tagError(new Error("The Space upload endpoint returned no file path."), 500);
        return {
          path,
          url: /^https?:\/\//i.test(path) ? path : `${space.host}/file=${String(path).replace(/^\//, "")}`,
          orig_name: file.name,
          size: file.size,
          mime_type: file.type || "application/octet-stream",
        };
      } catch (error) {
        lastError = error;
        if (error.status && ![404, 405].includes(error.status)) break;
      }
    }
    throw lastError ?? tagError(new Error("Could not upload this file input."), 500);
  }

  /**
   * Run one job against one Space.
   * Returns `{ ok, kind, results, message }`; never throws.
   */
  async function runJob({ space, job, token, files = new Map(), signal, onProgress }) {
    const endpoint = endpointFor(space, job.apiName, { fallback: false });
    if (!endpoint) {
      return { ok: false, kind: FAILURE.protocol, message: `The endpoint /${job.apiName} is no longer in this Space's schema. Refresh and clone the job.` };
    }
    let plan;
    try {
      const values = { ...job.values };
      for (const key of job.files ?? []) {
        const file = files.get(key);
        if (!file) {
          return { ok: false, kind: FAILURE.fatal, message: `File input "${key}" is no longer in memory. Clone the job and reattach the file.` };
        }
      }
      plan = buildCallPlan({ space, endpoint, values, protocol: space.protocol, token, privateSpace: space.private || space.sendToken === true });
      for (const field of plan.fileFields) {
        const file = files.get(field.key);
        if (!file) continue;
        const uploaded = await uploadFile({ space, plan, file, token });
        const position = endpoint.fields.findIndex((item) => item.key === field.key);
        if (position >= 0) plan.data[position] = uploaded;
      }
    } catch (error) {
      const kind = error.failure ?? classifyFailure(error.status, error.message);
      return { ok: false, kind, message: error.message };
    }

    const timer = withTimeout(GEN_TIMEOUT_MS, signal);
    try {
      if (plan.mode === "predict" || plan.mode === "legacy") {
        const body = plan.mode === "legacy"
          ? { data: plan.data, fn_index: endpoint.fnIndex }
          : { data: plan.data };
        const payload = await requestRaw(plan.url, {
          method: "POST",
          headers: plan.headers,
          body: JSON.stringify(body),
        }, "Generation failed", timer.signal);
        if (payload?.error || payload?.success === false) throw tagError(new Error(errorMessage(payload)), 500);
        return { ok: true, results: toResults(payload?.data ?? payload?.output?.data ?? payload, space.host) };
      }

      const accepted = await requestRaw(plan.url, {
        method: "POST",
        headers: plan.headers,
        body: JSON.stringify({ data: plan.data, session_hash: safeId("s") }),
      }, "Generation failed", timer.signal);
      if (accepted?.error || accepted?.success === false) throw tagError(new Error(errorMessage(accepted)), 500);

      let streamUrl = null;
      if (accepted?.event_id) streamUrl = `${plan.url}/${encodeURIComponent(accepted.event_id)}`;
      else if (accepted?.data) return { ok: true, results: toResults(accepted.data, space.host) };
      else if (accepted?.output?.data) return { ok: true, results: toResults(accepted.output.data, space.host) };
      else if (typeof accepted?.event_id === "string") streamUrl = `${plan.url}/${encodeURIComponent(accepted.event_id)}`;
      if (!streamUrl) {
        return { ok: false, kind: FAILURE.protocol, message: "The Space accepted the call but returned no event stream. Refresh its schema." };
      }

      const stream = await fetchImpl(streamUrl, { headers: plan.uploadHeaders, signal: timer.signal });
      if (!stream.ok) {
        const detail = summarise(await stream.text().catch(() => ""), 400);
        throw tagError(new Error(detail || `Result stream failed (HTTP ${stream.status})`), stream.status);
      }
      const data = await readGradioStream(stream, { onProgress, events: plan.streamEvents });
      return { ok: true, results: toResults(data, space.host) };
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        return { ok: false, kind: FAILURE.transient, message: "The request timed out or was cancelled. The Space may still be working on it." };
      }
      const kind = error.failure ?? classifyFailure(error.status, error.message);
      return { ok: false, kind, message: error.message };
    } finally {
      timer.done();
    }
  }

  async function requestRaw(url, options, failureMessage, signal) {
    let response;
    try {
      response = await fetchImpl(url, signal ? { ...options, signal } : options);
    } catch (error) {
      if (isAbortError(error)) throw tagError(new Error(`${failureMessage}: the request timed out.`), 408);
      throw tagError(error);
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = summarise(await response.text(), 500);
      } catch {
        detail = "";
      }
      throw tagError(new Error(detail || `${failureMessage} (HTTP ${response.status})`), response.status);
    }
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw tagError(new Error(`${failureMessage}: the Space returned a non-JSON body.`), 502);
    }
  }

  return { hubStatus, wakeSpace, confirmProtocol, checkSpace, runJob, uploadFile };
}

