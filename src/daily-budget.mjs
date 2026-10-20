const DAY = 24 * 60 * 60_000;

// Most recent local day boundary (e.g. 08:00) at or before `now`.
export function dayStartAt(now, config = {}) {
  const [hour, minute] = String(config.dayStartTime || "08:00").split(":").map(Number);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: config.dayTimeZone || undefined,
    hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(now)).map((part) => [part.type, Number(part.value)]));
  const offset = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    - Math.floor(now / 1000) * 1000;
  // shortcut: uses today's UTC offset, so a DST change between the boundary and now shifts it by an hour.
  const boundary = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute) - offset;
  return boundary > now ? boundary - DAY : boundary;
}

// Equal share of what is left of the weekly window for each remaining local day.
export function evaluateDailyBudget(window, history, config, now = Date.now()) {
  if (config.dailyBudget === false || window.resetsAt == null || window.windowMinutes == null
    || window.windowMinutes <= 360 || now >= window.resetsAt) return null;

  const dayStart = dayStartAt(now, config);
  const periodStart = window.resetsAt - window.windowMinutes * 60_000;
  const reserve = window.reservePercent ?? config.weeklyReservePercent;
  const samples = (history || []).filter((item) => item.observedAt <= now);
  let usedAtDayStart;
  let baselineEstimated = false;
  if (periodStart >= dayStart) {
    usedAtDayStart = 0; // The weekly window itself began today.
  } else {
    const before = samples.filter((item) => item.observedAt <= dayStart).at(-1);
    const after = samples.find((item) => item.observedAt > dayStart);
    usedAtDayStart = before?.usedPercent ?? after?.usedPercent ?? window.usedPercent;
    baselineEstimated = !before;
  }
  usedAtDayStart = Math.min(usedAtDayStart, window.usedPercent);

  // Fractional days, so a short final day before the reset gets a matching short share.
  const daysLeft = Math.max(1 / 24, (window.resetsAt - Math.max(dayStart, periodStart)) / DAY);
  const todayBudgetPercent = Math.max(0, 100 - reserve - usedAtDayStart) * Math.min(1, daysLeft) / daysLeft;
  const usedTodayPercent = window.usedPercent - usedAtDayStart;
  return {
    dayStartAt: dayStart,
    nextDayAt: Math.min(dayStart + DAY, window.resetsAt),
    daysLeft: Math.round(daysLeft * 10) / 10,
    usedAtDayStartPercent: usedAtDayStart,
    todayBudgetPercent,
    usedTodayPercent,
    remainingTodayPercent: Math.max(0, todayBudgetPercent - usedTodayPercent),
    borrowedPercent: Math.max(0, usedTodayPercent - todayBudgetPercent),
    // Positive: unspent budget from earlier days rolled into today.
    rolledForwardPercent: todayBudgetPercent - (100 - reserve) / (window.windowMinutes / 1440),
    spent: usedTodayPercent >= todayBudgetPercent,
    baselineEstimated,
  };
}
