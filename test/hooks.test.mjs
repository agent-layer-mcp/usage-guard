import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
  }, { claudeDesktop: { platform: "linux" } });
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
  }, { claudeDesktop: { platform: "linux" } });
  assert.equal(output.continue, undefined);
  assert.equal(output.decision, undefined);
  assert.equal(output.systemMessage, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /Quality lock is on/i);
  store.close();
});

test("Claude Desktop hook synchronizes aggregate usage before protecting reserve", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-hook-cache-"));
  const cachePath = path.join(root, "plan-usage-history.json");
  const now = Date.now();
  writeFileSync(cachePath, JSON.stringify({
    version: 2,
    samples: [{ t: now, org: "active", u: { fh: 94, sd: 32, xu: 99 } }],
  }));
  const store = new GuardStore({ filename: ":memory:" });

  const output = await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the migration",
  }, { claudeDesktop: { cachePath } });

  assert.equal(output.decision, "block");
  assert.match(output.reason, /protected/i);
  assert.deepEqual(store.latest("claude").map((window) => [window.key, window.usedPercent]), [
    ["five-hour", 94],
    ["seven-day", 32],
  ]);
  store.close();
});

test("a stale Claude Desktop cache never blocks a prompt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-stale-cache-"));
  const cachePath = path.join(root, "plan-usage-history.json");
  writeFileSync(cachePath, JSON.stringify({
    version: 2,
    samples: [{ t: Date.now() - 24 * 60 * 60_000, org: "active", u: { fh: 100, sd: 100 } }],
  }));
  const store = new GuardStore({ filename: ":memory:" });

  const output = await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the migration",
  }, { claudeDesktop: { cachePath } });

  assert.equal(output.decision, undefined);
  assert.equal(output.continue, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /stale/i);
  store.close();
});
