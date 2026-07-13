import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../src/time.mjs";

test("duration rounding carries minutes into the next hour", () => {
  assert.equal(formatDuration(119.9), "2h");
  assert.equal(formatDuration(61.1), "1h 2m");
  assert.equal(formatDuration(59.2), "1h");
});
