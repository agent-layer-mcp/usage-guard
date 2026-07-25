import test from "node:test";
import assert from "node:assert/strict";
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
    [true, true, true],
  );
  assert.deepEqual(usageGuardInvocation({ USAGE_GUARD_HOME: stateHome }), {
    command: process.execPath,
    argsPrefix: [cliPath],
  });

  uninstallIntegrations({ recordPath, removePlugins: false });
  const restoredClaude = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const restoredCodexRaw = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.equal(restoredClaude.statusLine.command, "old");
  assert.deepEqual(parse(restoredCodexRaw).tui.status_line, ["model"]);
  assert.match(restoredCodexRaw, /# user comment/);
});
