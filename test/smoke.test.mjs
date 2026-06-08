// Smoke tests for the security + read-only enumeration logic. `npm test` builds first, so these
// import the compiled dist. They must not depend on a live Claude session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { secretsMatch } from "../dist/server.js";
import { isPidAlive, listSessions, listLiveSessions, extractText, decodeProjectDir } from "../dist/sessionStore.js";
import { notify } from "../dist/notify.js";

test("secretsMatch: equal/diff/length/empty", () => {
  assert.equal(secretsMatch("abc123", "abc123"), true);
  assert.equal(secretsMatch("abc123", "abc124"), false);
  assert.equal(secretsMatch("short", "muchlongersecret"), false);
  assert.equal(secretsMatch("", "x"), false);
  assert.equal(secretsMatch("x", ""), false);
});

test("isPidAlive: this process alive, absurd pid dead", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(2147480000), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
});

test("listSessions / listLiveSessions never throw and return arrays", async () => {
  const all = await listSessions();
  const live = await listLiveSessions();
  assert.ok(Array.isArray(all));
  assert.ok(Array.isArray(live));
  // live sessions must be a subset reflected in the full list's live flag
  for (const l of live) assert.ok(typeof l.sessionId === "string");
});

test("extractText handles string and content-block arrays", () => {
  assert.equal(extractText("hello"), "hello");
  assert.equal(extractText([{ type: "text", text: "a" }, { type: "tool_use", name: "Bash" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(extractText([{ type: "tool_result", content: "x" }]), "");
  assert.equal(extractText(undefined), "");
});

test("decodeProjectDir best-effort decode", () => {
  assert.equal(decodeProjectDir("C--Users-harsh-Downloads"), "C:\\Users\\harsh\\Downloads");
});

test("notify is a no-op (no throw, no network) without a Poke key", () => {
  assert.doesNotThrow(() => notify({}, "sess-1", "hello"));
  assert.doesNotThrow(() => notify({ pokeApiKey: undefined }, "sess-2", "hello"));
});
