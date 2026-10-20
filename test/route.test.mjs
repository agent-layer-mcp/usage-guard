import test from "node:test";
import assert from "node:assert/strict";
import { readOpenRouterSpend, routeJob } from "../src/route.mjs";
import { GuardStore } from "../src/store.mjs";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 20, 1, 0); // 11:00 Brisbane
const DAY_START = Date.UTC(2026, 9, 19, 22, 0);
const RESET = DAY_START + 3 * 24 * HOUR;

function fixture(t, { claude, codex, config = {} }) {
  const store = new GuardStore({ filename: ":memory:" });
  t.after(() => store.close());
  store.setConfig({ dayTimeZone: "Australia/Brisbane", ...config });
  for (const [provider, [atStart, current]] of Object.entries({ claude, codex })) {
    for (const [observedAt, usedPercent] of [[DAY_START - HOUR, atStart], [NOW, current]]) {
      store.saveSnapshot({
        provider, source: "test", observedAt,
        windows: [{ key: "seven-day", label: "weekly", usedPercent, windowMinutes: 10_080, resetsAt: RESET }],
      });
    }
  }
  return store;
}
const deepseek = (spentTodayUsd) => ({ configured: true, spentTodayUsd });

test("code goes to the lane with the most daily share left", (t) => {
  const store = fixture(t, { claude: [59, 60], codex: [50, 58] }); // claude 11/12, codex 7/15 used
  const route = routeJob(store, "code", { now: NOW, payAsYouGo: deepseek(0) });
  assert.equal(route.lane, "claude");
  assert.equal(routeJob(fixture(t, { claude: [59, 68], codex: [50, 52] }), "code", { now: NOW }).lane, "codex");
});

test("planning and review stay on Claude while its share allows, and never go to DeepSeek", (t) => {
  const store = fixture(t, { claude: [59, 66], codex: [20, 20] });
  assert.equal(routeJob(store, "plan", { now: NOW }).lane, "claude");
  assert.equal(routeJob(store, "review", { now: NOW }).lane, "claude");
  const spent = fixture(t, { claude: [59, 75], codex: [80, 95] });
  assert.equal(routeJob(spent, "review", { now: NOW, payAsYouGo: deepseek(0) }).lane, "wait");
});

test("with Claude spent and Codex nearly spent, DeepSeek takes code within its cap", (t) => {
  const store = fixture(t, { claude: [59, 75], codex: [50, 64] }); // codex 14 of 15 used
  const route = routeJob(store, "code", { now: NOW, payAsYouGo: deepseek(1.2) });
  assert.equal(route.lane, "deepseek");
  assert.match(route.reason, /\$5 daily cap/);
  assert.equal(routeJob(store, "code", { now: NOW, payAsYouGo: deepseek(5) }).lane, "codex");
  assert.equal(routeJob(store, "code", { now: NOW }).lane, "codex");
});

test("everything spent waits for the next share; pause stops routing", (t) => {
  const store = fixture(t, { claude: [59, 75], codex: [50, 70] });
  const route = routeJob(store, "bulk", { now: NOW, payAsYouGo: deepseek(9) });
  assert.equal(route.lane, "wait");
  assert.match(route.reason, /next daily share starts/);
  const paused = fixture(t, { claude: [10, 10], codex: [10, 10], config: { routingPaused: true } });
  assert.equal(routeJob(paused, "code", { now: NOW }).lane, "wait");
  assert.equal(routeJob(paused, "code", { now: NOW }).paused, true);
  assert.ok(paused.recentDecisions(10).some((decision) => decision.action === "route-code"));
  assert.throws(() => routeJob(store, "deploy", { now: NOW }), /Route kind/);
});

test("OpenRouter spend uses only the API key and fails soft", async () => {
  assert.deepEqual(await readOpenRouterSpend({ env: {} }), { configured: false });
  let seen;
  const spend = await readOpenRouterSpend({
    env: { OPENROUTER_API_KEY: "k" },
    fetch: async (url, init) => { seen = [url, init.headers.Authorization]; return { ok: true, json: async () => ({ data: { usage_daily: 1.5 } }) }; },
  });
  assert.deepEqual(seen, ["https://openrouter.ai/api/v1/key", "Bearer k"]);
  assert.equal(spend.spentTodayUsd, 1.5);
  const failed = await readOpenRouterSpend({ env: { OPENROUTER_API_KEY: "k" }, fetch: async () => { throw new Error("offline"); } });
  assert.equal(failed.spentTodayUsd, undefined);
});

test("the local API previews a route without logging it", async (t) => {
  const { startDashboard } = await import("../src/dashboard.mjs");
  const store = new GuardStore({ filename: ":memory:" });
  const dashboard = await startDashboard(store, { port: 40_000 + Math.floor(Math.random() * 20_000), readSpend: async () => ({ configured: false }) });
  t.after(() => { dashboard.server.close(); store.close(); });
  const route = await (await fetch(`${dashboard.url}/api/route?kind=review`)).json();
  assert.equal(route.kind, "review");
  assert.ok(Array.isArray(route.lanes));
  assert.equal(store.recentDecisions(50).some((decision) => decision.action.startsWith("route-")), false);
  assert.equal((await fetch(`${dashboard.url}/api/route?kind=deploy`)).status, 400);
});
