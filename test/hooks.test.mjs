import test from "node:test";
import assert from "node:assert/strict";
import { runProviderHook } from "../src/hooks.mjs";
import { GuardStore } from "../src/store.mjs";

test("Claude prompt hook visibly blocks at reserve", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 94, windowMinutes: 300, resetsAt: now + 45 * 60_000 }],
  });
  const output = await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the migration",
  });
  assert.equal(output.decision, "block");
  assert.match(output.reason, /protected/i);
  assert.equal(output.continue, false);
  assert.match(output.stopReason, /protected/i);
  assert.match(output.hookSpecificOutput.additionalContext, /never does so silently/i);
  store.close();
});

test("safe hook adds bounded context without blocking", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 12, windowMinutes: 300, resetsAt: now + 240 * 60_000 }],
  });
  const output = await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit",
    prompt: "Build a settings page",
  });
  assert.equal(output.continue, undefined);
  assert.equal(output.decision, undefined);
  assert.equal(output.systemMessage, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /Quality lock is on/i);
  store.close();
});
