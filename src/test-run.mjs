import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guardHome } from "./config.mjs";

const MAX_FAILURES = 20;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const ERROR_LINES = 5;
// Failure headers from node:test/TAP, Jest/Vitest, pytest and common reporters.
const FAILURE_PATTERNS = [
  /^\s*not ok \d+ - (.+)$/,
  /^\s*● (?!Console)(.+)$/,
  /^FAILED (\S+)(?: - (.*))?$/,
  /^\s*[✗✕×] (.+)$/,
  /^\s*FAIL (\S.*)$/,
];

// Short failure list from a test run's output; the full log stays on disk.
export function summarizeTestOutput(output, exitCode) {
  const lines = String(output).split(/\r?\n/);
  const failures = [];
  const seen = new Set();
  for (let i = 0; i < lines.length && failures.length < MAX_FAILURES; i += 1) {
    const match = FAILURE_PATTERNS.map((pattern) => lines[i].match(pattern)).find(Boolean);
    if (!match) continue;
    const name = match[1].trim();
    if (seen.has(name)) continue;
    seen.add(name);
    const error = match[2] ? [match[2]] : [];
    for (let j = i + 1; j < lines.length && error.length < ERROR_LINES; j += 1) {
      if (FAILURE_PATTERNS.some((pattern) => pattern.test(lines[j]))) break;
      const text = lines[j].trim();
      if (text && !/^(---|\.\.\.|duration_ms|type:|location:)/.test(text)) error.push(text.slice(0, 200));
    }
    failures.push({ name, error });
  }
  // Nothing recognised but the run failed: keep the tail so the cause is not lost.
  const tail = exitCode !== 0 && failures.length === 0
    ? lines.filter((line) => line.trim()).slice(-15).map((line) => line.slice(0, 200)) : [];
  return { passed: exitCode === 0, exitCode, failures, tail };
}

export function runTests(command, options = {}) {
  if (!command.length) throw new TypeError("Give the test command after `--`, e.g. `usage-guard test-run -- npm test`.");
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd, env: options.env || process.env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (result.error && !timedOut) throw result.error;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const directory = path.join(guardHome(options.env), "test-runs");
  mkdirSync(directory, { recursive: true });
  const logFile = path.join(directory, `${new Date(options.now ?? Date.now()).toISOString().replace(/[:.]/g, "-")}.log`);
  writeFileSync(logFile, output, { mode: 0o600 });
  const exitCode = result.status ?? 1;
  return { command: command.join(" "), logFile, timedOut, ...summarizeTestOutput(output, exitCode) };
}

export function formatTestRun(run) {
  const lines = [`${run.passed ? "PASS" : "FAIL"} (exit ${run.exitCode}): ${run.command}`];
  if (run.timedOut) lines.push("Timed out and was killed.");
  for (const failure of run.failures) {
    lines.push(`- ${failure.name}`, ...failure.error.map((line) => `    ${line}`));
  }
  if (run.tail.length) lines.push("Last lines:", ...run.tail.map((line) => `    ${line}`));
  lines.push(`Full log: ${run.logFile}`);
  return lines.join("\n");
}
