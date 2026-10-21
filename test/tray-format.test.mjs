import test from "node:test";
import assert from "node:assert/strict";
import { countdown, hermesText, paceText, staleText, statusPill, todayText, weekText } from "../tray/ui/format.js";

const NOW = Date.UTC(2026, 9, 21, 0, 0);
const daily = { usedTodayPercent: 2, todayBudgetPercent: 13.1, remainingTodayPercent: 11.1, borrowedPercent: 0, spent: false };
const week = { windowMinutes: 10_080, usedPercent: 14, reservePercent: 5, resetsAt: NOW + (6 * 24 + 6) * 60 * 60_000, paceRatio: 1.94 };

test("today shows points of today's share, the share percent and points left", () => {
  assert.deepEqual(todayText(daily), {
    figure: "2.0 of 13.1 pts",
    detail: "15% of today's share used (±1 pt) · 11.1 pts left today.",
  });
  const spent = todayText({ ...daily, usedTodayPercent: 15, remainingTodayPercent: 0, borrowedPercent: 1.9, spent: true });
  assert.match(spent.detail, /^Today's share is used up \(115% of it\), 1\.9 pts borrowed from later days\. New work goes to another lane/);
  assert.equal(todayText(null).figure, "no share yet");
});

test("week shows used, left, reserve and the reset countdown", () => {
  assert.deepEqual(weekText(week, NOW), {
    figure: "14% used",
    detail: "14% used · 86% left (5% kept in reserve) · resets in 6d 6h.",
  });
  assert.equal(weekText(undefined), null);
  assert.equal(countdown(NOW + 90 * 60_000, NOW), "1h 30m");
});

test("the status pill never shows a bare policy state", () => {
  const base = { daily, windows: [week] };
  assert.deepEqual(statusPill({ ...base, state: "safe" }), { tone: "good", text: "On track" });
  assert.deepEqual(statusPill({ ...base, state: "protect" }), { tone: "warn", text: "Pace warning · still taking work" });
  assert.deepEqual(statusPill({ ...base, state: "protect", daily: { ...daily, spent: true } }), { tone: "spent", text: "Today's share spent" });
  assert.deepEqual(statusPill({ ...base, state: "queue" }), { tone: "paused", text: "Paused · reserve reached" });
  assert.deepEqual(statusPill({ ...base, state: "safe" }, { paused: true }), { tone: "paused", text: "Paused" });
  assert.equal(statusPill({ ...base, state: "stale" }).text, "No fresh reading");
});

test("pace is explained as a warning with the recommended model", () => {
  const provider = { state: "protect", daily, windows: [week], recommendedModel: "claude-sonnet-5-5", recommendedEffort: "high" };
  assert.equal(paceText(provider),
    "Pace: using the week at 1.9x the steady rate in the last few hours. Models step down one level until it slows. Next model here: claude-sonnet-5-5 (high).");
  assert.equal(paceText({ ...provider, state: "safe" }), "Next model here: claude-sonnet-5-5 (high).");
});

test("Hermes shows dollars spent against the cap", () => {
  const open = hermesText({ available: true, spentTodayUsd: 0.4, dailyCapUsd: 5, reason: "Under today's cap." });
  assert.equal(open.pill, "Open · under cap");
  assert.equal(open.figure, "$0.40 of $5.00");
  assert.match(open.detail, /^\$0\.40 spent today · \$4\.60 left\./);
  assert.equal(hermesText({ available: false, spentTodayUsd: 5.2, dailyCapUsd: 5 }).pill, "Cap reached");
  assert.equal(hermesText({ available: false, spentTodayUsd: null, reason: "No key." }).pill, "Not set up");
});

test("a stale lane says how old its figures are", () => {
  const now = Date.UTC(2026, 9, 21, 8, 10);
  const text = staleText({ provider: "claude", stale: true, lastReadingAt: now - (4 * 60 + 14) * 60_000 }, now);
  assert.match(text, /^Figures are from the last reading at .+ \(4h 14m ago\)\. Claude gets new work only after lanes with fresh readings/);
  assert.equal(staleText({ provider: "codex", stale: false }), null);
});
