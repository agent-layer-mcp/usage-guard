import { formatDuration } from "./time.mjs";

const ANSI = Object.freeze({
  reset: "\u001b[0m",
  muted: "\u001b[2m",
  green: "\u001b[32m",
  amber: "\u001b[33m",
  red: "\u001b[31m",
  bold: "\u001b[1m",
});

export function formatStatusLine(decision, options = {}) {
  const color = options.color ?? Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  const windows = decision.windows
    .filter((window) => Number.isFinite(window.usedPercent))
    .slice(0, 3)
    .map((window) => `${shortLabel(window)} ${Math.round(window.usedPercent)}%`)
    .join(" | ");
  const state = decision.state.toUpperCase();
  const context = decision.context && !decision.context.stale
    ? ` | ctx ${Math.round(decision.context.contextPercent)}%`
    : "";
  const reset = decision.resetAt
    ? ` | ${formatDuration(Math.max(0, (decision.resetAt - Date.now()) / 60_000))}`
    : "";
  const base = `UG ${windows || "waiting for meter"}${context} | ${state}${reset} | quality locked`;
  if (!color) return base;
  const stateColor = decision.state === "safe"
    ? ANSI.green
    : decision.state === "watch" || decision.state === "stale"
      ? ANSI.amber
      : decision.state === "missing"
        ? ANSI.muted
        : ANSI.red;
  return `${ANSI.bold}UG${ANSI.reset} ${windows || "waiting for meter"}${context} | ${stateColor}${state}${ANSI.reset}${reset} | ${ANSI.muted}quality locked${ANSI.reset}`;
}

export function formatStatusText(status) {
  const output = [
    "Usage Guard",
    `Mode: ${status.config.enforcement} | Quality lock: ${status.config.qualityLock ? "on" : "off"}`,
    "",
  ];
  for (const provider of status.providers) {
    output.push(`${providerName(provider.provider)}  ${provider.state.toUpperCase()}`);
    for (const window of provider.windows) {
      const reset = window.minutesUntilReset == null ? "reset unknown" : `resets in ${formatDuration(window.minutesUntilReset)}`;
      const pace = window.paceRatio == null ? "learning pace" : `${window.paceRatio.toFixed(1)}x sustainable`;
      output.push(`  ${window.label.padEnd(18)} ${window.usedPercent.toFixed(1).padStart(5)}% used  ${reset}  ${pace}`);
    }
    if (provider.context) {
      const freshness = provider.context.stale ? "stale" : provider.contextState;
      output.push(`  ${"session context".padEnd(18)} ${provider.context.contextPercent.toFixed(1).padStart(5)}% used  ${freshness}`);
    }
    output.push(`  Choice: ${provider.action}`);
    output.push(`  Why: ${provider.reason}`);
    output.push("");
  }
  const request = status.diagnostics?.claudeRequest;
  const impact = status.diagnostics?.requestImpact;
  if (request && !request.stale) {
    output.push("Claude request diagnostics (local pxpipe)");
    output.push(`  Context tokens      ${formatNumber(request.contextTokens)}`);
    output.push(`  Resident images     ${formatNumber(request.imageCount)}`);
    output.push(`  Weighted request    ${formatRange(
      request.weightedInputEquivalentMin,
      request.weightedInputEquivalentMax,
    )} API input-equivalents`);
    output.push(`  Cache write TTL     ${request.cacheWriteTtl || "unknown"}`);
    if (request.microcompactDisabled) {
      output.push("  Microcompact        disabled in this process environment");
    }
    if (impact) {
      output.push(`  Estimated quota/call ${impact.quotaPercentPerRequest.toFixed(2)}%`);
      output.push(`  Calls to reserve    ~${Math.max(0, Math.floor(impact.estimatedCallsUntilReserve)).toLocaleString("en-US")}`);
      output.push(`  Compaction posture  ${impact.compactionRecommended ? "compact at next safe boundary" : "normal"}`);
      output.push(`  Estimate caveat     ${impact.caveat}`);
    }
    output.push(`  Caveat              ${request.weighting.caveat}`);
    output.push("");
  }
  output.push("Local only: no prompts, source code, credentials, or telemetry stored.");
  return output.join("\n");
}

function formatNumber(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "unknown";
}

function formatRange(minimum, maximum) {
  if (!Number.isFinite(minimum)) return "unknown";
  if (!Number.isFinite(maximum) || minimum === maximum) return formatNumber(minimum);
  return `${formatNumber(minimum)}-${formatNumber(maximum)}`;
}

function shortLabel(window) {
  if (window.windowMinutes != null && window.windowMinutes <= 360) return "5h";
  if (window.windowMinutes != null && window.windowMinutes >= 6 * 24 * 60) return "wk";
  return window.label.replace(/\s+/g, "-");
}

function providerName(provider) {
  return provider === "claude" ? "Claude Code" : "Codex";
}
