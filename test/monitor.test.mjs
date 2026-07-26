import test from "node:test";
import assert from "node:assert/strict";
import { runMonitorCycle, notifyMacOS } from "../src/monitor.mjs";
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

test("macOS notifier emits a visible AppleScript notification", () => {
  const calls = [];
  const shown = notifyMacOS({
    title: "Usage Guard",
    subtitle: "Claude: PROTECT",
    message: 'Quota "pressure"',
    state: "protect",
  }, {
    platform: "darwin",
    commandRunner(command, args) {
      calls.push([command, ...args]);
    },
  });

  assert.equal(shown, true);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.match(calls[0][2], /display notification/);
  assert.match(calls[0][2], /sound name "Glass"/);
});
