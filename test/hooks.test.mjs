import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProviderHook } from "../src/hooks.mjs";
import { GuardStore } from "../src/store.mjs";

test("Claude prompt hook visibly blocks at reserve", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.setConfig({ qualityLock: true });
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
  assert.match(output.hookSpecificOutput.additionalContext, /never lower the active model/i);
  store.close();
});

test("safe prompt hook stays silent", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.setConfig({ qualityLock: true });
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
  assert.deepEqual(output, {});
  store.close();
});

test("session start adds one stable quality contract without volatile meter data", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.setConfig({ qualityLock: true });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 12, windowMinutes: 300, resetsAt: now + 240 * 60_000 }],
  });
  const output = await runProviderHook(store, "claude", {
    hook_event_name: "SessionStart",
    session_id: "stable-session",
  }, { claudeDesktop: { platform: "linux" } });

  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /Quality lock is on/i);
  assert.match(context, /usage_guard_status/i);
  assert.doesNotMatch(context, /\d+%|resets in|Reason:/i);
  store.close();
});

test("Claude stop hook shows a post-response usage footer without model context", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.setConfig({ qualityLock: true });
  store.saveSnapshot({
    provider: "claude",
    source: "claude-status-line",
    observedAt: now,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent: 4,
      windowMinutes: 300,
      resetsAt: now + 3 * 60 * 60_000,
    }, {
      key: "seven-day",
      label: "weekly",
      usedPercent: 30,
      windowMinutes: 10_080,
      resetsAt: now + 5 * 24 * 60 * 60_000,
    }],
  });

  const output = await runProviderHook(store, "claude", {
    hook_event_name: "Stop",
    session_id: "desktop-session",
    last_assistant_message: "This content must not be repeated or stored.",
  }, { claudeDesktop: { platform: "linux" } });

  assert.match(output.systemMessage, /UG 5h 4% \| wk 30%/);
  assert.match(output.systemMessage, /SAFE/);
  assert.match(output.systemMessage, /quality locked/);
  assert.equal(output.hookSpecificOutput, undefined);
  assert.equal(output.suppressOutput, undefined);
  assert.doesNotMatch(output.systemMessage, /must not be repeated/i);
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
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /tool boundary/i);
  store.close();
});

test("safe Claude pre-tool hook stays silent", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.setConfig({ qualityLock: true });
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

test("Claude hooks show one chat cue per watch or protect transition per session", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.setConfig({ qualityLock: true });
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
  const protect = await runProviderHook(store, "claude", {
    ...input,
    hook_event_name: "UserPromptSubmit",
  }, {
    claudeDesktop: { platform: "linux" },
  });
  assert.match(protect.systemMessage, /PROTECT/);

  const repeatedProtectFromTool = await runProviderHook(store, "claude", input, {
    claudeDesktop: { platform: "linux" },
  });
  assert.equal(repeatedProtectFromTool.hookSpecificOutput.permissionDecision, "ask");
  assert.match(repeatedProtectFromTool.hookSpecificOutput.permissionDecisionReason, /one active implementation path/i);

  const acceptedProtectFromTool = await runProviderHook(store, "claude", input, {
    claudeDesktop: { platform: "linux" },
  });
  assert.deepEqual(acceptedProtectFromTool, {});

  const otherSession = await runProviderHook(store, "claude", {
    ...input,
    session_id: "other-session",
  }, {
    claudeDesktop: { platform: "linux" },
  });
  assert.match(otherSession.systemMessage, /PROTECT/);
  store.close();
});

test("Claude post-tool batch hook stops before another model request at reserve", async () => {
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
    hook_event_name: "PostToolBatch",
    session_id: "active-session",
    tool_uses: [],
  }, { claudeDesktop: { platform: "linux" } });

  assert.equal(output.decision, "block");
  assert.equal(output.continue, false);
  assert.match(output.reason, /before another model request/i);
  store.close();
});

test("Claude compact summary is saved and injected into a different session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-handoff-"));
  const stateHome = path.join(root, "state");
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: Date.now(),
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent: 12,
      windowMinutes: 300,
      resetsAt: null,
    }],
  });

  const written = await runProviderHook(store, "claude", {
    hook_event_name: "PostCompact",
    session_id: "old-session",
    cwd: root,
    trigger: "auto",
    compact_summary: "The implementation is complete through the parser. Next, verify the desktop hook.",
  }, {
    claudeDesktop: { platform: "linux" },
    compactionHandoff: { stateHome },
  });
  assert.match(written.systemMessage, /saved the compacted context handoff/i);

  const resumed = await runProviderHook(store, "claude", {
    hook_event_name: "SessionStart",
    session_id: "new-session",
    cwd: root,
  }, {
    claudeDesktop: { platform: "linux" },
    compactionHandoff: { stateHome },
  });
  assert.match(resumed.hookSpecificOutput.additionalContext, /implementation is complete through the parser/i);

  const sameSession = await runProviderHook(store, "claude", {
    hook_event_name: "SessionStart",
    session_id: "old-session",
    cwd: root,
  }, {
    claudeDesktop: { platform: "linux" },
    compactionHandoff: { stateHome },
  });
  assert.doesNotMatch(sameSession.hookSpecificOutput.additionalContext, /implementation is complete through the parser/i);

  const detailedSummary = `${"A".repeat(39_000)}\nCritical final continuation detail`;
  await runProviderHook(store, "claude", {
    hook_event_name: "PostCompact",
    session_id: "detailed-old-session",
    cwd: root,
    trigger: "auto",
    compact_summary: detailedSummary,
  }, {
    claudeDesktop: { platform: "linux" },
    compactionHandoff: { stateHome },
  });
  const detailedResume = await runProviderHook(store, "claude", {
    hook_event_name: "SessionStart",
    session_id: "detailed-new-session",
    cwd: root,
  }, {
    claudeDesktop: { platform: "linux" },
    compactionHandoff: { stateHome },
  });
  assert.match(detailedResume.hookSpecificOutput.additionalContext, /Critical final continuation detail/);
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
  store.setConfig({ qualityLock: true });

  const output = await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the migration",
  }, { claudeDesktop: { cachePath } });

  assert.deepEqual(output, {});
  store.close();
});

test("stepping is on by default and offers role-aware models at a task boundary", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude", source: "test", observedAt: now,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 12, windowMinutes: 300, resetsAt: now + 240 * 60_000 }],
  });
  const prompt = await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit", session_id: "routine-task",
    prompt: "Run tests and summarize the results",
  }, { claudeDesktop: { platform: "linux" } });
  assert.match(prompt.hookSpecificOutput.additionalContext, /Model stepping is on and already authorized/i);
  assert.match(prompt.hookSpecificOutput.additionalContext, /claude-sonnet-5-5/);
  assert.doesNotMatch(prompt.hookSpecificOutput.additionalContext, /Quality lock is on/i);
  const tool = await runProviderHook(store, "claude", {
    hook_event_name: "PreToolUse", session_id: "routine-task", tool_name: "Read",
  }, { claudeDesktop: { platform: "linux" } });
  assert.deepEqual(tool, {});
  store.close();
});

test("a tool-boundary step is deferred until the next task, without asking for downgrade approval", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  const save = (usedPercent, observedAt) => store.saveSnapshot({
    provider: "claude", source: "test", observedAt,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent, windowMinutes: 300, resetsAt: now + 240 * 60_000 }],
  });
  save(12, now);
  await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit", session_id: "edit-session", prompt: "Build a settings page",
  }, { claudeDesktop: { platform: "linux" } });
  save(65, now + 1);
  const tool = await runProviderHook(store, "claude", {
    hook_event_name: "PreToolUse", session_id: "edit-session", tool_name: "Edit",
  }, { claudeDesktop: { platform: "linux" } });
  assert.match(tool.systemMessage, /next task boundary/i);
  assert.equal(tool.hookSpecificOutput.permissionDecision, undefined);
  const repeat = await runProviderHook(store, "claude", {
    hook_event_name: "PreToolUse", session_id: "edit-session", tool_name: "Edit",
  }, { claudeDesktop: { platform: "linux" } });
  assert.deepEqual(repeat, {});
  const nextTask = await runProviderHook(store, "claude", {
    hook_event_name: "UserPromptSubmit", session_id: "edit-session", prompt: "Build the next settings page",
  }, { claudeDesktop: { platform: "linux" } });
  assert.match(nextTask.hookSpecificOutput.additionalContext, /Finish the current edit/i);
  store.close();
});

test("reserve creates a private quota-only handover before blocking work", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-quota-handover-"));
  const store = new GuardStore({ filename: path.join(root, "state.sqlite3") });
  const now = Date.now();
  store.saveSnapshot({
    provider: "claude", source: "test", observedAt: now,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 94, windowMinutes: 300, resetsAt: now + 45 * 60_000 }],
  });
  const output = await runProviderHook(store, "claude", {
    hook_event_name: "PreToolUse", session_id: "secret-session",
    prompt: "Production security review: secret project title",
    tool_name: "Bash", tool_input: { command: "secret-source-code" },
  }, { claudeDesktop: { platform: "linux" } });
  assert.equal(output.continue, false);
  assert.match(output.stopReason, /Quota-only handover saved/);
  const handoverPath = path.join(root, "handoffs", "quota-claude.json");
  const body = readFileSync(handoverPath, "utf8");
  const data = JSON.parse(body);
  assert.equal(data.provider, "claude");
  assert.equal(data.quota[0].usedPercent, 94);
  assert.equal(data.model, "claude-sonnet-5-5");
  assert.equal(statSync(handoverPath).mode & 0o777, 0o600);
  assert.doesNotMatch(body, /secret|source|session|prompt|tool_input/i);
  store.close();
});
