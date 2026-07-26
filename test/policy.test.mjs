import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderDecision, classifyTask, evaluateWindow } from "../src/policy.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { GuardStore } from "../src/store.mjs";

test("classifies quality-sensitive work without storing prompt text", () => {
  assert.equal(classifyTask("Debug an authentication race condition"), "high-reasoning");
  assert.equal(classifyTask("Fix formatting and a README typo"), "mechanical");
  assert.equal(classifyTask("Build the settings page"), "standard");
});

test("queues new work at the protected reserve without lowering quality", () => {
  const now = Date.UTC(2026, 6, 14);
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    model: "Opus",
    effort: "high",
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 93, windowMinutes: 300, resetsAt: now + 60 * 60_000 }],
  });

  const decision = buildProviderDecision(store, "claude", {
    now,
    prompt: "Review a security migration",
  });
  assert.equal(decision.state, "queue");
  assert.equal(decision.blocked, true);
  assert.equal(decision.qualityLocked, true);
  assert.match(decision.instructions, /do not lower/i);
  assert.match(decision.instructions, /Do not begin quota-heavy work/i);
  store.close();
});

test("marks fast burn as protect before the reserve is reached", () => {
  const now = Date.UTC(2026, 6, 14);
  const observation = {
    provider: "codex",
    key: "codex:primary",
    label: "5 hour",
    usedPercent: 55,
    windowMinutes: 300,
    resetsAt: now + 180 * 60_000,
    observedAt: now,
  };
  const window = evaluateWindow(observation, [
    { ...observation, usedPercent: 35, observedAt: now - 20 * 60_000 },
    observation,
  ], DEFAULT_CONFIG, now);

  assert.equal(window.state, "protect");
  assert.ok(window.paceRatio > 1.3);
});

test("protects rapid Claude Desktop burn without reset metadata", () => {
  const now = Date.UTC(2026, 6, 26, 20, 52);
  const observation = {
    provider: "claude",
    key: "five-hour",
    label: "5 hour",
    usedPercent: 53,
    windowMinutes: 300,
    resetsAt: null,
    observedAt: now,
  };
  const window = evaluateWindow(observation, [
    { ...observation, usedPercent: 13, observedAt: now - 10 * 60_000 },
    observation,
  ], DEFAULT_CONFIG, now);

  assert.equal(window.state, "protect");
  assert.equal(window.paceRatio, null);
  assert.ok(window.minutesUntilReserve < 10);
});

test("replays the reported Claude Desktop exhaustion as watch then protect", () => {
  const store = new GuardStore({ filename: ":memory:" });
  const base = Date.UTC(2026, 6, 25, 20, 32, 7);
  const points = [
    [0, 0, "safe"],
    [5, 7, "watch"],
    [10, 13, "watch"],
    [20, 53, "protect"],
    [25, 75, "protect"],
    [45, 78, "watch"],
    [50, 96, "queue"],
  ];

  for (const [minutes, usedPercent, expected] of points) {
    const now = base + minutes * 60_000;
    store.saveSnapshot({
      provider: "claude",
      source: "claude-desktop-cache",
      observedAt: now,
      windows: [{
        key: "five-hour",
        label: "5 hour",
        usedPercent,
        windowMinutes: 300,
        resetsAt: null,
      }],
    });
    const decision = buildProviderDecision(store, "claude", { now });
    assert.equal(decision.quotaState, expected, `${usedPercent}% should be ${expected}`);
  }
  store.close();
});

test("estimates burn from the nearest useful recent sample", () => {
  const now = Date.UTC(2026, 6, 14);
  const observation = {
    provider: "codex",
    key: "codex:primary",
    label: "5 hour",
    usedPercent: 50,
    windowMinutes: 300,
    resetsAt: now + 180 * 60_000,
    observedAt: now,
  };
  const window = evaluateWindow(observation, [
    { ...observation, usedPercent: 0, observedAt: now - 60 * 60_000 },
    { ...observation, usedPercent: 40, observedAt: now - 10 * 60_000 },
    observation,
  ], DEFAULT_CONFIG, now);

  assert.equal(window.burnPercentPerMinute, 1);
});

test("stale signals never trigger a blocking decision", () => {
  const now = Date.UTC(2026, 6, 14);
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "codex",
    source: "test",
    observedAt: now - 60 * 60_000,
    windows: [{ key: "codex:primary", label: "weekly", usedPercent: 99, windowMinutes: 10_080, resetsAt: now + 60 * 60_000 }],
  });
  const decision = buildProviderDecision(store, "codex", { now });
  assert.equal(decision.state, "stale");
  assert.equal(decision.blocked, false);
  store.close();
});

test("keeps parallel Claude session context isolated", () => {
  const now = Date.UTC(2026, 6, 14);
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent: 10,
      windowMinutes: 300,
      resetsAt: now + 240 * 60_000,
    }],
  });
  store.saveContextObservation({
    provider: "claude",
    sessionId: "large-session",
    contextPercent: 89,
    observedAt: now,
    source: "test",
  });
  store.saveContextObservation({
    provider: "claude",
    sessionId: "fresh-session",
    contextPercent: 12,
    observedAt: now,
    source: "test",
  });

  const large = buildProviderDecision(store, "claude", {
    now,
    sessionId: "large-session",
  });
  const fresh = buildProviderDecision(store, "claude", {
    now,
    sessionId: "fresh-session",
  });

  assert.equal(large.state, "protect");
  assert.equal(large.quotaState, "safe");
  assert.equal(large.contextState, "protect");
  assert.equal(large.action, "compact-at-safe-boundary");
  assert.equal(large.blocked, false);
  assert.match(large.instructions, /durable handoff/i);
  assert.equal(fresh.state, "safe");
  assert.equal(fresh.contextState, "safe");
  assert.doesNotMatch(fresh.instructions, /durable handoff/i);
  store.close();
});

test("does not reuse another session's context when an exact session is unknown", () => {
  const now = Date.UTC(2026, 6, 14);
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent: 10,
      windowMinutes: 300,
      resetsAt: now + 240 * 60_000,
    }],
  });
  store.saveContextObservation({
    provider: "claude",
    sessionId: "other-session",
    contextPercent: 95,
    observedAt: now,
    source: "test",
  });

  const decision = buildProviderDecision(store, "claude", {
    now,
    sessionId: "unknown-session",
  });
  assert.equal(decision.state, "safe");
  assert.equal(decision.context, null);
  store.close();
});
