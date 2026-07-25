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
