import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProviderDecision } from "../src/policy.mjs";
import { readCodexLogHistory } from "../src/providers/codex.mjs";
import { routeJob } from "../src/route.mjs";
import { backfillHistory, claudeResetFromHours, syncClaudeDesktop } from "../src/service.mjs";
import { GuardStore } from "../src/store.mjs";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 20, 3, 45); // 13:45 Brisbane
const DAY_START = Date.UTC(2026, 9, 19, 22, 0); // 08:00 Brisbane
const CODEX_RESET = Date.UTC(2026, 9, 24, 20, 45);

function store(t) {
  const value = new GuardStore({ filename: ":memory:" });
  value.setConfig({ dayTimeZone: "Australia/Brisbane" });
  t.after(() => value.close());
  return value;
}

test("Codex session logs supply the reading from before 08:00", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ug-codex-logs-"));
  const dir = path.join(home, "sessions", "2026", "10", "20");
  mkdirSync(dir, { recursive: true });
  const line = (at, used) => JSON.stringify({ timestamp: new Date(at).toISOString(), payload: { rate_limits: {
    limit_id: "codex", primary: { used_percent: used, window_minutes: 10_080, resets_at: CODEX_RESET / 1000 } } } });
  writeFileSync(path.join(dir, "a.jsonl"), [line(DAY_START - 10 * HOUR, 63), "{not json", line(DAY_START + 2.4 * HOUR, 71)].join("\n"));
  const readings = readCodexLogHistory({ env: { CODEX_HOME: home }, since: 0 });
  assert.deepEqual(readings.map((r) => [r.key, r.usedPercent]), [["codex:primary", 63], ["codex:primary", 71]]);

  const s = store(t);
  s.saveSnapshot({ provider: "codex", source: "codex-app-server", observedAt: NOW, authoritativeWindows: true,
    windows: [{ key: "codex:primary", label: "weekly", usedPercent: 77, windowMinutes: 10_080, resetsAt: CODEX_RESET }] });
  backfillHistory(s, "codex", (since) => readCodexLogHistory({ env: { CODEX_HOME: home }, since }), "codex-session-log", NOW);
  backfillHistory(s, "codex", (since) => readCodexLogHistory({ env: { CODEX_HOME: home }, since }), "codex-session-log", NOW);
  assert.equal(s.history("codex", "codex:primary", null, 0).length, 3, "backfill adds older readings once");

  const decision = buildProviderDecision(s, "codex", { now: NOW });
  assert.equal(decision.daily.usedAtDayStartPercent, 63);
  assert.equal(decision.daily.usedTodayPercent, 14);
  assert.equal(decision.daily.spent, true);
  assert.equal(decision.daily.baselineAt, DAY_START - 10 * HOUR);
  const lane = routeJob(s, "code", { now: NOW, record: false }).lanes.find((l) => l.lane === "codex");
  assert.match(lane.reason, /^Today's share is spent, [\d.]+% borrowed from later days\.$/);
});

test("Claude gets a daily share from the Desktop cache history and a host-reported reset", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ug-claude-cache-"));
  const cachePath = path.join(home, "plan-usage-history.json");
  writeFileSync(cachePath, JSON.stringify({ samples: [
    { t: DAY_START - 2 * 60_000, u: { fh: 0, sd: 58 } },
    { t: NOW - 6 * 60_000, u: { fh: 5, sd: 61 } },
  ] }));
  const s = store(t);
  const reset = Date.UTC(2026, 9, 22, 23, 0); // Thursday 09:00 Brisbane
  // As balance.mjs passes it: a reading with a reset, then later readings from the cache.
  s.saveSnapshot({ provider: "claude", source: "host-usage", observedAt: NOW - 10 * 60_000,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 61, windowMinutes: 10_080, resetsAt: reset }] });
  syncClaudeDesktop(s, { cachePath });
  const decision = buildProviderDecision(s, "claude", { now: NOW });
  const weekly = decision.windows.find((w) => w.key === "seven-day");
  assert.equal(weekly.resetsAt, reset);
  assert.equal(decision.daily.usedAtDayStartPercent, 58);
  assert.equal(decision.daily.usedTodayPercent, 3);
  assert.ok(Math.abs(decision.daily.todayBudgetPercent - 12.2) < 0.1, String(decision.daily.todayBudgetPercent));
});

test("a weekly Claude reset in the past rolls forward a week", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ug-claude-roll-"));
  const cachePath = path.join(home, "plan-usage-history.json");
  writeFileSync(cachePath, JSON.stringify({ samples: [{ t: NOW, u: { fh: 1, sd: 4 } }] }));
  const s = store(t);
  const lastWeek = Date.UTC(2026, 9, 15, 23, 0);
  s.saveSnapshot({ provider: "claude", source: "host-usage", observedAt: lastWeek - HOUR,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 90, windowMinutes: 10_080, resetsAt: lastWeek }] });
  const snapshot = syncClaudeDesktop(s, { cachePath });
  assert.equal(snapshot.windows.find((w) => w.key === "seven-day").resetsAt, lastWeek + 7 * 24 * HOUR);
});

test("a lane with only weekly room is not described as daily share", (t) => {
  const s = store(t);
  s.saveSnapshot({ provider: "claude", source: "claude-desktop-aggregate-cache", observedAt: NOW,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 61, windowMinutes: 10_080, resetsAt: null }] });
  const route = routeJob(s, "code", { now: NOW, record: false });
  assert.equal(route.lane, "claude");
  assert.match(route.reason, /34\.0% of the week left; its daily share is unknown/);
  assert.doesNotMatch(route.reason, /most daily share/);
  assert.match(route.lanes.find((l) => l.lane === "claude").reason, /reset time unknown/);
});

test("Claude's reset prefers the app's time over a newer status-line time", (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ug-claude-pref-"));
  const cachePath = path.join(home, "plan-usage-history.json");
  writeFileSync(cachePath, JSON.stringify({ samples: [{ t: NOW, u: { fh: 1, sd: 64 } }] }));
  const s = store(t);
  const app = Date.UTC(2026, 9, 22, 23, 0);
  const statusLine = Date.UTC(2026, 9, 22, 22, 42);
  s.saveSnapshot({ provider: "claude", source: "host-usage", observedAt: NOW - 2 * HOUR,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 63, windowMinutes: 10_080, resetsAt: app }] });
  s.saveSnapshot({ provider: "claude", source: "status-line", observedAt: NOW - HOUR,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 63, windowMinutes: 10_080, resetsAt: statusLine }] });
  const snapshot = syncClaudeDesktop(s, { cachePath });
  assert.equal(snapshot.windows.find((w) => w.key === "seven-day").resetsAt, app);
});

test("an hours-left figure snaps Claude's reset to the hour", () => {
  const now = Date.UTC(2026, 9, 21, 0, 17);
  assert.equal(claudeResetFromHours(now, 46.7), Date.UTC(2026, 9, 22, 23, 0));
  assert.equal(claudeResetFromHours(now, 46.4), Date.UTC(2026, 9, 22, 23, 0));
});
