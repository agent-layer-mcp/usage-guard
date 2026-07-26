import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseClaudeDesktopUsage,
  readClaudeDesktopUsage,
} from "../src/providers/claude-desktop.mjs";
import { parseClaudeStatusLine } from "../src/providers/claude.mjs";
import { parseCodexRateLimits } from "../src/providers/codex.mjs";
import { ingestClaudeStatus, syncClaudeDesktop } from "../src/service.mjs";
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

test("normalizes the latest Claude Desktop aggregate sample without retaining organization data", () => {
  const snapshot = parseClaudeDesktopUsage({
    version: 2,
    samples: [
      { t: 1_000, org: "older-org", u: { fh: 88, sd: 44, xu: 91 } },
      { t: 2_000, org: "active-org", u: { fh: 12.5, sd: 61, xu: 7 } },
      { t: 1_500, org: "active-org", u: { fh: -1, sd: 105 } },
      { t: "bad", org: "active-org", u: { fh: 99, sd: 99 } },
    ],
  });

  assert.equal(snapshot.provider, "claude");
  assert.equal(snapshot.observedAt, 2_000);
  assert.equal(snapshot.source, "claude-desktop-aggregate-cache");
  assert.equal("organization" in snapshot, false);
  assert.deepEqual(snapshot.windows.map((window) => [window.key, window.usedPercent]), [
    ["five-hour", 12.5],
    ["seven-day", 61],
  ]);
});

test("never fabricates a Desktop reset from an earlier aggregate usage drop", () => {
  const start = Date.UTC(2026, 6, 25, 0, 0, 0);
  const snapshot = parseClaudeDesktopUsage({
    samples: [
      { t: start, org: "active", u: { fh: 96, sd: 72 } },
      { t: start + 5 * 60_000, org: "other", u: { fh: 0, sd: 0 } },
      { t: start + 10 * 60_000, org: "active", u: { fh: 1, sd: 71 } },
      { t: start + 20 * 60_000, org: "active", u: { fh: 2, sd: 20 } },
    ],
  });

  assert.deepEqual(snapshot.windows.map((window) => window.resetsAt), [null, null]);
});

test("retains an authoritative status-line reset across Desktop percentage refreshes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-claude-reset-"));
  const cachePath = path.join(root, "plan-usage-history.json");
  const now = Date.UTC(2026, 6, 27, 0, 0, 0);
  const resetAt = now + 4 * 60 * 60_000;
  const store = new GuardStore({ filename: ":memory:" });

  ingestClaudeStatus(store, {
    session_id: "authoritative-session",
    rate_limits: {
      five_hour: { used_percentage: 3, resets_at: resetAt / 1_000 },
      seven_day: { used_percentage: 30, resets_at: (now + 5 * 24 * 60 * 60_000) / 1_000 },
    },
  }, now);
  writeFileSync(cachePath, JSON.stringify({
    version: 2,
    samples: [{
      t: now + 5 * 60_000,
      org: "active",
      u: { fh: 4, sd: 31 },
    }],
  }));

  const snapshot = syncClaudeDesktop(store, { cachePath });
  assert.equal(snapshot.source, "claude-desktop-aggregate-cache+status-line-reset");
  assert.equal(snapshot.windows[0].resetsAt, resetAt);
  assert.equal(store.latest("claude")[0].resetsAt, resetAt);
  store.close();
});

test("does not carry an expired or rolled-over status-line reset", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-claude-rollover-"));
  const cachePath = path.join(root, "plan-usage-history.json");
  const now = Date.UTC(2026, 6, 27, 0, 0, 0);
  const resetAt = now + 60 * 60_000;
  const store = new GuardStore({ filename: ":memory:" });

  ingestClaudeStatus(store, {
    rate_limits: {
      five_hour: { used_percentage: 80, resets_at: resetAt / 1_000 },
    },
  }, now);
  writeFileSync(cachePath, JSON.stringify({
    version: 2,
    samples: [{
      t: now + 30 * 60_000,
      org: "active",
      u: { fh: 2 },
    }],
  }));
  assert.equal(syncClaudeDesktop(store, { cachePath }).windows[0].resetsAt, null);

  writeFileSync(cachePath, JSON.stringify({
    version: 2,
    samples: [{
      t: resetAt + 60_000,
      org: "active",
      u: { fh: 1 },
    }],
  }));
  assert.equal(syncClaudeDesktop(store, { cachePath }).windows[0].resetsAt, null);
  store.close();
});

test("fails open when the Claude Desktop cache is absent or malformed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-claude-cache-"));
  const cachePath = path.join(root, "plan-usage-history.json");
  assert.equal(readClaudeDesktopUsage({ cachePath }), null);

  writeFileSync(cachePath, "{not-json");
  assert.equal(readClaudeDesktopUsage({ cachePath }), null);

  writeFileSync(cachePath, JSON.stringify({ samples: [{ t: 1, u: { fh: 101, sd: -2 } }] }));
  assert.equal(readClaudeDesktopUsage({ cachePath }), null);
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
