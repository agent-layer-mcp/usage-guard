import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function installIntegrations(options = {}) {
  const home = options.homeDir || os.homedir();
  const stateHome = options.stateHome || guardHome(options.env);
  const packageRoot = options.packageRoot;
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const record = {
    installedAt: Date.now(),
    claude: configureClaude(path.join(home, ".claude", "settings.json"), stateHome),
    codex: configureCodex(path.join(home, ".codex", "config.toml"), stateHome),
  };

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
  if (options.removePlugins !== false) removePlugins(options.commandRunner || runCommand);
  return record;
}

export function configureClaude(settingsPath, stateHome) {
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  backupFile(settingsPath, stateHome, "claude-settings.json");
  const settings = readJsonFile(settingsPath, {});
  const previous = Object.hasOwn(settings, "statusLine") ? settings.statusLine : null;
  settings.statusLine = {
    type: "command",
    command: "usage-guard statusline claude",
    padding: 0,
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { path: settingsPath, previous };
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

function installPlugins(packageRoot, run) {
  const results = [];
  results.push(run("claude", ["plugin", "marketplace", "add", packageRoot]));
  results.push(run("claude", ["plugin", "install", "usage-guard@agent-layer", "--scope", "user"]));
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

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
