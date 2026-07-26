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
        weightedInputEquivalent: 737_000,
        microcompactDisabled: true,
        weighting: {
          caveat: "Directional API-equivalent weighting; subscription quota weighting is not public.",
        },
      },
    },
  });

  assert.match(text, /Context tokens\s+566,691/);
  assert.match(text, /Resident images\s+143/);
  assert.match(text, /subscription quota weighting is not public/i);
});
