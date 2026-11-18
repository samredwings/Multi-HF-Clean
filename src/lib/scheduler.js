/**
 * Queue scheduling helpers kept pure so retry isolation and dispatch concurrency
 * can be tested without a browser, network, or Android bridge.
 */

export function eligibleJobsForDispatch(jobs, retryAfter, now = Date.now()) {
  return jobs.filter((job) => {
    if (job.status !== "ready") return false;
    const retryAt = retryAfter.get(job.spaceId);
    return !Number.isFinite(retryAt) || retryAt <= now;
  });
}

export function earliestPendingRetry(jobs, retryAfter, now = Date.now()) {
  const pending = jobs
    .filter((job) => job.status === "ready")
    .map((job) => retryAfter.get(job.spaceId))
    .filter((retryAt) => Number.isFinite(retryAt) && retryAt > now);
  return pending.length ? Math.min(...pending) : null;
}

export async function dispatchStaggered(
  plan,
  runOne,
  { delayMs = 800, isPaused = () => false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  await Promise.all(plan.map(async ({ job }, index) => {
    if (index > 0) await sleep(index * delayMs);
    if (isPaused()) return;
    await runOne(job);
  }));
}
