# Multi-HF-Clean Roadmap

**Status:** Audited against GitHub `main` on 2026-11-17  
**Product direction:** Local-first Hugging Face Gradio batch workbench.

Checkboxes are only checked when the current committed source and/or reproducible checks support completion. A visible UI fragment is not considered complete if required imported modules or build scripts are missing.

## Phase 0 — Stabilize the current build
- [ ] Reproduce and resolve the reported job-queue error using supplied debug logs.
- [ ] Verify queue lifecycle states: queued, running, completed, failed, cancelled.
- [ ] Ensure a failed job does not block subsequent jobs.
- [ ] Add actionable error messages and structured diagnostic logging.
- [ ] Add a repeatable debug/diagnostics export so users can provide logs without manual file hunting.
- [ ] Run the existing test suite and a clean installation/build from the lockfile.

**Exit criteria:** A representative batch can be submitted, processed, failed safely, retried, and diagnosed without wedging the queue.

## Phase 1 — Reliable batch execution
- [ ] Validate job inputs before enqueueing and report row-level validation errors.
- [ ] Make progress, current item, completed count, and failure count visible.
- [ ] Add safe retry and cancellation behavior.
- [ ] Persist enough job metadata to recover sensibly after an application restart.
- [ ] Prevent duplicate submissions caused by repeated clicks or transient UI retries.

**Exit criteria:** Long batches remain observable and recoverable, with deterministic job state transitions.

## Phase 2 — Hugging Face workflow quality
- [ ] Audit model/Space discovery, configuration, and submission flows.
- [ ] Validate authentication and token handling; never write tokens into logs.
- [ ] Improve handling of rate limits, timeouts, unavailable Spaces, and network interruptions.
- [ ] Make output collection and per-item result reporting consistent.
- [ ] Document supported workflows and known provider limitations.

**Exit criteria:** Common Hugging Face workflows have clear success/failure outcomes and safe credential handling.

## Phase 3 — Usability and maintainability
- [ ] Improve batch history, filtering, and export.
- [ ] Add accessible progress and error states.
- [ ] Add regression tests for queue ordering, retries, cancellation, and recovery.
- [ ] Document local setup, troubleshooting, and release packaging.

## Release gates
- [ ] Clean dependency install and production build pass.
- [ ] Queue regression tests pass.
- [ ] No secrets appear in diagnostics.
- [ ] README troubleshooting instructions match the shipped behavior.

## Audit findings — 2026-11-17
- The current `main` checkout has `src/app.js` importing `src/lib/*` modules that are absent from the committed tree.
- `package.json` declares `scripts/check.mjs` and `scripts/build.mjs`, but those files are absent; `npm run check` and `npm run build` fail with module-not-found errors.
- `npm test` exits successfully but discovers **zero tests**.
- `.multi-hf-transfer` contains only two Base64 chunks, while the import workflow requires 15 chunks or a complete `source.zip`; the workflow cannot reconstruct the expected source from the current transfer files.
- The visible app source contains queue scheduling, progress display, retry, pause and abort logic. These are not checked off because the required queue/protocol/state modules are missing and the app cannot be built or tested end to end.
- `ROADMAP.md` was absent from the current `main` checkout during this audit and has been restored with this audit state.

**Audit conclusion:** No roadmap deliverable is marked complete yet. Restore the complete verified source archive first, then re-run the queue, build and regression checks before closing items.
