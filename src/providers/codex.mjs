import { spawn } from "node:child_process";
import readline from "node:readline";
import { VERSION } from "../config.mjs";
import { toEpochMilliseconds } from "../time.mjs";

export async function fetchCodexSnapshot(options = {}) {
  const { rateLimits, config } = await readCodexMeter(options);
  return parseCodexRateLimits(rateLimits, {
    now: options.now ?? Date.now(),
    // The account quota response describes buckets, not the model selected in
    // Codex. Read the effective default config separately; a session can still
    // override it, so an explicitly supplied session model takes precedence.
    model: options.model ?? config?.model,
    effort: options.effort ?? config?.model_reasoning_effort,
    modelSource: options.model != null
      ? "session-provided"
      : config?.model != null ? "configured-default" : null,
  });
}

export function parseCodexRateLimits(response, options = {}) {
  if (!response || typeof response !== "object") throw new TypeError("Codex rate-limit response is required.");
  const buckets = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length
    ? response.rateLimitsByLimitId
    : { codex: response.rateLimits };
  const windows = [];

  for (const [bucketKey, snapshot] of Object.entries(buckets)) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const bucketId = snapshot.limitId || bucketKey || "codex";
    const bucketName = snapshot.limitName || (bucketId === "codex" ? "" : bucketId);
    addCodexWindow(windows, bucketId, bucketName, "primary", snapshot.primary);
    addCodexWindow(windows, bucketId, bucketName, "secondary", snapshot.secondary);
  }

  return {
    provider: "codex",
    observedAt: options.now ?? Date.now(),
    source: "codex-app-server",
    model: options.model || null,
    effort: options.effort || null,
    modelSource: options.modelSource || null,
    contextPercent: finiteOrNull(options.contextPercent),
    windows,
  };
}

export async function readCodexRateLimits(options = {}) {
  const { rateLimits } = await readCodexMeter(options, { includeConfig: false });
  return rateLimits;
}

function readCodexMeter(options = {}, { includeConfig = true } = {}) {
  const executable = options.codexPath || process.env.CODEX_PATH || "codex";
  const timeoutMs = options.timeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env || process.env,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    let rateLimits = null;
    let config = null;
    let configFinished = !includeConfig;

    const timer = setTimeout(() => {
      if (rateLimits) finish(null, { rateLimits, config });
      else finish(new Error(`Codex rate-limit read timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (settled) return;
      if (rateLimits) finish(null, { rateLimits, config });
      else finish(new Error(stderr.trim() || `Codex app-server exited with code ${code}.`));
    });

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 1 && message.result) {
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: 2, params: null });
        if (includeConfig) {
          send({
            method: "config/read",
            id: 3,
            params: { includeLayers: false, ...(options.cwd ? { cwd: options.cwd } : {}) },
          });
        }
      } else if (message.id === 1 && message.error) {
        finish(new Error(message.error.message || "Codex app-server initialization failed."));
      } else if (message.id === 2 && message.result) {
        rateLimits = message.result;
        if (configFinished) finish(null, { rateLimits, config });
      } else if (message.id === 2 && message.error) {
        finish(new Error(message.error.message || "Codex rate-limit read failed."));
      } else if (message.id === 3 && (message.result || message.error)) {
        // Older Codex versions may not support config/read. Quota still works.
        config = message.result?.config || null;
        configFinished = true;
        if (rateLimits) finish(null, { rateLimits, config });
      }
    });

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "usage_guard", title: "Usage Guard", version: VERSION },
        capabilities: null,
      },
    });

    function send(message) {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(result);
    }
  });
}

function addCodexWindow(output, bucketId, bucketName, slot, window) {
  if (!window || window.usedPercent == null || !Number.isFinite(Number(window.usedPercent))) return;
  const minutes = finiteOrNull(window.windowDurationMins ?? window.windowMinutes);
  const durationLabel = labelForDuration(minutes, slot);
  output.push({
    key: `${bucketId}:${slot}`,
    label: bucketName ? `${bucketName} ${durationLabel}` : durationLabel,
    usedPercent: Number(window.usedPercent),
    windowMinutes: minutes,
    resetsAt: toEpochMilliseconds(window.resetsAt),
  });
}

function labelForDuration(minutes, fallback) {
  if (minutes != null && minutes >= 240 && minutes <= 360) return "5 hour";
  if (minutes != null && minutes >= 6 * 24 * 60) return "weekly";
  if (minutes != null && minutes >= 60) return `${Math.round(minutes / 60)} hour`;
  return fallback;
}

function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
