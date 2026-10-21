import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guardHome } from "./config.mjs";

const DAY = 24 * 60 * 60_000;

// OpenRouter's public model list, narrowed to models that can call tools.
export function parseOpenRouterModels(body) {
  return (Array.isArray(body?.data) ? body.data : [])
    .filter((model) => typeof model?.id === "string"
      && Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools"))
    .map((model) => ({
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      inputPerMillionUsd: perMillion(model.pricing?.prompt),
      outputPerMillionUsd: perMillion(model.pricing?.completion),
      contextLength: Number.isFinite(model.context_length) ? model.context_length : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Cached locally and refreshed at most once a day; a stale cache beats no list.
export async function listOpenRouterModels(options = {}) {
  const cachePath = options.cachePath || path.join(guardHome(options.env), "openrouter-models.json");
  const now = options.now ?? Date.now();
  const cached = existsSync(cachePath) ? safeJson(readFileSync(cachePath, "utf8")) : null;
  if (cached?.models && now - cached.fetchedAt < DAY && !options.refresh) return cached;
  try {
    const response = await (options.fetch || fetch)("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    });
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}.`);
    const fresh = { fetchedAt: now, models: parseOpenRouterModels(await response.json()) };
    mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    writeFileSync(cachePath, JSON.stringify(fresh), { mode: 0o600 });
    return fresh;
  } catch (error) {
    if (cached?.models) return { ...cached, stale: true };
    throw error;
  }
}

function perMillion(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1e6 * 1000) / 1000 : null;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
