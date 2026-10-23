import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTestOutput } from "../src/test-run.mjs";

test("empty output yields no failures or tail", () => {
  assert.deepEqual(summarizeTestOutput("", 0), { passed: true, exitCode: 0, failures: [], tail: [] });
  assert.deepEqual(summarizeTestOutput("", 1), { passed: false, exitCode: 1, failures: [], tail: [] });
});

test("passing-only output has no failures", () => {
  const tap = ["TAP version 13", "ok 1 - adds", "ok 2 - subtracts", "# pass 2"].join("\n");
  assert.deepEqual(summarizeTestOutput(tap, 0), { passed: true, exitCode: 0, failures: [], tail: [] });
  // A non-zero exit with nothing recognised falls back to the tail.
  assert.deepEqual(summarizeTestOutput(tap, 1).tail, tap.split("\n"));
});

test("TAP with several not-ok blocks captures each name and short error", () => {
  const tap = [
    "TAP version 13",
    "ok 1 - adds",
    "not ok 2 - alpha",
    "  ---",
    "  duration_ms: 1.2",
    "  error: 'alpha broke'",
    "  ...",
    "not ok 3 - beta",
    "  error: 'beta broke'",
    "not ok 4 - gamma",
    "  location: /x/y.mjs:3:1",
    "  expected: 1",
    "  actual: 2",
  ].join("\n");
  const summary = summarizeTestOutput(tap, 1);
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.failures, [
    { name: "alpha", error: ["error: 'alpha broke'"] },
    { name: "beta", error: ["error: 'beta broke'"] },
    { name: "gamma", error: ["expected: 1", "actual: 2"] },
  ]);
});

test("duplicate failure names are collapsed", () => {
  const summary = summarizeTestOutput("not ok 1 - dup\nnot ok 2 - dup\n", 1);
  assert.deepEqual(summary.failures, [{ name: "dup", error: [] }]);
});

test("failures are capped at twenty", () => {
  const tap = Array.from({ length: 25 }, (_, i) => `not ok ${i + 1} - case ${i + 1}`).join("\n");
  const summary = summarizeTestOutput(tap, 1);
  assert.equal(summary.failures.length, 20);
  assert.equal(summary.failures[0].name, "case 1");
  assert.equal(summary.failures.at(-1).name, "case 20");
});

test("error details stop at five lines and each line is truncated to 200 characters", () => {
  const noisy = ["not ok 1 - noisy", ...Array.from({ length: 8 }, (_, i) => `detail ${i + 1}`)].join("\n");
  assert.deepEqual(summarizeTestOutput(noisy, 1).failures[0].error,
    ["detail 1", "detail 2", "detail 3", "detail 4", "detail 5"]);

  const long = summarizeTestOutput(`not ok 1 - long\n${"x".repeat(250)}\n`, 1);
  assert.equal(long.failures[0].error[0].length, 200);
});

test("Jest-style failures are recognised but the Console heading is not", () => {
  const jest = [
    "  ● Cart › totals",
    "",
    "    expect(received).toBe(expected)",
    "    Expected: 3",
    "    Received: 4",
    "    at foo (bar.js:1:1)",
    "    extra",
    "    overflow",
    "  ● second thing",
    "    second line",
  ].join("\n");
  assert.deepEqual(summarizeTestOutput(jest, 1).failures, [
    { name: "Cart › totals", error: [
      "expect(received).toBe(expected)", "Expected: 3", "Received: 4",
      "at foo (bar.js:1:1)", "extra",
    ] },
    { name: "second thing", error: ["second line"] },
  ]);
  const consoleOnly = summarizeTestOutput("  ● Console\n\n    console.log hello\n", 1);
  assert.deepEqual(consoleOnly.failures, []);
  assert.deepEqual(consoleOnly.tail, ["  ● Console", "    console.log hello"]);
});

test("Windows line endings are split correctly for every failure format", () => {
  const crlf = [
    "not ok 1 - crlf case",
    "  error: 'crlf failed'",
    "FAILED tests/a.test.js::one - boom",
    "  ✗ renders",
    "FAIL src/a.test.js",
    "",
  ].join("\r\n");
  const summary = summarizeTestOutput(crlf, 1);
  assert.deepEqual(summary.failures, [
    { name: "crlf case", error: ["error: 'crlf failed'"] },
    { name: "tests/a.test.js::one", error: ["boom"] },
    { name: "renders", error: [] },
    { name: "src/a.test.js", error: [] },
  ]);
  assert.deepEqual(summarizeTestOutput("oops\r\nboom\r\n", 1).tail, ["oops", "boom"]);
});

test("unrecognised failing output keeps only the last fifteen non-blank lines", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  lines.splice(10, 0, "", "   ");
  lines.push("y".repeat(250));
  const summary = summarizeTestOutput(lines.join("\n"), 3);
  assert.equal(summary.failures.length, 0);
  assert.equal(summary.tail.length, 15);
  assert.equal(summary.tail[0], "line 17");
  assert.equal(summary.tail.at(-1).length, 200);
});

test("passed mirrors the exit code and exitCode is preserved", () => {
  assert.equal(summarizeTestOutput("", 0).passed, true);
  assert.equal(summarizeTestOutput("", 2).passed, false);
  assert.equal(summarizeTestOutput("not ok 1 - x", 7).exitCode, 7);
});
