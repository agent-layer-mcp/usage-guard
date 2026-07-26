import os from "node:os";
import path from "node:path";

export const VERSION = "0.2.6";
export const PRODUCT_NAME = "Usage Guard";

export const DEFAULT_CONFIG = Object.freeze({
  enforcement: "protect",
  qualityLock: true,
  fiveHourReservePercent: 8,
  weeklyReservePercent: 5,
  rapidBurnWatchMinutes: 90,
  rapidBurnProtectMinutes: 30,
  contextWatchPercent: 70,
  contextProtectPercent: 85,
  staleAfterMinutes: 15,
  dashboardPort: 4765,
});

export function guardHome(env = process.env) {
  return path.resolve(env.USAGE_GUARD_HOME || path.join(os.homedir(), ".usage-guard"));
}

export function databasePath(env = process.env) {
  return path.join(guardHome(env), "usage-guard.sqlite3");
}

export function installRecordPath(env = process.env) {
  return path.join(guardHome(env), "install-record.json");
}

export function normalizeConfig(input = {}) {
  const merged = { ...DEFAULT_CONFIG, ...input };
  const enforcement = ["observe", "protect"].includes(merged.enforcement)
    ? merged.enforcement
    : DEFAULT_CONFIG.enforcement;
  const contextWatchPercent = clampNumber(merged.contextWatchPercent, 1, 99, 70);
  const contextProtectPercent = Math.max(
    contextWatchPercent,
    clampNumber(merged.contextProtectPercent, 1, 100, 85),
  );
  const rapidBurnProtectMinutes = clampNumber(
    merged.rapidBurnProtectMinutes,
    5,
    120,
    30,
  );
  const rapidBurnWatchMinutes = Math.max(
    rapidBurnProtectMinutes,
    clampNumber(merged.rapidBurnWatchMinutes, 10, 240, 90),
  );
  return {
    enforcement,
    qualityLock: merged.qualityLock !== false,
    fiveHourReservePercent: clampNumber(merged.fiveHourReservePercent, 0, 30, 8),
    weeklyReservePercent: clampNumber(merged.weeklyReservePercent, 0, 30, 5),
    rapidBurnWatchMinutes,
    rapidBurnProtectMinutes,
    contextWatchPercent,
    contextProtectPercent,
    staleAfterMinutes: clampNumber(merged.staleAfterMinutes, 1, 240, 15),
    dashboardPort: Math.round(clampNumber(merged.dashboardPort, 1024, 65535, 4765)),
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
