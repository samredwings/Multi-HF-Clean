// Browser-shell smoke test plus a mock end-to-end Gradio job lifecycle.
import assert from "node:assert/strict";
import { sanitizeWorkspace } from "../src/lib/state.js";
import { createRunner, planDispatch } from "../src/lib/queue.js";
import { spaceRecord } from "./fixtures.js";

const listeners = new WeakMap();
function makeEl(tag = "div") {
  const el = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    _html: "", _text: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    hidden: false, className: "", id: "", value: "", checked: false, files: null,
    addEventListener(t, fn) { const map = listeners.get(el) ?? {}; (map[t] ??= []).push(fn); listeners.set(el, map); },
    removeEventListener() {}, querySelector() { return makeEl(); }, querySelectorAll() { return []; },
    appendChild(c) { el.children.push(c); return c; }, prepend(c) { el.children.unshift(c); return c; },
    after() {}, remove() {}, click() {}, focus() {}, requestSubmit() {},
    showModal() { el.open = true; }, close() { el.open = false; },
    scrollIntoView() {}, setAttribute() {}, getAttribute() { return null; },
    open: false, parent: null,
  };
  return el;
}
const registry = new Map();
for (const id of ["view","dialog","dialog-content","toast","notice","page-title","nav-queue-count","account-summary","import-file","quick-add","export-data","import-data","theme-toggle"]) registry.set(id, makeEl("div"));
globalThis.document = {
  documentElement: { dataset: {}, setAttribute() {} },
  querySelector(sel) { const id = String(sel).replace(/^#/, ""); if (!registry.has(id)) registry.set(id, makeEl("div")); return registry.get(id); },
  querySelectorAll() { return []; }, createElement(tag) { return makeEl(tag); }, addEventListener() {},
};
globalThis.window = { addEventListener() {}, MultiHFAndroid: null };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
globalThis.localStorage = {
  _d: new Map(), getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); }, removeItem(k) { this._d.delete(k); },
};
globalThis.FormData = class { constructor() { this._m = new Map(); } get(k) { return this._m.get(k) ?? null; } set(k, v) { this._m.set(k, v); } };
globalThis.CSS = { escape: (v) => String(v).replace(/[^\w-]/g, (c) => `\\${c}`) };
globalThis.confirm = () => true;
globalThis.fetch = async () => { throw new Error("network disabled in smoke test"); };

await import("../src/app.js");
console.log("app.js imported OK");

// Start from an actual sanitized import. Imported jobs are intentionally paused.
const imported = sanitizeWorkspace({
  spaces: [{ ...spaceRecord(), protocol: undefined, private: true, sendToken: true }],
  profiles: [],
  jobs: [{ id: "job-e2e", spaceId: "owner/space", apiName: "infer", status: "running", values: { c9: "A test image" }, createdAt: 1 }],
});
assert.equal(imported.jobs[0].status, "paused");
assert.equal(imported.spaces[0].private, false);

// Re-probing establishes the live schema and verified protocol before retry.
const space = {
  ...imported.spaces[0],
  private: false,
  sendToken: false,
  title: "E2E Space",
  activeApi: "generate",
  endpoints: spaceRecord().endpoints,
  needsProbe: false,
  protocol: {
    base: "/gradio_api", mode: "queue", version: "5.12.0", verified: true,
    source: "declared", configPath: "/config", uploadPath: "/gradio_api/upload",
    callPath: "/gradio_api/call", streamEvents: { complete: ["complete", "process_completed"], progress: ["generating"] },
  },
};
const job = { ...imported.jobs[0], apiName: "generate", status: "ready", values: { c1: "A test image" }, attempts: 0, files: [] };
const matchingConfig = {
  version: "5.12.0", api_prefix: "/gradio_api", title: "E2E Space",
  components: [
    { id: 1, type: "textbox", props: { label: "Prompt", lines: 2 } },
    { id: 2, type: "image", props: { label: "Output" } },
  ],
  dependencies: [{ id: 0, api_name: "generate", inputs: [1], outputs: [2], backend_fn: true }],
};
const fakeFetch = async (url, options = {}) => {
  if (url.includes("huggingface.co/api/spaces/")) {
    return new Response(JSON.stringify({ private: false, runtime: { stage: "RUNNING" }, host: "owner-space.hf.space" }), { status: 200 });
  }
  if (url.endsWith("/config")) return new Response(JSON.stringify(matchingConfig), { status: 200 });
  if (options.method === "POST" && url.endsWith("/gradio_api/call/generate")) {
    return new Response(JSON.stringify({ event_id: "event-e2e" }), { status: 200 });
  }
  if (url.endsWith("/event-e2e")) {
    return new Response('event: complete\ndata: ["https://cdn.example.test/result.png"]\n\n', { status: 200 });
  }
  return new Response("not found", { status: 404 });
};
const runner = createRunner({ fetchImpl: fakeFetch, hubRateGate: async () => {}, configRateGate: async () => {} });
const health = await runner.checkSpace(space, null);
assert.equal(health.ready, true);
const dispatch = planDispatch({ jobs: [job], lanes: {}, maxParallelSpaces: 1 });
assert.equal(dispatch.length, 1, "the mock queue should dispatch the ready job");
job.status = "running";
const outcome = await runner.runJob({ space, job, token: null });
assert.equal(outcome.ok, true, outcome.message);
assert.equal(outcome.results[0].kind, "image");
job.status = "done";
job.result = outcome.results;
assert.equal(job.status, "done");
console.log("mock Space end-to-end job lifecycle passed");
