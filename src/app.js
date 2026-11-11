import { parseSpaceInput, normalizeHost, tokenHeaders } from "./lib/hosts.js";
import {
  CONFIG_PATHS, deriveProtocol, endpointFor, parseSpaceConfig, protocolConfirmUrl,
  taskFromEndpoints,
} from "./lib/protocol.js";
import {
  clampConcurrency, emptyWorkspace, exportWorkspace, makeSpace, recoverRunningJobs,
  sanitizeWorkspace, serializeWorkspace, STORAGE_KEY, upsertSpace, WORKSPACE_VERSION,
} from "./lib/state.js";
import {
  BLOCK_REASON, createRunner, describeLane, LANE, laneFor, nextLaneState, planDispatch,
} from "./lib/queue.js";
import { escapeHtml, safeId, timeAgo, fmtDate, waitForHubRequest, waitForSpaceConfigProbe } from "./lib/util.js";
import { retryDelay, FAILURE } from "./lib/protocol.js";
import { createAndroidBridgeClient } from "./lib/android-bridge.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const view = $("#view");
const dialog = $("#dialog");
const dialogContent = $("#dialog-content");
const toast = $("#toast");
const notice = $("#notice");
const pageTitle = $("#page-title");
const navCount = $("#nav-queue-count");
const accountSummary = $("#account-summary");
const accountTokens = new Map();
const nativeBridge = createAndroidBridgeClient();
const THEME_KEY = "multi-hf.theme";
const jobFiles = new Map();
const activeControllers = new Map();
const activeJobs = new Set();
const healthCache = new Map();
let toastTimer = 0;
let saveTimer = 0;
let currentTab = "queue";
let queueRunning = false;
let queuePaused = false;
let schedulerPromise = null;
const spaceRetryAfter = new Map();
let appState = loadState();
const runner = createRunner();

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!parsed) return emptyWorkspace();
    if (Array.isArray(parsed.spaces) && Array.isArray(parsed.jobs)) {
      return {
        ...emptyWorkspace(),
        ...parsed,
        spaces: parsed.spaces.map((space) => ({ ...space, health: null })),
        jobs: recoverRunningJobs(parsed.jobs),
        accounts: (parsed.accounts ?? []).map((account) => ({ ...account, connected: false })),
        settings: { ...emptyWorkspace().settings, ...(parsed.settings ?? {}) },
      };
    }
    // Previous workspace version used `models`; migrate only the non-secret
    // user data, then force each model through a fresh Space probe.
    if (Array.isArray(parsed.models)) {
      const imported = sanitizeWorkspace({
        spaces: parsed.models.map((model) => ({
          id: model.id, ref: model.ref, host: model.host, title: model.title, task: model.task,
          endpoints: model.endpoints, accountId: "", private: false, sendToken: false,
        })),
        profiles: (parsed.profiles ?? []).map((profile) => ({ ...profile, spaceId: profile.spaceId ?? profile.modelId })),
        jobs: (parsed.jobs ?? []).map((job) => ({ ...job, spaceId: job.spaceId ?? job.modelId, accountId: "" })),
        accounts: parsed.accounts ?? [],
        settings: parsed.settings ?? {},
      });
      return imported;
    }
  } catch (error) {
    console.warn("Could not load the saved workspace", error);
  }
  return emptyWorkspace();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeWorkspace(appState)));
  } catch (error) {
    showNotice(`Browser storage is full. Export your workspace and remove old results. ${error.message}`, "error");
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
}

function ping(message) {
  toast.textContent = String(message ?? "");
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3800);
}

function showNotice(message, kind = "") {
  notice.textContent = String(message ?? "");
  notice.className = `notice ${kind}`.trim();
  notice.hidden = false;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.className = "notice";
}

function showDialog(html) {
  dialogContent.innerHTML = html;
  if (!dialog.open) dialog.showModal();
  $$('[data-close]', dialogContent).forEach((button) => button.addEventListener("click", () => dialog.close()));
}

function dialogHeader(title, description = "") {
  return `<div class="dialog-header"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><button class="icon-button" type="button" data-close aria-label="Close">×</button></div>`;
}

function accountFor(id) {
  return appState.accounts.find((account) => account.id === id);
}
function spaceFor(id) {
  return appState.spaces.find((space) => space.id === id);
}
function jobFor(id) {
  return appState.jobs.find((job) => job.id === id);
}
function connectedAccounts() {
  return appState.accounts.filter((account) => account.connected && accountTokens.has(account.id) && account.enabled !== false);
}
function queueCount() {
  return appState.jobs.filter((job) => ["ready", "running"].includes(job.status)).length;
}
function laneForView(space) {
  const active = [...activeJobs].find((jobId) => jobFor(jobId)?.spaceId === space.id);
  if (active) return { spaceId: space.id, status: LANE.busy, jobId: active };
  return space.health?.lane ?? laneFor({}, space.id);
}

function render() {
  const labels = {
    queue: "Job queue", spaces: "Spaces", jobs: "Job history", profiles: "Profiles", accounts: "Accounts",
  };
  pageTitle.textContent = labels[currentTab] ?? "Multi-HF";
  $$('[data-tab]').forEach((button) => button.classList.toggle("active", button.dataset.tab === currentTab));
  navCount.textContent = String(queueCount());
  const connected = connectedAccounts().length;
  accountSummary.textContent = connected ? `${connected} connected` : "No account connected";
  if (currentTab === "queue") renderQueue();
  else if (currentTab === "spaces") renderSpaces();
  else if (currentTab === "jobs") renderJobs();
  else if (currentTab === "profiles") renderProfiles();
  else if (currentTab === "accounts") renderAccounts();
  else if (currentTab === "debug") renderDebug();
  else renderQueue();
}

function stat(label, value, detail) {
  return `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function statusBadge(status) {
  const labels = { ready: "READY", running: "RUNNING", done: "DONE", failed: "FAILED", paused: "PAUSED" };
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(labels[status] ?? status ?? "UNKNOWN")}</span>`;
}

function renderQueue() {
  const ready = appState.jobs.filter((job) => job.status === "ready").length;
  const running = activeJobs.size;
  const done = appState.jobs.filter((job) => job.status === "done").length;
  const paused = appState.jobs.filter((job) => job.status === "paused").length;
  const jobs = appState.jobs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
  const cards = jobs.map((job) => jobCard(job)).join("");
  view.innerHTML = `
    <section class="stats">${stat("Ready", ready, "Waiting for a free Space")}${stat("Running", running, "One job per Space")}${stat("Completed", done, "Saved in this browser")}${stat("Paused", paused, "Needs a decision")}</section>
    <section class="panel queue-controls">
      <div><h2>Batch queue</h2><p>Spaces run independently. A Space runs one job at a time; different Spaces can run in parallel.</p></div>
      <div class="button-row"><button class="button secondary" id="queue-pause">${queuePaused ? "Resume queue" : "Pause queue"}</button><button class="button primary" id="queue-run">Run ready jobs</button><button class="button" id="queue-add">＋ Add job</button></div>
      <div class="queue-meta"><span>${queueRunning ? "Scheduler active" : "Scheduler idle"}</span><span>Parallel Spaces: ${escapeHtml(appState.settings.maxParallelSpaces)}</span><label class="inline-select">Limit <select id="parallel-limit"><option value="1" ${appState.settings.maxParallelSpaces === 1 ? "selected" : ""}>1</option><option value="2" ${appState.settings.maxParallelSpaces === 2 ? "selected" : ""}>2</option><option value="3" ${appState.settings.maxParallelSpaces === 3 ? "selected" : ""}>3</option><option value="4" ${appState.settings.maxParallelSpaces === 4 ? "selected" : ""}>4</option></select></label></div>
    </section>
    <section class="panel"><div class="section-heading"><div><h2>Queue and recent jobs</h2><p>Queue state is saved locally; uploaded files must be reattached after a refresh.</p></div><button class="button" id="jobs-clear">Clear completed</button></div>
      ${cards || `<div class="empty"><span>▦</span><h3>No jobs yet</h3><p>Add a Space, then create jobs from a discovered endpoint.</p><button class="button primary" id="queue-empty-add">＋ Create first job</button></div>`}
    </section>`;
  $("#queue-run")?.addEventListener("click", () => startQueue());
  $("#queue-pause")?.addEventListener("click", toggleQueue);
  $("#queue-add")?.addEventListener("click", () => openNewJob());
  $("#queue-empty-add")?.addEventListener("click", () => openNewJob());
  $("#jobs-clear")?.addEventListener("click", () => {
    appState.jobs = appState.jobs.filter((job) => job.status !== "done");
    saveState(); render(); ping("Completed jobs cleared.");
  });
  $("#parallel-limit")?.addEventListener("change", (event) => {
    appState.settings.maxParallelSpaces = clampConcurrency(event.target.value);
    saveState(); render();
  });
  bindJobButtons();
}

function jobCard(job) {
  const space = spaceFor(job.spaceId);
  const lane = space ? laneForView(space) : { status: LANE.blocked, blockedReason: BLOCK_REASON.noSpace };
  const title = job.name || job.apiName || "Generation job";
  const progress = job.status === "running" && Number.isFinite(job.progress)
    ? `<div class="progress"><span style="width:${Math.max(0, Math.min(100, job.progress * 100))}%"></span></div>` : "";
  const error = job.error ? `<p class="job-error">${escapeHtml(job.error)}</p>` : "";
  const action = ["failed", "paused"].includes(job.status)
    ? `<button class="button small" data-job-retry="${escapeHtml(job.id)}">Retry</button>` : "";
  return `<article class="job-card">
    <div class="job-main"><div class="job-top"><strong>${escapeHtml(title)}</strong>${statusBadge(job.status)}</div>
      <div class="job-sub"><span>${escapeHtml(space?.title ?? "Missing Space")}</span><span>/ ${escapeHtml(job.apiName)}</span><span>${escapeHtml(fmtDate(job.updatedAt || job.createdAt))}</span></div>
      <div class="lane-line"><span class="dot ${escapeHtml(lane.status)}"></span><span>${escapeHtml(space ? describeLane(lane) : "Space missing")}</span>${progress}</div>${error}
    </div>
    <div class="job-actions"><button class="button small" data-job-open="${escapeHtml(job.id)}">Details</button>${action}</div>
  </article>`;
}

function renderSpaces() {
  const cards = appState.spaces.map((space) => {
    const lane = laneForView(space);
    const protocol = space.protocol ? `${space.protocol.mode} · ${space.protocol.base || "/"}` : "Not probed";
    const needsProbe = space.needsProbe || !space.protocol;
    return `<article class="space-card">
      <div class="space-top"><div><div class="eyebrow">${escapeHtml(String(space.task).toUpperCase())} · ${space.endpoints.length} endpoint(s)</div><h3>${escapeHtml(space.title)}</h3><p class="muted">${escapeHtml(space.ref || space.host)}</p></div>${statusBadge(needsProbe ? "paused" : lane.status === "busy" ? "running" : "ready")}</div>
      <div class="space-details"><span><b>Protocol</b> ${escapeHtml(protocol)}</span><span><b>Queue lane</b> ${escapeHtml(describeLane(lane))}</span><span><b>Last probe</b> ${space.probedAt ? escapeHtml(timeAgo(space.probedAt)) : "Required"}</span></div>
      ${space.needsProbe ? `<p class="warning-text">Imported/updated Space. Re-probe before running; private status and API details are never trusted from a workspace file.</p>` : ""}
      <div class="button-row"><button class="button primary" data-space-job="${escapeHtml(space.id)}">New job</button><button class="button" data-space-probe="${escapeHtml(space.id)}">Probe / refresh</button><button class="button" data-space-toggle-token="${escapeHtml(space.id)}">${space.sendToken ? "Disable token" : "Allow token"}</button><button class="button danger" data-space-remove="${escapeHtml(space.id)}">Remove</button></div>
    </article>`;
  }).join("");
  view.innerHTML = `<section class="panel section-heading"><div><h2>Spaces and models</h2><p>Each Space stores its own schema and verified Gradio protocol. Imported trust flags are discarded.</p></div><button class="button primary" id="space-add">＋ Add Space</button></section>
  <section class="space-grid">${cards || `<div class="empty"><span>◇</span><h3>No Spaces discovered</h3><p>Add a Hugging Face Space ID or URL to inspect its API.</p><button class="button primary" id="space-empty-add">Discover a Space</button></div>`}</section>`;
  $("#space-add")?.addEventListener("click", () => openAddSpace());
  $("#space-empty-add")?.addEventListener("click", () => openAddSpace());
  $$('[data-space-job]').forEach((button) => button.addEventListener("click", () => openNewJob(button.dataset.spaceJob)));
  $$('[data-space-probe]').forEach((button) => button.addEventListener("click", () => discoverSpace(button.dataset.spaceProbe)));
  $$('[data-space-toggle-token]').forEach((button) => button.addEventListener("click", () => {
    const space = spaceFor(button.dataset.spaceToggleToken);
    if (!space) return;
    if (!space.sendToken && !space.private && !confirm("This will send your selected account's token to the Space owner. Only do this when you trust that owner.")) return;
    space.sendToken = !space.sendToken; saveState(); render();
  }));
  $$('[data-space-remove]').forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.spaceRemove;
    if (!confirm("Remove this Space? Its job history will remain but cannot be run.")) return;
    appState.spaces = appState.spaces.filter((space) => space.id !== id);
    appState.profiles = appState.profiles.filter((profile) => profile.spaceId !== id);
    saveState(); render();
  }));
}

function renderJobs() {
  const jobs = appState.jobs.slice().sort((a, b) => b.createdAt - a.createdAt);
  view.innerHTML = `<section class="panel section-heading"><div><h2>Job history</h2><p>${jobs.length} stored job(s). Results and prompt values stay in this browser.</p></div><button class="button primary" id="jobs-new">＋ New job</button></section>
  <section class="panel">${jobs.map(jobCard).join("") || `<div class="empty"><h3>No saved jobs</h3><p>Jobs created from Space endpoints appear here.</p></div>`}</section>`;
  $("#jobs-new")?.addEventListener("click", () => openNewJob());
  bindJobButtons();
}

function renderProfiles() {
  const rows = appState.profiles.map((profile) => {
    const space = spaceFor(profile.spaceId);
    return `<article class="profile-row"><div><strong>${escapeHtml(profile.name)}</strong><p>${escapeHtml(space?.title ?? profile.spaceId)} · /${escapeHtml(profile.apiName)}</p></div><div class="button-row"><button class="button small" data-profile-use="${escapeHtml(profile.id)}">Use</button><button class="button small danger" data-profile-remove="${escapeHtml(profile.id)}">Delete</button></div></article>`;
  }).join("");
  view.innerHTML = `<section class="panel"><h2>Reusable profiles</h2><p>Profiles store endpoint values; they do not store access tokens or local file contents.</p>${rows || `<div class="empty"><h3>No profiles yet</h3><p>Enable “Save profile” from the job form.</p></div>`}</section>`;
  $$('[data-profile-use]').forEach((button) => button.addEventListener("click", () => {
    const profile = appState.profiles.find((item) => item.id === button.dataset.profileUse);
    if (profile) openNewJob(profile.spaceId, profile);
  }));
  $$('[data-profile-remove]').forEach((button) => button.addEventListener("click", () => {
    appState.profiles = appState.profiles.filter((profile) => profile.id !== button.dataset.profileRemove);
    saveState(); render(); ping("Profile deleted.");
  }));
}

function renderAccounts() {
  const accounts = appState.accounts.map((account) => `<article class="account-row"><div><div class="job-top"><strong>${escapeHtml(account.label)}</strong>${account.connected && accountTokens.has(account.id) ? statusBadge("ready") : statusBadge("paused")}</div><p>${escapeHtml(account.username ? `@${account.username}` : "Username not verified")} · ${account.connected ? "Token available for this tab" : "Reconnect after page refresh"}</p></div>
    <div class="button-row"><button class="button small" data-account-connect="${escapeHtml(account.id)}">${account.connected ? "Replace token" : "Connect"}</button><button class="button small" data-account-disable="${escapeHtml(account.id)}">${account.enabled ? "Disable" : "Enable"}</button><button class="button small danger" data-account-remove="${escapeHtml(account.id)}">Remove</button></div></article>`).join("");
  view.innerHTML = `<section class="panel"><div class="section-heading"><div><h2>Hugging Face accounts</h2><p>Your Hugging Face token is never stored on disk or in exports. You will need to re-enter it after refreshing the page; tokens remain in memory for this tab only. A token is sent to the Hub for discovery and to a private Space only when the Hub confirms its privacy. Public Space token sharing requires a separate opt-in.</p></div><button class="button primary" id="account-add">＋ Connect account</button></div>
  <div class="notice warning">Use a fine-grained token with minimum permissions. Connecting a token does not grant every public Space permission to receive it. Your Hugging Face token is never stored on disk. You will need to re-enter it after refreshing the page.</div>
  ${accounts || `<div class="empty"><h3>No account connected</h3><p>Public Spaces can be tested without an account.</p></div>`}</section>`;
  $("#account-add")?.addEventListener("click", () => openAccountDialog());
  $$('[data-account-connect]').forEach((button) => button.addEventListener("click", () => openAccountDialog(accountFor(button.dataset.accountConnect))));
  $$('[data-account-disable]').forEach((button) => button.addEventListener("click", () => {
    const account = accountFor(button.dataset.accountDisable); if (!account) return;
    account.enabled = !account.enabled; if (!account.enabled) accountTokens.delete(account.id); account.connected = accountTokens.has(account.id); saveState(); render();
  }));
  $$('[data-account-remove]').forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.accountRemove;
    accountTokens.delete(id); appState.accounts = appState.accounts.filter((account) => account.id !== id);
    saveState(); render(); ping("Account removed.");
  }));
}

function bindJobButtons() {
  $$('[data-job-open]').forEach((button) => button.addEventListener("click", () => openJobDetails(button.dataset.jobOpen)));
  $$('[data-job-retry]').forEach((button) => button.addEventListener("click", () => retryJob(button.dataset.jobRetry)));
}

function retryJob(id) {
  const job = jobFor(id); if (!job) return;
  if (!spaceFor(job.spaceId)) { ping("The Space was removed. Add it again before retrying."); return; }
  job.status = "ready"; job.error = ""; job.attempts = 0; job.updatedAt = Date.now();
  const space = spaceFor(job.spaceId);
  if (space?.health?.lane?.status === LANE.blocked) space.health.lane = laneFor({}, space.id);
  saveState(); render(); ping("Job returned to the queue.");
  if (queueRunning && !queuePaused) scheduleQueue();
}

function renderResultItems(results) {
  return (results ?? []).map((item, index) => {
    const label = escapeHtml(item.label || "Output");
    const url = escapeHtml(item.url || "");
    const save = `<button class="button small" type="button" data-save-index="${index}">${canSaveNatively() ? "Save" : "Save"}</button>`;
    if (item.kind === "image" && url) {
      return `<figure class="result-item"><img loading="lazy" src="${url}" alt="${label}"><figcaption><span>${label}</span>${save}</figcaption></figure>`;
    }
    if (item.kind === "video" && url) {
      return `<figure class="result-item"><video controls preload="metadata" src="${url}"></video><figcaption><span>${label}</span>${save}</figcaption></figure>`;
    }
    if (item.kind === "audio" && url) {
      return `<figure class="result-item"><audio controls preload="none" src="${url}"></audio><figcaption><span>${label}</span>${save}</figcaption></figure>`;
    }
    if (url) return `<div class="result-file"><span>${label}</span>${save}</div>`;
    return `<div class="result-text"><strong>${label}</strong><pre>${escapeHtml(item.text || "")}</pre></div>`;
  }).join("") || `<div class="empty"><p>No outputs were returned.</p></div>`;
}

/** The APK exposes an asynchronous bridge; browsers use normal download links. */
function androidBridge() {
  return nativeBridge.available ? nativeBridge : null;
}
function canSaveNatively() {
  return Boolean(androidBridge());
}

function showBusyToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = String(message ?? "Saving…");
  toast.classList.add("show");
  return () => {
    clearTimeout(toastTimer);
    toast.classList.remove("show");
  };
}

async function saveThroughAndroid(fileName, mimeType, payload, isBase64 = true) {
  const bridge = androidBridge();
  if (!bridge) return false;
  const hideBusy = showBusyToast(`Saving ${fileName}…`);
  let message = "Save failed.";
  let success = false;
  try {
    const permission = await bridge.requestStoragePermission();
    if (!permission.ok) {
      message = permission.message || "Storage permission was not granted.";
      return false;
    }
    const result = isBase64
      ? await bridge.saveBase64(fileName, mimeType, payload)
      : await bridge.saveUrl(fileName, mimeType, payload);
    success = result.ok;
    message = success
      ? (result.message || `Saved ${fileName} to Downloads.`)
      : `Save failed: ${result.message || "Unknown Android bridge error."}`;
    return success;
  } catch (error) {
    message = `Save failed: ${error?.message || error}`;
    return false;
  } finally {
    hideBusy();
    ping(message);
  }
}

function fileNameFor(item, index) {
  const label = String(item.label || "output").replace(/[^\w.-]+/g, "_").slice(0, 60) || "output";
  const extension = (() => {
    try {
      const path = new URL(item.url).pathname;
      const match = /\.([a-z0-9]{2,5})$/i.exec(path);
      if (match) return `.${match[1].toLowerCase()}`;
    } catch { /* data: URL */ }
    return item.kind === "video" ? ".mp4" : item.kind === "audio" ? ".mp3" : item.kind === "image" ? ".png" : ".bin";
  })();
  return `${label}-${index + 1}${extension}`;
}

async function saveResult(item, index) {
  const bridge = androidBridge();
  const name = fileNameFor(item, index);
  const mime = item.kind === "video" ? "video/mp4" : item.kind === "audio" ? "audio/mpeg" : item.kind === "image" ? "image/png" : "application/octet-stream";
  if (!bridge) {
    const anchor = document.createElement("a");
    anchor.href = item.url;
    anchor.download = name;
    anchor.rel = "noopener noreferrer";
    anchor.target = "_blank";
    anchor.click();
    return;
  }
  if (item.url.startsWith("data:")) {
    const comma = item.url.indexOf(",");
    if (comma < 0 || !/;base64/i.test(item.url.slice(0, comma))) {
      ping("Save failed: this inline output is not base64 encoded.");
      return;
    }
    await saveThroughAndroid(name, mime, item.url.slice(comma + 1), true);
    return;
  }
  await saveThroughAndroid(name, mime, item.url, false);
}

function bindSaveButtons(root, results) {
  $$('[data-save-index]', root).forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.saveIndex);
    if (Number.isFinite(index) && results[index]) saveResult(results[index], index);
  }));
}

async function openAccountDialog(existing = null) {
  showDialog(`${dialogHeader(existing ? "Reconnect account" : "Connect Hugging Face account", "The token stays in this tab's memory only.")}
    <form id="account-form" class="form-stack">
      <label>Account label<input name="label" maxlength="60" required value="${escapeHtml(existing?.label ?? "")}" placeholder="Personal account"></label>
      <label>Username (optional)<input name="username" maxlength="80" value="${escapeHtml(existing?.username ?? "")}"></label>
      <label>Access token<input name="token" type="password" autocomplete="off" required placeholder="hf_…"></label>
      <p class="muted">Use a fine-grained token with minimal permissions. Never put it in a profile, prompt, workspace file, or issue report.</p>
      <div class="button-row end"><button type="button" class="button" data-close>Cancel</button><button type="submit" class="button primary">Connect for this tab</button></div>
    </form>`);
  $("#account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const label = String(form.get("label") || "").trim();
    const username = String(form.get("username") || "").trim();
    const token = String(form.get("token") || "").trim();
    const submit = $("[type=submit]", event.currentTarget);
    submit.disabled = true; submit.textContent = "Checking token…";
    try {
      const response = await fetch("https://huggingface.co/api/whoami-v2", { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) throw new Error("Hugging Face rejected the token. Check its permissions and expiration.");
      let resolvedName = username;
      if (response.ok) {
        const body = await response.json();
        resolvedName ||= body.name ?? "";
      } else if (response.status !== 404) {
        throw new Error(`Token validation returned HTTP ${response.status}.`);
      }
      const id = existing?.id ?? safeId("account");
      const old = accountFor(id);
      const account = {
        id,
        label: label || resolvedName || "Account",
        username: resolvedName,
        enabled: true,
        connected: true,
        createdAt: old?.createdAt ?? Date.now(),
      };
      const index = appState.accounts.findIndex((item) => item.id === id);
      if (index >= 0) appState.accounts.splice(index, 1, account); else appState.accounts.push(account);
      accountTokens.set(id, token);
      appState.settings.lastAccountId = id;
      saveState(); dialog.close(); render(); ping(`Connected ${account.label} for this tab.`);
    } catch (error) {
      submit.disabled = false; submit.textContent = "Connect for this tab";
      if (/Failed to fetch|NetworkError/i.test(String(error))) {
        ping("Token validation was blocked by the network. Nothing was saved; try again in a compatible browser.");
      } else {
        showDialog(`${dialogHeader("Could not connect token")}
          <div class="notice error">${escapeHtml(error.message || "Token check failed")}</div>
          <div class="button-row end"><button class="button" data-close>Close</button></div>`);
      }
    }
  });
}

function accountChoices(preferred = "") {
  const list = [{ id: "", label: "No token / public Space" }, ...connectedAccounts().map((account) => ({ id: account.id, label: account.label }))];
  return list
    .map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === preferred ? "selected" : ""}>${escapeHtml(account.label)}</option>`)
    .join("");
}

function openAddSpace() {
  showDialog(`${dialogHeader("Discover a Space", "Read Hub metadata, the Gradio schema, and the wire protocol before adding it to the queue.")}
    <form id="space-form" class="form-stack">
      <label>Space ID or URL<input name="ref" required placeholder="owner/name or https://owner-name.hf.space"></label>
      <label>Account for private Space discovery<select name="accountId">${accountChoices(appState.settings.lastAccountId)}</select></label>
      <label>Optional label<input name="note" maxlength="120" placeholder="My model"></label>
      <label class="check-row"><input name="sendToken" type="checkbox"><span>Allow this Space to receive your token (only if you trust its owner)</span></label>
      <div class="button-row end"><button type="button" class="button" data-close>Cancel</button><button type="submit" class="button primary">Probe Space</button></div>
      <p class="muted">Public Spaces receive no token unless you opt in. A Space is treated as private only when a fresh Hub response says so, never because a file said so.</p>
    </form>`);
  $("#space-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submit = $("[type=submit]", event.currentTarget);
    submit.disabled = true; submit.textContent = "Probing…";
    try {
      const space = await discoverSpace(null, {
        ref: String(form.get("ref") ?? "").trim(),
        accountId: String(form.get("accountId") ?? ""),
        note: String(form.get("note") ?? "").trim(),
        sendToken: form.get("sendToken") === "on",
      });
      dialog.close(); currentTab = "spaces"; render();
      ping(`Discovered ${space.title} with ${space.endpoints.length} endpoint(s).`);
    } catch (error) {
      submit.disabled = false; submit.textContent = "Probe Space";
      let box = $("#dialog-error", dialogContent);
      if (!box) {
        box = document.createElement("div");
        box.id = "dialog-error";
        box.className = "notice error";
        $("#space-form").prepend(box);
      }
      box.textContent = error.message || "Space discovery failed.";
    }
  });
}

async function fetchJson(url, { token, privateSpace = false, timeout = 30_000 } = {}) {
  const target = new URL(url);
  if (["huggingface.co", "www.huggingface.co", "hf.co"].includes(target.hostname.toLowerCase())) {
    await waitForHubRequest("hub");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: tokenHeaders(token, url, { privateSpace }), signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      const error = new Error(detail || `HTTP ${response.status} from ${new URL(url).host}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function tokenFor(accountId) {
  if (!accountId) return null;
  const account = accountFor(accountId);
  if (!account || account.enabled === false) return null;
  return accountTokens.get(accountId) ?? null;
}

async function discoverSpace(existingId = null, options = {}) {
  clearNotice();
  const old = existingId ? spaceFor(existingId) : null;
  const ref = options.ref || old?.ref || old?.host || existingId;
  const parsed = parseSpaceInput(ref);
  const accountId = options.accountId ?? old?.accountId ?? appState.settings.lastAccountId ?? "";
  const token = tokenFor(accountId);
  const sendToken = options.sendToken ?? old?.sendToken ?? false;

  let id = parsed.id ?? (old && !parsed.host ? old.id : "");
  let host = parsed.host;

  let metadata = null;
  if (id) {
    const metadataUrl = `https://huggingface.co/api/spaces/${id.split("/").map(encodeURIComponent).join("/")}`;
    metadata = await fetchJson(metadataUrl, { token });
    host = normalizeHost(metadata.host)
      || normalizeHost(metadata.subdomain ? `https://${metadata.subdomain}.hf.space` : "")
      || host;
    if (!host) throw new Error("The Hub did not return a valid *.hf.space host. Check that the Space exists and is visible to this account.");
  }
  if (!host) throw new Error("Could not resolve a Space host from that input.");

  // A token is offered here only when the Host says the Space is private, or the
  // user explicitly opted in for this Space.
  const privateSpace = metadata?.private === true;
  const allowToken = privateSpace || sendToken;

  await waitForSpaceConfigProbe(id || host);
  let config = null;
  let configPath = "";
  let lastError = null;
  for (const path of CONFIG_PATHS) {
    try {
      config = await fetchJson(`${host}${path}`, { token, privateSpace: allowToken });
      configPath = path;
      break;
    } catch (error) {
      lastError = error;
      if (![404, 405].includes(error.status)) break;
    }
  }
  if (!config) {
    throw new Error(`${lastError?.message || "Could not read this Space's config."} Check that the Space is running, that the account can see a private Space, and whether its CORS settings allow this origin.`);
  }

  const schema = parseSpaceConfig(config);
  const derived = deriveProtocol({ config, configPath });
  let verified = derived.verified;
  if (!verified) {
    // Only an unversioned, prefixless config lands here. Confirm it with one cheap
    // request; if that fails the Space is added but stays un-probed so the queue
    // refuses to dispatch against a guessed contract.
    try {
      await fetchJson(protocolConfirmUrl(host, derived), { token, privateSpace: allowToken, timeout: 15_000 });
      verified = true;
    } catch {
      verified = false;
    }
  }

  const space = makeSpace({
    id: id || old?.id || host,
    ref: id ? `${id}` : "",
    host,
    title: options.note || old?.note || schema.title || metadata?.cardData?.title || id || host,
    note: options.note || old?.note || "",
    task: taskFromEndpoints(schema.endpoints),
    accountId,
    private: privateSpace,
    sendToken,
    endpoints: schema.endpoints,
    activeApi: schema.endpoints[0]?.apiName ?? "",
    protocol: { ...derived, verified, configPath },
    needsProbe: !verified,
    probedAt: Date.now(),
    fetchedAt: Date.now(),
  });
  space.hardware = metadata?.runtime?.hardware?.current ?? metadata?.runtime?.hardware ?? "Unknown";
  space.stage = String(metadata?.runtime?.stage ?? "UNKNOWN").toUpperCase();
  space.health = { lane: laneFor({}, space.id), checkedAt: Date.now(), stage: space.stage };

  appState.spaces = upsertSpace(appState.spaces, space);
  if (accountId) appState.settings.lastAccountId = accountId;
  healthCache.delete(space.id);
  saveState();
  return space;
}

function fieldMarkup(field, value) {
  if (field.hidden) return "";
  const id = `field-${field.key}`;
  const label = escapeHtml(field.label || field.key);
  const hint = field.hint ? `<small>${escapeHtml(field.hint)}</small>` : "";
  const common = `id="${escapeHtml(id)}" data-key="${escapeHtml(field.key)}"`;
  if (field.type === "checkbox") {
    const checked = value === true || (value == null && field.defaultValue === true);
    return `<div class="field"><label class="check-row"><input ${common} type="checkbox" ${checked ? "checked" : ""}><span>${label}</span></label>${hint}</div>`;
  }
  if (field.type === "checkboxgroup") {
    const chosen = Array.isArray(value) ? value.map(String) : Array.isArray(field.defaultValue) ? field.defaultValue.map(String) : [];
    const choices = (field.choices ?? [])
      .map((choice) => `<label class="check-row"><input type="checkbox" data-key="${escapeHtml(field.key)}" value="${escapeHtml(choice.value)}" ${chosen.includes(choice.value) ? "checked" : ""}><span>${escapeHtml(choice.label)}</span></label>`)
      .join("");
    return `<div class="field"><label>${label}</label>${choices || `<small>No choices detected.</small>`}${hint}</div>`;
  }
  let input = "";
  if (field.type === "textarea") {
    input = `<textarea ${common} rows="4" placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(value ?? field.defaultValue ?? "")}</textarea>`;
  } else if (["select", "radio"].includes(field.type)) {
    const current = value ?? field.defaultValue;
    const choices = (field.choices ?? [])
      .map((choice) => `<option value="${escapeHtml(choice.value)}" ${String(current ?? "") === choice.value ? "selected" : ""}>${escapeHtml(choice.label)}</option>`)
      .join("");
    input = `<select ${common}>${choices || `<option value="">No choices detected</option>`}</select>`;
  } else if (field.type === "slider") {
    const current = value ?? field.defaultValue ?? field.min ?? 0;
    input = `<input ${common} type="range" min="${escapeHtml(field.min ?? 0)}" max="${escapeHtml(field.max ?? 100)}" step="${escapeHtml(field.step ?? 1)}" value="${escapeHtml(current)}"><output data-output-for="${escapeHtml(id)}">${escapeHtml(current)}</output>`;
  } else if (field.type === "number") {
    input = `<input ${common} type="number" ${field.min != null ? `min="${escapeHtml(field.min)}"` : ""} ${field.max != null ? `max="${escapeHtml(field.max)}"` : ""} step="${escapeHtml(field.step ?? "any")}" value="${escapeHtml(value ?? field.defaultValue ?? "")}">`;
  } else if (["image", "video", "audio", "file"].includes(field.type)) {
    const accept = field.type === "image" ? "image/*"
      : field.type === "video" ? "video/*"
        : field.type === "audio" ? "audio/*"
          : "image/*,video/*,audio/*,application/octet-stream";
    input = `<input ${common} type="file" accept="${accept}"><small>The file stays in this tab and is uploaded to this Space when the job runs.</small>`;
  } else {
    input = `<input ${common} type="text" value="${escapeHtml(value ?? field.defaultValue ?? "")}" placeholder="${escapeHtml(field.placeholder || "")}">`;
  }
  return `<div class="field"><label for="${escapeHtml(id)}">${label}</label>${input}${hint}</div>`;
}

function collectValues(form, endpoint, fileMap) {
  const values = {};
  for (const field of endpoint.fields) {
    if (field.hidden) {
      values[field.key] = field.passthrough ?? field.defaultValue ?? null;
      continue;
    }
    const inputs = $$(`[data-key="${CSS.escape(field.key)}"]`, form);
    if (!inputs.length) continue;
    const input = inputs[0];
    if (field.type === "checkboxgroup") {
      values[field.key] = inputs.filter((item) => item.checked).map((item) => item.value);
    } else if (["image", "video", "audio", "file"].includes(field.type)) {
      const file = input.files?.[0];
      if (file) fileMap.set(field.key, file);
      values[field.key] = file ? { name: file.name, size: file.size, mime: file.type } : null;
    } else if (field.type === "checkbox") {
      values[field.key] = input.checked;
    } else if (field.type === "number" || field.type === "slider") {
      values[field.key] = input.value === "" ? null : Number(input.value);
    } else {
      values[field.key] = input.value;
    }
  }
  return values;
}

function openNewJob(spaceId = null, profile = null) {
  if (!appState.spaces.length) { currentTab = "spaces"; render(); openAddSpace(); return; }
  const space = spaceFor(spaceId || profile?.spaceId) || appState.spaces[0];
  if (space.needsProbe || !space.protocol) {
    showNotice("Probe this Space before creating jobs; its wire contract is not verified yet.", "warning");
    currentTab = "spaces"; render();
    return;
  }
  const endpoint = endpointFor(space, profile?.apiName || space.activeApi);
  if (!endpoint) { ping("This Space has no runnable endpoint. Probe it again."); return; }
  const fileMap = new Map();
  showDialog(`${dialogHeader("Create job", "A job belongs to one Space and endpoint. Different Spaces run in parallel.")}
    <form id="job-form" class="form-stack">
      <label>Job name<input name="name" maxlength="120" value="${escapeHtml(profile?.name || "")}" placeholder="Optional label"></label>
      <label>Space<select id="job-space" name="spaceId">${appState.spaces.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === space.id ? "selected" : ""}>${escapeHtml(item.title)} · ${escapeHtml(item.task)}</option>`).join("")}</select></label>
      <label>Endpoint<select id="job-api" name="apiName" data-space-id="${escapeHtml(space.id)}">${space.endpoints.map((item) => `<option value="${escapeHtml(item.apiName)}" ${item.apiName === endpoint.apiName ? "selected" : ""}>/${escapeHtml(item.apiName)}</option>`).join("")}</select></label>
      <label>Account<select name="accountId">${accountChoices(profile?.accountId || space.accountId || appState.settings.lastAccountId || "")}</select></label>
      <div id="job-fields" class="dynamic-fields"></div>
      <label class="check-row"><input type="checkbox" id="job-save-profile"><span>Save these parameters as a profile</span></label>
      <div id="job-profile-name-wrap" class="field" hidden><label for="job-profile-name">Profile name</label><input id="job-profile-name" maxlength="120" value="${escapeHtml(profile?.name || "")}"></div>
      <div class="button-row end"><button type="button" class="button" data-close>Cancel</button><button type="submit" class="button primary">Add to queue</button></div>
    </form>`);

  const form = $("#job-form");
  const spaceSelect = $("#job-space", form);
  const apiSelect = $("#job-api", form);
  const fieldsBox = $("#job-fields", form);

  const refill = () => {
    const chosen = spaceFor(spaceSelect.value);
    const selected = endpointFor(chosen, apiSelect.value, { fallback: false });
    if (!chosen || !selected) {
      fieldsBox.innerHTML = `<p class="muted">No runnable endpoint selected.</p>`;
      return;
    }
    const values = profile && profile.spaceId === chosen.id && profile.apiName === selected.apiName ? profile.values : {};
    fieldsBox.innerHTML = selected.fields.filter((field) => !field.hidden).map((field) => fieldMarkup(field, values?.[field.key])).join("")
      || `<p class="muted">This endpoint exposes no supported visible inputs.</p>`;
    $$('input[type="range"]', fieldsBox).forEach((input) => input.addEventListener("input", () => {
      const output = $(`[data-output-for="${CSS.escape(input.id)}"]`, fieldsBox);
      if (output) output.textContent = input.value;
    }));
  };

  spaceSelect.addEventListener("change", () => {
    const chosen = spaceFor(spaceSelect.value);
    apiSelect.innerHTML = (chosen?.endpoints ?? []).map((item) => `<option value="${escapeHtml(item.apiName)}">/${escapeHtml(item.apiName)}</option>`).join("");
    refill();
  });
  apiSelect.addEventListener("change", refill);
  refill();

  $("#job-save-profile", form).addEventListener("change", (event) => {
    $("#job-profile-name-wrap", form).hidden = !event.target.checked;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const chosen = spaceFor(spaceSelect.value);
    const selected = endpointFor(chosen, apiSelect.value, { fallback: false });
    if (!chosen || chosen.needsProbe || !selected) {
      ping("Choose a probed Space and a valid endpoint.");
      return;
    }
    const values = collectValues(form, selected, fileMap);
    const data = new FormData(form);
    const id = safeId("job");
    const name = String(data.get("name") || values.prompt || selected.apiName).trim() || "Generation job";
    const job = {
      id,
      name,
      spaceId: chosen.id,
      apiName: selected.apiName,
      accountId: String(data.get("accountId") || ""),
      values,
      files: [...fileMap.keys()],
      status: "ready",
      error: "",
      attempts: 0,
      result: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    appState.jobs.push(job);
    if (fileMap.size) jobFiles.set(id, fileMap);
    if ($("#job-save-profile", form).checked) {
      const profileName = String($("#job-profile-name", form).value || name).trim();
      if (profileName) {
        const existing = appState.profiles.find((item) => item.spaceId === chosen.id && item.name === profileName);
        const record = {
          id: existing?.id || safeId("profile"),
          name: profileName,
          spaceId: chosen.id,
          apiName: selected.apiName,
          values: JSON.parse(JSON.stringify(values)),
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        if (existing) Object.assign(existing, record); else appState.profiles.push(record);
      }
    }
    saveState(); dialog.close(); currentTab = "queue"; render(); ping("Job added to the queue.");
  });
}

function openJobDetails(id) {
  const job = jobFor(id); if (!job) return;
  const space = spaceFor(job.spaceId);
  showDialog(`${dialogHeader(job.name, `${space?.title ?? "Missing Space"} · /${job.apiName}`)}
    <div class="detail-grid"><div><b>Status</b>${statusBadge(job.status)}</div><div><b>Created</b>${escapeHtml(fmtDate(job.createdAt))}</div><div><b>Attempts</b>${escapeHtml(job.attempts ?? 0)}</div></div>
    ${job.error ? `<div class="notice error">${escapeHtml(job.error)}</div>` : ""}
    <section><h3>Results</h3><div class="result-grid" id="detail-results">${renderResultItems(job.result)}</div></section>
    <section class="values-block"><h3>Parameters</h3><pre>${escapeHtml(JSON.stringify(job.values, null, 2))}</pre></section>
    <div class="button-row end">${["paused", "failed"].includes(job.status) ? `<button class="button primary" id="detail-retry">Retry</button>` : ""}<button class="button" id="detail-clone">Clone</button><button class="button" data-close>Close</button></div>`);
  bindSaveButtons($("#detail-results", dialogContent), job.result ?? []);
  $("#detail-retry")?.addEventListener("click", () => { dialog.close(); retryJob(id); });
  $("#detail-clone")?.addEventListener("click", () => { dialog.close(); openNewJob(job.spaceId, { spaceId: job.spaceId, apiName: job.apiName, values: job.values, name: job.name }); });
}

function progressFor(jobId, progress) {
  const job = jobFor(jobId); if (!job) return;
  if (Number.isFinite(progress?.progress)) job.progress = progress.progress;
  job.updatedAt = Date.now(); saveSoon();
  if (currentTab === "queue") render();
}

function blockSpace(space, reason, message) {
  const old = laneFor(space.health?.lanes ?? {}, space.id);
  const blockedReason = reason || BLOCK_REASON.unknown;
  space.health = {
    ...(space.health ?? {}),
    lane: { ...old, status: LANE.blocked, blockedReason, updatedAt: Date.now() },
    message: message || "",
    checkedAt: Date.now(),
  };
}

function clearSpaceBlock(space) {
  space.health = { ...(space.health ?? {}), lane: laneFor({}, space.id), message: "", checkedAt: Date.now() };
}

async function checkSpaceCached(space, token) {
  const cached = healthCache.get(space.id);
  if (cached && Date.now() - cached.at < 90_000 && cached.ready) return cached.result;
  const result = await runner.checkSpace(space, token);
  if (result.ready) {
    // The runner obtains a fresh `private` bit from the Hub; persist it only as
    // a transient fact used during this app session, not as authority on import.
    space.private = result.facts?.private === true;
    space.hardware = result.facts?.hardware ?? space.hardware;
    space.stage = result.facts?.stage ?? space.stage;
    clearSpaceBlock(space);
    healthCache.set(space.id, { at: Date.now(), ready: true, result });
    saveSoon();
  } else {
    const reason = result.reason || BLOCK_REASON.unknown;
    blockSpace(space, reason, result.error?.message || "Space health check did not pass.");
    healthCache.set(space.id, { at: Date.now(), ready: false, result });
  }
  return result;
}

function getJobToken(job, space) {
  const account = accountFor(job.accountId || space.accountId || appState.settings.lastAccountId);
  if (!account || account.enabled === false) return { account, token: null, error: "" };
  const token = accountTokens.get(account.id);
  if (!token) return { account, token: null, error: `Reconnect account “${account.label}” in this browser tab.` };
  return { account, token, error: "" };
}

function resolveTokenForJob(job, space) {
  const { token, error } = getJobToken(job, space);
  if (error && (space.private || space.sendToken)) return { token: null, error };
  if (space.private && !token) return { token: null, error: "This Space is private. Connect an account with access before running the job." };
  return { token: space.private || space.sendToken ? token : null, error: "" };
}

async function runOne(job) {
  const space = spaceFor(job.spaceId);
  if (!space) {
    job.status = "failed"; job.error = "The Space for this job is missing."; job.updatedAt = Date.now(); saveState(); return;
  }
  if (space.needsProbe || !space.protocol) {
    job.status = "paused"; job.error = "Re-probe this Space before running jobs."; job.updatedAt = Date.now(); saveState(); return;
  }
  // Keep the selected credential available for the Hub metadata check even
  // when the Space is currently believed public. The runner sends it to the Hub
  // only; its Space-host request still obeys private/explicit-consent policy.
  const credential = getJobToken(job, space);
  if (credential.error && (space.private || space.sendToken)) {
    job.status = "paused"; job.error = credential.error; job.updatedAt = Date.now();
    blockSpace(space, BLOCK_REASON.auth, credential.error); saveState(); return;
  }
  const health = await checkSpaceCached(space, credential.token);
  if (!health.ready) {
    const reason = health.reason || BLOCK_REASON.unknown;
    job.status = "paused";
    job.error = health.error?.message || `Space is not ready (${reason}).`;
    job.updatedAt = Date.now();
    saveState();
    return;
  }
  // The Hub's fresh privacy result may differ from an old workspace snapshot.
  const token = resolveTokenForJob(job, space);
  if (token.error) {
    job.status = "paused"; job.error = token.error; blockSpace(space, BLOCK_REASON.auth, token.error); saveState(); return;
  }

  job.status = "running"; job.error = ""; job.progress = 0; job.startedAt = Date.now(); job.updatedAt = Date.now();
  activeJobs.add(job.id);
  const controller = new AbortController();
  activeControllers.set(space.id, controller);
  saveState(); if (currentTab === "queue") render();

  const result = await runner.runJob({
    space,
    job,
    token: token.token,
    files: jobFiles.get(job.id) ?? new Map(),
    signal: controller.signal,
    onProgress: (payload) => progressFor(job.id, payload),
  });
  activeControllers.delete(space.id); activeJobs.delete(job.id);

  if (result.ok) {
    job.status = "done"; job.result = result.results ?? []; job.error = ""; job.finishedAt = Date.now(); job.progress = 1; job.attempts = 0; job.updatedAt = Date.now();
    spaceRetryAfter.delete(space.id);
    clearSpaceBlock(space); healthCache.set(space.id, { at: Date.now(), ready: true, result: { ready: true } });
    ping(`Completed: ${job.name}`);
  } else {
    const kind = result.kind;
    job.error = result.message || "The Space rejected this job.";
    job.updatedAt = Date.now();
    if (controller.signal.aborted && queuePaused) {
      job.status = "paused";
      job.error = "Queue paused; the request was cancelled. The Space may still finish server-side.";
      saveState();
      if (currentTab === "queue") render();
      return;
    }
    job.attempts = (job.attempts ?? 0) + 1;
    if (kind === "protocol") {
      job.status = "paused";
      space.needsProbe = true; space.protocol = null; healthCache.delete(space.id);
      blockSpace(space, BLOCK_REASON.drifting, job.error);
    } else if (kind === "auth") {
      job.status = "paused"; blockSpace(space, BLOCK_REASON.auth, job.error);
    } else if (kind === "quota") {
      job.status = "paused"; blockSpace(space, BLOCK_REASON.quota, job.error);
    } else if (kind === "waking") {
      job.status = "paused"; blockSpace(space, BLOCK_REASON.asleep, job.error);
    } else if (kind === "transient" && job.attempts <= 3 && !controller.signal.aborted && !queuePaused) {
      job.status = "ready";
      const delay = retryDelay(FAILURE.transient, { attempts: job.attempts - 1 }) ?? 2_000;
      job.error += ` — retrying in ${Math.ceil(delay / 1000)}s (${job.attempts}/3).`;
      spaceRetryAfter.set(space.id, Date.now() + delay);
    } else {
      job.status = "failed";
    }
    if (kind !== "transient") ping(`${space.title}: ${job.error}`);
  }
  saveState();
  if (currentTab === "queue") render();
}

function startQueue() {
  if (queuePaused) queuePaused = false;
  if (queueRunning) { scheduleQueue(); return schedulerPromise; }
  queueRunning = true;
  schedulerPromise = schedulerLoop().finally(() => {
    queueRunning = false;
    schedulerPromise = null;
    render();
  });
  render();
  return schedulerPromise;
}

async function schedulerLoop() {
  while (!queuePaused) {
    const available = clampConcurrency(appState.settings.maxParallelSpaces) - activeJobs.size;
    if (available <= 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!appState.jobs.some((job) => job.status === "ready") && activeJobs.size === 0) break;
      continue;
    }

    const now = Date.now();
    // A retry deadline applies only to its own Space. Keep delayed jobs out of
    // this dispatch plan while allowing ready jobs from other Spaces to proceed.
    const eligibleJobs = appState.jobs.filter((job) => {
      const retryAt = spaceRetryAfter.get(job.spaceId);
      return !retryAt || retryAt <= now;
    });
    const lanes = Object.fromEntries(appState.spaces.map((space) => [space.id, laneForView(space)]));
    const plan = planDispatch({ jobs: eligibleJobs, lanes, maxParallelSpaces: available });

    if (!plan.length) {
      if (activeJobs.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const pendingRetryTimes = appState.jobs
        .filter((job) => job.status === "ready")
        .map((job) => spaceRetryAfter.get(job.spaceId))
        .filter((retryAt) => Number.isFinite(retryAt) && retryAt > Date.now());
      if (pendingRetryTimes.length > 0) {
        const nextRetryAt = Math.min(...pendingRetryTimes);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextRetryAt - Date.now())));
        continue;
      }
      break;
    }

    // Start each planned Space independently, offset by 800 ms. Promise.all
    // keeps this batch accounted for while allowing its jobs to run in parallel.
    await Promise.all(plan.map(async ({ job }, index) => {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, index * 800));
      if (queuePaused) return;
      await runOne(job);
    }));
  }
}

function scheduleQueue() {
  if (!queueRunning && !queuePaused && appState.jobs.some((job) => job.status === "ready")) startQueue();
}

function renderDebug() {
  if (!nativeBridge.available) {
    view.innerHTML = `<section class="panel"><h2>Android diagnostics</h2><p>Crash reporting is only available in the Android app. This browser session does not expose the native Android bridge.</p></section>`;
    return;
  }
  const report = nativeBridge.getLastCrashReport();
  view.innerHTML = `<section class="panel debug-panel">
    <div class="section-heading"><div><h2>Android crash report</h2><p>Reports are stored locally on this device. Review the content before sharing it.</p></div>
      <div class="button-row"><button class="button" id="debug-share" ${report ? "" : "disabled"}>Share report</button><button class="button danger" id="debug-clear" ${report ? "" : "disabled"}>Clear report</button></div>
    </div>
    ${report ? `<pre class="crash-report">${escapeHtml(report)}</pre>` : `<div class="empty"><h3>No crash report saved</h3><p>A report will appear here after an uncaught Android application crash.</p></div>`}
  </section>`;
  $("#debug-clear")?.addEventListener("click", () => {
    const result = nativeBridge.clearCrashReport();
    if (!result.ok) ping(`Could not clear report: ${result.message}`);
    else ping("Crash report cleared.");
    render();
  });
  $("#debug-share")?.addEventListener("click", async () => {
    if (!report) return;
    if (nativeBridge.shareCrashReport()) return;
    try {
      if (navigator.share) await navigator.share({ title: "Multi-HF crash report", text: report });
      else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(report); ping("Crash report copied to clipboard."); }
      else ping("Sharing is not available on this device.");
    } catch (error) {
      if (error?.name !== "AbortError") ping(`Could not share report: ${error?.message || error}`);
    }
  });
}

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  if (document.documentElement) document.documentElement.dataset.theme = selected;
  try { localStorage.setItem(THEME_KEY, selected); } catch { /* theme remains active for this session */ }
  const button = $("#theme-toggle");
  if (button) {
    button.textContent = selected === "dark" ? "Light theme" : "Dark theme";
    button.setAttribute("aria-label", `Switch to ${selected === "dark" ? "light" : "dark"} theme`);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", selected === "dark" ? "#0c111b" : "#edf2f8");
}

function toggleQueue() {
  queuePaused = !queuePaused;
  if (queuePaused) activeControllers.forEach((controller) => controller.abort());
  render();
  if (!queuePaused) startQueue();
}

function importWorkspace(data) {
  const next = sanitizeWorkspace(data);
  const count = next.spaces.length;
  if (!confirm(`Replace this workspace with ${count} Space(s), ${next.jobs.length} job(s), and ${next.profiles.length} profile(s)? All imported Spaces need a fresh probe. Tokens and file uploads are never imported.`)) return;
  appState = next;
  accountTokens.clear(); jobFiles.clear(); healthCache.clear();
  saveState(); currentTab = "spaces"; render(); ping("Workspace imported. Probe each Space and reconnect any account before running.");
}

async function doExport() {
  const json = JSON.stringify(exportWorkspace(appState), null, 2);
  const name = `multi-hf-workspace-${new Date().toISOString().slice(0, 10)}.json`;
  if (androidBridge()) {
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    await saveThroughAndroid(name, "application/json", btoa(binary), true);
    return;
  }
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name;
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doImport() {
  $("#import-file").click();
}

function bindGlobal() {
  $$('[data-tab]').forEach((button) => button.addEventListener("click", () => { currentTab = button.dataset.tab; render(); }));
  $("#quick-add").addEventListener("click", () => openNewJob());
  $("#theme-toggle")?.addEventListener("click", () => {
    const current = document.documentElement?.dataset?.theme === "light" ? "light" : "dark";
    applyTheme(current === "dark" ? "light" : "dark");
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (dialog.open) { event.preventDefault(); dialog.close(); }
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier) return;
    if (event.key === "Enter") {
      const form = $("#job-form");
      if (form) { event.preventDefault(); form.requestSubmit(); }
      return;
    }
    if (event.shiftKey && event.key.toLowerCase() === "r") {
      event.preventDefault(); startQueue();
    } else if (event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault(); toggleQueue();
    }
  });
  $("#export-data").addEventListener("click", doExport);
  $("#import-data").addEventListener("click", doImport);
  $("#import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { importWorkspace(JSON.parse(await file.text())); }
    catch (error) { ping(error.message || "Could not import this workspace."); }
    event.target.value = "";
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => { dialogContent.innerHTML = ""; });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      // Another tab may have edited workspace state. Reload only non-secret
      // persistent state; this tab's session tokens remain in memory.
      appState = loadState(); render();
    }
  });
}

bindGlobal();
let savedTheme = "dark";
try { savedTheme = localStorage.getItem(THEME_KEY) || "dark"; } catch { /* use the default theme */ }
applyTheme(savedTheme);
render();
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

