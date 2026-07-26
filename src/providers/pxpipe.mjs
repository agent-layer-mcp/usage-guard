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
  const weighted = weightedInputEquivalent(latest);
  const recentWeighted = recent.reduce(
    (total, event) => total + weightedInputEquivalent(event),
    0,
  );
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
    cacheReadTokens: finiteOrNull(latest.cache_read_tokens),
    weightedInputEquivalent: weighted,
    recentRequestCount: recent.length,
    recentWeightedPerMinute: elapsedMinutes == null
      ? null
      : recentWeighted / elapsedMinutes,
    weighting: {
      input: 1,
      cacheCreate: 1.25,
      cacheRead: 0.1,
      output: 5,
      caveat: "Directional API-equivalent weighting; subscription quota weighting is not public.",
    },
    microcompactDisabled: options.env?.DISABLE_MICROCOMPACT === "1",
  };
}

export function weightedInputEquivalent(event) {
  return (
    finite(event.input_tokens)
    + finite(event.cache_create_tokens) * 1.25
    + finite(event.cache_read_tokens) * 0.1
    + finite(event.output_tokens) * 5
  );
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
