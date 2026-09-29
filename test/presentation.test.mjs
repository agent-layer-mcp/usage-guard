import test from "node:test";
import assert from "node:assert/strict";
import { formatStatusLine, formatStatusText } from "../src/presentation.mjs";

test("status surfaces show current session context pressure", () => {
  const decision = {
    provider: "claude",
    state: "protect",
    action: "compact-at-safe-boundary",
    reason: "Context pressure.",
    resetAt: null,
    windows: [],
    contextState: "protect",
    context: {
      contextPercent: 88,
      stale: false,
    },
  };

  assert.match(formatStatusLine(decision, { color: false }), /ctx 88%/);
  const text = formatStatusText({
    config: { enforcement: "protect", qualityLock: true },
    providers: [decision],
  });
  assert.match(text, /session context\s+88\.0% used\s+protect/);
});

test("status surfaces fresh local request cost drivers with a quota caveat", () => {
  const text = formatStatusText({
    config: { enforcement: "protect", qualityLock: true },
    providers: [],
    diagnostics: {
      claudeRequest: {
        stale: false,
        contextTokens: 566_691,
        imageCount: 143,
        weightedInputEquivalentMin: 737_000,
        weightedInputEquivalentMax: 1_179_000,
        cacheWriteTtl: "unknown",
        microcompactDisabled: true,
        weighting: {
          caveat: "API-equivalent weighting; subscription quota weighting is not public.",
        },
      },
      requestImpact: {
        quotaPercentPerRequest: 0.5,
        estimatedCallsUntilReserve: 180,
        compactionRecommended: true,
        caveat: "Directional estimate: account burn may include other sessions or devices.",
      },
    },
  });

  assert.match(text, /Context tokens\s+566,691/);
  assert.match(text, /Resident images\s+143/);
  assert.match(text, /subscription quota weighting is not public/i);
  assert.match(text, /Estimated quota\/call\s+0\.50%/);
  assert.match(text, /Calls to reserve\s+~180/);
  assert.match(text, /compact at next safe boundary/i);
});

test("stepping status surfaces main and routine models, reason, and overnight summary", () => {
  const decision = {
    provider: "codex", state: "watch", action: "trim-context", reason: "Quota approaching threshold.",
    resetAt: null, windows: [], context: null, modelStepping: true,
    recommendedModel: "gpt-6-sol", recommendedEffort: "high",
    routineModel: "gpt-6-luna", routineEffort: "high",
    modelReason: "5-hour usable 25.0%; main rung 2, routine rung 4.",
  };
  const line = formatStatusLine(decision, { color: false });
  assert.match(line, /main gpt-6-sol \(high\)/);
  assert.match(line, /routine gpt-6-luna \(high\)/);
  assert.doesNotMatch(line, /quality locked/i);
  const text = formatStatusText({
    config: { enforcement: "protect", qualityLock: false, modelStepping: true, compactionHandoffEnabled: false },
    providers: [decision],
    overnightSummary: "Last 12 hours: 2 model recommendations down, 1 up.",
  });
  assert.match(text, /Model stepping: on/);
  assert.match(text, /Main thread: gpt-6-sol \(high\)/);
  assert.match(text, /Routine subagents: gpt-6-luna \(high\)/);
  assert.match(text, /Model reason: 5-hour usable 25\.0%/);
  assert.match(text, /Overnight: Last 12 hours/);
});
