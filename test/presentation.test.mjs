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
