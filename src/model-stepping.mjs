const PROTECTED_ROLES = new Set(["planning", "architecture", "review", "sensitive"]);
export const TASK_ROLES = ["planning", "architecture", "review", "sensitive", "routine", "standard"];

// Only the role label leaves this function; descriptions never enter state/logs.
export function classifyRole(prompt = "", requestedRole) {
  const text = String(prompt).toLowerCase();
  if (/\b(secur\w*|vulnerab\w*|crypt\w*|auth\w*|permission\w*|money|payment\w*|financ\w*|billing|bank\w*|invoice\w*|children(?:'s)?|child(?:'s)?|kids?|minors?|production|prod|deploy\w*|data loss)\b/.test(text)) return "sensitive";
  if (/\b(review\w*|audit\w*|verify finished|final verification)\b/.test(text)) return "review";
  if (/\b(architect\w*|design decision\w*)\b/.test(text)) return "architecture";
  if (/\b(plan|planning|migration\w*|debug\w*|root cause|incident|race condition|deadlock)\b/.test(text)) return "planning";
  if (TASK_ROLES.includes(requestedRole)) return requestedRole;
  if (/\b(search\w*|find|read|reading|test runs?|run tests?|format\w*|rename|typo|lint|mechanical|summari[sz]\w*|summar[yi]\w*|documentation|readme|changelog|organize imports)\b/.test(text)) return "routine";
  return text.trim() ? "standard" : "planning";
}

export function quietHoursActive(quietHours, now = Date.now()) {
  if (!quietHours) return false;
  const date = new Date(now);
  let minutes = date.getHours() * 60 + date.getMinutes();
  if (quietHours.timeZone) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: quietHours.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    minutes = Number(parts.find((p) => p.type === "hour").value) * 60
      + Number(parts.find((p) => p.type === "minute").value);
  }
  const start = clockMinutes(quietHours.start);
  const end = clockMinutes(quietHours.end);
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export function applyModelStepping(store, decision, config, options = {}) {
  if (!config.modelStepping || config.qualityLock) return decision;
  const taskRole = classifyRole(options.prompt, options.role);
  const now = decision.createdAt;
  const unavailable = decision.stale || !decision.windows.length
    || decision.windows.some((w) => now - w.observedAt > config.staleAfterMinutes * 60_000
      || (w.resetsAt != null && now >= w.resetsAt));
  if (unavailable) {
    return {
      ...decision, modelStepping: true, taskRole,
      recommendedModel: null, recommendedEffort: null, routineModel: null, routineEffort: null,
      recommendedRung: null, routineRung: null, quotaRung: null,
      modelReason: decision.blocked
        ? "A fresh quota window has reached its reserve: pause work and save a quota handover; refresh the other meters."
        : "Refresh all quota windows before choosing a model; keep the current model until then.",
      instructions: `${decision.instructions} Model stepping is enabled, but recommendations await fresh quota. Do not switch models on stale or expired evidence.`
        + (decision.blocked ? ` ${switchingInstructions(decision, {})}` : ""),
    };
  }
  const recommendation = store.updateModelStepping(decision.provider, (previous) => {
    // A settings change starts a fresh threshold evaluation, not stale hysteresis.
    const policyKey = JSON.stringify([
      config.fiveHourStepDownThresholds, config.weeklyStepDownThresholds,
      config.stepUpMarginPercent, config.fiveHourReservePercent, config.weeklyReservePercent,
    ]);
    const priorWindows = previous?.policyKey === policyKey ? previous.windows : {};
    const windows = {};
    let thresholdRung = 1;
    const causes = [];
    let held = false;
    for (const w of decision.windows) {
      const short = w.windowMinutes != null && w.windowMinutes <= 360;
      const levels = short
        ? config.fiveHourStepDownThresholds.map((threshold, i) => ({ threshold, rung: i + 2 }))
        : config.weeklyStepDownThresholds.map((threshold, i) => ({ threshold, rung: i === 0 ? 2 : 4 }));
      const rawRung = levels.reduce((rung, level) => w.usablePercent < level.threshold ? level.rung : rung, 1);
      const prior = priorWindows?.[w.key];
      // A provider-confirmed reset releases hysteresis only for this window.
      const reset = prior && w.observedAt > prior.observedAt && prior.resetsAt != null
        && w.observedAt >= prior.resetsAt && w.resetsAt !== prior.resetsAt;
      let rung = rawRung;
      if (prior && !reset) {
        for (const level of levels) {
          if (prior.rung >= level.rung && w.usablePercent < level.threshold + config.stepUpMarginPercent) {
            rung = Math.max(rung, level.rung);
          }
        }
      }
      held ||= rung > rawRung;
      windows[w.key] = { rung, resetsAt: w.resetsAt, observedAt: w.observedAt };
      thresholdRung = Math.max(thresholdRung, rung);
      if (rung > 1) causes.push(`${short ? "5-hour" : "weekly"} usable ${w.usablePercent.toFixed(1)}%`);
    }
    const rapidBurn = config.rapidBurnStepDown && decision.windows.some((w) =>
      (w.paceRatio != null && w.paceRatio >= 0.95)
      || (w.minutesUntilReserve != null && w.minutesUntilReserve <= config.rapidBurnWatchMinutes));
    const quiet = quietHoursActive(config.quietHours, now);
    const quotaRung = Math.min(4, thresholdRung + (rapidBurn ? 1 : 0) + (quiet ? config.quietHours.extraRungs : 0));
    const routineRung = Math.min(4, quotaRung + config.routineStepDownRungs);
    const recommendedRung = taskRole === "routine" ? routineRung
      : Math.min(quotaRung, PROTECTED_ROLES.has(taskRole) ? config.protectedMaxRung : 3);
    const ladder = config.modelLadders[decision.provider];
    const main = ladder[recommendedRung - 1];
    const routine = ladder[routineRung - 1];
    if (rapidBurn) causes.push("rapid burn");
    if (quiet && config.quietHours.extraRungs) causes.push("quiet hours");
    if (held) causes.push(`waiting for ${config.stepUpMarginPercent}-point recovery margin`);
    const protectedReason = PROTECTED_ROLES.has(taskRole) && quotaRung > config.protectedMaxRung
      ? `; ${taskRole} stays at rung ${config.protectedMaxRung}` : "";
    const modelReason = decision.blocked
      ? "Protected reserve reached: pause new work and save a quota handover; recommendations apply only after quota recovers."
      : `${causes.length ? causes.join(", ") : "Quota healthy"}; main rung ${recommendedRung}, routine rung ${routineRung}${protectedReason}.`;
    const recommendation = {
      modelStepping: true, taskRole, recommendedModel: main.model, recommendedEffort: main.effort,
      routineModel: routine.model, routineEffort: routine.effort,
      recommendedRung, routineRung, quotaRung, modelReason,
    };
    // Status reads and routine task lookups share quota latches, but must not
    // fabricate model changes merely by asking about different roles.
    const protectedRung = Math.min(quotaRung, config.protectedMaxRung);
    const protectedModel = ladder[protectedRung - 1];
    const auditRecommendation = {
      ...recommendation, taskRole: "planning", recommendedRung: protectedRung,
      recommendedModel: protectedModel.model, recommendedEffort: protectedModel.effort,
    };
    const state = { policyKey, windows, ...auditRecommendation };
    const changed = !previous || ["quotaRung", "recommendedRung", "routineRung", "recommendedModel", "recommendedEffort", "routineModel", "routineEffort"]
      .some((key) => previous[key] !== auditRecommendation[key]);
    const deltas = ["quotaRung", "recommendedRung", "routineRung"].map((key) => auditRecommendation[key] - (previous?.[key] ?? 1));
    const direction = deltas.some((delta) => delta > 0) && deltas.some((delta) => delta < 0) ? "mixed"
      : deltas.some((delta) => delta > 0) ? "down" : deltas.some((delta) => delta < 0) ? "up" : "changed";
    const transition = changed ? {
      provider: decision.provider, type: "model-step", direction,
      action: `model-step-${direction}`, state: decision.state, createdAt: now,
      reason: `${causes.length ? causes.join(", ") : "Quota healthy"}; protected main rung ${protectedRung}, routine rung ${routineRung}.`,
      taskClass: "high-reasoning", taskRole: "planning",
      fromRung: previous?.quotaRung ?? 1, rung: quotaRung,
      recommendedRung: protectedRung, routineRung, recommendedModel: protectedModel.model, recommendedEffort: protectedModel.effort,
      routineModel: routine.model, routineEffort: routine.effort,
      applied: false, // A recommendation is not evidence that a host actually switched.
      rapidBurn, quietHours: quiet, resetAt: decision.resetAt,
      quota: decision.windows.map((w) => ({
        key: w.key, windowMinutes: w.windowMinutes, usedPercent: w.usedPercent,
        remainingPercent: w.remainingPercent, usablePercent: w.usablePercent,
        reservePercent: w.reservePercent, resetsAt: w.resetsAt,
        observedAt: w.observedAt, paceRatio: w.paceRatio, minutesUntilReserve: w.minutesUntilReserve,
      })),
    } : null;
    return { state, transition, recommendation };
  });
  return {
    ...decision, ...recommendation,
    instructions: `${decision.instructions} ${switchingInstructions(decision, recommendation)}`,
  };
}

export function overnightSummary(store, config, now = Date.now()) {
  const counts = Object.fromEntries(store.modelStepCounts(now - config.overnightSummaryHours * 60 * 60_000)
    .map((item) => [item.direction, Number(item.count)]));
  return `Last ${config.overnightSummaryHours} hours: ${counts.down || 0} model recommendation(s) down, ${counts.up || 0} up`
    + `${counts.mixed || counts.changed ? `, ${(counts.mixed || 0) + (counts.changed || 0)} other change(s)` : ""}. Changes take effect when the host agent applies them between tasks.`;
}

function switchingInstructions(decision, recommendation) {
  if (decision.blocked) return "Pause at the reserve. Write a quota-only handover (time, quota, models, reset; no prompts or code) before stopping. Do not spawn subagents or switch to a cheaper model to bypass this pause.";
  const { recommendedModel: model, recommendedEffort: effort, routineModel, routineEffort } = recommendation;
  return `Model stepping is on and already authorized: use ${model} with ${effort} effort for new ${recommendation.taskRole} work. `
    + `Use ${routineModel} with ${routineEffort} effort for routine subagents only. `
    + "Planning, architecture, finished-work reviews, and money, security, children's data or production work must use the protected main-thread recommendation (never below rung 2). Recheck usage_guard_decision with that role before delegation. "
    + "Finish the current edit and its checks before switching; switch only between tasks. "
    + (decision.provider === "claude"
      ? "In Claude Desktop, when available, use mcp__ccd_session_mgmt__set_session_model and mcp__ccd_session_mgmt__set_session_effort with their declared schemas for this session. Claude Code needs version 2.1.284 or newer for this default ladder. "
      : "When this Codex host exposes a session-model control, use its declared schema to select the recommended model and reasoning effort. ")
    + "Report an applied switch only after the host confirms success. "
    + "Otherwise launch new work as a subagent with the exact recommended model and effort using the host's supported model/effort parameters. If a host only accepts aliases, resolve them against its verified model mapping first. "
    + "For default effort, omit the effort parameter and clear any inherited effort override. Never use max or xhigh on a stepped-down rung. "
    + "If the exact model or effort cannot be selected, keep work queued and report the limitation; do not guess an ID, substitute another model, or ask for stepping authorization again. "
    + "Usage Guard recommends these changes; it does not itself switch a running host session.";
}

function clockMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}
