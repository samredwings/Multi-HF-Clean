import test from "node:test";
import assert from "node:assert/strict";
import { createRateGate, escapeHtml, isSafeMediaUrl, safeId, stripEmoji, timeAgo } from "../src/lib/util.js";

test("escapeHtml is safe in text and attribute position", () => {
  assert.equal(escapeHtml('https://x" onerror="alert(1)'), "https://x&quot; onerror=&quot;alert(1)");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(escapeHtml("'"), "&#39;");
  assert.equal(escapeHtml(null), "");
});

test("isSafeMediaUrl accepts https and data media, rejects everything else", () => {
  assert.equal(isSafeMediaUrl("https://x.test/a.png"), true);
  assert.equal(isSafeMediaUrl("data:image/png;base64,AAAA"), true);
  assert.equal(isSafeMediaUrl("javascript:alert(1)"), false);
  assert.equal(isSafeMediaUrl('https://x.test/a.png" onerror="x'), false);
  assert.equal(isSafeMediaUrl("http://x.test/a.png"), false);
  assert.equal(isSafeMediaUrl("data:text/html;base64,AAAA"), false);
});

test("stripEmoji keeps labels readable", () => {
  assert.equal(stripEmoji("🎬 Demo  Space"), "Demo Space");
  assert.equal(stripEmoji(null), "");
});

test("safeId is unique enough to key jobs and sessions", () => {
  const ids = new Set(Array.from({ length: 200 }, () => safeId("job")));
  assert.equal(ids.size, 200);
  assert.ok([...ids][0].startsWith("job-"));
});

test("timeAgo is stable given a clock", () => {
  const now = 1_000_000_000;
  assert.equal(timeAgo(now, now), "just now");
  assert.equal(timeAgo(now - 5 * 60_000, now), "5m ago");
  assert.equal(timeAgo(now - 3 * 60 * 60_000, now), "3h ago");
  assert.equal(timeAgo(now - 2 * 24 * 60 * 60_000, now), "2d ago");
});


test("rate gates reserve separate slots for concurrent calls by key", async () => {
  let clock = 1000;
  const waits = [];
  const gate = createRateGate(200, {
    now: () => clock,
    delay: async (ms) => { waits.push(ms); clock += ms; },
  });
  await Promise.all([gate("hub"), gate("hub"), gate("other")]);
  assert.deepEqual(waits.sort((a, b) => a - b), [200]);
});
