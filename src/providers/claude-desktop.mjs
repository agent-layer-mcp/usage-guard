import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FIVE_HOUR_MS = 300 * 60_000;
const SEVEN_DAY_MS = 10_080 * 60_000;
const DEFAULT_MAX_RESET_GAP_MS = 15 * 60_000;
const DEFAULT_MIN_RESET_DROP = 5;

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

  const organizationSamples = samples.filter((sample) => sample.organization === latest.organization);
  const resetOptions = {
    maxGapMs: options.maxResetGapMs ?? DEFAULT_MAX_RESET_GAP_MS,
    minDrop: options.minResetDrop ?? DEFAULT_MIN_RESET_DROP,
  };
  const windows = [];

  if (latest.fiveHour != null) {
    windows.push({
      key: "five-hour",
      label: "5 hour",
      usedPercent: latest.fiveHour,
      windowMinutes: 300,
      resetsAt: inferNextReset(
        organizationSamples,
        "fiveHour",
        FIVE_HOUR_MS,
        latest.observedAt,
        resetOptions,
      ),
    });
  }

  if (latest.sevenDay != null) {
    windows.push({
      key: "seven-day",
      label: "weekly",
      usedPercent: latest.sevenDay,
      windowMinutes: 10_080,
      resetsAt: inferNextReset(
        organizationSamples,
        "sevenDay",
        SEVEN_DAY_MS,
        latest.observedAt,
        resetOptions,
      ),
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

function inferNextReset(samples, field, windowMs, latestAt, options) {
  let resetAt = null;
  let previous = null;

  for (const sample of samples) {
    const value = sample[field];
    if (value == null) continue;
    if (previous) {
      const gap = sample.observedAt - previous.observedAt;
      const drop = previous.value - value;
      if (gap > 0 && gap <= options.maxGapMs && drop >= options.minDrop) {
        const candidate = sample.observedAt + windowMs;
        if (candidate > latestAt) resetAt = candidate;
      }
    }
    previous = { observedAt: sample.observedAt, value };
  }

  return resetAt;
}
