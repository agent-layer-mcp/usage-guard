export function toEpochMilliseconds(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function minutesUntil(timestamp, now = Date.now()) {
  if (!timestamp) return null;
  return Math.max(0, (timestamp - now) / 60_000);
}

export function formatDuration(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return "unknown";
  if (minutes < 1) return "under 1m";
  const rounded = Math.ceil(minutes);
  if (rounded < 60) return `${rounded}m`;
  if (rounded < 1440) {
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  const days = Math.floor(rounded / 1440);
  const hours = Math.ceil((rounded % 1440) / 60);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function formatReset(timestamp, now = Date.now()) {
  const remaining = minutesUntil(timestamp, now);
  return remaining == null ? "reset unknown" : `resets in ${formatDuration(remaining)}`;
}
