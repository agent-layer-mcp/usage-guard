import { toEpochMilliseconds } from "../time.mjs";

export function parseClaudeStatusLine(input, now = Date.now()) {
  if (!input || typeof input !== "object") throw new TypeError("Claude status-line JSON is required.");
  const rateLimits = input.rate_limits || input.rateLimits || {};
  const windows = [];

  addWindow(windows, "five-hour", "5 hour", rateLimits.five_hour || rateLimits.fiveHour, 300);
  addWindow(windows, "seven-day", "weekly", rateLimits.seven_day || rateLimits.sevenDay, 10_080);

  return {
    provider: "claude",
    observedAt: now,
    source: "claude-status-line",
    model: textValue(input.model?.display_name || input.model?.displayName || input.model?.id || input.model),
    effort: textValue(input.effort?.level || input.effort || input.reasoning_effort),
    contextPercent: firstFinite(
      input.context_window?.used_percentage,
      input.context_window?.usedPercent,
      deriveContextPercent(input.context_window),
    ),
    windows,
  };
}

function addWindow(output, key, label, window, defaultMinutes) {
  if (!window || typeof window !== "object") return;
  const usedPercent = firstFinite(window.used_percentage, window.usedPercent);
  if (usedPercent == null) return;
  output.push({
    key,
    label,
    usedPercent,
    windowMinutes: firstFinite(window.window_minutes, window.windowMinutes, defaultMinutes),
    resetsAt: toEpochMilliseconds(window.resets_at ?? window.resetsAt),
  });
}

function deriveContextPercent(context) {
  if (!context || !Number.isFinite(context.context_window_size)) return null;
  const used = Number(context.total_input_tokens || 0) + Number(context.total_output_tokens || 0);
  return (used / context.context_window_size) * 100;
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function textValue(value) {
  if (value == null || typeof value === "object") return null;
  return String(value);
}
