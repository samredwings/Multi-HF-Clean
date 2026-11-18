import test from "node:test";
import assert from "node:assert/strict";
import {
  hostForSubdomain, isSpaceHost, isSpaceId, normalizeHost, parseSpaceInput, tokenHeaders,
} from "../src/lib/hosts.js";

test("parses accepted Space identifiers and rejects arbitrary hosts", () => {
  assert.deepEqual(parseSpaceInput("owner/space-name"), { id: "owner/space-name", host: null });
  assert.deepEqual(parseSpaceInput("https://huggingface.co/spaces/owner/space-name"), { id: "owner/space-name", host: null });
  assert.deepEqual(parseSpaceInput("https://demo-owner.hf.space"), { id: null, host: "https://demo-owner.hf.space" });
  assert.throws(() => parseSpaceInput("http://huggingface.co/spaces/a/b"), /HTTPS/);
  assert.throws(() => parseSpaceInput("https://example.com"), /only connects/i);
  assert.throws(() => parseSpaceInput("https://user:pw@huggingface.co/spaces/a/b"), /HTTPS/);
  assert.throws(() => parseSpaceInput("a/../b"), /only connects/i);
});

test("normalizeHost accepts exactly one label under hf.space", () => {
  assert.equal(normalizeHost("worker.hf.space"), "https://worker.hf.space");
  assert.equal(normalizeHost("https://worker.hf.space/"), "https://worker.hf.space");
  assert.equal(normalizeHost("http://worker.hf.space"), "");
  assert.equal(normalizeHost("https://a.b.hf.space"), "", "multi-label hosts are rejected");
  assert.equal(normalizeHost("https://worker.hf.space.evil.com"), "");
  assert.equal(normalizeHost("https://worker.hf.space/path"), "");
  assert.equal(normalizeHost("http://example.com"), "");
  assert.equal(hostForSubdomain("valid-space-name"), "https://valid-space-name.hf.space");
  assert.equal(hostForSubdomain("a.b"), "");
});

test("isSpaceHost and isSpaceId agree with normalizeHost", () => {
  assert.equal(isSpaceHost("x.hf.space"), true);
  assert.equal(isSpaceHost("a.b.hf.space"), false);
  assert.equal(isSpaceId("owner/name"), true);
  assert.equal(isSpaceId("owner/../name"), false);
});

test("a token goes to the Hub, and to a Space only when it is private", () => {
  assert.deepEqual(tokenHeaders("t", "https://huggingface.co/api/spaces/a/b"), { Authorization: "Bearer t" });
  assert.deepEqual(tokenHeaders("t", "https://evil.hf.space/config"), {});
  assert.deepEqual(tokenHeaders("t", "https://own.hf.space/config", { privateSpace: true }), { Authorization: "Bearer t" });
  assert.deepEqual(tokenHeaders("t", "https://attacker.example/x", { privateSpace: true }), {});
  assert.deepEqual(tokenHeaders("t", "http://huggingface.co/api"), {});
  assert.deepEqual(tokenHeaders("t", "https://huggingface.co.evil.com/"), {});
  assert.deepEqual(tokenHeaders("t", "https://a.b.hf.space/x", { privateSpace: true }), {});
  assert.deepEqual(tokenHeaders("t", "https://user@own.hf.space/x", { privateSpace: true }), {});
  assert.deepEqual(tokenHeaders(null, "https://huggingface.co/"), {});
});

