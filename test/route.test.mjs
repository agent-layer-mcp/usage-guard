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
const hermes = (spentTodayUsd) => ({ configured: true, spentTodayUsd });

test("code goes to the lane with the most daily share left", (t) => {
  const store = fixture(t, { claude: [59, 60], codex: [50, 58] }); // claude 11/12, codex 7/15 used
  const route = routeJob(store, "code", { now: NOW, payAsYouGo: hermes(0) });
  assert.equal(route.lane, "claude");
  assert.equal(routeJob(fixture(t, { claude: [59, 68], codex: [50, 52] }), "code", { now: NOW }).lane, "codex");
});

test("planning and review stay on Claude while its share allows, and never go to Hermes", (t) => {
  const store = fixture(t, { claude: [59, 66], codex: [20, 20] });
  assert.equal(routeJob(store, "plan", { now: NOW }).lane, "claude");
  assert.equal(routeJob(store, "review", { now: NOW }).lane, "claude");
  const spent = fixture(t, { claude: [59, 75], codex: [80, 95] });
  assert.equal(routeJob(spent, "review", { now: NOW, payAsYouGo: hermes(0) }).lane, "wait");
});

test("with Claude spent and Codex nearly spent, Hermes takes code within its cap", (t) => {
  const store = fixture(t, { claude: [59, 75], codex: [50, 64] }); // codex 14 of 15 used
  const route = routeJob(store, "code", { now: NOW, payAsYouGo: hermes(1.2) });
  assert.equal(route.lane, "hermes");
  assert.match(route.workdir, /scratch directory or a git worktree/);
  assert.match(route.reason, /\$5 daily cap/);
  assert.match(route.command, /^hermes -p dstest --provider openrouter -m deepseek\/deepseek-v4\.1-flash-1017 /);
  assert.equal(routeJob(store, "code", { now: NOW, payAsYouGo: hermes(5) }).lane, "codex");
  assert.equal(routeJob(store, "code", { now: NOW }).lane, "codex");
});

test("everything spent waits for the next share; pause stops routing", (t) => {
  const store = fixture(t, { claude: [59, 75], codex: [50, 70] });
  const route = routeJob(store, "bulk", { now: NOW, payAsYouGo: hermes(9) });
  assert.equal(route.lane, "wait");
  assert.match(route.reason, /next daily share starts/);
  const paused = fixture(t, { claude: [10, 10], codex: [10, 10], config: { routingPaused: true } });
  assert.equal(routeJob(paused, "code", { now: NOW }).lane, "wait");
  assert.equal(routeJob(paused, "code", { now: NOW }).paused, true);
  assert.ok(paused.recentDecisions(10).some((decision) => decision.action === "route-code"));
  assert.throws(() => routeJob(store, "deploy", { now: NOW }), /Route kind/);
});

test("OpenRouter spend uses only the API key and fails soft", async () => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), "ug-nokey-"));
  assert.deepEqual(await readOpenRouterSpend({ env: { USAGE_GUARD_HOME: emptyHome } }), { configured: false });
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

test("model picker keeps tool-calling models with per-million prices and caches for a day", async (t) => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { listOpenRouterModels, parseOpenRouterModels } = await import("../src/openrouter-models.mjs");
  const body = { data: [
    { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", context_length: 131072,
      pricing: { prompt: "0.0000002", completion: "0.0000008" }, supported_parameters: ["tools", "temperature"] },
    { id: "x/no-tools", name: "No Tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
  ] };
  assert.deepEqual(parseOpenRouterModels(body), [{
    id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash",
    inputPerMillionUsd: 0.2, outputPerMillionUsd: 0.8, contextLength: 131072,
  }]);
  assert.deepEqual(parseOpenRouterModels(null), []);

  const cachePath = path.join(mkdtempSync(path.join(os.tmpdir(), "ug-models-")), "models.json");
  let calls = 0;
  const fetch = async () => { calls += 1; return { ok: true, json: async () => body }; };
  await listOpenRouterModels({ cachePath, fetch, now: 0 });
  await listOpenRouterModels({ cachePath, fetch, now: 60_000 });
  assert.equal(calls, 1);
  const offline = await listOpenRouterModels({ cachePath, now: 2 * 24 * 60 * 60_000, fetch: async () => { throw new Error("offline"); } });
  assert.equal(offline.stale, true);
  assert.equal(offline.models.length, 1);
});

test("old payAsYouGoModel setting carries over to hermesModel", () => {
  const store = new GuardStore({ filename: ":memory:" });
  store.database.prepare("INSERT INTO config(key, value) VALUES (?, ?)").run("payAsYouGoModel", JSON.stringify("qwen/qwen4-coder"));
  assert.equal(store.getConfig().hermesModel, "qwen/qwen4-coder");
  store.setConfig({ hermesModel: "moonshotai/kimi-k3" });
  assert.equal(store.getConfig().hermesModel, "moonshotai/kimi-k3");
  store.close();
});

test("the OpenRouter key can come from the user's openrouter.env file", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = mkdtempSync(path.join(os.tmpdir(), "ug-key-"));
  writeFileSync(path.join(home, "openrouter.env"), "export OPENROUTER_API_KEY=\"sk-or-test\"\n");
  let auth;
  await readOpenRouterSpend({ env: { USAGE_GUARD_HOME: home }, fetch: async (url, init) => { auth = init.headers.Authorization; return { ok: true, json: async () => ({ data: { usage_daily: 0 } }) }; } });
  assert.equal(auth, "Bearer sk-or-test");
});

test("a lane without a fresh reading is not described as having share left", (t) => {
  const store = new GuardStore({ filename: ":memory:" });
  t.after(() => store.close());
  const route = routeJob(store, "code", { now: NOW });
  assert.match(route.reason, /no fresh usage reading/);
});

test("Codex first sends code and bulk to Codex above the line, even with its daily share spent", (t) => {
  // Codex: 5% used at day start, 36% now: 31 used of today's 30% share (spent), 64% of the week left.
  const store = fixture(t, { claude: [40, 41], codex: [5, 36], config: { codexFirstUntilLeftPercent: 60 } });
  for (const kind of ["code", "bulk"]) {
    const route = routeJob(store, kind, { now: NOW, payAsYouGo: hermes(0), record: false });
    assert.equal(route.lane, "codex", kind);
    assert.equal(route.lanes.find((lane) => lane.lane === "codex").available, false); // daily share spent
    assert.match(route.reason, /Codex first: 64% of the week left, at or above the 60% line/);
  }
  assert.equal(routeJob(store, "plan", { now: NOW, payAsYouGo: hermes(0), record: false }).lane, "claude");
  assert.equal(routeJob(store, "review", { now: NOW, payAsYouGo: hermes(0), record: false }).lane, "claude");
});

test("Codex first falls back below the line and never picks Hermes", (t) => {
  const store = fixture(t, { claude: [40, 41], codex: [20, 38], config: { codexFirstUntilLeftPercent: 70 } });
  const route = routeJob(store, "code", { now: NOW, payAsYouGo: hermes(0), record: false });
  assert.equal(route.lane, "claude");
  assert.match(route.reason, /^Codex first: 62% of the week left, below the 70% line, so falling back\. Claude/);
  // Both subscriptions spent today: the normal rule picks Hermes, the Codex-first rule never does.
  const spent = fixture(t, { claude: [40, 60], codex: [35, 62], config: { codexFirstUntilLeftPercent: 70 } });
  const fallback = routeJob(spent, "code", { now: NOW, payAsYouGo: hermes(0), record: false });
  assert.equal(fallback.lane, "hermes");
  assert.match(fallback.reason, /38% of the week left, below the 70% line, so falling back/);
});

test("a stale Codex reading never triggers Codex first", (t) => {
  const store = fixture(t, { claude: [40, 41], codex: [20, 21], config: { codexFirstUntilLeftPercent: 70 } });
  const later = NOW + 60 * 60_000;
  store.saveSnapshot({
    provider: "claude", source: "test", observedAt: later,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 41, windowMinutes: 10_080, resetsAt: RESET }],
  });
  const route = routeJob(store, "code", { now: later, payAsYouGo: hermes(0), record: false });
  assert.equal(route.lane, "claude");
  assert.match(route.reason, /^Codex first: no fresh Codex reading, so falling back\./);
});

test("codexFirstUntilLeftPercent accepts 0-100 or null", (t) => {
  const store = fixture(t, { claude: [40, 41], codex: [20, 21] });
  assert.equal(store.getConfig().codexFirstUntilLeftPercent, null);
  store.setConfig({ codexFirstUntilLeftPercent: 70 });
  assert.equal(store.getConfig().codexFirstUntilLeftPercent, 70);
});

test("with share on both, code goes to the lane on pace and says so", (t) => {
  // Codex has more share left (12.3 vs 10.0 pts) but burned 6 pts in 4 hours (about 2x pace).
  const store = fixture(t, { claude: [59, 61], codex: [40, 46] });
  for (const kind of ["code", "bulk"]) {
    const route = routeJob(store, kind, { now: NOW, payAsYouGo: hermes(0), record: false });
    assert.equal(route.lane, "claude", kind);
    assert.match(route.reason, /^Preferred the lane on pace: Codex is over pace \(\d\.\dx\), so Claude takes it with 10\.0 pts left today\./);
  }
  assert.equal(routeJob(store, "plan", { now: NOW, record: false }).lane, "claude");
});

test("when both or neither lane is over pace, the most share left wins", (t) => {
  const both = fixture(t, { claude: [59, 63], codex: [40, 46] });
  const route = routeJob(both, "code", { now: NOW, payAsYouGo: hermes(0), record: false });
  assert.equal(route.lane, "codex");
  assert.doesNotMatch(route.reason, /on pace/);
  assert.equal(routeJob(fixture(t, { claude: [59, 60], codex: [40, 41] }), "code", { now: NOW, record: false }).lane, "codex");
});

test("under half a point left counts as spent, so the next job moves on", (t) => {
  // Codex: 13.0 of 13.3 pts used (0.3 left). Claude has share left.
  const store = fixture(t, { claude: [59, 61], codex: [55, 68.04] });
  const codex = routeJob(store, "code", { now: NOW, payAsYouGo: hermes(0), record: false }).lanes.find((l) => l.lane === "codex");
  assert.ok(codex.remainingTodayPercent < 0.5 && codex.remainingTodayPercent > 0, String(codex.remainingTodayPercent));
  assert.equal(codex.available, false);
  assert.match(codex.reason, /^Today's share is spent/);
});

test("a stale lane keeps its last known share but ranks after a fresh one", (t) => {
  const store = fixture(t, { claude: [59, 60], codex: [40, 41] });
  const later = NOW + 60 * 60_000;
  store.saveSnapshot({ provider: "codex", source: "test", observedAt: later,
    windows: [{ key: "seven-day", label: "weekly", usedPercent: 41, windowMinutes: 10_080, resetsAt: RESET }] });
  const route = routeJob(store, "code", { now: later, payAsYouGo: hermes(0), record: false });
  const claude = route.lanes.find((l) => l.lane === "claude");
  assert.equal(claude.verified, false);
  assert.ok(claude.todayBudgetPercent > 0); // last known share kept
  assert.equal(route.lane, "codex");
});
