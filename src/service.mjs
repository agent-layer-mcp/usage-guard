import { buildProviderDecision, buildStatus } from "./policy.mjs";
import { parseClaudeStatusLine } from "./providers/claude.mjs";
import { fetchCodexSnapshot } from "./providers/codex.mjs";

export function ingestClaudeStatus(store, input, now = Date.now()) {
  const snapshot = parseClaudeStatusLine(input, now);
  if (snapshot.windows.length) store.saveSnapshot(snapshot);
  if (Number.isFinite(snapshot.contextPercent)) store.saveContextObservation(snapshot);
  return snapshot;
}

export async function syncCodex(store, options = {}) {
  const snapshot = await fetchCodexSnapshot(options);
  if (!snapshot.windows.length) throw new Error("Codex returned no rate-limit windows.");
  store.saveSnapshot(snapshot);
  return snapshot;
}

export function providerDecision(store, provider, options = {}) {
  return buildProviderDecision(store, provider, options);
}

export function completeStatus(store, options = {}) {
  return buildStatus(store, options);
}
