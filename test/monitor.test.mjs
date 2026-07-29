import test from "node:test";
import assert from "node:assert/strict";
import {
  findNativeNotifier,
  findTerminalNotifier,
  runMonitorCycle,
  notifyMacOS,
} from "../src/monitor.mjs";
import { GuardStore } from "../src/store.mjs";

test("monitor notifies once on escalation and rearms after returning safe", async () => {
  const store = new GuardStore({ filename: ":memory:" });
  const notifications = [];
  let now = Date.UTC(2026, 6, 26, 20, 0);

  const save = (usedPercent) => store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent,
      windowMinutes: 300,
      resetsAt: null,
    }],
  });
  const cycle = () => runMonitorCycle(store, {
    providers: ["claude"],
    now,
    claudeDesktop: { platform: "linux" },
    notifier: (notification) => notifications.push(notification),
  });

  save(75);
  assert.equal((await cycle())[0].notified, true);
  assert.equal(notifications.length, 1);
  assert.equal((await cycle())[0].notified, false);

  now += 5 * 60_000;
  save(96);
  assert.equal((await cycle())[0].notified, true);
  assert.equal(notifications.at(-1).state, "queue");

  now += 5 * 60_000;
  save(5);
  assert.equal((await cycle())[0].notified, false);

  now += 5 * 60_000;
  save(75);
  assert.equal((await cycle())[0].notified, true);
  assert.equal(notifications.length, 3);
  store.close();
});

test("monitor alerts when short-window pressure takes control at the same overall severity", async () => {
  const store = new GuardStore({ filename: ":memory:" });
  const notifications = [];
  let now = Date.UTC(2026, 6, 30, 0, 0);
  const save = (fiveHour, weekly) => store.saveSnapshot({
    provider: "claude",
    source: "test",
    observedAt: now,
    windows: [{
      key: "five-hour",
      label: "5 hour",
      usedPercent: fiveHour,
      windowMinutes: 300,
      resetsAt: null,
    }, {
      key: "seven-day",
      label: "weekly",
      usedPercent: weekly,
      windowMinutes: 10_080,
      resetsAt: null,
    }],
  });
  const cycle = () => runMonitorCycle(store, {
    providers: ["claude"],
    now,
    claudeDesktop: { platform: "linux" },
    notifier: (notification) => notifications.push(notification),
  });

  save(10, 70);
  await cycle();
  now += 5 * 60_000;
  save(10, 85);
  const weeklyProtect = await cycle();
  assert.equal(weeklyProtect[0].decision.state, "protect");
  assert.equal(weeklyProtect[0].notified, true);

  now += 5 * 60_000;
  save(80, 85);
  const shortWindowProtect = await cycle();
  assert.equal(shortWindowProtect[0].decision.state, "protect");
  assert.equal(shortWindowProtect[0].notified, true);
  assert.equal(notifications.length, 3);
  store.close();
});

test("macOS notifier emits a visible AppleScript notification", () => {
  const calls = [];
  const shown = notifyMacOS({
    title: "Usage Guard",
    subtitle: "Claude: PROTECT",
    message: 'Quota "pressure"',
    state: "protect",
  }, {
    platform: "darwin",
    nativeNotifierPath: null,
    terminalNotifierPath: null,
    commandRunner(command, args) {
      calls.push([command, ...args]);
    },
  });

  assert.equal(shown, true);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.match(calls[0][2], /display notification/);
  assert.match(calls[0][2], /sound name "Glass"/);
});

test("macOS notifier prefers the native Usage Guard helper", () => {
  const calls = [];
  const shown = notifyMacOS({
    title: "Usage Guard",
    subtitle: "Claude: WATCH",
    message: "Quota pressure",
    state: "watch",
  }, {
    platform: "darwin",
    nativeNotifierPath: "/tmp/Usage Guard.app/Contents/MacOS/UsageGuardNotifier",
    commandRunner(command, args) {
      calls.push([command, ...args]);
    },
  });

  assert.equal(shown, true);
  assert.equal(calls[0][0], "/tmp/Usage Guard.app/Contents/MacOS/UsageGuardNotifier");
  assert.deepEqual(calls[0].slice(1), [
    "--title", "Usage Guard",
    "--subtitle", "Claude: WATCH",
    "--message", "Quota pressure",
    "--identifier", "sh.agentlayer.usage-guard.watch",
  ]);
});

test("macOS notifier falls back to terminal-notifier", () => {
  const calls = [];
  notifyMacOS({
    title: "Usage Guard",
    subtitle: "Claude: WATCH",
    message: "Quota pressure",
    state: "watch",
  }, {
    platform: "darwin",
    nativeNotifierPath: null,
    terminalNotifierPath: "/opt/homebrew/bin/terminal-notifier",
    commandRunner(command, args) {
      calls.push([command, ...args]);
    },
  });
  assert.equal(calls[0][0], "/opt/homebrew/bin/terminal-notifier");
});

test("native notifier discovery uses the Usage Guard state directory", () => {
  const expected = "/tmp/usage-guard/Usage Guard.app/Contents/MacOS/UsageGuardNotifier";
  assert.equal(findNativeNotifier({
    stateHome: "/tmp/usage-guard",
    exists: (candidate) => candidate === expected,
  }), expected);
  assert.equal(findNativeNotifier({ stateHome: "/tmp/missing", exists: () => false }), null);
});

test("terminal-notifier discovery checks Apple Silicon and Intel Homebrew paths", () => {
  assert.equal(findTerminalNotifier({
    exists: (candidate) => candidate === "/usr/local/bin/terminal-notifier",
  }), "/usr/local/bin/terminal-notifier");
  assert.equal(findTerminalNotifier({ exists: () => false }), null);
});
