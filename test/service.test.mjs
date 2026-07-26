import test from "node:test";
import assert from "node:assert/strict";
import { estimateRequestImpact } from "../src/service.mjs";

test("request impact estimates quota per call and recommends economic compaction", () => {
  const impact = estimateRequestImpact({
    windows: [{
      key: "five-hour",
      windowMinutes: 300,
      burnPercentPerMinute: 2,
      usablePercent: 90,
    }],
  }, {
    stale: false,
    recentRequestCount: 40,
    recentElapsedMinutes: 10,
    contextTokens: 566_691,
    imageCount: 139,
  });

  assert.equal(impact.quotaPercentPerRequest, 0.5);
  assert.equal(impact.estimatedCallsUntilReserve, 180);
  assert.equal(impact.compactionRecommended, true);
});

test("request impact stays unavailable without enough correlated requests", () => {
  assert.equal(estimateRequestImpact({ windows: [] }, {
    stale: false,
    recentRequestCount: 1,
    recentElapsedMinutes: 1,
  }), null);
});
