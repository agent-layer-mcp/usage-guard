import { buildProviderDecision, buildStatus } from "./policy.mjs";
import { parseClaudeStatusLine } from "./providers/claude.mjs";
import { fetchClaudeUsage } from "./providers/claude-api.mjs";
import { readClaudeDesktopSamples, readClaudeDesktopUsage } from "./providers/claude-desktop.mjs";
import { fetchCodexSnapshot, readCodexLogHistory } from "./providers/codex.mjs";
import { readPxpipeTelemetry } from "./providers/pxpipe.mjs";
import { readScreenshotMemoryStatus } from "./screenshot-proxy.mjs";

export function ingestClaudeStatus(store, input, now = Date.now()) {
  const snapshot = parseClaudeStatusLine(input, now);
  if (snapshot.windows.length) store.saveSnapshot(snapshot);
  if (Number.isFinite(snapshot.contextPercent)) store.saveContextObservation(snapshot);
  return snapshot;
}

export async function syncCodex(store, options = {}) {
  const snapshot = await fetchCodexSnapshot(options);
  if (!snapshot.windows.length) throw new Error("Codex returned no rate-limit windows.");
  // This response enumerates currently exposed buckets. Keep historical rows
  // for burn analysis, but do not present retired Spark-era buckets as live.
  store.saveSnapshot({ ...snapshot, authoritativeWindows: true });
  backfillHistory(store, "codex", (since) => readCodexLogHistory({ ...options, since }), "codex-session-log", snapshot.observedAt);
  return snapshot;
}

const BACKFILL_HOURS = 36;

// Fill in readings from before Usage Guard started watching, so the daily
// share can start from the real 08:00 figure. Runs only while older local data exists.
export function backfillHistory(store, provider, read, source, now = Date.now()) {
  const since = now - BACKFILL_HOURS * 60 * 60_000;
  const readings = read(since);
  const firstByKey = new Map();
  for (const reading of readings) {
    if (!firstByKey.has(reading.key)) firstByKey.set(reading.key, store.earliestObservedAt(provider, reading.key) ?? Infinity);
    if (reading.observedAt >= firstByKey.get(reading.key)) continue;
    store.saveSnapshot({ provider, source, observedAt: reading.observedAt, windows: [reading] });
  }
}

const CLAUDE_POLL_MS = 60_000;

// Claude's own usage endpoint first, the desktop cache as fallback. Hooks fire on
// every tool call, so the endpoint is asked at most once a minute (failures included).
// The endpoint is polled only when options.claudeApi is given, so tests stay offline.
export async function syncClaude(store, options = {}) {
  if (options.claudeApi) {
    const now = options.claudeApi.now ?? Date.now();
    const last = store.getNoticeState("claude", "claude-oauth-poll");
    if (!last || now - last.updatedAt >= CLAUDE_POLL_MS) {
      store.setNoticeState("claude", "claude-oauth-poll", "attempted", now);
      const snapshot = await fetchClaudeUsage(options.claudeApi);
      if (snapshot) {
        store.saveSnapshot({ ...snapshot, authoritativeWindows: true });
        return snapshot;
      }
    }
  }
  return syncClaudeDesktop(store, options.claudeDesktop);
}

export function syncClaudeDesktop(store, options = {}) {
  const snapshot = readClaudeDesktopUsage(options);
  if (!snapshot?.windows.length) return snapshot;

  let retainedAuthoritativeReset = false;
  const windows = snapshot.windows.map((window) => {
    if (window.resetsAt != null) return window;
    // Status line or host usage (e.g. balance.mjs) supply the reset the cache lacks.
    // Prefer the Claude app's own reset time (host-usage) over the status line's.
    const authoritative = store.latestFutureReset("claude", window.key, snapshot.observedAt, "host-usage")
      || store.latestFutureReset("claude", window.key, snapshot.observedAt);
    if (authoritative && window.usedPercent + 1 >= authoritative.usedPercent) {
      retainedAuthoritativeReset = true;
      return { ...window, resetsAt: authoritative.resetsAt };
    }
    // A weekly reset recurs every 7 days, so a past one still fixes the next.
    const known = window.windowMinutes >= 10_080 && !authoritative && store.latestKnownReset("claude", window.key);
    if (!known) return window;
    const week = window.windowMinutes * 60_000;
    retainedAuthoritativeReset = true;
    return { ...window, resetsAt: known.resetsAt + Math.ceil((snapshot.observedAt - known.resetsAt) / week) * week };
  });
  const enriched = {
    ...snapshot,
    windows,
    source: retainedAuthoritativeReset
      ? "claude-desktop-aggregate-cache+status-line-reset"
      : snapshot.source,
  };
  store.saveSnapshot(enriched);
  backfillHistory(store, "claude", (since) => readClaudeDesktopSamples(options)
    .filter((sample) => sample.observedAt >= since)
    .flatMap((sample) => [
      sample.fiveHour == null ? null : { observedAt: sample.observedAt, key: "five-hour", label: "5 hour", usedPercent: sample.fiveHour, windowMinutes: 300, resetsAt: null },
      sample.sevenDay == null ? null : { observedAt: sample.observedAt, key: "seven-day", label: "weekly", usedPercent: sample.sevenDay, windowMinutes: 10_080, resetsAt: null },
    ].filter(Boolean)), "claude-desktop-aggregate-cache", snapshot.observedAt);
  return enriched;
}

export function providerDecision(store, provider, options = {}) {
  return buildProviderDecision(store, provider, options);
}

export function completeStatus(store, options = {}) {
  const status = buildStatus(store, options);
  const claudeRequest = readPxpipeTelemetry({
    ...options.pxpipe,
    now: options.now,
    env: options.env || process.env,
  });
  const claudeDecision = status.providers.find((item) => item.provider === "claude");
  const requestImpact = estimateRequestImpact(claudeDecision, claudeRequest);
  const screenshotMemory = readScreenshotMemoryStatus({
    env: options.env || process.env,
  });
  return {
    ...status,
    privacy: {
      ...status.privacy,
      localRequestMetadataRead: Boolean(claudeRequest),
      requestMetadataStored: false,
    },
    diagnostics: {
      claudeRequest,
      requestImpact,
      screenshotMemory,
    },
  };
}

export function estimateRequestImpact(decision, request) {
  if (
    !decision
    || !request
    || request.stale
    || request.recentRequestCount < 2
    || !Number.isFinite(request.recentElapsedMinutes)
    || request.recentElapsedMinutes <= 0
  ) return null;

  const requestsPerMinute = request.recentRequestCount / request.recentElapsedMinutes;
  const window = [...(decision.windows || [])]
    .filter((item) => Number.isFinite(item.burnPercentPerMinute) && item.burnPercentPerMinute > 0)
    .sort((a, b) => (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER))[0];
  if (!window || !Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) return null;

  const quotaPercentPerRequest = window.burnPercentPerMinute / requestsPerMinute;
  const estimatedCallsUntilReserve = quotaPercentPerRequest > 0
    ? window.usablePercent / quotaPercentPerRequest
    : null;
  const contextIsLarge = Number.isFinite(request.contextTokens)
    && request.contextTokens >= 200_000;
  const imagesAreMaterial = Number.isFinite(request.imageCount)
    && request.imageCount >= 25;
  const compactionRecommended = contextIsLarge
    && (quotaPercentPerRequest >= 0.2 || imagesAreMaterial);

  return {
    windowKey: window.key,
    requestsPerMinute,
    quotaPercentPerRequest,
    estimatedCallsUntilReserve,
    compactionRecommended,
    reason: compactionRecommended
      ? "Current context cost is high relative to observed quota burn; compact at the next safe boundary."
      : "Request impact is within the current advisory threshold.",
    caveat: "Directional estimate: account burn may include other sessions or devices.",
  };
}

// Claude's weekly reset falls on the hour; an hours-left figure is rounded, so snap to the hour.
export function claudeResetFromHours(now, hours) {
  return Math.round((now + hours * 3_600_000) / 3_600_000) * 3_600_000;
}
