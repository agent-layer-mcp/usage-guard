import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureBackgroundMonitor } from "../src/install.mjs";
import { readClaudeCodeToken } from "../src/providers/claude-api.mjs";
import { detectCloud, detectTools, runSetup, SetupCancelled, writeOpenRouterKey } from "../src/setup.mjs";
import { GuardStore } from "../src/store.mjs";

const CANCEL = Symbol("cancel");

// A scripted stand-in for @clack/prompts: answers are taken in order.
function fakeUi(answers = []) {
  const shown = [];
  const next = (kind, opts) => { shown.push([kind, opts.message]); return answers.length ? answers.shift() : opts.initialValue ?? opts.initialValues; };
  return {
    shown,
    intro: (text) => shown.push(["intro", text]),
    outro: (text) => shown.push(["outro", text]),
    note: (text, title) => shown.push(["note", title, text]),
    log: { warn: (text) => shown.push(["warn", text]) },
    spinner: () => ({ start: (text) => shown.push(["spin", text]), stop: (text) => shown.push(["done", text]) }),
    confirm: async (opts) => next("confirm", opts),
    multiselect: async (opts) => next("multiselect", opts),
    password: async (opts) => next("password", opts),
    isCancel: (value) => value === CANCEL,
  };
}

function deps(t, overrides = {}) {
  const store = new GuardStore({ filename: ":memory:" });
  t.after(() => store.close());
  const installs = [];
  return {
    env: { DISPLAY: ":0" },
    platform: "linux",
    homeDir: "/home/u",
    exists: () => false,
    which: (name) => (name === "claude" ? "/usr/bin/claude" : null),
    store,
    installs,
    claudeLoginFound: () => true,
    openRouterKeySaved: () => false,
    writeOpenRouterKey: () => "/home/u/.usage-guard/openrouter.env",
    readOpenRouterSpend: async () => ({ configured: true, spentTodayUsd: 0.25 }),
    now: 10 * 3_600_000,
    syncClaude: async () => ({ observedAt: 10 * 3_600_000, windows: [{ label: "5 hour", usedPercent: 9 }, { label: "weekly", usedPercent: 66.4 }] }),
    syncCodex: async () => { throw new Error("codex not signed in"); },
    install: (options) => { installs.push(options); return { monitor: { enabled: true } }; },
    ...overrides,
  };
}

test("cloud sessions are refused with the local command; containers are asked about", () => {
  assert.deepEqual(detectCloud({ env: { CLAUDE_CODE_REMOTE: "true" } }), { cloud: "Claude Code on the web" });
  assert.deepEqual(detectCloud({ env: { CODESPACES: "true" }, platform: "linux" }), { cloud: "GitHub Codespaces" });
  assert.deepEqual(detectCloud({ env: {}, platform: "linux", exists: (p) => p === "/.dockerenv" }), { unsure: true });
  assert.deepEqual(detectCloud({ env: { DISPLAY: ":0" }, platform: "linux", exists: () => true }), {});
  assert.deepEqual(detectCloud({ env: {}, platform: "darwin", exists: () => false }), {});
});

test("setup in a cloud session changes nothing and says to run it locally", async (t) => {
  const d = deps(t, { env: { CLAUDE_CODE_REMOTE: "true" } });
  const ui = fakeUi();
  const result = await runSetup({ ...d, ui });
  assert.equal(result.status, "cloud");
  assert.equal(d.installs.length, 0);
  const note = ui.shown.find(([kind]) => kind === "note");
  assert.match(note[2], /usage-guard setup/);
  assert.match(note[2], /tracks your cloud sessions too/);
});

test("a container that isn't the user's own computer stops too", async (t) => {
  const d = deps(t, { env: {}, exists: (p) => p === "/.dockerenv" });
  const result = await runSetup({ ...d, ui: fakeUi([false]) });
  assert.equal(result.status, "cloud");
  assert.equal(d.installs.length, 0);
});

test("any mix of tools: Claude and Hermes, with a 10-minute check and no Codex changes", async (t) => {
  const d = deps(t);
  const ui = fakeUi([["claude", "hermes"], true, "sk-or-v1-abcdefghijklmnop", true]);
  const result = await runSetup({ ...d, ui });
  assert.equal(result.status, "installed");
  assert.deepEqual(d.installs[0], { integrations: true, claude: true, codex: false, monitorIntervalMinutes: 2 });
  assert.deepEqual(d.store.getConfig().trackedProviders, ["claude", "hermes"]);
  assert.equal(d.store.getConfig().staleAfterMinutes, 25);
  const usage = ui.shown.find(([kind, title]) => kind === "note" && title === "Usage now")[2];
  assert.match(usage, /Claude: 5 hour 9%, weekly 66%/);
  assert.match(usage, /Hermes \(OpenRouter\): \$0\.25 spent today/);
});

test("Codex only never asks about the Claude login, and a failed first reading is explained", async (t) => {
  const d = deps(t, { which: () => "/usr/bin/x" });
  const ui = fakeUi([["codex"], true]);
  await runSetup({ ...d, ui });
  assert.ok(!ui.shown.some(([, message]) => /Claude Code login/.test(message || "")));
  assert.deepEqual(d.installs[0], { integrations: true, claude: false, codex: true, monitorIntervalMinutes: 2 });
  assert.match(ui.shown.find(([, title]) => title === "Usage now")[2], /Codex: no reading yet \(codex not signed in\)/);
});

test("a missing Claude login is a warning, and a rejected OpenRouter key stops setup", async (t) => {
  const d = deps(t, { claudeLoginFound: () => false });
  const ui = fakeUi([["claude"], true, false]);
  await runSetup({ ...d, ui });
  assert.ok(ui.shown.some(([kind, text]) => kind === "warn" && /sign in with \/login/.test(text)));
  assert.equal(d.installs[0].integrations, false);

  const bad = deps(t, { readOpenRouterSpend: async () => ({ configured: true, error: "OpenRouter returned 401." }) });
  await assert.rejects(runSetup({ ...bad, ui: fakeUi([["hermes"], "sk-or-v1-abcdefghijklmnop"]) }), /didn't accept that key: OpenRouter returned 401/);
  assert.equal(bad.installs.length, 0);
});

test("cancelling and unknown tools stop before anything changes", async (t) => {
  const d = deps(t);
  await assert.rejects(runSetup({ ...d, ui: fakeUi([CANCEL]) }), SetupCancelled);
  await assert.rejects(runSetup({ ...d, ui: fakeUi(), options: { tools: ["gemini"] } }), /--tools takes any of/);
  assert.equal(d.installs.length, 0);
});

test("--yes with --tools runs without prompts", async (t) => {
  const d = deps(t);
  const ui = fakeUi();
  await runSetup({ ...d, ui, options: { yes: true, tools: ["claude", "codex"] } });
  assert.ok(!ui.shown.some(([kind]) => ["confirm", "multiselect", "password"].includes(kind)));
  assert.deepEqual(d.installs[0], { integrations: true, claude: true, codex: true, monitorIntervalMinutes: 2 });
});

test("tools found on the machine start ticked", () => {
  const found = detectTools({ which: (name) => (name === "codex" ? "/bin/codex" : null), homeDir: "/h", exists: (p) => p === "/h/.claude", env: { OPENROUTER_API_KEY: "k" } });
  assert.deepEqual(found, ["claude", "codex", "hermes"]);
});

test("the OpenRouter key file is private", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ug-setup-"));
  const file = writeOpenRouterKey(path.join(dir, "state"), "sk-or-v1-abc");
  assert.equal(readFileSync(file, "utf8"), "OPENROUTER_API_KEY=sk-or-v1-abc\n");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("macOS reads the Claude login from the Keychain", () => {
  const calls = [];
  const token = readClaudeCodeToken({
    platform: "darwin", now: 1,
    commandRunner: (command, args) => { calls.push([command, ...args]); return JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: 5 } }); },
  });
  assert.equal(token, "k");
  assert.deepEqual(calls[0], ["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  assert.equal(readClaudeCodeToken({ platform: "darwin", commandRunner: () => { throw new Error("not found"); } }), null);
});

test("the background check runs every 10 minutes on Linux, macOS and Windows", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ug-interval-"));
  const runtime = { command: "/usr/bin/node", argsPrefix: ["/opt/ug.mjs"] };
  const calls = [];
  const commandRunner = (command, args) => { calls.push([command, ...args]); return { ok: true }; };
  const linux = configureBackgroundMonitor({ home: path.join(root, "l"), stateHome: path.join(root, "ls"), runtime, platform: "linux", env: {}, intervalMinutes: 10, commandRunner });
  assert.match(readFileSync(linux.path, "utf8"), /OnUnitActiveSec=10min/);
  const mac = configureBackgroundMonitor({ home: path.join(root, "m"), stateHome: path.join(root, "ms"), runtime, platform: "darwin", uid: 501, intervalMinutes: 10, commandRunner });
  const plist = readFileSync(mac.path, "utf8");
  assert.match(plist, /<integer>600<\/integer>/);
  assert.match(plist, /<string>--provider<\/string>\s*<string>all<\/string>/);
  const win = configureBackgroundMonitor({ runtime, platform: "win32", intervalMinutes: 10, commandRunner });
  assert.equal(win.intervalSeconds, 600);
  assert.deepEqual(calls.at(-1), ["schtasks", "/Create", "/F", "/SC", "MINUTE", "/MO", "10", "/TN", "Usage Guard monitor",
    "/TR", '"/usr/bin/node" "/opt/ug.mjs" "monitor" "--once" "--quiet" "--provider" "all"']);
});

test("an old fallback reading is labelled, not shown as current", async (t) => {
  const d = deps(t, { syncClaude: async () => ({ observedAt: 5 * 3_600_000, windows: [{ label: "weekly", usedPercent: 66 }] }) });
  const ui = fakeUi([["claude"], true, true]);
  await runSetup({ ...d, ui });
  assert.match(ui.shown.find(([, title]) => title === "Usage now")[2], /Claude: no live reading yet \(last known, 5h old: weekly 66%\)/);
});

test("Linux reads the Claude login from the keyring when the file has none", () => {
  const calls = [];
  const login = JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: 5 } });
  const runner = (command, args) => { calls.push([command, ...args]); return login; };
  const homeDir = "/nonexistent-usage-guard-test";
  assert.equal(readClaudeCodeToken({ platform: "linux", homeDir, env: {}, now: 1, commandRunner: runner }), "k");
  assert.deepEqual(calls[0], ["secret-tool", "lookup", "service", "Claude Code-credentials"]);
  assert.equal(readClaudeCodeToken({ platform: "linux", homeDir, env: {}, now: 9, commandRunner: runner }), null); // expired
  assert.equal(readClaudeCodeToken({ platform: "linux", homeDir, env: {}, commandRunner: () => { throw new Error("no keyring"); } }), null);
});
