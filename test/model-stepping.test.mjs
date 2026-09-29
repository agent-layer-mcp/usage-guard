import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONFIG, DEFAULT_MODEL_LADDERS, CONFIG_SCHEMA, normalizeConfig } from "../src/config.mjs";
import { buildProviderDecision, buildStatus } from "../src/policy.mjs";
import { classifyRole, quietHoursActive } from "../src/model-stepping.mjs";
import { GuardStore } from "../src/store.mjs";

const START = Date.UTC(2026, 8, 29, 12);
function meter(store, { provider = "claude", now = START, short = 80, weekly = 80, shortReset = null, weeklyReset = null } = {}) {
  store.saveSnapshot({
    provider, source: "test", observedAt: now,
    windows: [
      { key: "five-hour", label: "5 hour", usedPercent: 100 - short - 8, windowMinutes: 300, resetsAt: shortReset },
      { key: "weekly", label: "weekly", usedPercent: 100 - weekly - 5, windowMinutes: 10_080, resetsAt: weeklyReset },
    ],
  });
}
function fixture(t, patch = {}) {
  const store = new GuardStore({ filename: ":memory:" });
  t.after(() => store.close());
  store.setConfig({ rapidBurnStepDown: false, ...patch });
  return store;
}
function decision(store, options = {}) {
  return buildProviderDecision(store, options.provider || "claude", { now: START, ...options });
}

test("stepping defaults on with exact provider IDs, safe effort and all config in MCP schema", () => {
  const config = normalizeConfig();
  assert.equal(config.modelStepping, true);
  assert.equal(config.qualityLock, false);
  assert.equal(config.quietHours, null);
  assert.deepEqual(Object.keys(CONFIG_SCHEMA.properties).sort(), Object.keys(config).sort());
  assert.deepEqual(config.modelLadders.claude.map((r) => r.model), [
    "claude-opus-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001",
  ]);
  assert.deepEqual(config.modelLadders.codex.map((r) => r.model), ["gpt-6-astra", "gpt-6-sol", "gpt-6-sol", "gpt-6-luna"]);
  for (const ladder of Object.values(config.modelLadders)) {
    assert.ok(ladder.every((r) => !/fable|gpt-5\.5/.test(r.model)));
    assert.ok(ladder.slice(1).every((r) => !["max", "xhigh"].includes(r.effort)));
  }
  config.modelLadders.claude[0].model = "changed";
  assert.equal(DEFAULT_MODEL_LADDERS.claude[0].model, "claude-opus-5-5");
});

for (const [usable, expected] of [[40, 1], [39.9, 2], [25, 2], [24.9, 3], [12, 3], [11.9, 4]]) {
  test(`5-hour usable ${usable}% chooses quota rung ${expected}`, (t) => {
    const store = fixture(t);
    meter(store, { short: usable });
    const value = decision(store, { role: "standard" });
    assert.equal(value.quotaRung, expected);
    assert.equal(value.recommendedRung, Math.min(3, expected));
    assert.equal(value.routineRung, Math.min(4, expected + 1));
  });
}
for (const [usable, expected] of [[30, 1], [29.9, 2], [10, 2], [9.9, 4]]) {
  test(`weekly usable ${usable}% chooses quota rung ${expected}`, (t) => {
    const store = fixture(t);
    meter(store, { weekly: usable });
    assert.equal(decision(store).quotaRung, expected);
  });
}
test("the worse window wins even when the 5-hour meter is healthy", (t) => {
  const store = fixture(t);
  meter(store, { short: 80, weekly: 9 });
  assert.equal(decision(store).quotaRung, 4);
  meter(store, { now: START + 60_000, short: 20, weekly: 70 });
  assert.equal(decision(store, { now: START + 60_000 }).quotaRung, 3);
});
test("thresholds apply after reserves, not raw remaining percentages", (t) => {
  const store = fixture(t);
  meter(store, { short: 35 }); // 43% raw remaining, minus 8 reserve.
  const value = decision(store);
  assert.equal(value.quotaRung, 2);
  assert.match(value.modelReason, /usable 35\.0%/);
});
test("routine work steps down first while protected roles never fall below rung 2", (t) => {
  const store = fixture(t);
  meter(store);
  assert.equal(decision(store).recommendedRung, 1);
  assert.equal(decision(store).routineRung, 2);
  meter(store, { short: 4, now: START + 60_000 });
  for (const prompt of ["Plan the feature", "Architecture decisions", "Review finished work", "Inspect money calculations", "Fix a security bug", "Search children's data", "Summarize production changes"]) {
    const value = decision(store, { now: START + 60_000, prompt, role: "routine" });
    assert.equal(value.recommendedRung, 2, prompt);
    assert.equal(value.recommendedEffort, "high");
    assert.equal(value.routineRung, 4);
  }
  for (const prompt of ["Search files", "Run tests", "Read files", "Mechanical edits", "Summarize findings"]) {
    const value = decision(store, { now: START + 60_000, prompt });
    assert.equal(value.taskRole, "routine", prompt);
    assert.equal(value.recommendedRung, 4, prompt);
    assert.equal(value.recommendedEffort, "default");
  }
});
test("floor is routine-only and bounded despite stacked pressure", (t) => {
  const store = fixture(t, { quietHours: { start: "00:00", end: "23:59", timeZone: "UTC", extraRungs: 3 }, routineStepDownRungs: 3 });
  meter(store, { short: 2, weekly: 2 });
  assert.equal(decision(store).recommendedRung, 2);
  assert.equal(decision(store, { role: "standard" }).recommendedRung, 3);
  assert.equal(decision(store, { role: "routine" }).recommendedRung, 4);
  assert.equal(decision(store).routineRung, 4);
});
test("Codex recommendations use the configured GPT-6 ladder", (t) => {
  const store = fixture(t);
  meter(store, { provider: "codex", short: 20 });
  const value = decision(store, { provider: "codex", role: "standard" });
  assert.equal(value.recommendedModel, "gpt-6-sol");
  assert.equal(value.recommendedEffort, "medium");
  assert.equal(value.routineModel, "gpt-6-luna");
  assert.equal(value.routineEffort, "high");
});
test("rapid-burn warning steps down an extra rung without ratcheting on each read", (t) => {
  const store = fixture(t, { rapidBurnStepDown: true });
  meter(store, { now: START - 10 * 60_000, short: 80 });
  meter(store, { short: 50 });
  assert.equal(decision(store).quotaRung, 2);
  assert.equal(decision(store).quotaRung, 2);
  assert.match(decision(store).modelReason, /rapid burn/);
  store.setConfig({ rapidBurnStepDown: false });
  assert.equal(decision(store).quotaRung, 1);
});
test("quiet hours support midnight, local time, IANA zones, and ending without hysteresis", (t) => {
  const quiet = { start: "22:00", end: "07:00", timeZone: "Australia/Brisbane", extraRungs: 1 };
  assert.equal(quietHoursActive(quiet, Date.UTC(2026, 8, 29, 12)), true);
  assert.equal(quietHoursActive(quiet, Date.UTC(2026, 8, 29, 20, 59)), true);
  assert.equal(quietHoursActive(quiet, Date.UTC(2026, 8, 29, 21)), false);
  const local22 = new Date(2026, 8, 29, 22).getTime();
  assert.equal(quietHoursActive({ ...quiet, timeZone: null }, local22), true);
  assert.equal(quietHoursActive(null, local22), false);
  assert.equal(quietHoursActive({ start: "09:00", end: "17:00" }, new Date(2026, 8, 29, 12).getTime()), true);
  const store = fixture(t, { quietHours: quiet });
  meter(store);
  assert.equal(decision(store).quotaRung, 2);
  const morning = Date.UTC(2026, 8, 29, 21);
  meter(store, { now: morning });
  assert.equal(decision(store, { now: morning }).quotaRung, 1);
});
test("5-hour step-up hysteresis requires a full 10-point margin for each rung", (t) => {
  const store = fixture(t);
  for (const [i, [short, expected]] of [[11, 4], [12, 4], [21.9, 4], [22, 3], [34.9, 3], [35, 2], [49.9, 2], [50, 1]].entries()) {
    const now = START + i * 60_000;
    meter(store, { now, short });
    assert.equal(decision(store, { now }).quotaRung, expected, `${short}%`);
  }
});
test("weekly hysteresis skips the absent middle rung and survives a short-window reset", (t) => {
  const store = fixture(t);
  meter(store, { short: 11, weekly: 9, shortReset: START + 60_000, weeklyReset: START + 6 * 86400_000 });
  assert.equal(decision(store).quotaRung, 4);
  meter(store, { now: START + 2 * 60_000, short: 45, weekly: 19, shortReset: START + 300 * 60_000, weeklyReset: START + 6 * 86400_000 });
  assert.equal(decision(store, { now: START + 2 * 60_000 }).quotaRung, 4);
  meter(store, { now: START + 3 * 60_000, short: 80, weekly: 20 });
  assert.equal(decision(store, { now: START + 3 * 60_000 }).quotaRung, 2);
  meter(store, { now: START + 4 * 60_000, weekly: 40 });
  assert.equal(decision(store, { now: START + 4 * 60_000 }).quotaRung, 1);
});
test("confirmed reset releases only that window's recovery latch", (t) => {
  const store = fixture(t);
  meter(store, { short: 39, shortReset: START + 60_000 });
  assert.equal(decision(store).quotaRung, 2);
  meter(store, { now: START + 2 * 60_000, short: 45, shortReset: START + 300 * 60_000 });
  assert.equal(decision(store, { now: START + 2 * 60_000 }).quotaRung, 1);
});
test("reset metadata changing early does not falsely release hysteresis", (t) => {
  const store = fixture(t);
  meter(store, { short: 39, shortReset: START + 200 * 60_000 });
  decision(store);
  meter(store, { now: START + 60_000, short: 45, shortReset: START + 201 * 60_000 });
  assert.equal(decision(store, { now: START + 60_000 }).quotaRung, 2);
});
test("reserve pauses even protected work and cheap routine subagents", (t) => {
  const store = fixture(t);
  for (const quota of [{ short: 0 }, { weekly: 0 }]) {
    meter(store, quota);
    for (const role of ["review", "routine"]) {
      const value = decision(store, { role });
      assert.equal(value.blocked, true);
      assert.match(value.instructions, /handover/);
      assert.match(value.instructions, /Do not spawn subagents/);
    }
  }
});
test("missing, expired or individually stale quota windows never produce a model recommendation", (t) => {
  const store = fixture(t);
  assert.equal(decision(store).recommendedModel, null);
  meter(store, { shortReset: START - 60_000 });
  assert.equal(decision(store).recommendedModel, null);
  store.clear();
  meter(store, { now: START - 20 * 60_000 });
  store.saveSnapshot({ provider: "claude", source: "test", observedAt: START, windows: [{ key: "five-hour", label: "5 hour", usedPercent: 20, windowMinutes: 300 }] });
  const value = decision(store);
  assert.equal(value.stale, true);
  assert.equal(value.recommendedModel, null);
  assert.equal(value.blocked, false);
});
test("authoritative Codex refresh retires obsolete buckets without deleting their history", (t) => {
  const store = fixture(t);
  const old = { key: "codex_bengalfox:primary", label: "GPT-5.3-Codex-Spark 5 hour", usedPercent: 99, windowMinutes: 300, resetsAt: null };
  store.saveSnapshot({ provider: "codex", source: "old-meter", observedAt: START - 86400_000, model: "gpt-5.3-codex-spark", windows: [old] });
  const windows = [{ key: "codex:primary", label: "weekly", usedPercent: 20, windowMinutes: 10_080, resetsAt: null }];
  store.saveSnapshot({ provider: "codex", source: "codex-app-server", observedAt: START, model: "gpt-6-sol", effort: "medium", windows, authoritativeWindows: true });
  assert.deepEqual(store.latest("codex").map((w) => w.key), ["codex:primary"]);
  assert.equal(store.history("codex", old.key, null, 0).length, 1);
  assert.equal(decision(store, { provider: "codex" }).recommendedModel, "gpt-6-astra");
  store.saveSnapshot({ provider: "codex", source: "late-response", observedAt: START - 60_000, windows: [old], authoritativeWindows: true });
  assert.deepEqual(store.latest("codex").map((w) => w.key), ["codex:primary"]);
});
test("quality lock takes precedence with the unchanged legacy provider output", (t) => {
  const store = fixture(t, { qualityLock: true });
  meter(store, { short: 0 });
  const value = decision(store, { prompt: "Review a security migration" });
  assert.equal(value.qualityLocked, true);
  assert.equal(value.blocked, true);
  assert.equal(value.taskClass, "high-reasoning");
  assert.equal("recommendedModel" in value, false);
  assert.equal("modelStepping" in value, false);
  assert.equal(value.instructions, "Quality lock is on: do not lower the active model or reasoning effort. Do not begin quota-heavy work. Preserve the request for the next reset; lightweight local inspection and deterministic checks may continue.");
  const status = buildStatus(store, { now: START });
  assert.equal("overnightSummary" in status, false);
  assert.equal(status.recentDecisions.some((d) => d.type === "model-step"), false);
  assert.deepEqual(store.recentModelSteps(), []);
});
test("fresh reserve stop wins even while another quota window is stale", (t) => {
  const store = fixture(t);
  meter(store, { now: START - 20 * 60_000 });
  store.saveSnapshot({ provider: "claude", source: "test", observedAt: START, windows: [{ key: "five-hour", label: "5 hour", usedPercent: 95, windowMinutes: 300 }] });
  const value = decision(store);
  assert.equal(value.blocked, true);
  assert.equal(value.quotaState, "queue");
  assert.equal(value.recommendedModel, null);
  assert.match(value.instructions, /Do not spawn subagents/);
});
test("changing queried roles never creates phantom overnight steps", (t) => {
  const store = fixture(t);
  meter(store, { short: 11 });
  decision(store);
  const initial = store.recentModelSteps().length;
  for (let i = 0; i < 10; i++) {
    decision(store, { role: "routine" });
    decision(store, { role: "standard" });
    buildStatus(store, { now: START });
    decision(store, { role: "review" });
  }
  assert.equal(store.recentModelSteps().length, initial);
  assert.match(buildStatus(store, { now: START }).overnightSummary, /1 model recommendation\(s\) down, 0 up/);
});
test("disabling both stepping and lock preserves the chosen model", (t) => {
  const store = fixture(t, { modelStepping: false });
  meter(store);
  assert.equal("recommendedModel" in decision(store), false);
  assert.match(decision(store).instructions, /current model choice/);
});
test("history persists through process restarts, deduplicates and survives frequent status calls", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "usage-guard-steps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "guard.sqlite3");
  let store = new GuardStore({ filename });
  store.setConfig({ rapidBurnStepDown: false });
  meter(store, { short: 39 });
  decision(store, { prompt: "secret prompt with source_code_xyz" });
  const count = store.recentModelSteps().length;
  for (let i = 0; i < 30; i++) decision(store, { prompt: "secret prompt with source_code_xyz" });
  assert.equal(store.recentModelSteps().length, count);
  store.close();
  store = new GuardStore({ filename });
  t.after(() => store.close());
  meter(store, { now: START + 60_000, short: 49 });
  assert.equal(decision(store, { now: START + 60_000 }).quotaRung, 2);
  meter(store, { now: START + 120_000, short: 50 });
  const status = buildStatus(store, { now: START + 120_000 });
  assert.ok(status.recentDecisions.some((d) => d.type === "model-step" && d.direction === "up"));
  const step = status.recentDecisions.find((d) => d.type === "model-step");
  assert.equal(step.quota[0].usablePercent, 50);
  assert.equal(step.applied, false);
  assert.equal(step.createdAt, START + 120_000);
  assert.match(status.overnightSummary, /Last 12 hours/);
  for (const table of ["model_steps", "model_stepping_state", "decisions"]) {
    const serialized = JSON.stringify(store.database.prepare(`SELECT * FROM ${table}`).all());
    assert.doesNotMatch(serialized, /secret prompt|source_code_xyz/);
  }
});
test("upgrade replaces the old fixed default once, then preserves an explicit lock", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "usage-guard-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "guard.sqlite3");
  const old = new DatabaseSync(filename);
  old.exec("CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO config VALUES ('qualityLock', 'true'), ('fiveHourReservePercent', '12');");
  old.close();
  const upgraded = new GuardStore({ filename });
  assert.equal(upgraded.getConfig().qualityLock, false);
  assert.equal(upgraded.getConfig().modelStepping, true);
  assert.equal(upgraded.getConfig().fiveHourReservePercent, 12);
  upgraded.setConfig({ qualityLock: true });
  upgraded.close();
  const reopened = new GuardStore({ filename });
  assert.equal(reopened.getConfig().qualityLock, true);
  reopened.close();
});
test("custom settings work and unsafe, malformed or unknown settings fail atomically", (t) => {
  const store = fixture(t);
  store.setConfig({ fiveHourStepDownThresholds: [60, 40, 20], weeklyStepDownThresholds: [50, 20], stepUpMarginPercent: 5, protectedMaxRung: 1, routineStepDownRungs: 2 });
  meter(store, { short: 55 });
  const value = decision(store);
  assert.equal(value.quotaRung, 2);
  assert.equal(value.recommendedRung, 1);
  assert.equal(value.routineRung, 4);
  const config = store.getConfig();
  for (const patch of [
    { qualityLock: "false" }, { prompt: "do not store me" }, { fiveHourStepDownThresholds: [12, 25, 40] },
    { fiveHourStepDownThresholds: [40, 25] }, { weeklyStepDownThresholds: [30, 30] },
    { protectedMaxRung: 3 }, { quietHours: { start: "25:00", end: "07:00" } },
    { quietHours: { start: "22:00", end: "22:00" } }, { quietHours: { start: "22:00", end: "07:00", timeZone: "invalid-zone" } },
  ]) assert.throws(() => store.setConfig(patch));
  const badLadder = structuredClone(DEFAULT_MODEL_LADDERS);
  badLadder.claude[1].effort = "max";
  assert.throws(() => store.setConfig({ modelLadders: badLadder }), /max or xhigh/);
  badLadder.claude[1].effort = "xhigh";
  assert.throws(() => store.setConfig({ modelLadders: badLadder }), /max or xhigh/);
  badLadder.claude[1].effort = "high";
  badLadder.claude[3].effort = "medium";
  assert.throws(() => store.setConfig({ modelLadders: badLadder }), /Haiku/);
  assert.deepEqual(store.getConfig(), config);
});
test("switching instructions describe authorization, exact choices and safe boundaries", (t) => {
  const store = fixture(t);
  meter(store, { short: 20 });
  const value = decision(store);
  assert.match(value.instructions, /already authorized/);
  assert.match(value.instructions, /claude-sonnet-5-5/);
  assert.match(value.instructions, /switch only between tasks/);
  assert.match(value.instructions, /omit the effort parameter/);
  assert.match(value.instructions, /does not itself switch/);
  assert.doesNotMatch(value.instructions, /explicitly approve a change/);
  assert.equal(classifyRole("search payment code", "routine"), "sensitive");
});
