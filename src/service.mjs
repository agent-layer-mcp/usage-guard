import { buildProviderDecision, buildStatus } from "./policy.mjs";
import { parseClaudeStatusLine } from "./providers/claude.mjs";
import { readClaudeDesktopUsage } from "./providers/claude-desktop.mjs";
import { fetchCodexSnapshot } from "./providers/codex.mjs";
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
  store.saveSnapshot(snapshot);
  return snapshot;
}

export function syncClaudeDesktop(store, options = {}) {
  const snapshot = readClaudeDesktopUsage(options);
  if (!snapshot?.windows.length) return snapshot;

  let retainedAuthoritativeReset = false;
  const windows = snapshot.windows.map((window) => {
    if (window.resetsAt != null) return window;
    const authoritative = store.latestFutureReset(
      "claude",
      window.key,
      snapshot.observedAt,
      "claude-status-line",
    );
    if (
      !authoritative
      || window.usedPercent + 1 < authoritative.usedPercent
    ) return window;
    retainedAuthoritativeReset = true;
    return { ...window, resetsAt: authoritative.resetsAt };
  });
  const enriched = {
    ...snapshot,
    windows,
    source: retainedAuthoritativeReset
      ? "claude-desktop-aggregate-cache+status-line-reset"
      : snapshot.source,
  };
  store.saveSnapshot(enriched);
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
