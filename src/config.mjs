import os from "node:os";
import path from "node:path";

export const VERSION = "0.5.1";
export const PRODUCT_NAME = "Usage Guard";

export const DEFAULT_MODEL_LADDERS = Object.freeze({
  claude: Object.freeze([
    Object.freeze({ model: "claude-opus-5-5", effort: "high" }),
    Object.freeze({ model: "claude-sonnet-5-5", effort: "high" }),
    Object.freeze({ model: "claude-sonnet-5-5", effort: "medium" }),
    Object.freeze({ model: "claude-haiku-4-5-20251001", effort: "default" }),
  ]),
  codex: Object.freeze([
    Object.freeze({ model: "gpt-6-astra", effort: "high" }),
    Object.freeze({ model: "gpt-6-sol", effort: "high" }),
    Object.freeze({ model: "gpt-6-sol", effort: "medium" }),
    Object.freeze({ model: "gpt-6-luna", effort: "high" }),
  ]),
});

export const DEFAULT_CONFIG = Object.freeze({
  enforcement: "protect",
  modelStepping: true,
  qualityLock: false,
  modelLadders: DEFAULT_MODEL_LADDERS,
  fiveHourStepDownThresholds: Object.freeze([40, 25, 12]),
  weeklyStepDownThresholds: Object.freeze([30, 10]),
  stepUpMarginPercent: 10,
  rapidBurnStepDown: true,
  quietHours: null,
  routineStepDownRungs: 1,
  protectedMaxRung: 2,
  overnightSummaryHours: 12,
  fiveHourReservePercent: 8,
  weeklyReservePercent: 5,
  rapidBurnWatchMinutes: 90,
  rapidBurnProtectMinutes: 30,
  contextWatchPercent: 70,
  contextProtectPercent: 85,
  compactionHandoffEnabled: true,
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
    modelStepping: merged.modelStepping !== false,
    qualityLock: merged.qualityLock === true,
    modelLadders: structuredClone(merged.modelLadders),
    fiveHourStepDownThresholds: [...merged.fiveHourStepDownThresholds],
    weeklyStepDownThresholds: [...merged.weeklyStepDownThresholds],
    stepUpMarginPercent: clampNumber(merged.stepUpMarginPercent, 0, 50, 10),
    rapidBurnStepDown: merged.rapidBurnStepDown !== false,
    quietHours: merged.quietHours ? { timeZone: null, extraRungs: 1, ...merged.quietHours } : null,
    routineStepDownRungs: Math.round(clampNumber(merged.routineStepDownRungs, 0, 3, 1)),
    protectedMaxRung: Math.round(clampNumber(merged.protectedMaxRung, 1, 2, 2)),
    overnightSummaryHours: clampNumber(merged.overnightSummaryHours, 1, 48, 12),
    fiveHourReservePercent: clampNumber(merged.fiveHourReservePercent, 0, 30, 8),
    weeklyReservePercent: clampNumber(merged.weeklyReservePercent, 0, 30, 5),
    rapidBurnWatchMinutes,
    rapidBurnProtectMinutes,
    contextWatchPercent,
    contextProtectPercent,
    compactionHandoffEnabled: merged.compactionHandoffEnabled !== false,
    staleAfterMinutes: clampNumber(merged.staleAfterMinutes, 1, 240, 15),
    dashboardPort: Math.round(clampNumber(merged.dashboardPort, 1024, 65535, 4765)),
  };
}

const percent = (maximum = 100) => ({ type: "number", minimum: 0, maximum });
const thresholds = (length) => ({ type: "array", minItems: length, maxItems: length, items: percent() });
const ladder = {
  type: "array", minItems: 4, maxItems: 4,
  items: {
    type: "object", additionalProperties: false, required: ["model", "effort"],
    properties: {
      model: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$" },
      effort: { type: "string", enum: ["default", "minimal", "low", "medium", "high", "xhigh", "max"] },
    },
  },
};

// Shared by MCP and local settings validation; unknown keys never enter the DB.
export const CONFIG_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    enforcement: { type: "string", enum: ["observe", "protect"] },
    modelStepping: { type: "boolean" }, qualityLock: { type: "boolean" },
    modelLadders: {
      type: "object", additionalProperties: false, required: ["claude", "codex"],
      properties: { claude: ladder, codex: ladder },
    },
    fiveHourStepDownThresholds: thresholds(3), weeklyStepDownThresholds: thresholds(2),
    stepUpMarginPercent: percent(50), rapidBurnStepDown: { type: "boolean" },
    quietHours: {
      anyOf: [{ type: "null" }, {
        type: "object", additionalProperties: false, required: ["start", "end"],
        properties: {
          start: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
          end: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
          timeZone: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 80 }] },
          extraRungs: { type: "integer", minimum: 0, maximum: 3 },
        },
      }],
    },
    routineStepDownRungs: { type: "integer", minimum: 0, maximum: 3 },
    protectedMaxRung: { type: "integer", minimum: 1, maximum: 2 },
    overnightSummaryHours: { type: "number", minimum: 1, maximum: 48 },
    fiveHourReservePercent: percent(30), weeklyReservePercent: percent(30),
    rapidBurnWatchMinutes: { type: "number", minimum: 10, maximum: 240 },
    rapidBurnProtectMinutes: { type: "number", minimum: 5, maximum: 120 },
    contextWatchPercent: { type: "number", minimum: 1, maximum: 99 },
    contextProtectPercent: { type: "number", minimum: 1, maximum: 100 },
    compactionHandoffEnabled: { type: "boolean" },
    staleAfterMinutes: { type: "number", minimum: 1, maximum: 240 },
    dashboardPort: { type: "integer", minimum: 1024, maximum: 65535 },
  },
};

export function validateConfigPatch(patch) {
  validateValue(patch, CONFIG_SCHEMA, "config");
  for (const key of ["fiveHourStepDownThresholds", "weeklyStepDownThresholds"]) {
    if (patch[key]?.some((value, i, values) => i > 0 && value >= values[i - 1])) {
      throw new TypeError(`${key} must be strictly descending.`);
    }
  }
  for (const [provider, rungs] of Object.entries(patch.modelLadders || {})) {
    if (rungs.slice(1).some((rung) => ["max", "xhigh"].includes(rung.effort))) {
      throw new TypeError(`${provider}: stepped-down rungs cannot use max or xhigh effort.`);
    }
    for (const rung of rungs) {
      if (/^claude-haiku-4-5(?:-20251001)?$/.test(rung.model) && rung.effort !== "default") {
        throw new TypeError("Haiku 4.5 requires default effort; it does not support the effort parameter.");
      }
    }
  }
  if (patch.quietHours) {
    if (patch.quietHours.start === patch.quietHours.end) throw new TypeError("Quiet hours start and end must differ.");
    if (patch.quietHours.timeZone) new Intl.DateTimeFormat("en", { timeZone: patch.quietHours.timeZone }).format();
  }
  return patch;
}

function validateValue(value, schema, name) {
  if (schema.anyOf) {
    for (const alternative of schema.anyOf) {
      try { validateValue(value, alternative, name); return; } catch { /* Try next allowed shape. */ }
    }
    throw new TypeError(`${name} has an invalid value.`);
  }
  const validType = schema.type === "null" ? value === null
    : schema.type === "array" ? Array.isArray(value)
      : schema.type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
        : schema.type === "integer" ? Number.isInteger(value)
          : typeof value === schema.type;
  if (!validType) throw new TypeError(`${name} must be ${schema.type}.`);
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(`${name} is not supported.`);
  if (["number", "integer"].includes(schema.type)
    && (!Number.isFinite(value) || value < schema.minimum || value > schema.maximum)) {
    throw new TypeError(`${name} must be between ${schema.minimum} and ${schema.maximum}.`);
  }
  if (schema.type === "string" && ((schema.pattern && !new RegExp(schema.pattern).test(value))
    || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity))) {
    throw new TypeError(`${name} has an invalid format.`);
  }
  if (schema.type === "array") {
    if (value.length < schema.minItems || value.length > schema.maxItems) throw new TypeError(`${name} has an invalid length.`);
    value.forEach((item, i) => validateValue(item, schema.items, `${name}[${i}]`));
  }
  if (schema.type === "object") {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new TypeError(`${name}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new TypeError(`Unknown setting: ${name}.${key}`);
      validateValue(item, schema.properties[key], `${name}.${key}`);
    }
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
