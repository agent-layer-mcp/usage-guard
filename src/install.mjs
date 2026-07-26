import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { guardHome, installRecordPath } from "./config.mjs";

const CODEX_STATUS_ITEMS = [
  "model-with-reasoning",
  "context-remaining",
  "five-hour-limit",
  "weekly-limit",
];
const MONITOR_LABEL = "sh.agentlayer.usage-guard.monitor";

export function installIntegrations(options = {}) {
  const home = options.homeDir || os.homedir();
  const stateHome = options.stateHome || guardHome(options.env);
  const packageRoot = options.packageRoot;
  const runtime = normalizeRuntime(options.runtime);
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const bootstrapRuntimePath = path.join(stateHome, "node-runtime");
  if (runtime?.command) {
    writeFileSync(bootstrapRuntimePath, `${runtime.command}\n`, { mode: 0o600 });
  }
  const record = {
    installedAt: Date.now(),
    runtime,
    bootstrapRuntimePath,
    providers: normalizeProviderPaths(options.providerPaths),
    claude: configureClaude(
      path.join(home, ".claude", "settings.json"),
      stateHome,
      runtime ? runtimeCommand(runtime, ["statusline", "claude"]) : undefined,
    ),
    codex: configureCodex(path.join(home, ".codex", "config.toml"), stateHome),
  };
  record.monitor = configureBackgroundMonitor({
    home,
    stateHome,
    runtime,
    enabled: options.installMonitor !== false,
    platform: options.platform,
    uid: options.uid,
    commandRunner: options.commandRunner || runCommand,
  });

  if (options.installPlugins !== false && packageRoot) {
    record.plugins = installPlugins(packageRoot, options.commandRunner || runCommand);
  }
  writeFileSync(options.recordPath || installRecordPath(options.env), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

export function uninstallIntegrations(options = {}) {
  const recordPath = options.recordPath || installRecordPath(options.env);
  if (!existsSync(recordPath)) throw new Error("No Usage Guard install record was found.");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  restoreClaude(record.claude);
  restoreCodex(record.codex);
  restoreBackgroundMonitor(record.monitor, {
    platform: options.platform,
    uid: options.uid,
    commandRunner: options.commandRunner || runCommand,
  });
  if (options.removePlugins !== false) removePlugins(options.commandRunner || runCommand);
  return record;
}

export function configureClaude(
  settingsPath,
  stateHome,
  command = "usage-guard statusline claude",
) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  backupFile(settingsPath, stateHome, "claude-settings.json");
  const settings = readJsonFile(settingsPath, {});
  const previous = Object.hasOwn(settings, "statusLine") ? settings.statusLine : null;
  settings.statusLine = {
    type: "command",
    command,
    padding: 0,
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { path: settingsPath, previous };
}

export function inspectConfiguredIntegrations(options = {}) {
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const recordPath = options.recordPath || installRecordPath(options.env);
  const settingsPath = path.join(home, ".claude", "settings.json");
  const configPath = path.join(home, ".codex", "config.toml");
  const record = existsSync(recordPath) ? readJsonFile(recordPath, {}) : {};
  const runtime = normalizeRuntime(record.runtime);
  const providers = normalizeProviderPaths(record.providers);
  const expectedClaudeCommand = runtime
    ? runtimeCommand(runtime, ["statusline", "claude"])
    : null;
  const settings = readJsonFile(settingsPath, {});
  const claudeCommand = settings.statusLine?.command || null;
  const codexConfig = existsSync(configPath) && readFileSync(configPath, "utf8").trim()
    ? parse(readFileSync(configPath, "utf8"))
    : {};
  const codexItems = Array.isArray(codexConfig.tui?.status_line)
    ? codexConfig.tui.status_line
    : [];
  const runtimeFiles = runtime
    ? [runtime.command, ...runtime.argsPrefix].filter((value) => path.isAbsolute(value))
    : [];
  const runtimeReady = runtime
    && path.isAbsolute(runtime.command)
    && runtimeFiles.every(existsSync);
  const bootstrapRuntimePath = record.bootstrapRuntimePath
    || path.join(path.dirname(recordPath), "node-runtime");
  const bootstrapRuntime = existsSync(bootstrapRuntimePath)
    ? readFileSync(bootstrapRuntimePath, "utf8").trim()
    : null;
  const bootstrapReady = Boolean(
    runtimeReady
    && bootstrapRuntime === runtime.command
    && path.isAbsolute(bootstrapRuntime)
    && existsSync(bootstrapRuntime),
  );
  const monitorPath = record.monitor?.path
    || path.join(home, "Library", "LaunchAgents", `${MONITOR_LABEL}.plist`);
  const monitorReady = platform !== "darwin"
    || Boolean(record.monitor?.enabled && existsSync(monitorPath));

  return [
    {
      label: "Desktop runtime",
      ok: Boolean(runtimeReady),
      detail: runtimeReady
        ? runtime.command
        : "rerun `usage-guard install` to record absolute Node and CLI paths",
    },
    {
      label: "Plugin bootstrap",
      ok: bootstrapReady,
      detail: bootstrapReady
        ? bootstrapRuntimePath
        : "rerun `usage-guard install` to make hooks independent of desktop PATH",
    },
    {
      label: "Claude status line",
      ok: Boolean(expectedClaudeCommand && claudeCommand === expectedClaudeCommand),
      detail: expectedClaudeCommand && claudeCommand === expectedClaudeCommand
        ? "absolute runtime configured"
        : claudeCommand || "not configured",
    },
    {
      label: "Codex app-server",
      ok: Boolean(providers.codex && path.isAbsolute(providers.codex) && existsSync(providers.codex)),
      detail: providers.codex || "rerun `usage-guard install` to record the Codex CLI path",
    },
    {
      label: "Codex status line",
      ok: CODEX_STATUS_ITEMS.every((item) => codexItems.includes(item)),
      detail: codexItems.length ? codexItems.join(", ") : "not configured",
    },
    {
      label: "Desktop monitor",
      ok: monitorReady,
      detail: platform !== "darwin"
        ? "not applicable on this platform"
        : monitorReady
          ? "checks aggregate Claude usage every minute"
          : "rerun `usage-guard install` to enable macOS alerts",
    },
  ];
}

export function configureBackgroundMonitor(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "darwin" || options.enabled === false || !options.runtime) {
    return { enabled: false, platform };
  }

  const home = options.home || os.homedir();
  const stateHome = options.stateHome || guardHome();
  const plistPath = path.join(home, "Library", "LaunchAgents", `${MONITOR_LABEL}.plist`);
  const run = options.commandRunner || runCommand;
  const uid = options.uid ?? process.getuid?.();
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const existing = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : null;
  const previous = existing?.includes(`<string>${MONITOR_LABEL}</string>`) ? null : existing;
  const plist = monitorPlist({
    runtime: options.runtime,
    stateHome,
    stdoutPath: path.join(stateHome, "monitor.log"),
  });

  if (existsSync(plistPath)) {
    run("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath], true);
  }
  writeFileSync(plistPath, plist, { mode: 0o600 });
  run("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);

  return {
    enabled: true,
    label: MONITOR_LABEL,
    path: plistPath,
    previous,
    intervalSeconds: 60,
  };
}

export function configureCodex(configPath, stateHome) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  backupFile(configPath, stateHome, "codex-config.toml");
  const raw = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const parsed = raw.trim() ? parse(raw) : {};
  const previous = Array.isArray(parsed.tui?.status_line) ? parsed.tui.status_line : null;
  const merged = [...new Set([...(previous || []), ...CODEX_STATUS_ITEMS])];
  const updated = upsertTomlArray(raw, "tui", "status_line", merged);
  parse(updated);
  writeFileSync(configPath, updated);
  return { path: configPath, previous };
}

export function upsertTomlArray(raw, section, key, values) {
  const line = `${key} = [${values.map((value) => JSON.stringify(value)).join(", ")}]`;
  const lines = raw.replace(/\s+$/, "").split("\n").filter((item, index, all) => !(all.length === 1 && item === ""));
  let sectionStart = lines.findIndex((item) => item.trim() === `[${section}]`);
  if (sectionStart === -1) {
    if (lines.length) lines.push("");
    lines.push(`[${section}]`, line);
    return `${lines.join("\n")}\n`;
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  const keyIndex = lines.findIndex((item, index) => index > sectionStart && index < sectionEnd && keyPattern.test(item));
  if (keyIndex >= 0) lines[keyIndex] = line;
  else lines.splice(sectionStart + 1, 0, line);
  return `${lines.join("\n")}\n`;
}

export function removeTomlKey(raw, section, key) {
  const lines = raw.split("\n");
  const sectionStart = lines.findIndex((item) => item.trim() === `[${section}]`);
  if (sectionStart < 0) return raw;
  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  return lines.filter((item, index) => !(index > sectionStart && index < sectionEnd && keyPattern.test(item))).join("\n");
}

function restoreClaude(record) {
  if (!record?.path || !existsSync(record.path)) return;
  const settings = readJsonFile(record.path, {});
  if (record.previous == null) delete settings.statusLine;
  else settings.statusLine = record.previous;
  writeFileSync(record.path, `${JSON.stringify(settings, null, 2)}\n`);
}

function restoreCodex(record) {
  if (!record?.path || !existsSync(record.path)) return;
  const raw = readFileSync(record.path, "utf8");
  const updated = record.previous == null
    ? removeTomlKey(raw, "tui", "status_line")
    : upsertTomlArray(raw, "tui", "status_line", record.previous);
  if (updated.trim()) parse(updated);
  writeFileSync(record.path, updated.endsWith("\n") ? updated : `${updated}\n`);
}

function restoreBackgroundMonitor(record, options = {}) {
  if (!record?.enabled || !record.path) return;
  const platform = options.platform || process.platform;
  if (platform !== "darwin") return;
  const run = options.commandRunner || runCommand;
  const uid = options.uid ?? process.getuid?.();
  run("/bin/launchctl", ["bootout", `gui/${uid}`, record.path], true);
  if (record.previous == null) {
    if (existsSync(record.path)) unlinkSync(record.path);
    return;
  }
  writeFileSync(record.path, record.previous, { mode: 0o600 });
  run("/bin/launchctl", ["bootstrap", `gui/${uid}`, record.path], true);
}

function installPlugins(packageRoot, run) {
  const results = [];
  results.push(run("claude", ["plugin", "marketplace", "add", packageRoot]));
  results.push(run("claude", ["plugin", "install", "usage-guard@agent-layer", "--scope", "user"]));
  results.push(run("claude", ["plugin", "update", "usage-guard@agent-layer", "--scope", "user"]));
  results.push(run("codex", ["plugin", "marketplace", "add", packageRoot, "--json"]));
  results.push(run("codex", ["plugin", "add", "usage-guard@agent-layer", "--json"]));
  return results;
}

function removePlugins(run) {
  run("claude", ["plugin", "uninstall", "usage-guard@agent-layer"], true);
  run("claude", ["plugin", "marketplace", "remove", "agent-layer"], true);
  run("codex", ["plugin", "remove", "usage-guard"], true);
  run("codex", ["plugin", "marketplace", "remove", "agent-layer"], true);
}

function runCommand(command, args, allowFailure = false) {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { command: `${command} ${args.join(" ")}`, ok: true, output: output.trim() };
  } catch (error) {
    const message = String(error.stderr || error.message || "Command failed").trim();
    if (allowFailure || /already|exists|configured|installed/i.test(message)) {
      return { command: `${command} ${args.join(" ")}`, ok: true, output: message };
    }
    throw new Error(`${command} integration failed: ${message}`);
  }
}

function backupFile(source, stateHome, filename) {
  if (!existsSync(source)) return null;
  const directory = path.join(stateHome, "backups");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${Date.now()}-${filename}`);
  copyFileSync(source, destination);
  return destination;
}

function readJsonFile(filename, fallback) {
  if (!existsSync(filename)) return fallback;
  return JSON.parse(readFileSync(filename, "utf8"));
}

function normalizeRuntime(runtime) {
  if (!runtime?.command || typeof runtime.command !== "string") return null;
  return {
    command: runtime.command,
    argsPrefix: Array.isArray(runtime.argsPrefix)
      ? runtime.argsPrefix.map(String)
      : [],
  };
}

function normalizeProviderPaths(providerPaths) {
  return {
    claude: typeof providerPaths?.claude === "string" ? providerPaths.claude : null,
    codex: typeof providerPaths?.codex === "string" ? providerPaths.codex : null,
  };
}

function runtimeCommand(runtime, args = []) {
  return [runtime.command, ...runtime.argsPrefix, ...args]
    .map((value) => JSON.stringify(value))
    .join(" ");
}

function monitorPlist({ runtime, stateHome, stdoutPath }) {
  const args = [
    runtime.command,
    ...runtime.argsPrefix,
    "monitor",
    "--once",
    "--provider",
    "claude",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MONITOR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>USAGE_GUARD_HOME</key>
    <string>${escapeXml(stateHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stdoutPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
