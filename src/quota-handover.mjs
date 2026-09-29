import { chmodSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const PROVIDERS = new Set(["claude", "codex"]);

// A quota handover contains operational meter data only. Hook input, task text,
// tool arguments, source, and session identifiers must never be copied here.
export function writeQuotaHandover(store, decision, options = {}) {
  if (!PROVIDERS.has(decision?.provider) || !decision.blocked) return null;
  const directory = handoverDirectory(store, options);
  if (!directory) return null;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `quota-${decision.provider}.json`);
  const temporary = path.join(directory, `.quota-${decision.provider}-${randomUUID()}.tmp`);
  const payload = {
    provider: decision.provider,
    createdAt: Number.isFinite(decision.createdAt) ? decision.createdAt : Date.now(),
    quota: (decision.windows || []).map((window) => ({
      window: safeWindowName(window),
      usedPercent: finiteOrNull(window.usedPercent),
      remainingPercent: finiteOrNull(window.remainingPercent),
      usablePercent: finiteOrNull(window.usablePercent),
      reservePercent: finiteOrNull(window.reservePercent),
      resetAt: finiteOrNull(window.resetsAt),
    })),
    model: decision.recommendedModel || null,
    effort: decision.recommendedEffort || null,
    reason: "New work paused at the protected quota reserve.",
    resetAt: finiteOrNull(decision.resetAt),
  };
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  return { path: target, payload };
}

export function clearQuotaHandovers(store, options = {}) {
  const directory = handoverDirectory(store, options);
  if (!directory) return;
  for (const provider of PROVIDERS) {
    try { unlinkSync(path.join(directory, `quota-${provider}.json`)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function handoverDirectory(store, options) {
  if (options.stateHome) return path.join(path.resolve(options.stateHome), "handoffs");
  if (!store?.filename || store.filename === ":memory:") return null;
  return path.join(path.dirname(path.resolve(store.filename)), "handoffs");
}

function safeWindowName(window) {
  if (window.windowMinutes != null && window.windowMinutes <= 360) return "five-hour";
  if (window.windowMinutes != null && window.windowMinutes >= 6 * 24 * 60) return "weekly";
  return "other";
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}
