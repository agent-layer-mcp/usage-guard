import { formatReset, minutesUntil } from "./time.mjs";

const STATE_ORDER = Object.freeze({ missing: -1, stale: 0, safe: 1, watch: 2, protect: 3, queue: 4 });

export function classifyTask(prompt = "") {
  const text = String(prompt).toLowerCase();
  if (!text.trim()) return "unknown";

  if (/\b(security|vulnerab|crypt|auth|permission|migration|architecture|architect|data loss|production|incident|race condition|deadlock|debug|root cause)\b/.test(text)) {
    return "high-reasoning";
  }
  if (/\b(format|formatting|rename|typo|lint|sort|organize imports|documentation|readme|changelog|mechanical|boilerplate)\b/.test(text)) {
    return "mechanical";
  }
  return "standard";
}

export function buildProviderDecision(store, provider, options = {}) {
  const now = options.now ?? Date.now();
  const config = options.config || store.getConfig();
  const observations = store.latest(provider);
  const taskClass = classifyTask(options.prompt);

  if (!observations.length) {
    return {
      provider,
      state: "missing",
      action: "connect-meter",
      reason: `No ${providerLabel(provider)} quota signal has been observed yet.`,
      taskClass,
      qualityLocked: config.qualityLock,
      blocked: false,
      stale: true,
      resetAt: null,
      createdAt: now,
      windows: [],
      instructions: meterInstructions(provider),
    };
  }

  const newest = Math.max(...observations.map((item) => item.observedAt));
  const stale = now - newest > config.staleAfterMinutes * 60_000;
  const windows = observations.map((observation) => {
    const since = Math.max(observation.observedAt - 24 * 60 * 60_000, now - 8 * 24 * 60 * 60_000);
    const history = store.history(provider, observation.key, observation.resetsAt, since);
    return evaluateWindow(observation, history, config, now);
  });

  if (stale) {
    return {
      provider,
      state: "stale",
      action: "refresh-meter",
      reason: `The latest ${providerLabel(provider)} signal is older than ${config.staleAfterMinutes} minutes.`,
      taskClass,
      qualityLocked: config.qualityLock,
      blocked: false,
      stale: true,
      resetAt: soonestReset(windows),
      createdAt: now,
      windows,
      instructions: "Refresh quota before making a pacing decision. Preserve the current model and reasoning setting.",
    };
  }

  const controlling = [...windows].sort((a, b) => STATE_ORDER[b.state] - STATE_ORDER[a.state])[0];
  const state = controlling?.state || "safe";
  const blocked = state === "queue" && config.enforcement === "protect";
  const action = actionFor(state, taskClass);
  const reason = reasonFor(controlling, state, blocked);
  const decision = {
    provider,
    state,
    action,
    reason,
    taskClass,
    qualityLocked: config.qualityLock,
    blocked,
    stale: false,
    resetAt: controlling?.resetsAt || soonestReset(windows),
    createdAt: now,
    windows,
    instructions: instructionsFor(state, taskClass, config, controlling),
  };
  store.recordDecision(decision);
  return decision;
}

export function buildStatus(store, options = {}) {
  const providers = options.providers || ["claude", "codex"];
  const decisions = providers.map((provider) => buildProviderDecision(store, provider, options));
  return {
    generatedAt: options.now ?? Date.now(),
    config: options.config || store.getConfig(),
    providers: decisions,
    recentDecisions: store.recentDecisions(10),
    privacy: {
      promptStored: false,
      sourceCodeStored: false,
      credentialsStored: false,
      telemetryEnabled: false,
    },
  };
}

export function evaluateWindow(observation, history, config, now = Date.now()) {
  const remainingPercent = Math.max(0, 100 - observation.usedPercent);
  const resetMinutes = minutesUntil(observation.resetsAt, now);
  const reservePercent = reserveFor(observation.windowMinutes, config);
  const usablePercent = Math.max(0, remainingPercent - reservePercent);
  const sustainableBurn = resetMinutes && resetMinutes > 0 ? usablePercent / resetMinutes : null;
  const burnPercentPerMinute = estimateBurn(history);
  const paceRatio = sustainableBurn != null && burnPercentPerMinute != null
    ? sustainableBurn === 0
      ? Number.POSITIVE_INFINITY
      : burnPercentPerMinute / sustainableBurn
    : null;
  const projectedExhaustionAt = burnPercentPerMinute && burnPercentPerMinute > 0
    ? now + (remainingPercent / burnPercentPerMinute) * 60_000
    : null;

  let state = "safe";
  if (remainingPercent <= reservePercent) state = "queue";
  else if (remainingPercent <= reservePercent + 10 || (paceRatio != null && paceRatio >= 1.3)) state = "protect";
  else if (remainingPercent <= reservePercent + 25 || (paceRatio != null && paceRatio >= 0.95)) state = "watch";

  return {
    ...observation,
    state,
    remainingPercent,
    reservePercent,
    usablePercent,
    minutesUntilReset: resetMinutes,
    burnPercentPerMinute,
    sustainableBurnPercentPerMinute: sustainableBurn,
    paceRatio: Number.isFinite(paceRatio) ? paceRatio : paceRatio === Number.POSITIVE_INFINITY ? 999 : null,
    projectedExhaustionAt,
  };
}

function estimateBurn(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const latest = history.at(-1);
  let earliest = history[0];
  for (const candidate of history) {
    if (latest.observedAt - candidate.observedAt >= 2 * 60_000) {
      earliest = candidate;
      break;
    }
  }
  const elapsedMinutes = (latest.observedAt - earliest.observedAt) / 60_000;
  if (elapsedMinutes < 2) return null;
  return Math.max(0, latest.usedPercent - earliest.usedPercent) / elapsedMinutes;
}

function reserveFor(windowMinutes, config) {
  if (windowMinutes != null && windowMinutes <= 360) return config.fiveHourReservePercent;
  return config.weeklyReservePercent;
}

function actionFor(state, taskClass) {
  if (state === "queue") return "queue-until-reset";
  if (state === "protect") return taskClass === "mechanical" ? "bounded-execution" : "serialize-work";
  if (state === "watch") return "trim-context";
  if (state === "stale") return "refresh-meter";
  if (state === "missing") return "connect-meter";
  return "observe";
}

function reasonFor(window, state, blocked) {
  if (!window) return "No controlling quota window was found.";
  const pace = window.paceRatio != null ? ` Current burn is ${window.paceRatio.toFixed(1)}x sustainable.` : "";
  const reset = window.resetsAt ? ` ${formatReset(window.resetsAt)}.` : "";
  if (state === "queue") {
    return `${window.label} has ${window.remainingPercent.toFixed(1)}% left, at the protected ${window.reservePercent}% reserve.${reset}${blocked ? " New heavy work is paused." : ""}`;
  }
  if (state === "protect") return `${window.label} is under pressure.${pace}${reset}`;
  if (state === "watch") return `${window.label} is approaching its sustainable pace.${pace}${reset}`;
  return `${window.label} is inside its sustainable budget.${reset}`;
}

function instructionsFor(state, taskClass, config, window) {
  const quality = config.qualityLock
    ? "Quality lock is on: do not lower the active model or reasoning effort."
    : "Keep the user's current model choice unless they explicitly approve a change.";
  const reset = window?.resetsAt ? ` The controlling window ${formatReset(window.resetsAt)}.` : "";

  if (state === "queue") {
    return `${quality} Do not begin quota-heavy work. Preserve the request for the next reset; lightweight local inspection and deterministic checks may continue.${reset}`;
  }
  if (state === "protect") {
    const route = taskClass === "mechanical"
      ? "Keep the task tightly bounded and run its normal verification."
      : "Use one active agent, avoid speculative branches, and keep the strongest appropriate reasoning for planning and final review.";
    return `${quality} ${route}${reset}`;
  }
  if (state === "watch") {
    return `${quality} Reuse existing evidence, avoid duplicate reads, compact only at a safe boundary, and keep parallel work bounded.${reset}`;
  }
  return `${quality} Work normally; avoid unnecessary duplicate context and speculative parallel agents.${reset}`;
}

function meterInstructions(provider) {
  return provider === "claude"
    ? "Run one Claude Code response with the Usage Guard status line enabled to establish live quota windows."
    : "Run `usage-guard sync codex` to read the documented local Codex rate-limit snapshot.";
}

function providerLabel(provider) {
  return provider === "claude" ? "Claude Code" : "Codex";
}

function soonestReset(windows) {
  const resets = windows.map((window) => window.resetsAt).filter(Number.isFinite);
  return resets.length ? Math.min(...resets) : null;
}
