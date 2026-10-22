import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dayStartAt, evaluateDailyBudget } from "../src/daily-budget.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { configureBackgroundMonitor } from "../src/install.mjs";
import { notifyDesktop } from "../src/monitor.mjs";
import { buildProviderDecision } from "../src/policy.mjs";
import { claudeDesktopUsagePath } from "../src/providers/claude-desktop.mjs";
import { GuardStore } from "../src/store.mjs";

const HOUR = 60 * 60_000;
const BRISBANE = { ...DEFAULT_CONFIG, dayTimeZone: "Australia/Brisbane" };
// 2026-10-20 11:00 Brisbane (UTC+10) = 01:00 UTC; day began 08:00 Brisbane = 22:00 UTC the day before.
const NOW = Date.UTC(2026, 9, 20, 1, 0);
const DAY_START = Date.UTC(2026, 9, 19, 22, 0);
const weekly = (usedPercent, resetsAt) => ({
  key: "seven-day", label: "weekly", usedPercent, windowMinutes: 10_080, resetsAt, observedAt: NOW, reservePercent: 5,
});

test("day boundary is 08:00 in the configured time zone", () => {
  assert.equal(dayStartAt(NOW, BRISBANE), DAY_START);
  assert.equal(dayStartAt(DAY_START - 1, BRISBANE), DAY_START - 24 * HOUR);
  assert.equal(dayStartAt(DAY_START, BRISBANE), DAY_START);
});

test("today's budget is what is left above the reserve split over the days left", () => {
  const resetsAt = DAY_START + 3 * 24 * HOUR; // three local days left, including today
  const history = [{ observedAt: DAY_START - HOUR, usedPercent: 59 }, { observedAt: NOW, usedPercent: 63 }];
  const daily = evaluateDailyBudget(weekly(63, resetsAt), history, BRISBANE, NOW);
  assert.equal(daily.daysLeft, 3);
  assert.equal(daily.usedAtDayStartPercent, 59);
  assert.equal(daily.todayBudgetPercent, 12); // (100 - 5 - 59) / 3
  assert.equal(daily.usedTodayPercent, 4);
  assert.equal(daily.remainingTodayPercent, 8);
  assert.equal(daily.spent, false);
  assert.ok(daily.rolledForwardPercent < 0, "spending ahead of the even share shrinks today's budget");
});

test("unspent days roll forward and overspend is reported as borrowed", () => {
  const resetsAt = DAY_START + 2 * 24 * HOUR;
  const history = [{ observedAt: DAY_START - HOUR, usedPercent: 15 }];
  const light = evaluateDailyBudget(weekly(15, resetsAt), history, BRISBANE, NOW);
  assert.equal(light.todayBudgetPercent, 40); // a light week leaves a large share for each remaining day
  const heavy = evaluateDailyBudget(weekly(60, resetsAt), history, BRISBANE, NOW);
  assert.equal(heavy.spent, true);
  assert.equal(heavy.borrowedPercent, 5);
});

test("a weekly window that began today starts from zero; five-hour windows have no daily share", () => {
  const resetsAt = NOW + 7 * 24 * HOUR - HOUR;
  const daily = evaluateDailyBudget(weekly(3, resetsAt), [], BRISBANE, NOW);
  assert.equal(daily.usedAtDayStartPercent, 0);
  assert.equal(daily.daysLeft, 7);
  assert.equal(evaluateDailyBudget({ ...weekly(3, resetsAt), windowMinutes: 300 }, [], BRISBANE, NOW), null);
  assert.equal(evaluateDailyBudget(weekly(3, null), [], BRISBANE, NOW), null);
  assert.equal(evaluateDailyBudget(weekly(3, resetsAt), [], { ...BRISBANE, dailyBudget: false }, NOW), null);
});

test("a spent daily share moves the provider to protect without blocking", () => {
  const store = new GuardStore({ filename: ":memory:" });
  store.setConfig({ dayTimeZone: "Australia/Brisbane" });
  const resetsAt = DAY_START + 3 * 24 * HOUR;
  const save = (observedAt, usedPercent) => store.saveSnapshot({
    provider: "codex", source: "test", observedAt,
    windows: [{ key: "seven-day", label: "weekly", usedPercent, windowMinutes: 10_080, resetsAt }],
  });
  save(DAY_START - HOUR, 59);
  save(NOW, 75);
  const decision = buildProviderDecision(store, "codex", { now: NOW });
  assert.equal(decision.state, "protect");
  assert.equal(decision.blocked, false);
  assert.equal(decision.daily.spent, true);
  assert.match(decision.reason, /Today's share of weekly is spent/);
  assert.match(decision.reason, /borrowed/);
  store.close();
});

test("Linux reads the Claude Desktop cache from XDG config", () => {
  assert.equal(
    claudeDesktopUsagePath({ platform: "linux", homeDir: "/home/a", env: {} }),
    "/home/a/.config/Claude/plan-usage-history.json",
  );
  assert.equal(
    claudeDesktopUsagePath({ platform: "linux", homeDir: "/home/a", env: { XDG_CONFIG_HOME: "/x" } }),
    "/x/Claude/plan-usage-history.json",
  );
});

test("Linux notifications use notify-send and fail soft", () => {
  const calls = [];
  const sent = notifyDesktop({ title: "Usage Guard", subtitle: "Codex: QUEUE", message: "m", state: "queue" }, {
    platform: "linux", commandRunner: (command, args) => calls.push([command, ...args]),
  });
  assert.equal(sent, true);
  assert.deepEqual(calls[0].slice(0, 3), ["notify-send", "--app-name=Usage Guard", "--urgency=critical"]);
  assert.equal(notifyDesktop({ title: "t", subtitle: "s", message: "m", state: "watch" }, {
    platform: "linux", commandRunner: () => { throw new Error("missing"); },
  }), false);
});

test("Linux monitor installs a systemd user timer for both providers", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-systemd-"));
  const calls = [];
  const monitor = configureBackgroundMonitor({
    home: path.join(root, "home"),
    stateHome: path.join(root, "state 100%"),
    runtime: { command: process.execPath, argsPrefix: ["/opt/usage guard.mjs"] },
    platform: "linux",
    env: {},
    commandRunner: (command, args) => { calls.push([command, ...args]); return { ok: true }; },
  });
  assert.equal(monitor.enabled, true);
  const service = readFileSync(monitor.servicePath, "utf8");
  assert.match(service, /ExecStart=".*" "\/opt\/usage guard\.mjs" "monitor" "--once" "--quiet" "--provider" "all"/);
  assert.match(service, /USAGE_GUARD_HOME=.*state 100%%/);
  assert.match(readFileSync(monitor.path, "utf8"), /OnUnitActiveSec=1min/);
  assert.deepEqual(calls.at(-1), ["systemctl", "--user", "enable", "--now", "usage-guard-monitor.timer"]);
});

test("a mid-day reset clears a spent share at the next reading", () => {
  const resetsAt = DAY_START + 3 * 24 * HOUR;
  const spentHistory = [{ observedAt: DAY_START - HOUR, usedPercent: 59 }, { observedAt: NOW - HOUR, usedPercent: 75 }];
  assert.equal(evaluateDailyBudget(weekly(75, resetsAt), spentHistory, BRISBANE, NOW - HOUR).spent, true);
  // The provider restores the allowance: the next reading shows 0% used.
  const daily = evaluateDailyBudget(weekly(0, resetsAt), [...spentHistory, { observedAt: NOW, usedPercent: 0 }], BRISBANE, NOW);
  assert.equal(daily.spent, false);
  assert.equal(daily.usedAtDayStartPercent, 0);
  assert.equal(daily.usedTodayPercent, 0);
  assert.ok(Math.abs(daily.todayBudgetPercent - 95 / 3) < 1e-9); // the whole allowance over the days left
});

test("after a reset, a same-day climb above the morning figure counts from the reset", () => {
  const resetsAt = DAY_START + 3 * 24 * HOUR;
  const history = [
    { observedAt: DAY_START - HOUR, usedPercent: 20 },
    { observedAt: NOW - 2 * HOUR, usedPercent: 30 },
    { observedAt: NOW - HOUR, usedPercent: 1 }, // reset
    { observedAt: NOW, usedPercent: 26 },
  ];
  const daily = evaluateDailyBudget(weekly(26, resetsAt), history, BRISBANE, NOW);
  assert.equal(daily.usedAtDayStartPercent, 1);
  assert.equal(daily.usedTodayPercent, 25); // not 6, as counting from the morning's 20 would say
  assert.equal(daily.baselineAt, NOW - HOUR);
});

test("a one-point wobble in a whole-% meter is not a reset", () => {
  const resetsAt = DAY_START + 3 * 24 * HOUR;
  const history = [{ observedAt: DAY_START - HOUR, usedPercent: 59 }, { observedAt: NOW - HOUR, usedPercent: 64 }, { observedAt: NOW, usedPercent: 63 }];
  assert.equal(evaluateDailyBudget(weekly(63, resetsAt), history, BRISBANE, NOW).usedAtDayStartPercent, 59);
});

test("a small dip that stays above the day's start is not a reset", () => {
  const resetsAt = DAY_START + 3 * 24 * HOUR;
  // A lagging source reads 56 after the API read 60; the day began at 50.
  const history = [{ observedAt: DAY_START - HOUR, usedPercent: 50 }, { observedAt: NOW - HOUR, usedPercent: 60 }, { observedAt: NOW - 30 * 60_000, usedPercent: 56 }];
  assert.equal(evaluateDailyBudget(weekly(60, resetsAt), [...history, { observedAt: NOW, usedPercent: 60 }], BRISBANE, NOW).usedAtDayStartPercent, 50);
});

test("a reading still showing last period's reset time is not a mid-period drop", () => {
  const resetsAt = NOW + 7 * 24 * HOUR - 2 * HOUR; // this week began 2 hours ago, after the day start
  const history = [
    { observedAt: NOW - HOUR, usedPercent: 92, resetsAt: NOW - 2 * HOUR }, // lagging: old period
    { observedAt: NOW - 30 * 60_000, usedPercent: 3, resetsAt },
  ];
  assert.equal(evaluateDailyBudget(weekly(5, resetsAt), history, BRISBANE, NOW).usedAtDayStartPercent, 0);
});

test("sources that disagree by more than 10 points are not a reset", () => {
  const resetsAt = DAY_START + 3 * 24 * HOUR;
  const oauth = "claude-oauth-usage";
  const history = [
    { observedAt: DAY_START - HOUR, usedPercent: 30, source: oauth },
    { observedAt: NOW - 2 * HOUR, usedPercent: 60, source: oauth },
    { observedAt: NOW - HOUR, usedPercent: 45, source: "claude-desktop-aggregate-cache" },
  ];
  const daily = evaluateDailyBudget({ ...weekly(60, resetsAt), source: oauth }, history, BRISBANE, NOW);
  assert.equal(daily.usedAtDayStartPercent, 30);
  assert.equal(daily.usedTodayPercent, 30);
});
