import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeStatusLine } from "../src/providers/claude.mjs";
import { parseCodexRateLimits } from "../src/providers/codex.mjs";
import { ingestClaudeStatus } from "../src/service.mjs";
import { GuardStore } from "../src/store.mjs";

test("normalizes Claude five-hour and weekly status-line windows", () => {
  const now = Date.UTC(2026, 6, 14, 0, 0, 0);
  const snapshot = parseClaudeStatusLine({
    session_id: "session-a",
    model: { id: "claude-sonnet", display_name: "Sonnet" },
    effort: { level: "high" },
    context_window: { used_percentage: 42 },
    rate_limits: {
      five_hour: { used_percentage: 31.5, resets_at: "2026-07-14T02:00:00Z" },
      seven_day: { used_percentage: 67, resets_at: 1_784_000_000 },
    },
  }, now);

  assert.equal(snapshot.provider, "claude");
  assert.equal(snapshot.sessionId, "session-a");
  assert.equal(snapshot.model, "Sonnet");
  assert.equal(snapshot.contextPercent, 42);
  assert.deepEqual(snapshot.windows.map((window) => window.key), ["five-hour", "seven-day"]);
  assert.equal(snapshot.windows[0].windowMinutes, 300);
  assert.equal(snapshot.windows[0].resetsAt, Date.parse("2026-07-14T02:00:00Z"));
  assert.equal(snapshot.windows[1].resetsAt, 1_784_000_000_000);
});

test("persists Claude context even when optional quota windows are absent", () => {
  const now = Date.UTC(2026, 6, 14);
  const store = new GuardStore({ filename: ":memory:" });
  const snapshot = ingestClaudeStatus(store, {
    session_id: "context-only",
    model: { id: "claude-sonnet", display_name: "Sonnet" },
    context_window: { used_percentage: 74 },
  }, now);

  assert.deepEqual(snapshot.windows, []);
  assert.deepEqual(store.latest("claude"), []);
  assert.deepEqual(store.latestContext("claude", "context-only"), {
    provider: "claude",
    sessionId: "context-only",
    contextPercent: 74,
    observedAt: now,
    model: "Sonnet",
    effort: null,
    source: "claude-status-line",
  });
  store.close();
});

test("does not invent Claude windows when optional rate-limit fields are absent", () => {
  const snapshot = parseClaudeStatusLine({ model: { id: "claude" }, rate_limits: {} });
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.contextPercent, null);
});

test("normalizes arbitrary Codex limit buckets", () => {
  const snapshot = parseCodexRateLimits({
    rateLimits: { primary: null, secondary: null },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: null,
        primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_784_000_000 },
        secondary: { usedPercent: 52, windowDurationMins: 10_080, resetsAt: 1_784_500_000 },
      },
      codex_fast: {
        limitId: "codex_fast",
        limitName: "Fast",
        primary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_784_500_000 },
        secondary: null,
      },
    },
  }, { now: 123 });

  assert.equal(snapshot.contextPercent, null);
  assert.deepEqual(snapshot.windows.map((window) => window.key), [
    "codex:primary",
    "codex:secondary",
    "codex_fast:primary",
  ]);
  assert.deepEqual(snapshot.windows.map((window) => window.label), ["5 hour", "weekly", "Fast weekly"]);
});
