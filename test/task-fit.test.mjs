import test from "node:test";
import assert from "node:assert/strict";
import { taskFitRung } from "../src/task-fit.mjs";

const r = (o) => taskFitRung({ quotaRung: 1, ...o }).rung;

test("difficulty sets the rung when quota is healthy", () => {
  assert.equal(r({ difficulty: "easy" }), 4);
  assert.equal(r({ difficulty: "medium" }), 2);
  assert.equal(r({}), 2);
  assert.equal(r({ difficulty: "hard" }), 1);
});

test("quota only pushes cheaper", () => {
  assert.equal(r({ difficulty: "hard", quotaRung: 3 }), 3);
  assert.equal(r({ difficulty: "easy", quotaRung: 2 }), 4);
});

test("protected work is at least medium and never cheaper than rung 2", () => {
  assert.equal(r({ difficulty: "easy", protectedRole: true }), 2);
  assert.equal(r({ difficulty: "hard", protectedRole: true, quotaRung: 4 }), 2);
  assert.equal(r({ difficulty: "hard", protectedRole: true }), 1);
});

test("failures step stronger down to the quota rung, then cap", () => {
  assert.deepEqual(taskFitRung({ difficulty: "easy", quotaRung: 1, subscriptionFailures: 2 }), { rung: 2, capped: false });
  assert.deepEqual(taskFitRung({ difficulty: "medium", quotaRung: 2, subscriptionFailures: 1 }), { rung: 2, capped: true });
  assert.equal(r({ difficulty: "easy", subscriptionFailures: 9 }), 1);
});

test("unknown difficulty throws", () => {
  assert.throws(() => taskFitRung({ difficulty: "trivial", quotaRung: 1 }), TypeError);
});
