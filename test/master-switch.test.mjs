import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProviderHook } from "../src/hooks.mjs";
import { installIntegrations, setMonitorRunning } from "../src/install.mjs";
import { runMonitorCycle } from "../src/monitor.mjs";
import { routeJob } from "../src/route.mjs";
import { GuardStore } from "../src/store.mjs";

function reserveStore() {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "claude", source: "test", observedAt: now,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 97, windowMinutes: 300, resetsAt: now + 30 * 60_000 }],
  });
  return store;
}

test("off: hooks are silent even at the reserve, and back on they block again", async () => {
  const store = reserveStore();
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash" };
  const options = { claudeDesktop: { platform: "none" } };
  store.setConfig({ enabled: false });
  assert.deepEqual(await runProviderHook(store, "claude", input, options), {});
  assert.deepEqual(await runProviderHook(store, "claude", { hook_event_name: "UserPromptSubmit", prompt: "go" }, options), {});
  store.setConfig({ enabled: true });
  assert.equal((await runProviderHook(store, "claude", input, options)).hookSpecificOutput.permissionDecision, "deny");
  store.close();
});

test("off: monitor does nothing and route answers passthrough", async () => {
  const store = reserveStore();
  store.setConfig({ enabled: false });
  const notifications = [];
  assert.deepEqual(await runMonitorCycle(store, { providers: ["claude"], claudeDesktop: { platform: "none" }, notifier: (n) => notifications.push(n) }), []);
  assert.equal(notifications.length, 0);
  const route = routeJob(store, "code");
  assert.equal(route.lane, "off");
  assert.equal(route.disabled, true);
  assert.equal(store.recentDecisions(10).length, 0);
  store.close();
});

test("install without integrations leaves Claude/Codex settings alone and the timer stopped; the switch starts it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-off-"));
  const home = path.join(root, "home");
  const recordPath = path.join(root, "state", "install-record.json");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const calls = [];
  installIntegrations({ homeDir: home, stateHome: path.join(root, "state"), recordPath, platform: "linux", integrations: false, startMonitor: false,
    runtime: { command: process.execPath, argsPrefix: ["/x/usage-guard.mjs"] }, env: {},
    commandRunner: (command, args) => { calls.push([command, ...args]); return { ok: true }; } });
  assert.deepEqual(calls, [["systemctl", "--user", "daemon-reload"]]);
  assert.equal(existsSync(settingsPath), false);
  assert.equal(existsSync(path.join(home, ".codex", "config.toml")), false);
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  assert.equal(record.integrations, false);
  assert.equal(record.monitor.started, false);
  assert.match(readFileSync(record.monitor.servePath, "utf8"), /"serve"/);
  const toggles = [];
  const runner = (command, args) => { toggles.push([command, ...args]); return { ok: true }; };
  assert.equal(setMonitorRunning(true, { recordPath, platform: "linux", commandRunner: runner }), true);
  assert.equal(setMonitorRunning(false, { recordPath, platform: "linux", commandRunner: runner }), true);
  assert.deepEqual(toggles.map((call) => call[2]), ["enable", "disable"]);
  writeFileSync(recordPath, "{}");
  assert.equal(setMonitorRunning(true, { recordPath, platform: "linux", commandRunner: runner }), false);
});

test("the Claude status line keeps the user's previous status line, unchanged while off", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-statusline-"));
  const script = path.join(root, "statusline.sh");
  writeFileSync(script, "#!/bin/sh\nread input\necho \"mine: $input\"\n", { mode: 0o755 });
  writeFileSync(path.join(root, "install-record.json"), JSON.stringify({ claude: { previous: { type: "command", command: script } } }));
  const cli = fileURLToPath(new URL("../bin/usage-guard.mjs", import.meta.url));
  const run = (args, input = "") => spawnSync(process.execPath, [cli, ...args], {
    input, encoding: "utf8", env: { ...process.env, USAGE_GUARD_HOME: root },
  }).stdout.trim();
  run(["config", "enabled", "false"]);
  assert.equal(run(["statusline", "claude"], '{"session_id":"s"}'), 'mine: {"session_id":"s"}');
  run(["config", "enabled", "true"]);
  assert.match(run(["statusline", "claude"], '{"session_id":"s"}'), /^mine: \{"session_id":"s"\} \| UG /);
});
