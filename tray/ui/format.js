// Plain-text pieces of the panel, kept apart from the DOM so they can be tested.
export const pct = (value) => `${Number(value).toFixed(1)}%`;
const points = (value) => Number(value).toFixed(1);

export function countdown(at, now = Date.now()) {
  if (!at) return "reset unknown";
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export const weeklyWindow = (provider) => (provider.windows || [])
  .filter((window) => window.windowMinutes > 360)
  .sort((a, b) => b.windowMinutes - a.windowMinutes)[0];

// The status pill says what the lane is doing, never a bare policy state.
export function statusPill(provider, { paused = false } = {}) {
  if (paused) return { tone: "paused", text: "Paused" };
  if (provider.state === "queue") return { tone: "paused", text: "Paused · reserve reached" };
  if (provider.daily?.spent) return { tone: "spent", text: "Today's share spent" };
  if (provider.state === "missing" || provider.state === "stale") return { tone: "unknown", text: "No fresh reading" };
  if (provider.state === "watch" || provider.state === "protect") return { tone: "warn", text: "Pace warning · still taking work" };
  return { tone: "good", text: "On track" };
}

// Today row: points of the weekly allowance, out of today's share. Used today is the
// difference of two whole-percent meter readings, so it is good to about ±1 point.
export function todayText(daily, { stale = false } = {}) {
  if (!daily && stale) return { figure: "no fresh reading", detail: "No fresh meter reading, so today's share is unknown." };
  if (!daily) return { figure: "no share yet", detail: "No daily share until a weekly reset time is known." };
  const share = daily.todayBudgetPercent > 0 ? Math.round((daily.usedTodayPercent / daily.todayBudgetPercent) * 100) : 100;
  return {
    figure: `${points(daily.usedTodayPercent)} of ${points(daily.todayBudgetPercent)} pts`,
    detail: daily.spent
      ? `Today's share is used up (${share}% of it)${daily.borrowedPercent > 0 ? `, ${points(daily.borrowedPercent)} pts borrowed from later days` : ""}. New work goes to another lane until the next share.`
      : `${share}% of today's share used (±1 pt) · ${points(daily.remainingTodayPercent)} pts left today.`,
  };
}

// A stale lane keeps its last known figures, labelled with their age.
export function staleText(provider, now = Date.now()) {
  if (!provider.stale || !provider.lastReadingAt) return null;
  const at = new Date(provider.lastReadingAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const name = provider.provider === "claude" ? "Claude" : "Codex";
  return `No fresh reading. Figures are from the last reading at ${at} (${countdown(now + (now - provider.lastReadingAt), now)} ago). ${name} gets new work only after lanes with fresh readings; open the ${name} app to refresh it.`;
}

// Week row: whole-week percentages, with the kept reserve called out.
export function weekText(window, now = Date.now()) {
  if (!window) return null;
  const used = Math.round(window.usedPercent);
  const reserve = window.reservePercent ?? 0;
  return {
    figure: `${used}% used`,
    detail: `${used}% used · ${100 - used}% left (${reserve}% kept in reserve) · resets in ${countdown(window.resetsAt, now)}.`,
  };
}

// Pace explained as a warning, with the model it currently recommends.
export function paceText(provider) {
  const window = weeklyWindow(provider);
  const model = provider.recommendedModel
    ? ` Next model here: ${provider.recommendedModel}${provider.recommendedEffort ? ` (${provider.recommendedEffort})` : ""}.` : "";
  if (!["watch", "protect"].includes(provider.state) || provider.daily?.spent) return model.trim() || null;
  const ratio = window?.paceRatio != null ? `${window.paceRatio.toFixed(1)}x` : "faster than";
  const effect = provider.state === "protect" ? " Models step down one level until it slows." : "";
  return `Pace: using the week at ${ratio} the steady rate in the last few hours.${effect}${model}`;
}

export function hermesText(lane) {
  if (lane.spentTodayUsd == null) return { tone: "unknown", pill: "Not set up", figure: "—", detail: lane.reason };
  const left = Math.max(0, lane.dailyCapUsd - lane.spentTodayUsd);
  return {
    tone: lane.available ? "good" : "spent",
    pill: lane.available ? "Open · under cap" : "Cap reached",
    figure: `$${lane.spentTodayUsd.toFixed(2)} of $${Number(lane.dailyCapUsd).toFixed(2)}`,
    detail: `$${lane.spentTodayUsd.toFixed(2)} spent today · $${left.toFixed(2)} left. Takes work when both subscriptions are nearly spent, and its own job types in opted-in repos.`,
  };
}

// The daily cap box: empty or blank must not become $0, and the server (config.mjs schema) rejects above 1000.
export const CAP_MAX_USD = 1000;
export function parseCap(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { error: "Enter a daily cap in US$." };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return { error: "The cap must be a number of dollars, 0 or more." };
  if (value > CAP_MAX_USD) return { error: `The cap can be at most $${CAP_MAX_USD}.` };
  return { value };
}
