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
  if (decision.modelStepping === true) {
    const main = modelLabel(decision.recommendedModel, decision.recommendedEffort);
    const routine = modelLabel(decision.routineModel, decision.routineEffort);
    const suffix = ` | main ${main} | routine ${routine}`;
    if (!color) return `UG ${windows || "waiting for meter"}${context} | ${state}${reset}${suffix}`;
    const stateColor = decision.state === "safe"
      ? ANSI.green
      : decision.state === "watch" || decision.state === "stale"
        ? ANSI.amber
        : decision.state === "missing"
          ? ANSI.muted
          : ANSI.red;
    return `${ANSI.bold}UG${ANSI.reset} ${windows || "waiting for meter"}${context} | ${stateColor}${state}${ANSI.reset}${reset}${suffix}`;
  }
  const modeLabel = decision.qualityLocked === false ? "model stepping off" : "quality locked";
  const base = `UG ${windows || "waiting for meter"}${context} | ${state}${reset} | ${modeLabel}`;
  if (!color) return base;
  const stateColor = decision.state === "safe"
    ? ANSI.green
    : decision.state === "watch" || decision.state === "stale"
      ? ANSI.amber
      : decision.state === "missing"
        ? ANSI.muted
        : ANSI.red;
  return `${ANSI.bold}UG${ANSI.reset} ${windows || "waiting for meter"}${context} | ${stateColor}${state}${ANSI.reset}${reset} | ${ANSI.muted}${modeLabel}${ANSI.reset}`;
}

export function formatStatusText(status) {
  const stepping = status.config.modelStepping && !status.config.qualityLock;
  const output = [
    "Usage Guard",
    stepping
      ? `Mode: ${status.config.enforcement} | Model stepping: on | Quality lock: off`
      : `Mode: ${status.config.enforcement} | Quality lock: ${status.config.qualityLock ? "on" : "off"}`,
    "",
  ];
  if (stepping && status.overnightSummary) {
    output.push(`Overnight: ${status.overnightSummary}`, "");
  }
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
    if (provider.modelStepping === true) {
      output.push(`  Main thread: ${modelLabel(provider.recommendedModel, provider.recommendedEffort)}`);
      output.push(`  Routine subagents: ${modelLabel(provider.routineModel, provider.routineEffort)}`);
      output.push(`  Model reason: ${provider.modelReason}`);
    }
    output.push("");
  }
  const request = status.diagnostics?.claudeRequest;
  const impact = status.diagnostics?.requestImpact;
  const screenshotMemory = status.diagnostics?.screenshotMemory;
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
  if (screenshotMemory) {
    output.push("Screenshot Memory (local)");
    output.push(`  Visual tail         ${screenshotMemory.retentionTurns} user turns`);
    output.push(`  Images summarized   ${formatNumber(screenshotMemory.imagesReplaced)}`);
    output.push(`  Image bytes removed ${formatBytes(screenshotMemory.imageBytesReplaced)}`);
    if (screenshotMemory.lastRequestImagesReplaced > 0) {
      output.push(
        `  Latest request      ${screenshotMemory.lastRequestImagesReplaced} image(s), `
        + `${formatBytes(screenshotMemory.lastRequestBytesReplaced)} removed`,
      );
    }
    output.push("");
  }
  output.push(
    status.config.compactionHandoffEnabled
      ? "Local only: quota data stays local; Claude compact summaries are kept only in private handoff files."
      : "Local only: no prompts, source code, credentials, or telemetry stored.",
  );
  return output.join("\n");
}

function modelLabel(model, effort) {
  return model ? `${model} (${effort || "default"})` : "waiting for fresh quota";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
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
