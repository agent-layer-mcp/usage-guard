import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The plan-usage endpoint Claude Code's own usage screen reads, signed in with its
// OAuth login. The token is read per call, sent only to this URL, and never kept.
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 15_000;
// A keyring or keychain lookup that takes longer than this is treated as "no login here".
const LOGIN_READ_MS = 2000;

export function claudeCredentialsPath(options = {}) {
  const env = options.env ?? process.env;
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(options.homeDir ?? os.homedir(), ".claude"), ".credentials.json");
}

// Where Claude Code keeps its login: the macOS Keychain; on Linux the ~/.claude file,
// then the Secret Service keyring; elsewhere the file.
export function claudeLoginSources(options = {}) {
  if (options.credentialsPath) return ["file"];
  const platform = options.platform ?? process.platform;
  return platform === "darwin" ? ["keychain"] : platform === "linux" ? ["file", "keyring"] : ["file"];
}

async function readClaudeLogin(source, options) {
  const timeout = Math.min(LOGIN_READ_MS, options.budgetMs ?? Infinity);
  const run = options.commandRunner ?? (async (command, args) => (await execFileAsync(command, args, { encoding: "utf8", timeout })).stdout);
  if (source === "keychain") return run("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  if (source === "keyring") return run("secret-tool", ["lookup", "service", "Claude Code-credentials"]);
  return readFileSync(options.credentialsPath ?? claudeCredentialsPath(options), "utf8");
}

// Claude Code's login, or null when it is missing or expired. No other credential is tried.
export async function readClaudeCodeToken(options = {}) {
  const now = options.now ?? Date.now();
  for (const source of claudeLoginSources(options)) {
    try {
      const oauth = JSON.parse(await readClaudeLogin(source, options))?.claudeAiOauth;
      if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) continue;
      if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= now) continue;
      return oauth.accessToken;
    } catch {
      // Missing or unreadable here; try the next place.
    }
  }
  return null;
}

export function parseClaudeUsage(payload, now = Date.now()) {
  const windows = [];
  for (const [field, key, label, windowMinutes] of [["five_hour", "five-hour", "5 hour", 300], ["seven_day", "seven-day", "weekly", 10_080]]) {
    const bucket = payload?.[field];
    if (!Number.isFinite(bucket?.utilization)) continue;
    const resetsAt = bucket.resets_at ? Date.parse(bucket.resets_at) : NaN;
    windows.push({ key, label, usedPercent: Math.max(0, Math.min(100, bucket.utilization)), windowMinutes, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null });
  }
  return { provider: "claude", observedAt: now, source: "claude-oauth-usage", model: null, effort: null, contextPercent: null, windows };
}

// One reading, or null when there is no login or the call fails (the lane then goes stale).
// options.budgetMs caps the whole call (login read plus request), for hooks that have a deadline.
export async function fetchClaudeUsage(options = {}) {
  const started = Date.now();
  const token = await readClaudeCodeToken(options);
  if (!token) return null;
  const remainingMs = (options.budgetMs ?? Infinity) - (Date.now() - started);
  if (remainingMs < 500) return null;
  try {
    const response = await (options.fetch ?? fetch)(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? TIMEOUT_MS, remainingMs)),
    });
    if (!response.ok) return null;
    const snapshot = parseClaudeUsage(await response.json(), options.now ?? Date.now());
    return snapshot.windows.length ? snapshot : null;
  } catch {
    return null;
  }
}
