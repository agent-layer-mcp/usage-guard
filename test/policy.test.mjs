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
