import test from "node:test";
import assert from "node:assert/strict";
import {
  exportWorkspace, makeSpace, persistableResult, recoverRunningJobs, sanitizeWorkspace,
  serializeWorkspace, emptyWorkspace,
} from "../src/lib/state.js";
import { spaceRecord } from "./fixtures.js";

test("an imported workspace cannot grant a Space the right to receive a token", () => {
  const imported = sanitizeWorkspace({
    workspace: {
      spaces: [
        { ...spaceRecord({ private: true, sendToken: true }), accountId: "acc" },
        { ...spaceRecord(), id: "evil", host: "https://attacker.example" },
      ],
      profiles: [],
      accounts: [{ id: "acc", label: "me", token: "hf_secret", connected: true }],
      jobs: [{ ...spaceRecord(), id: "j1", spaceId: "owner/space", apiName: "generate", status: "running" }],
    },
  });
  assert.equal(imported.spaces.length, 1, "the non-hf.space host is dropped");
  assert.equal(imported.spaces[0].private, false, "private is never imported");
  assert.equal(imported.spaces[0].sendToken, false, "sendToken is never imported");
  assert.equal(imported.spaces[0].protocol, null, "the imported protocol is discarded");
  assert.equal(imported.spaces[0].needsProbe, true);
  assert.equal(imported.spaces[0].accountId, "");
  assert.equal("token" in imported.accounts[0], false);
  assert.equal(imported.accounts[0].connected, false);
  assert.equal(imported.jobs[0].status, "paused");
});

test("import rejects files that are not workspaces", () => {
  assert.throws(() => sanitizeWorkspace({ models: 1 }), /not a Multi-HF/);
  assert.throws(() => sanitizeWorkspace(null), /not a Multi-HF/);
});

test("imported jobs for unknown Spaces and bad media are dropped", () => {
  const imported = sanitizeWorkspace({
    spaces: [spaceRecord()],
    profiles: [{ spaceId: "owner/space", name: "p", apiName: "generate", values: { c1: "hi" } }],
    jobs: [
      { id: "keep", spaceId: "owner/space", apiName: "generate", status: "done",
        result: [{ kind: "image", url: "javascript:alert(1)" }, { kind: "image", url: "https://x.test/o.png" }] },
      { id: "drop", spaceId: "missing", apiName: "generate", status: "ready" },
    ],
  });
  assert.equal(imported.profiles.length, 1);
  assert.equal(imported.jobs.length, 1);
  assert.equal(imported.jobs[0].id, "keep");
  assert.equal(imported.jobs[0].result.length, 1, "the hostile URL is stripped");
});

test("oversized inline media is replaced on persist, not stored", () => {
  const bulky = { kind: "image", url: `data:image/png;base64,${"A".repeat(60_000)}`, label: "x" };
  assert.equal(persistableResult([bulky])[0].kind, "text");
  assert.equal(persistableResult([{ kind: "image", url: "https://x.test/a.png" }])[0].kind, "image");
});

test("running jobs are paused on load so quota is never silently re-spent", () => {
  const recovered = recoverRunningJobs([{ id: "1", status: "running" }, { id: "2", status: "done" }]);
  assert.equal(recovered[0].status, "paused");
  assert.match(recovered[0].error, /closed while this job was running/);
  assert.equal(recovered[1].status, "done");
});

test("serialize and export never carry tokens or transient health", () => {
  const state = {
    ...emptyWorkspace(),
    spaces: [{ ...spaceRecord(), health: { stage: "RUNNING" } }],
    accounts: [{ id: "acc", label: "me", username: "u", enabled: true, connected: true, token: "hf_secret" }],
    jobs: [{ id: "j", spaceId: "owner/space", status: "running", progress: 0.4, values: { c1: "hi" }, result: [] }],
  };
  const persisted = serializeWorkspace(state);
  assert.equal("health" in persisted.spaces[0], false);
  assert.equal("token" in persisted.accounts[0], false);
  assert.equal("progress" in persisted.jobs[0], false);
  const exported = JSON.stringify(exportWorkspace(state));
  assert.equal(exported.includes("hf_secret"), false);
  assert.equal(exported.includes("RUNNING"), false);
});

test("makeSpace refuses a host that is not a Space host", () => {
  assert.throws(() => makeSpace({ host: "https://attacker.example", endpoints: [] }), /hf\.space/);
  const space = makeSpace({ host: "https://a-b.hf.space", title: "T", endpoints: [] });
  assert.equal(space.needsProbe, true);
  assert.equal(space.private, false);
});

