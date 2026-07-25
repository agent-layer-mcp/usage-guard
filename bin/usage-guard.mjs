#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/config.mjs";
import { startDashboard } from "../src/dashboard.mjs";
import { runProviderHook } from "../src/hooks.mjs";
import {
  inspectConfiguredIntegrations,
  installIntegrations,
  uninstallIntegrations,
} from "../src/install.mjs";
import { runMcpServer } from "../src/mcp.mjs";
import { formatStatusLine, formatStatusText } from "../src/presentation.mjs";
import { completeStatus, ingestClaudeStatus, providerDecision, syncCodex } from "../src/service.mjs";
import { GuardStore } from "../src/store.mjs";

const cliPath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(cliPath), "..");
const [command = "status", ...args] = process.argv.slice(2);
const store = new GuardStore();

try {
  if (["help", "--help", "-h"].includes(command)) {
    console.log(helpText());
    store.close();
  } else if (["--version", "-v", "version"].includes(command)) {
    console.log(VERSION);
    store.close();
  } else if (command === "status") {
    if (!args.includes("--no-sync")) await bestEffortCodexSync();
    const status = completeStatus(store);
    console.log(args.includes("--json") ? JSON.stringify(status, null, 2) : formatStatusText(status));
    store.close();
  } else if (command === "sync") {
    const provider = args[0] || "codex";
    if (!["codex", "all"].includes(provider)) throw new Error("Claude quota sync arrives through its status line; use `usage-guard statusline claude`.");
    const snapshot = await syncCodex(store);
    console.log(JSON.stringify({ synced: "codex", windows: snapshot.windows }, null, 2));
    store.close();
  } else if (command === "statusline" && args[0] === "claude") {
    const input = await readStdinJson();
    ingestClaudeStatus(store, input);
    const decision = providerDecision(store, "claude");
    console.log(formatStatusLine(decision));
    store.close();
  } else if (command === "hook") {
    const provider = args[0];
    if (!["claude", "codex"].includes(provider)) throw new Error("Hook provider must be `claude` or `codex`.");
    const input = await readStdinJson();
    const output = await runProviderHook(store, provider, input, { eventName: args[1] });
    console.log(JSON.stringify(output));
    store.close();
  } else if (command === "serve") {
    await bestEffortCodexSync();
    const portIndex = args.indexOf("--port");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;
    const dashboard = await startDashboard(store, { port });
    console.log(`Usage Guard is running at ${dashboard.url}`);
    const close = () => dashboard.server.close(() => {
      store.close();
      process.exit(0);
    });
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  } else if (command === "mcp") {
    runMcpServer(store);
    process.on("SIGINT", () => {
      store.close();
      process.exit(0);
    });
  } else if (command === "config") {
    if (!args.length) console.log(JSON.stringify(store.getConfig(), null, 2));
    else {
      const patch = parseConfigArgs(args);
      console.log(JSON.stringify(store.setConfig(patch), null, 2));
    }
    store.close();
  } else if (command === "install") {
    const record = installIntegrations({
      packageRoot,
      installPlugins: !args.includes("--settings-only"),
      runtime: {
        command: process.execPath,
        argsPrefix: [cliPath],
      },
    });
    console.log(`Usage Guard installed for Claude Code and Codex.\nBackup and rollback record: ${record.installedAt}`);
    store.close();
  } else if (command === "uninstall") {
    uninstallIntegrations({ removePlugins: !args.includes("--settings-only") });
    console.log("Usage Guard integrations removed and previous status-line settings restored.");
    store.close();
  } else if (command === "doctor") {
    await runDoctor();
    store.close();
  } else if (command === "demo") {
    seedDemo(store);
    console.log(formatStatusText(completeStatus(store)));
    store.close();
  } else if (command === "reset") {
    store.clear();
    console.log("Usage Guard quota history and decisions cleared.");
    store.close();
  } else {
    throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
} catch (error) {
  try { store.close(); } catch {}
  console.error(`Usage Guard: ${error.message}`);
  process.exitCode = 1;
}

async function bestEffortCodexSync() {
  try {
    await syncCodex(store, { timeoutMs: 6000 });
  } catch {
    // Status still communicates missing or stale data without breaking the CLI.
  }
}

async function readStdinJson() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  return JSON.parse(input);
}

function parseConfigArgs(values) {
  const patch = {};
  for (let index = 0; index < values.length; index += 1) {
    const [inlineKey, inlineValue] = values[index].split("=", 2);
    const key = inlineKey;
    const value = inlineValue ?? values[++index];
    if (value == null) throw new Error(`Missing value for ${key}.`);
    patch[key] = parseScalar(value);
  }
  return patch;
}

function parseScalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return Number.isFinite(number) && value.trim() !== "" ? number : value;
}

async function runDoctor() {
  const checks = [
    commandCheck("claude", ["--version"]),
    commandCheck("codex", ["--version"]),
    { label: "Local database", ok: true, detail: store.filename },
    { label: "Quality lock", ok: store.getConfig().qualityLock, detail: store.getConfig().qualityLock ? "enabled" : "disabled" },
    ...inspectConfiguredIntegrations(),
    pluginCheck("claude", ["plugin", "list", "--json"], "usage-guard@agent-layer"),
    pluginCheck("codex", ["plugin", "list", "--json"], "usage-guard@agent-layer"),
  ];
  await bestEffortCodexSync();
  for (const provider of ["claude", "codex"]) {
    const decision = providerDecision(store, provider);
    checks.push({ label: `${provider} meter`, ok: !["missing", "stale"].includes(decision.state), detail: decision.state });
  }
  const claudeContext = store.latestContext("claude");
  checks.push({
    label: "claude context",
    ok: Boolean(claudeContext),
    detail: claudeContext
      ? `${claudeContext.contextPercent.toFixed(1)}% from a local session`
      : "no context observation yet",
  });
  for (const check of checks) console.log(`${check.ok ? "PASS" : "WAIT"}  ${check.label.padEnd(18)} ${check.detail}`);
  console.log("\nUsage Guard reads provider quota signals only. It does not read auth files, cookies, prompts, transcripts, or source code.");
}

function commandCheck(executable, commandArgs) {
  const result = spawnSync(executable, commandArgs, { encoding: "utf8" });
  return {
    label: `${executable} CLI`,
    ok: result.status === 0,
    detail: result.status === 0 ? (result.stdout || result.stderr).trim() : "not found",
  };
}

function pluginCheck(executable, commandArgs, pluginId) {
  const result = spawnSync(executable, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    return { label: `${executable} plugin`, ok: false, detail: "unable to inspect" };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const plugins = Array.isArray(parsed) ? parsed : parsed.installed || [];
    const plugin = plugins.find((item) => (item.id || item.pluginId) === pluginId);
    return {
      label: `${executable} plugin`,
      ok: Boolean(plugin?.enabled),
      detail: plugin ? (plugin.enabled ? "installed and enabled" : "installed but disabled") : "not installed",
    };
  } catch {
    return { label: `${executable} plugin`, ok: false, detail: "invalid plugin-list response" };
  }
}

function seedDemo(target) {
  const now = Date.now();
  target.clear();
  target.saveSnapshot({
    provider: "claude", source: "demo", observedAt: now - 15 * 60_000, model: "Sonnet", effort: "high", contextPercent: 52,
    windows: [
      { key: "five-hour", label: "5 hour", usedPercent: 28, windowMinutes: 300, resetsAt: now + 185 * 60_000 },
      { key: "seven-day", label: "weekly", usedPercent: 57, windowMinutes: 10_080, resetsAt: now + 2.8 * 24 * 60 * 60_000 },
    ],
  });
  target.saveSnapshot({
    provider: "claude", source: "demo", observedAt: now, model: "Sonnet", effort: "high", contextPercent: 59,
    windows: [
      { key: "five-hour", label: "5 hour", usedPercent: 34, windowMinutes: 300, resetsAt: now + 185 * 60_000 },
      { key: "seven-day", label: "weekly", usedPercent: 58, windowMinutes: 10_080, resetsAt: now + 2.8 * 24 * 60 * 60_000 },
    ],
  });
  target.saveSnapshot({
    provider: "codex", source: "demo", observedAt: now - 15 * 60_000, model: "GPT", effort: "high", contextPercent: 41,
    windows: [
      { key: "codex:primary", label: "5 hour", usedPercent: 63, windowMinutes: 300, resetsAt: now + 95 * 60_000 },
      { key: "codex:secondary", label: "weekly", usedPercent: 71, windowMinutes: 10_080, resetsAt: now + 4.2 * 24 * 60 * 60_000 },
    ],
  });
  target.saveSnapshot({
    provider: "codex", source: "demo", observedAt: now, model: "GPT", effort: "high", contextPercent: 48,
    windows: [
      { key: "codex:primary", label: "5 hour", usedPercent: 68, windowMinutes: 300, resetsAt: now + 95 * 60_000 },
      { key: "codex:secondary", label: "weekly", usedPercent: 72, windowMinutes: 10_080, resetsAt: now + 4.2 * 24 * 60 * 60_000 },
    ],
  });
}

function helpText() {
  return `Usage Guard ${VERSION}

Quality-preserving quota governance for Claude Code and Codex.

Commands:
  status [--json] [--no-sync]  Show windows, pace, and deliberate choices
  sync codex                    Refresh Codex through its local app-server
  serve [--port 4765]           Run the local dashboard
  config [key value]            Read or change local policy
  install                       Install both plugins and status-line settings
  uninstall                     Remove integrations and restore prior settings
  doctor                        Verify providers, meters, and privacy boundary
  demo                          Load local example readings
  reset                         Clear local readings and decision history
  mcp                           Run the local MCP server over stdio

Integration commands used by the plugins:
  statusline claude
  hook <claude|codex> [event]

Usage Guard never silently changes model or reasoning quality.`;
}
