import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure, configUrlCandidates, deriveProtocol, FAILURE, isRetryable,
  coerceChoiceValue, defaultValueFor, normalizeOutputs, parseSpaceConfig, readGradioStream, retryDelay, taskFromEndpoints,
} from "../src/lib/protocol.js";
import {
  gradio3Config, gradio4Config, gradio5Config, gradio5NoPrefixConfig, unknownVersionConfig,
} from "./fixtures.js";

const streamOf = (text) => new Response(text);

test("Gradio 3 config resolves to the synchronous /run/{api_name} contract", () => {
  const parsed = parseSpaceConfig(gradio3Config);
  const protocol = deriveProtocol({ config: gradio3Config, configPath: "/config" });
  assert.equal(protocol.base, "");
  assert.equal(protocol.mode, "predict");
  assert.equal(protocol.callPath, "/run");
  assert.equal(protocol.verified, true);
  // Layout components are never offered as inputs.
  assert.deepEqual(parsed.endpoints[0].fields.map((f) => f.key), ["c1", "c2", "c4"]);
  assert.equal(parsed.endpoints.length, 1, "load_example is not a runnable endpoint");
  assert.equal(taskFromEndpoints(parsed.endpoints), "image");
});

test("Gradio 4 config resolves to the queue mode on the declared prefix", () => {
  const protocol = deriveProtocol({ config: gradio4Config, configPath: "/config" });
  assert.equal(protocol.base, "/gradio_api");
  assert.equal(protocol.mode, "queue");
  assert.equal(protocol.callPath, "/gradio_api/call");
  const parsed = parseSpaceConfig(gradio4Config);
  assert.equal(parsed.endpoints[0].apiName, "generate");
  assert.deepEqual(parsed.endpoints[0].fields[1].choices.map((c) => c.value), ["fast", "quality"]);
});

test("numeric Gradio dropdown choices retain numeric types through defaults and form values", () => {
  const parsed = parseSpaceConfig({
    version: "5.0.0",
    components: [
      { id: 1, type: "dropdown", props: { label: "Resolution", choices: [1024, 1536, 2048], value: 1536 } },
      { id: 2, type: "dropdown", props: { label: "Mode", choices: [["Fast", "fast"], ["Quality", "quality"]], value: "quality" } },
      { id: 3, type: "checkboxgroup", props: { label: "Sizes", choices: [512, 1024], value: [512] } },
      { id: 4, type: "image", props: { label: "Output" } },
    ],
    dependencies: [{ api_name: "generate", inputs: [1, 2, 3], outputs: [4] }],
  });
  const [resolution, mode, sizes] = parsed.endpoints[0].fields;
  assert.deepEqual(resolution.choices.map((choice) => choice.value), [1024, 1536, 2048]);
  assert.equal(resolution.defaultValue, 1536);
  assert.equal(coerceChoiceValue(resolution.choices, "1536"), 1536);
  assert.equal(typeof coerceChoiceValue(resolution.choices, "1536"), "number");
  assert.equal(mode.defaultValue, "quality");
  assert.equal(coerceChoiceValue(mode.choices, "fast"), "fast");
  assert.deepEqual(sizes.defaultValue, [512]);
  assert.deepEqual(sizes.defaultValue.map((value) => typeof value), ["number"]);
  assert.equal(defaultValueFor("select", "1024", resolution.choices), 1024);
});

test("Gradio 5 config resolves to the queue contract and honours private visibility", () => {
  const protocol = deriveProtocol({ config: gradio5Config, configPath: "/config" });
  assert.equal(protocol.mode, "queue");
  assert.equal(protocol.callPath, "/gradio_api/call");
  assert.deepEqual(protocol.streamEvents.complete, ["complete", "process_completed"]);
  const parsed = parseSpaceConfig(gradio5Config);
  assert.deepEqual(parsed.endpoints.map((e) => e.apiName), ["infer"]);
  const stateField = parsed.endpoints[0].fields.find((field) => field.key === "c12");
  assert.equal(stateField.hidden, true, "state inputs are hidden but kept for passthrough");
  assert.deepEqual(stateField.passthrough, { seed: 1 });
});

test("a prefixless config falls back to the path that served it, not a hardcoded default", () => {
  const servedFromOldBase = deriveProtocol({ config: gradio5NoPrefixConfig, configPath: "/config" });
  assert.equal(servedFromOldBase.base, "/gradio_api");
  const servedFromApi = deriveProtocol({ config: { ...gradio5NoPrefixConfig, version: "" }, configPath: "/api/config" });
  assert.equal(servedFromApi.base, "/api");
  assert.equal(servedFromApi.mode, "legacy");
});

test("an unversioned config is flagged unverified so the probe must confirm it", () => {
  const protocol = deriveProtocol({ config: unknownVersionConfig, configPath: "/config" });
  assert.equal(protocol.verified, false);
  assert.equal(protocol.mode, "predict");
});

test("config candidates are tried in a fixed order", () => {
  assert.deepEqual(configUrlCandidates("https://a-b.hf.space"), [
    "https://a-b.hf.space/config",
    "https://a-b.hf.space/gradio_api/config",
    "https://a-b.hf.space/api/config",
  ]);
});

test("endpoints without outputs or with bad names are dropped", () => {
  const parsed = parseSpaceConfig({
    version: "5.0.0",
    components: [{ id: 1, type: "textbox", props: {} }],
    dependencies: [
      { api_name: "no_out", inputs: [1], outputs: [] },
      { api_name: "bad name!", inputs: [1], outputs: [1] },
      { api_name: "js_fn", inputs: [1], outputs: [1] },
      { api_name: "ok", inputs: [1], outputs: [1] },
    ],
  });
  assert.deepEqual(parsed.endpoints.map((e) => e.apiName), ["ok"]);
});

test("failure classes drive queue decisions, and a 404 is a protocol problem", () => {
  assert.equal(classifyFailure(404, "Not Found"), FAILURE.protocol);
  assert.equal(classifyFailure(405, "Method Not Allowed"), FAILURE.protocol);
  assert.equal(classifyFailure(401, "Unauthorized"), FAILURE.auth);
  assert.equal(classifyFailure(402, "Payment required"), FAILURE.quota);
  assert.equal(classifyFailure(503, "Upstream unavailable"), FAILURE.transient);
  assert.equal(classifyFailure(200, "Space is sleeping"), FAILURE.waking);
  assert.equal(classifyFailure(200, "content policy blocked"), FAILURE.policy);
  assert.equal(classifyFailure(500, "boom"), FAILURE.fatal);
});

test("only waking and transient failures are retried automatically", () => {
  assert.equal(isRetryable(FAILURE.waking), true);
  assert.equal(isRetryable(FAILURE.transient), true);
  assert.equal(isRetryable(FAILURE.protocol), false);
  assert.equal(isRetryable(FAILURE.quota), false);
  assert.equal(isRetryable(FAILURE.fatal), false);
});

test("quota never invents a reset time; other classes back off", () => {
  assert.equal(retryDelay(FAILURE.quota, { now: 1000 }), null);
  assert.equal(retryDelay(FAILURE.quota, { resetAt: 5000, now: 1000 }), 4000);
  assert.equal(retryDelay(FAILURE.waking, { attempts: 0 }), 8000);
  assert.equal(retryDelay(FAILURE.waking, { attempts: 6 }), 300000);
  assert.equal(retryDelay(FAILURE.transient, { attempts: 0 }), 2000);
  assert.equal(retryDelay(FAILURE.transient, { attempts: 1 }), 4000);
  assert.equal(retryDelay(FAILURE.transient, { attempts: 2 }), 8000);
  assert.equal(retryDelay(FAILURE.transient, { attempts: 8 }), 60000);
  assert.equal(retryDelay(FAILURE.fatal, {}), null);
});

test("output normalization rejects hostile URLs instead of rendering them", () => {
  const injected = normalizeOutputs('https://x.test/a.png" onerror="alert(1)', "x");
  assert.equal(injected[0].kind, "text");
  const javascript = normalizeOutputs([{ url: "javascript:alert(1)" }], "x");
  assert.equal(javascript[0].kind, "text");
  const relative = normalizeOutputs("/file=/tmp/out.png", "x", "https://a-b.hf.space");
  assert.equal(relative[0].url, "https://a-b.hf.space/file=/tmp/out.png");
  assert.equal(relative[0].kind, "image");
  const video = normalizeOutputs([{ url: "https://x.test/c.mp4", mime_type: "video/mp4" }], "x");
  assert.equal(video[0].kind, "video");
});

test("SSE reader handles CRLF, progress, and completion", async () => {
  const seen = [];
  const data = await readGradioStream(
    streamOf('event: generating\r\ndata: {"progress":0.5}\r\n\r\nevent: complete\r\ndata: ["https://x.test/o.png"]\r\n\r\n'),
    { onProgress: (payload) => seen.push(payload) },
  );
  assert.deepEqual(data, ["https://x.test/o.png"]);
  assert.equal(seen[0].progress, 0.5);
});

test("SSE reader surfaces server errors with their text", async () => {
  await assert.rejects(
    readGradioStream(streamOf('event: error\ndata: "You have exceeded your GPU quota"\n\n')),
    /GPU quota/,
  );
  await assert.rejects(readGradioStream(streamOf("event: heartbeat\ndata: null\n\n")), /ended before/);
});

test("SSE reader accepts a process_completed frame with the output nested", async () => {
  const data = await readGradioStream(streamOf('event: process_completed\ndata: {"output":{"data":["https://x.test/a.png"]}}\n\n'));
  assert.deepEqual(data, ["https://x.test/a.png"]);
});

