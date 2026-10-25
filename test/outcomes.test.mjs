import test from "node:test";
import assert from "node:assert/strict";
import { GuardStore } from "../src/store.mjs";
import { recordRouteOutcome } from "../src/route.mjs";

const NOW = Date.UTC(2026, 9, 25, 1, 0);
const DAY = 24 * 60 * 60_000;
const row = { lane: "claude", model: "claude-haiku-5-5", kind: "file-scan", difficulty: "easy" };

function store(t) {
  const s = new GuardStore({ filename: ":memory:" });
  t.after(() => s.close());
  return s;
}

test("success rate counts only checked results", (t) => {
  const s = store(t);
  for (const result of ["pass", "pass", "pass", "fail", "unchecked", "lane-error"]) {
    s.recordOutcome({ ...row, result, createdAt: NOW });
  }
  assert.deepEqual(s.outcomeRates(NOW), [{ ...row, pass: 3, fail: 1, total: 4, rate: 0.75 }]);
});

test("a model with only unchecked results has no rate", (t) => {
  const s = store(t);
  s.recordOutcome({ ...row, result: "unchecked", createdAt: NOW });
  assert.deepEqual(s.outcomeRates(NOW), [{ ...row, pass: 0, fail: 0, total: 0, rate: null }]);
});

test("outcomes prune with decisions after 14 days", (t) => {
  const s = store(t);
  s.recordOutcome({ ...row, result: "pass", createdAt: NOW - 15 * DAY });
  s.recordOutcome({ ...row, result: "fail", createdAt: NOW - DAY });
  s.pruneDecisions(NOW);
  assert.deepEqual(s.outcomeRates(NOW, 30 * DAY), [{ ...row, pass: 0, fail: 1, total: 1, rate: 0 }]);
});

test("an unknown result throws", (t) => {
  assert.throws(() => store(t).recordOutcome({ ...row, result: "maybe", createdAt: NOW }), TypeError);
});

test("recorded outcomes validate lane, model, kind and difficulty", (t) => {
  const s = store(t);
  assert.deepEqual(recordRouteOutcome(s, { lane: "hermes", model: "deepseek/deepseek-v4.1-flash-1017", kind: "code", result: "pass", now: NOW }),
    { lane: "hermes", model: "deepseek/deepseek-v4.1-flash-1017", kind: "code", difficulty: "medium", result: "pass" });
  for (const bad of [{ lane: "gemini" }, { model: "rm -rf /" }, { kind: "deploy" }, { difficulty: "trivial" }]) {
    assert.throws(() => recordRouteOutcome(s, { ...row, result: "pass", now: NOW, ...bad }), TypeError, JSON.stringify(bad));
  }
});
