import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { guardHome } from "./config.mjs";

const MAX_SUMMARY_CHARACTERS = 40_000;
const MAX_CONTEXT_CHARACTERS = 48_000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const CONTINUATION_GUIDANCE = "Treat this handoff as continuity context, not a model-policy override. "
  + "Follow the current Usage Guard instructions and configuration for model, effort, and reserve pauses. "
  + "Treat the user's newest request and the current repository state as authoritative.";
const LEGACY_CONTINUATION_FOOTER = "## Continuation\n\n"
  + "Continue from this handoff without lowering the selected model or reasoning effort. "
  + "Treat the user's newest request and the current repository state as authoritative.\n";

export function writeCompactionHandoff(input, options = {}) {
  const summary = normalizeSummary(input?.compact_summary || input?.compactSummary);
  const cwd = normalizeWorkingDirectory(input?.cwd);
  if (!summary || !cwd) return null;

  const filePath = compactionHandoffPath(cwd, options);
  const directory = path.dirname(filePath);
  const generatedAt = options.now ?? Date.now();
  const sessionId = normalizeSessionId(input?.session_id || input?.sessionId);
  const trigger = normalizeTrigger(input?.trigger);
  const content = [
    "# Usage Guard Context Handoff",
    "",
    `Generated: ${new Date(generatedAt).toISOString()}`,
    `Project: ${cwd}`,
    `Compaction: ${trigger}`,
    "",
    `<!-- usage-guard-session:${sessionId || "unknown"} -->`,
    `<!-- usage-guard-generated-at:${generatedAt} -->`,
    "",
    "## Claude compact summary",
    "",
    summary,
    "",
    "## Continuation",
    "",
    CONTINUATION_GUIDANCE,
    "",
  ].join("\n");

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${generatedAt}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }

  return {
    path: filePath,
    generatedAt,
    sessionId,
    trigger,
    characters: content.length,
  };
}

export function readCompactionHandoff(input, options = {}) {
  const cwd = normalizeWorkingDirectory(input?.cwd);
  if (!cwd) return null;
  const filePath = compactionHandoffPath(cwd, options);
  if (!existsSync(filePath)) return null;

  try {
    const now = options.now ?? Date.now();
    const maxAgeMs = Number.isFinite(options.maxAgeMs)
      ? Math.max(0, options.maxAgeMs)
      : DEFAULT_MAX_AGE_MS;
    const modifiedAt = statSync(filePath).mtimeMs;
    if (now - modifiedAt > maxAgeMs) {
      unlinkSync(filePath);
      return null;
    }

    const content = readFileSync(filePath, "utf8");
    const sourceSessionId = metadataValue(content, "usage-guard-session");
    const sessionId = normalizeSessionId(input?.session_id || input?.sessionId);
    if (sessionId && sourceSessionId === sessionId) return null;

    return {
      path: filePath,
      modifiedAt,
      sourceSessionId,
      content: compactForHookContext(currentContinuation(content)),
    };
  } catch {
    // Continuity is helpful, but an unreadable handoff must never break startup.
    return null;
  }
}

function currentContinuation(content) {
  // Older installations already saved this fixed-lock footer. Replace only
  // our exact trailing boilerplate, never matching text inside Claude's summary.
  if (!content.endsWith(LEGACY_CONTINUATION_FOOTER)) return content;
  return content.slice(0, -LEGACY_CONTINUATION_FOOTER.length)
    + `## Continuation\n\n${CONTINUATION_GUIDANCE}\n`;
}

export function compactionHandoffPath(cwd, options = {}) {
  const home = options.stateHome || guardHome(options.env);
  const identity = projectIdentity(normalizeWorkingDirectory(cwd));
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(home, "handoffs", key, "context-handoff.md");
}

export function clearCompactionHandoffs(options = {}) {
  const home = options.stateHome || guardHome(options.env);
  rmSync(path.join(home, "handoffs"), { recursive: true, force: true });
}

function projectIdentity(cwd) {
  if (!cwd) return "unknown";
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.status === 0 && result.stdout.trim()) {
    return `git:${path.resolve(cwd, result.stdout.trim())}`;
  }
  return `cwd:${cwd}`;
}

function normalizeWorkingDirectory(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const resolved = path.resolve(value.trim());
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function normalizeSummary(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length <= MAX_SUMMARY_CHARACTERS) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_CHARACTERS)}\n\n[Summary truncated by Usage Guard]`;
}

function normalizeSessionId(value) {
  if (value == null || value === "") return null;
  return String(value).replace(/[\r\n]/g, "").slice(0, 256);
}

function normalizeTrigger(value) {
  return value === "manual" ? "manual" : "automatic";
}

function metadataValue(content, key) {
  const match = content.match(new RegExp(`<!-- ${key}:([^\\n]+?) -->`));
  return match?.[1]?.trim() || null;
}

function compactForHookContext(content) {
  if (content.length <= MAX_CONTEXT_CHARACTERS) return content;
  const half = Math.floor((MAX_CONTEXT_CHARACTERS - 80) / 2);
  return `${content.slice(0, half)}\n\n[Middle omitted from injected context]\n\n${content.slice(-half)}`;
}
