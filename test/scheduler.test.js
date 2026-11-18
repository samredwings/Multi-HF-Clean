import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchStaggered,
  earliestPendingRetry,
  eligibleJobsForDispatch,
} from "../src/lib/scheduler.js";

test("a retry deadline excludes only ready jobs for its own Space", () => {
  const jobs = [
    { id: "a1", spaceId: "A", status: "ready" },
    { id: "b1", spaceId: "B", status: "ready" },
    { id: "c1", spaceId: "C", status: "paused" },
  ];
  const retryAfter = new Map([["A", 5_000]]);
  assert.deepEqual(
    eligibleJobsForDispatch(jobs, retryAfter, 1_000).map((job) => job.id),
    ["b1"],
  );
});

test("earliestPendingRetry ignores expired deadlines and non-ready jobs", () => {
  const jobs = [
    { id: "a1", spaceId: "A", status: "ready" },
    { id: "b1", spaceId: "B", status: "ready" },
    { id: "c1", spaceId: "C", status: "paused" },
  ];
  const retryAfter = new Map([["A", 900], ["B", 3_000], ["C", 1_500]]);
  assert.equal(earliestPendingRetry(jobs, retryAfter, 1_000), 3_000);
  assert.equal(earliestPendingRetry(jobs, new Map(), 1_000), null);
});

test("dispatch starts later Spaces at staggered offsets without serializing jobs", async () => {
  const jobs = [
    { id: "a1", spaceId: "A" },
    { id: "b1", spaceId: "B" },
    { id: "c1", spaceId: "C" },
  ];
  const starts = [];
  const delays = [];
  let releaseFirst;
  const firstJobGate = new Promise((resolve) => { releaseFirst = resolve; });
  const running = dispatchStaggered(
    jobs.map((job) => ({ job })),
    async (job) => {
      starts.push(job.id);
      if (job.id === "a1") await firstJobGate;
    },
    { sleep: async (ms) => { delays.push(ms); } },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["a1", "b1", "c1"]);
  assert.deepEqual(delays, [800, 1_600]);
  releaseFirst();
  await running;
});

test("dispatch does not start jobs after the queue is paused during a stagger", async () => {
  let paused = false;
  const starts = [];
  await dispatchStaggered(
    [{ job: { id: "a" } }, { job: { id: "b" } }],
    async (job) => starts.push(job.id),
    {
      isPaused: () => paused,
      sleep: async () => { paused = true; },
    },
  );
  assert.deepEqual(starts, ["a"]);
});
