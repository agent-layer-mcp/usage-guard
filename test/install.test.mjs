import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import {
  configureBackgroundMonitor,
  configureNativeNotifier,
  configureScreenshotMemoryProxy,
  inspectConfiguredIntegrations,
  installIntegrations,
  uninstallIntegrations,
  upsertTomlArray,
} from "../src/install.mjs";
import { usageGuardInvocation } from "../plugins/usage-guard/scripts/runtime.mjs";

test("TOML update preserves comments and unrelated sections", () => {
  const raw = "# keep me\nmodel = \"example\"\n\n[tui]\ntheme = \"paper\"\n\n[features]\nweb = true\n";
  const updated = upsertTomlArray(raw, "tui", "status_line", ["five-hour-limit", "weekly-limit"]);
  const parsed = parse(updated);
  assert.match(updated, /# keep me/);
  assert.equal(parsed.tui.theme, "paper");
  assert.deepEqual(parsed.tui.status_line, ["five-hour-limit", "weekly-limit"]);
  assert.equal(parsed.features.web, true);
});

test("install and uninstall restore prior status-line settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-install-"));
  const home = path.join(root, "home");
  const stateHome = path.join(root, "state");
  const recordPath = path.join(stateHome, "install-record.json");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  const cliPath = path.join(root, "usage guard.mjs");
  writeFileSync(cliPath, "#!/usr/bin/env node\n");
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", statusLine: { type: "command", command: "old" } }));
  writeFileSync(path.join(home, ".codex", "config.toml"), "# user comment\n[tui]\nstatus_line = [\"model\"]\n");

  installIntegrations({
    homeDir: home,
    stateHome,
    recordPath,
    installPlugins: false,
    installMonitor: false,
    platform: "linux",
    runtime: {
      command: process.execPath,
      argsPrefix: [cliPath],
    },
    providerPaths: {
      claude: process.execPath,
      codex: process.execPath,
    },
  });
  const installedClaude = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const installedCodex = parse(readFileSync(path.join(home, ".codex", "config.toml"), "utf8"));
  assert.equal(
    installedClaude.statusLine.command,
    [process.execPath, cliPath, "statusline", "claude"].map(JSON.stringify).join(" "),
  );
  assert.ok(installedCodex.tui.status_line.includes("five-hour-limit"));
  assert.deepEqual(
    inspectConfiguredIntegrations({ homeDir: home, recordPath, platform: "linux" }).map((check) => check.ok),
    [true, true, true, true, true, true, true, true],
  );
  assert.equal(
    readFileSync(path.join(stateHome, "node-runtime"), "utf8").trim(),
    process.execPath,
  );
  assert.deepEqual(usageGuardInvocation({ USAGE_GUARD_HOME: stateHome }), {
    command: process.execPath,
    argsPrefix: [cliPath],
    providerPaths: {
      claude: process.execPath,
      codex: process.execPath,
    },
  });

  uninstallIntegrations({ recordPath, removePlugins: false });
  const restoredClaude = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const restoredCodexRaw = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.equal(restoredClaude.statusLine.command, "old");
  assert.deepEqual(parse(restoredCodexRaw).tui.status_line, ["model"]);
  assert.match(restoredCodexRaw, /# user comment/);
});

test("plugin bootstrap starts Node when desktop PATH omits it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-bootstrap-"));
  const stateHome = path.join(root, "state");
  const entrypoint = path.join(root, "entrypoint.mjs");
  const bootstrap = path.resolve("plugins/usage-guard/scripts/node-bootstrap.sh");
  mkdirSync(stateHome, { recursive: true });
  writeFileSync(path.join(stateHome, "node-runtime"), `${process.execPath}\n`);
  writeFileSync(entrypoint, "process.stdout.write('desktop-bootstrap-ok')\n");

  const output = execFileSync("/bin/sh", [bootstrap, entrypoint], {
    encoding: "utf8",
    env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      USAGE_GUARD_HOME: stateHome,
    },
  });

  assert.equal(output, "desktop-bootstrap-ok");
});

test("plugin manifests bootstrap without a bare Node command", () => {
  const hooks = readFileSync("plugins/usage-guard/hooks/hooks.json", "utf8");
  const parsedHooks = JSON.parse(hooks);
  const mcp = JSON.parse(readFileSync("plugins/usage-guard/.mcp.json", "utf8"));
  assert.doesNotMatch(hooks, /"command":\s*"node/);
  assert.match(hooks, /node-bootstrap\.sh/);
  assert.equal(parsedHooks.hooks.PreToolUse, undefined);
  assert.equal(parsedHooks.hooks.Stop.length, 1);
  assert.equal(mcp.mcpServers["usage-guard"].command, "/bin/sh");
  assert.match(mcp.mcpServers["usage-guard"].args[0], /node-bootstrap\.sh$/);
});

test("installer refreshes an existing Claude plugin version", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-update-"));
  const calls = [];
  installIntegrations({
    homeDir: path.join(root, "home"),
    stateHome: path.join(root, "state"),
    recordPath: path.join(root, "state", "install-record.json"),
    packageRoot: "/tmp/usage-guard-package",
    installMonitor: false,
    runtime: {
      command: process.execPath,
      argsPrefix: ["/tmp/usage-guard.mjs"],
    },
    commandRunner(command, args) {
      calls.push([command, ...args]);
      return { command: [command, ...args].join(" "), ok: true, output: "" };
    },
  });

  assert.ok(calls.some((call) => call.join(" ") ===
    "claude plugin update usage-guard@agent-layer --scope user"));
});

test("macOS monitor installs a one-minute LaunchAgent with the absolute runtime", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-monitor-"));
  const calls = [];
  const runtime = {
    command: process.execPath,
    argsPrefix: ["/tmp/usage guard.mjs"],
  };
  const monitor = configureBackgroundMonitor({
    home: path.join(root, "home"),
    stateHome: path.join(root, "state"),
    runtime,
    platform: "darwin",
    uid: 501,
    commandRunner(command, args) {
      calls.push([command, ...args]);
      return { ok: true };
    },
  });

  const plist = readFileSync(monitor.path, "utf8");
  assert.equal(monitor.enabled, true);
  assert.match(plist, /sh\.agentlayer\.usage-guard\.monitor/);
  assert.match(plist, /<integer>60<\/integer>/);
  assert.match(plist, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(plist, /<string>monitor<\/string>/);
  assert.match(plist, /<string>--once<\/string>/);
  assert.ok(calls.some((call) => call[1] === "bootstrap"));
});

test("macOS Screenshot Memory chains to the prior Claude upstream and restores it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-screenshot-memory-"));
  const home = path.join(root, "home");
  const stateHome = path.join(root, "state");
  const recordPath = path.join(stateHome, "install-record.json");
  const settingsPath = path.join(home, ".claude", "settings.json");
  const previousUpstream = "http://127.0.0.1:47821";
  const calls = [];
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: previousUpstream,
      KEEP_ME: "yes",
    },
  }));

  const record = installIntegrations({
    homeDir: home,
    stateHome,
    recordPath,
    packageRoot: root,
    installPlugins: false,
    installMonitor: false,
    platform: "darwin",
    uid: 501,
    runtime: {
      command: process.execPath,
      argsPrefix: [path.join(root, "usage-guard.mjs")],
    },
    providerPaths: {
      claude: process.execPath,
      codex: process.execPath,
    },
    commandRunner(command, args) {
      calls.push([command, ...args]);
      return { ok: true };
    },
  });

  const installedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const plist = readFileSync(record.screenshotMemory.path, "utf8");
  assert.equal(record.screenshotMemory.upstream, previousUpstream);
  assert.equal(installedSettings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:47822");
  assert.equal(installedSettings.env.KEEP_ME, "yes");
  assert.match(plist, /sh\.agentlayer\.usage-guard\.screenshot-memory/);
  assert.match(plist, /<string>http:\/\/127\.0\.0\.1:47821<\/string>/);
  assert.match(plist, /<string>5<\/string>/);
  assert.ok(calls.some((call) => call[1] === "bootstrap" && call.at(-1) === record.screenshotMemory.path));

  uninstallIntegrations({
    recordPath,
    removePlugins: false,
    platform: "darwin",
    uid: 501,
    commandRunner(command, args) {
      calls.push([command, ...args]);
      return { ok: true };
    },
  });

  const restoredSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(restoredSettings.env.ANTHROPIC_BASE_URL, previousUpstream);
  assert.equal(restoredSettings.env.KEEP_ME, "yes");
  assert.equal(existsSync(record.screenshotMemory.path), false);
});

test("Screenshot Memory LaunchAgent rejects a self-referencing upstream", () => {
  assert.throws(
    () => configureScreenshotMemoryProxy({
      home: "/tmp",
      stateHome: "/tmp",
      runtime: { command: process.execPath, argsPrefix: [] },
      upstream: "http://127.0.0.1:47822",
      platform: "darwin",
    }),
    /cannot point back to itself/,
  );
});

test("Screenshot Memory LaunchAgent rejects credential-bearing upstream URLs", () => {
  assert.throws(
    () => configureScreenshotMemoryProxy({
      home: "/tmp",
      stateHome: "/tmp",
      runtime: { command: process.execPath, argsPrefix: [] },
      upstream: "https://token@example.com/v1",
      platform: "darwin",
    }),
    /must not contain credentials/,
  );
});

test("macOS native notifier is built into the private state directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-notifier-"));
  const packageRoot = path.join(root, "package");
  const stateHome = path.join(root, "state");
  mkdirSync(path.join(packageRoot, "native"), { recursive: true });
  mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  writeFileSync(path.join(packageRoot, "native", "UsageGuardNotifier.swift"), "// source");
  writeFileSync(path.join(packageRoot, "native", "Info.plist"), "<plist/>");
  writeFileSync(path.join(packageRoot, "scripts", "build-macos-notifier.sh"), "#!/bin/sh");
  const calls = [];

  const notifier = configureNativeNotifier({
    packageRoot,
    stateHome,
    platform: "darwin",
    commandRunner(command, args) {
      calls.push([command, ...args]);
      return { ok: true };
    },
  });

  assert.equal(notifier.enabled, true);
  assert.equal(notifier.appPath, path.join(stateHome, "Usage Guard.app"));
  assert.deepEqual(calls[0], [
    "/bin/sh",
    path.join(packageRoot, "scripts", "build-macos-notifier.sh"),
    path.join(stateHome, "Usage Guard.app"),
  ]);
});
