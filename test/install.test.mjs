import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import {
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
    inspectConfiguredIntegrations({ homeDir: home, recordPath }).map((check) => check.ok),
    [true, true, true, true, true],
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
  const mcp = JSON.parse(readFileSync("plugins/usage-guard/.mcp.json", "utf8"));
  assert.doesNotMatch(hooks, /"command":\s*"node/);
  assert.match(hooks, /node-bootstrap\.sh/);
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
