import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_REASON, LANE, blankLanes, buildCallPlan, createRunner, describeLane,
  laneFor, nextLaneState, planDispatch, queueOrder,
} from "../src/lib/queue.js";
import { FAILURE } from "../src/lib/protocol.js";
import { spaceRecord } from "./fixtures.js";

// A config whose endpoints match `spaceRecord()`, so the health check's schema
// comparison sees no drift.
const matchingConfig = {
  version: "5.12.0",
  api_prefix: "/gradio_api",
  title: "Test Space",
  components: [
    { id: 1, type: "textbox", props: { label: "Prompt", lines: 2 } },
    { id: 2, type: "image", props: { label: "Out" } },
  ],
  dependencies: [{ id: 0, api_name: "generate", inputs: [1], outputs: [2], backend_fn: true }],
};

const job = (id, spaceId, overrides = {}) => ({
  id, spaceId, apiName: "generate", accountId: "", values: { c1: "hi" },
  files: [], status: "ready", createdAt: 1, attempts: 0, ...overrides,
});

test("dispatch order is oldest first, one job per Space, up to the parallelism limit", () => {
  const jobs = [
    job("b", "s/b", { createdAt: 2 }),
    job("a", "s/a", { createdAt: 1 }),
    job("a2", "s/a", { createdAt: 3 }),
    job("c", "s/c", { createdAt: 4 }),
  ];
  const plan = planDispatch({ jobs, lanes: blankLanes(), maxParallelSpaces: 2 });
  assert.deepEqual(plan.map((entry) => entry.job.id), ["a", "b"]);
});

test("a busy or blocked Space is skipped without blocking other Spaces", () => {
  const jobs = [job("a", "s/a", { createdAt: 1 }), job("b", "s/b", { createdAt: 2 })];
  const lanes = {
    "s/a": { spaceId: "s/a", status: LANE.blocked, blockedReason: BLOCK_REASON.asleep },
  };
  const plan = planDispatch({ jobs, lanes, maxParallelSpaces: 4 });
  assert.deepEqual(plan.map((entry) => entry.job.id), ["b"], "the blocked Space does not stall the queue");
});

test("only ready jobs are dispatched; paused and failed jobs wait for a human", () => {
  const jobs = [
    job("ready", "s/a", { status: "ready" }),
    job("paused", "s/b", { status: "paused" }),
    job("failed", "s/c", { status: "failed" }),
  ];
  assert.deepEqual(queueOrder(jobs).map((item) => item.id), ["ready"]);
  assert.equal(planDispatch({ jobs, lanes: {}, maxParallelSpaces: 4 }).length, 1);
});

test("a protocol failure blocks the lane instead of burning retries", () => {
  const lane = nextLaneState({ lane: laneFor({}, "s/a"), job: job("a", "s/a"), kind: FAILURE.protocol });
  assert.equal(lane.status, LANE.blocked);
  assert.equal(lane.blockedReason, BLOCK_REASON.drifting);
  assert.match(describeLane(lane), /re-probe/);
});

test("quota blocks the lane and is not retried", () => {
  const lane = nextLaneState({ lane: laneFor({}, "s/a"), job: job("a", "s/a"), kind: FAILURE.quota });
  assert.equal(lane.blockedReason, BLOCK_REASON.quota);
  assert.match(describeLane(lane), /quota/);
});

test("transient failures keep the lane idle for a retry, then give up", () => {
  const first = nextLaneState({ lane: laneFor({}, "s/a"), job: job("a", "s/a", { attempts: 0 }), kind: FAILURE.transient });
  assert.equal(first.status, LANE.idle);
  const third = nextLaneState({ lane: laneFor({}, "s/a"), job: job("a", "s/a", { attempts: 3 }), kind: FAILURE.transient });
  assert.equal(third.status, LANE.idle);
  assert.equal(third.blockedReason, null);
});

test("success clears the lane", () => {
  const lane = nextLaneState({
    lane: { spaceId: "s/a", status: LANE.blocked, blockedReason: BLOCK_REASON.quota, consecutiveFailures: 3 },
    job: job("a", "s/a"),
    kind: null,
  });
  assert.equal(lane.status, LANE.idle);
  assert.equal(lane.consecutiveFailures, 0);
});

test("the call plan uses the stored protocol verbatim", () => {
  const space = spaceRecord();
  const plan = buildCallPlan({
    space,
    endpoint: space.endpoints[0],
    values: { c1: "a prompt" },
    protocol: space.protocol,
    token: "hf_secret",
    privateSpace: false,
  });
  assert.equal(plan.url, "https://owner-space.hf.space/gradio_api/call/generate");
  assert.equal(plan.uploadUrl, "https://owner-space.hf.space/gradio_api/upload");
  assert.deepEqual(plan.data, ["a prompt"]);
  assert.equal("Authorization" in plan.headers, false, "a public Space never receives the token");

  const privatePlan = buildCallPlan({
    space: { ...space, private: true },
    endpoint: space.endpoints[0],
    values: {},
    protocol: space.protocol,
    token: "hf_secret",
    privateSpace: true,
  });
  assert.equal(privatePlan.headers.Authorization, "Bearer hf_secret");
});

test("a legacy Space builds the /api/predict call with its fn_index", () => {
  const space = spaceRecord({
    protocol: { base: "/api", mode: "legacy", uploadPath: "/api/upload", callPath: "/api/predict", streamEvents: { complete: [], progress: [] } },
  });
  const plan = buildCallPlan({
    space, endpoint: space.endpoints[0], values: { c1: "x" }, protocol: space.protocol, token: null, privateSpace: false,
  });
  assert.equal(plan.url, "https://owner-space.hf.space/api/predict");
  assert.equal(plan.mode, "legacy");
});

test("a Space without a verified protocol refuses to build a plan", () => {
  assert.throws(() => buildCallPlan({
    space: spaceRecord(), endpoint: spaceRecord().endpoints[0], values: {}, protocol: null, token: null, privateSpace: false,
  }), /no verified protocol/);
});

// --- runner behaviour with an injected fetch ---------------------------------

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [match, handler] of routes) {
      if (url.includes(match)) return handler(url, options);
    }
    return new Response("not found", { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a running Space returns ready, and the protocol check is one request", async () => {
  const fetchImpl = fakeFetch([
    ["/api/spaces/", () => json({ private: false, runtime: { stage: "RUNNING" }, host: "owner-space.hf.space" })],
    ["/config", () => json(matchingConfig)],
  ]);
  const runner = createRunner({ fetchImpl, hubRateGate: async () => {}, configRateGate: async () => {} });
  const result = await runner.checkSpace(spaceRecord(), "hf_secret");
  assert.equal(result.ready, true);
  assert.equal(result.facts.private, false);
  assert.equal(fetchImpl.calls.length, 2, "no per-job probing: hub once, schema once");
});

test("a 404 on the schema check marks the Space as drifted", async () => {
  const fetchImpl = fakeFetch([
    ["/api/spaces/", () => json({ runtime: { stage: "RUNNING" } })],
    ["/config", () => new Response("not found", { status: 404 })],
  ]);
  const runner = createRunner({ fetchImpl, hubRateGate: async () => {}, configRateGate: async () => {} });
  const result = await runner.checkSpace(spaceRecord(), "");
  assert.equal(result.ready, false);
  assert.equal(result.reason, BLOCK_REASON.drifting);
});

test("a renamed endpoint in the live schema is detected as drift before dispatch", async () => {
  const renamed = {
    ...matchingConfig,
    dependencies: [{ id: 0, api_name: "generate_v2", inputs: [1], outputs: [2], backend_fn: true }],
  };
  const fetchImpl = fakeFetch([
    ["/api/spaces/", () => json({ runtime: { stage: "RUNNING" } })],
    ["/config", () => json(renamed)],
  ]);
  const runner = createRunner({ fetchImpl, hubRateGate: async () => {}, configRateGate: async () => {} });
  const result = await runner.checkSpace(spaceRecord(), "");
  assert.equal(result.ready, false);
  assert.equal(result.reason, BLOCK_REASON.drifting);
});

test("a private flag from the Hub is what unlocks the token, not the stored record", async () => {
  const fetchImpl = fakeFetch([
    ["/api/spaces/", () => json({ private: true, runtime: { stage: "RUNNING" } })],
    ["/config", () => json(matchingConfig)],
  ]);
  const runner = createRunner({ fetchImpl, hubRateGate: async () => {}, configRateGate: async () => {} });
  const result = await runner.checkSpace(spaceRecord({ private: false }), "hf_secret");
  assert.equal(result.ready, true);
  assert.equal(result.facts.private, true);
  const schemaCall = fetchImpl.calls.find((call) => call.url.endsWith("/config"));
  assert.equal(schemaCall.options.headers.Authorization, "Bearer hf_secret");
});

test("a queue-mode job streams its result through the stored event names", async () => {
  const fetchImpl = fakeFetch([
    ["/gradio_api/call/generate/evt-1", () => new Response('event: complete\ndata: {"data":["https://x.test/out.png"]}\n\n')],
    ["/gradio_api/call/generate", () => json({ event_id: "evt-1" })],
  ]);
  const runner = createRunner({ fetchImpl, hubRateGate: async () => {}, configRateGate: async () => {} });
  const outcome = await runner.runJob({
    space: spaceRecord(),
    job: job("j1", "owner/space"),
    token: null,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].url, "https://x.test/out.png");
  assert.equal(outcome.results[0].kind, "image");
});

test("a 404 from the call endpoint is classified as a protocol problem", async () => {
  const fetchImpl = fakeFetch([
    ["/gradio_api/call/", () => new Response("not found", { status: 404 })],
  ]);
  const runner = createRunner({ fetchImpl, hubRateGate: async () => {}, configRateGate: async () => {} });
  const outcome = await runner.runJob({ space: spaceRecord(), job: job("j1", "owner/space"), token: null });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, FAILURE.protocol);
});

test("a quota message from the Space is classified as quota, not a generic failure", async () => {
  const fetchImpl = fakeFetch([
    ["/gradio_api/call/", () => new Response("You have exceeded your GPU quota", { status: 500 })],
  ]);
  const runner = createRunner({ fetchImpl, hubRateGate: async () => {}, configRateGate: async () => {} });
  const outcome = await runner.runJob({ space: spaceRecord(), job: job("j1", "owner/space"), token: null });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, FAILURE.quota);
});

test("a missing local file pauses the job instead of uploading nothing", async () => {
  const space = spaceRecord({
    endpoints: [{
      apiName: "generate",
      fields: [{ key: "c1", label: "Image", type: "image", hidden: false, choices: [] }],
      outputs: [{ key: "o2", label: "Out", type: "image" }],
    }],
  });
  const runner = createRunner({ fetchImpl: fakeFetch([]) });
  const outcome = await runner.runJob({
    space,
    job: job("j1", "owner/space", { values: {}, files: ["c1"] }),
    token: null,
    files: new Map(),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, FAILURE.fatal);
  assert.match(outcome.message, /no longer in memory/);
});

test("an unknown endpoint fails as protocol drift, not as a phantom retry", async () => {
  const runner = createRunner({ fetchImpl: fakeFetch([]) });
  const outcome = await runner.runJob({
    space: spaceRecord(), job: job("j1", "owner/space", { apiName: "gone" }), token: null,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, FAILURE.protocol);
});

