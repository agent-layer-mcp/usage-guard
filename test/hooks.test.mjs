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

test("Claude pre-tool hook stops an active run at the protected reserve", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent: 96,
      windowMinutes: 300,
      resetsAt: null,
    }],
  });

  const output = await runProviderHook(store, "claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
  }, { claudeDesktop: { platform: "linux" } });

  assert.equal(output.continue, false);
  assert.match(output.stopReason, /tool boundary/i);
  assert.equal(output.hookSpecificOutput, undefined);
  store.close();
});

test("safe Claude pre-tool hook stays silent", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent: 12,
      windowMinutes: 300,
      resetsAt: null,
    }],
  });

  const output = await runProviderHook(store, "claude", {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
  }, { claudeDesktop: { platform: "linux" } });

  assert.deepEqual(output, {});
  store.close();
});

test("Claude pre-tool hook shows one chat cue per watch or protect transition", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  const save = (usedPercent, observedAt) => store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent,
      windowMinutes: 300,
      resetsAt: null,
    }],
  });
  const input = {
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    session_id: "active-session",
  };

  save(75, now);
  const watch = await runProviderHook(store, "claude", input, {
    claudeDesktop: { platform: "linux" },
  });
  assert.match(watch.systemMessage, /WATCH/);
  assert.match(watch.hookSpecificOutput.additionalContext, /Quality lock is on/i);

  const repeatedWatch = await runProviderHook(store, "claude", input, {
    claudeDesktop: { platform: "linux" },
  });
  assert.deepEqual(repeatedWatch, {});

  save(85, now + 1);
  const protect = await runProviderHook(store, "claude", input, {
    claudeDesktop: { platform: "linux" },
  });
  assert.match(protect.systemMessage, /PROTECT/);

  const otherSession = await runProviderHook(store, "claude", {
    ...input,
    session_id: "other-session",
  }, {
    claudeDesktop: { platform: "linux" },
  });
  assert.match(otherSession.systemMessage, /PROTECT/);
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
