import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

export function readPxpipeTelemetry(options = {}) {
  const filename = options.filename
    || path.join(options.homeDir || os.homedir(), ".pxpipe", "events.jsonl");
  const now = options.now ?? Date.now();
  const events = readRecentEvents(filename, options.maxBytes ?? DEFAULT_MAX_BYTES)
    .filter(isMessageEvent);
  if (!events.length) return null;

  const latest = events.at(-1);
  const observedAt = Date.parse(latest.ts);
  if (!Number.isFinite(observedAt)) return null;
  const recent = events.filter((event) => {
    const timestamp = Date.parse(event.ts);
    return Number.isFinite(timestamp) && timestamp >= now - 15 * 60_000;
  });
  const weighted = weightedInputEquivalentRange(latest);
  const recentWeighted = recent.reduce((total, event) => {
    const range = weightedInputEquivalentRange(event);
    return {
      min: total.min + range.min,
      max: total.max + range.max,
    };
  }, { min: 0, max: 0 });
  const firstRecentAt = recent.length ? Date.parse(recent[0].ts) : null;
  const elapsedMinutes = firstRecentAt == null
    ? null
    : Math.max(1 / 60, (observedAt - firstRecentAt) / 60_000);

  return {
    source: "pxpipe",
    observedAt,
    stale: now - observedAt > (options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS),
    model: stringOrNull(latest.model),
    contextTokens: finiteOrNull(latest.baseline_tokens),
    imageCount: finiteOrNull(latest.image_count),
    inputTokens: finiteOrNull(latest.input_tokens),
    outputTokens: finiteOrNull(latest.output_tokens),
    cacheCreateTokens: finiteOrNull(latest.cache_create_tokens),
    cacheCreate5mTokens: finiteOrNull(latest.cache_create_5m_tokens),
    cacheCreate1hTokens: finiteOrNull(latest.cache_create_1h_tokens),
    cacheReadTokens: finiteOrNull(latest.cache_read_tokens),
    cacheWriteTtl: weighted.cacheWriteTtl,
    weightedInputEquivalent: weighted.min === weighted.max ? weighted.min : null,
    weightedInputEquivalentMin: weighted.min,
    weightedInputEquivalentMax: weighted.max,
    recentRequestCount: recent.length,
    recentElapsedMinutes: elapsedMinutes,
    recentWeightedPerMinuteMin: elapsedMinutes == null
      ? null
      : recentWeighted.min / elapsedMinutes,
    recentWeightedPerMinuteMax: elapsedMinutes == null
      ? null
      : recentWeighted.max / elapsedMinutes,
    weighting: {
      input: 1,
      cacheCreate5m: 1.25,
      cacheCreate1h: 2,
      cacheRead: 0.1,
      output: 5,
      caveat: "API-equivalent weighting; subscription quota weighting is not public.",
    },
    microcompactDisabled: options.env?.DISABLE_MICROCOMPACT === "1",
  };
}

export function weightedInputEquivalent(event) {
  return weightedInputEquivalentRange(event).min;
}

export function weightedInputEquivalentRange(event) {
  const cacheCreate = finite(event.cache_create_tokens);
  const cacheCreate5m = Math.min(
    cacheCreate,
    finite(event.cache_create_5m_tokens),
  );
  const cacheCreate1h = Math.min(
    Math.max(0, cacheCreate - cacheCreate5m),
    finite(event.cache_create_1h_tokens),
  );
  const unclassifiedCacheCreate = Math.max(
    0,
    cacheCreate - cacheCreate5m - cacheCreate1h,
  );
  const fixed = (
    finite(event.input_tokens)
    + cacheCreate5m * 1.25
    + cacheCreate1h * 2
    + finite(event.cache_read_tokens) * 0.1
    + finite(event.output_tokens) * 5
  );
  const cacheWriteTtl = unclassifiedCacheCreate > 0
    ? "unknown"
    : cacheCreate1h > 0 && cacheCreate5m > 0
      ? "mixed"
      : cacheCreate1h > 0
        ? "1h"
        : cacheCreate5m > 0
          ? "5m"
          : "none";

  return {
    min: fixed + unclassifiedCacheCreate * 1.25,
    max: fixed + unclassifiedCacheCreate * 2,
    cacheWriteTtl,
  };
}

function readRecentEvents(filename, maxBytes) {
  let descriptor;
  try {
    descriptor = openSync(filename, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, Math.max(1, maxBytes));
    const offset = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, offset);
    let text = buffer.toString("utf8");
    if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  } finally {
    if (descriptor != null) closeSync(descriptor);
  }
}

function isMessageEvent(event) {
  return event?.method === "POST"
    && event.path === "/v1/messages"
    && Number(event.status) >= 200
    && Number(event.status) < 300
    && Number.isFinite(Number(event.baseline_tokens));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteOrNull(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
