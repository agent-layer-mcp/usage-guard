import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function claudeDesktopUsagePath(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return null;
  const homeDir = options.homeDir ?? os.homedir();
  return path.join(homeDir, "Library", "Application Support", "Claude", "plan-usage-history.json");
}

export function readClaudeDesktopUsage(options = {}) {
  const cachePath = options.cachePath ?? claudeDesktopUsagePath(options);
  if (!cachePath) return null;

  try {
    const payload = JSON.parse(readFileSync(cachePath, "utf8"));
    return parseClaudeDesktopUsage(payload, options);
  } catch {
    return null;
  }
}

export function parseClaudeDesktopUsage(payload, options = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.samples)) return null;

  const samples = payload.samples
    .map(normalizeSample)
    .filter(Boolean)
    .sort((left, right) => left.observedAt - right.observedAt);
  const latest = samples.at(-1);
  if (!latest) return null;

  const windows = [];

  if (latest.fiveHour != null) {
    windows.push({
      key: "five-hour",
      label: "5 hour",
      usedPercent: latest.fiveHour,
      windowMinutes: 300,
      // The Desktop aggregate cache does not expose an authoritative reset.
      // A prior usage drop cannot anchor a later activity-started window.
      resetsAt: null,
    });
  }

  if (latest.sevenDay != null) {
    windows.push({
      key: "seven-day",
      label: "weekly",
      usedPercent: latest.sevenDay,
      windowMinutes: 10_080,
      resetsAt: null,
    });
  }

  if (!windows.length) return null;
  return {
    provider: "claude",
    observedAt: latest.observedAt,
    source: "claude-desktop-aggregate-cache",
    model: null,
    effort: null,
    contextPercent: null,
    windows,
  };
}

function normalizeSample(sample) {
  if (!sample || typeof sample !== "object" || !Number.isFinite(sample.t)) return null;
  const usage = sample.u;
  if (!usage || typeof usage !== "object") return null;
  const fiveHour = percentage(usage.fh);
  const sevenDay = percentage(usage.sd);
  if (fiveHour == null && sevenDay == null) return null;

  return {
    observedAt: Math.trunc(sample.t),
    organization: typeof sample.org === "string" ? sample.org : null,
    fiveHour,
    sevenDay,
  };
}

function percentage(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
