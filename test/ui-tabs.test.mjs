import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_TAB, TABS, TAB_KEY, loadTab, normalizeTab, saveTab, tabFromKey, tabsHtml } from "../src/ui/tabs.js";
import { decisionsHtml, ladderHtml, routeTitle } from "../src/ui/render.js";
import { dashboardHtml, startDashboard } from "../src/dashboard.mjs";
import { GuardStore } from "../src/store.mjs";

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value; }, data };
};

test("the tabs are Overview, Models, History, Settings and open on Overview", () => {
  assert.deepEqual(TABS.map((tab) => tab.label), ["Overview", "Models", "History", "Settings"]);
  assert.equal(DEFAULT_TAB, "overview");
  assert.equal(loadTab(memoryStorage()), "overview");
  assert.equal(loadTab(null), "overview");
});

test("the chosen tab is saved and read back, and an unknown value falls back to Overview", () => {
  const storage = memoryStorage();
  saveTab(storage, "history");
  assert.equal(storage.data[TAB_KEY], "history");
  assert.equal(loadTab(storage), "history");
  saveTab(storage, "nonsense");
  assert.equal(storage.data[TAB_KEY], "overview");
  assert.equal(loadTab(memoryStorage({ [TAB_KEY]: "<script>" })), "overview");
  assert.equal(normalizeTab(undefined), "overview");
});

test("blocked storage never breaks the tabs", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(loadTab(blocked), "overview");
  assert.doesNotThrow(() => saveTab(blocked, "models"));
});

test("arrow keys move between tabs and wrap; Home and End jump; other keys do nothing", () => {
  assert.equal(tabFromKey("overview", "ArrowRight"), "models");
  assert.equal(tabFromKey("settings", "ArrowRight"), "overview");
  assert.equal(tabFromKey("overview", "ArrowLeft"), "settings");
  assert.equal(tabFromKey("models", "Home"), "overview");
  assert.equal(tabFromKey("models", "End"), "settings");
  assert.equal(tabFromKey("models", "a"), null);
  assert.equal(tabFromKey("nope", "ArrowRight"), null);
});

test("tab keys ignore any held modifier, so Alt+Left still goes Back", () => {
  for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
    assert.equal(tabFromKey("models", "ArrowLeft", { [mod]: true }), null);
    assert.equal(tabFromKey("models", "Home", { [mod]: true }), null);
  }
  assert.equal(tabFromKey("models", "ArrowLeft", { altKey: false }), "overview");
});

test("the dashboard page has four tabs with tab, tablist and tabpanel roles wired together", () => {
  const html = dashboardHtml();
  assert.match(html, /role="tablist"/);
  for (const { id, label } of TABS) {
    assert.match(html, new RegExp(`role="tab" id="tab-${id}"[^>]*aria-controls="panel-${id}"[^>]*aria-selected="${id === "overview"}"[^>]*>${label}</button>`));
    assert.match(html, new RegExp(`role="tabpanel" id="panel-${id}"[^>]*aria-labelledby="tab-${id}"`));
  }
  assert.equal((html.match(/role="tab"/g) || []).length, 4);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 4);
  assert.equal(tabsHtml().includes('tabindex="-1"'), true);
  assert.doesNotMatch(html, /https?:\/\/(?!chatgpt\.com\/codex\/settings\/usage)/);
});

test("the dashboard serves the shared panel files, and only those", async (t) => {
  const store = new GuardStore({ filename: ":memory:" });
  const dashboard = await startDashboard(store, { port: 40_000 + Math.floor(Math.random() * 20_000) });
  t.after(() => { dashboard.server.close(); store.close(); });
  for (const file of ["style.css", "panel.js", "tabs.js", "render.js", "format.js", "fonts/Inter-latin.woff2"]) {
    assert.equal((await fetch(`${dashboard.url}/ui/${file}`)).status, 200, file);
  }
  assert.equal((await fetch(`${dashboard.url}/ui/../dashboard.mjs`)).status, 404);
  assert.equal((await fetch(`${dashboard.url}/ui/nope.js`)).status, 404);
  assert.equal((await fetch(`${dashboard.url}/ui/__proto__`)).status, 404);
});

test("the tray keeps byte-identical copies of the shared panel files", () => {
  for (const file of ["style.css", "format.js", "tabs.js", "render.js", "panel.js", "agent-layer-mark.svg", "fonts/Inter-latin.woff2"]) {
    const shared = readFileSync(new URL(`../src/ui/${file}`, import.meta.url));
    const copy = readFileSync(new URL(`../tray/ui/${file}`, import.meta.url));
    assert.ok(shared.equals(copy), `tray/ui/${file} differs from src/ui/${file}: copy it across`);
  }
});

test("route, ladders and decisions render escaped text", () => {
  assert.equal(routeTitle({ lane: "off" }), "Your own rules (Usage Guard is off)");
  assert.equal(routeTitle({ lane: "wait" }), "Wait for the next share");
  assert.equal(routeTitle({ lane: "claude", model: "claude-opus-5-5", ladder: "high" }), "Claude · claude-opus-5-5 (your high preset)");
  assert.equal(routeTitle({ lane: "codex", model: "gpt-6.1-sol", ladder: "standard" }), "Codex · gpt-6.1-sol");
  assert.match(ladderHtml({ claude: [{ model: "a", effort: "high" }, { model: "b", effort: "low" }] }), /<li>a <small>high<\/small><\/li><li>b <small>low<\/small><\/li>/);
  const rows = decisionsHtml([{ createdAt: 0, provider: "codex", action: "<b>x</b>", reason: "a & b" }, { createdAt: 0, provider: "claude", action: "y", reason: "z" }], 1);
  assert.match(rows, /&lt;b&gt;x&lt;\/b&gt;.*a &amp; b/);
  assert.equal((rows.match(/<li>/g) || []).length, 1);
});

test("back-to-back identical decisions collapse into one line with a count", () => {
  const same = { createdAt: 0, provider: "claude", action: "observe", reason: "fine" };
  const html = decisionsHtml([same, same, same, { ...same, provider: "codex" }, same]);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /observe <small>×3<\/small>/);
});

test("the dashboard API refuses other hosts and cross-site changes", async (t) => {
  const store = new GuardStore({ filename: ":memory:" });
  const dashboard = await startDashboard(store, { port: 40_000 + Math.floor(Math.random() * 20_000) });
  t.after(() => { dashboard.server.close(); store.close(); });
  const http = await import("node:http");
  const send = (method, headers, body) => new Promise((resolve, reject) => {
    const request = http.request(`${dashboard.url}/api/config`, { method, headers }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end(body);
  });
  const patch = JSON.stringify({ routingPaused: true });
  assert.equal(await send("GET", { host: "attacker.example:4765" }), 403); // DNS rebinding
  assert.equal(await send("PATCH", { "content-type": "application/json", origin: "https://attacker.example" }, patch), 403);
  assert.equal(await send("PATCH", { "content-type": "application/json", origin: "http://localhost:1" }, patch), 403); // another local port
  assert.equal(store.getConfig().routingPaused, false);
  assert.equal(await send("PATCH", { "content-type": "application/json", origin: dashboard.url }, patch), 200);
  assert.equal(await send("PATCH", { "content-type": "application/json" }, JSON.stringify({ routingPaused: false })), 200); // the tray sends no Origin
});

test("a failed model-list load does not stick over later refreshes", async () => {
  const { mountPanel } = await import("../src/ui/panel.js");
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, dataset: {}, style: {}, classList: { toggle() {} }, value: "", hidden: false, textContent: "", innerHTML: "",
      addEventListener() {}, click() {}, querySelector: () => null, querySelectorAll: () => [], matches: () => false });
    return els.get(id);
  };
  const root = { getElementById: el, querySelectorAll: () => [], querySelector: () => ({ addEventListener() {} }), body: { classList: { toggle() {} } }, activeElement: null, defaultView: {} };
  const status = { config: { hermesModel: "m", modelLadders: {}, payAsYouGoDailyCapUsd: 1 }, providers: [], recentDecisions: [] };
  const api = { status: async () => status, route: async () => ({ lanes: [], lane: "claude", reason: "" }), models: async () => { throw new Error("models down"); } };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // mountPanel starts a poll timer that would keep the test process alive
  const panel = mountPanel({ api, root, storage: memoryStorage() });
  globalThis.setInterval = realInterval;
  await new Promise((r) => setTimeout(r, 20));
  await panel.refresh();
  assert.equal(el("error").hidden, true, "later successful refresh clears the model error");
});
