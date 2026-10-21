import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_LADDERS, PLAN_PRESETS } from "../src/config.mjs";
import { routeJob } from "../src/route.mjs";
import { GuardStore } from "../src/store.mjs";

function store(t) {
  const s = new GuardStore({ filename: ":memory:" });
  t.after(() => s.close());
  return s;
}

test("the default is today's ladder and the standard preset", (t) => {
  const config = store(t).getConfig();
  assert.equal(config.planPreset, "standard");
  assert.deepEqual(config.modelLadders, structuredClone(DEFAULT_MODEL_LADDERS));
});

test("a plan preset sets both ladders", (t) => {
  const s = store(t);
  const lower = s.setConfig({ planPreset: "lower" });
  assert.equal(lower.planPreset, "lower");
  assert.equal(lower.modelLadders.claude[0].model, "claude-sonnet-5-5");
  assert.equal(lower.modelLadders.claude[3].model, "claude-haiku-5-5");
  assert.deepEqual(lower.modelLadders.codex[0], { model: "gpt-6.1-sol", effort: "medium" });
  assert.equal(s.setConfig({ planPreset: "high" }).modelLadders.claude[1].model, "claude-opus-5-5");
  assert.deepEqual(s.setConfig({ planPreset: "standard" }).modelLadders, structuredClone(DEFAULT_MODEL_LADDERS));
  assert.throws(() => s.setConfig({ planPreset: "huge" }), /not supported/);
});

test("presets only use models already in the default ladders", () => {
  const known = new Set(Object.values(DEFAULT_MODEL_LADDERS).flat().map((rung) => rung.model));
  for (const preset of Object.values(PLAN_PRESETS)) {
    for (const rung of Object.values(preset).flat()) assert.ok(known.has(rung.model), rung.model);
  }
});

test("a custom ladder accepts known higher-tier models and rejects unknown IDs", (t) => {
  const s = store(t);
  const ladders = structuredClone(DEFAULT_MODEL_LADDERS);
  ladders.claude[0] = { model: "claude-fable-5-1", effort: "high" };
  ladders.codex[0] = { model: "gpt-6-astra", effort: "high" };
  const config = s.setConfig({ modelLadders: ladders });
  assert.equal(config.planPreset, "custom");
  assert.equal(config.modelLadders.claude[0].model, "claude-fable-5-1");

  const bad = structuredClone(DEFAULT_MODEL_LADDERS);
  bad.codex[0] = { model: "gpt-9-imaginary", effort: "high" };
  assert.throws(() => s.setConfig({ modelLadders: bad }), /codex: unknown model "gpt-9-imaginary"\. Known: gpt-6\.1-sol/);
  bad.codex[0] = { model: "claude-opus-5-5", effort: "high" }; // a Claude model on the Codex lane
  assert.throws(() => s.setConfig({ modelLadders: bad }), /codex: unknown model/);
  assert.equal(s.getConfig().modelLadders.claude[0].model, "claude-fable-5-1");
});

test("route output names the ladder the model came from", (t) => {
  const s = store(t);
  s.setConfig({ planPreset: "lower", dayTimeZone: "Australia/Brisbane" });
  const now = Date.UTC(2026, 9, 21, 1, 0);
  s.saveSnapshot({
    provider: "claude", source: "test", observedAt: now,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 20, windowMinutes: 10_080, resetsAt: now + 3 * 86_400_000 }],
  });
  const route = routeJob(s, "plan", { now, record: false });
  assert.equal(route.lane, "claude");
  assert.equal(route.ladder, "lower");
  assert.equal(route.model, "claude-sonnet-5-5");
});
