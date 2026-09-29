import { formatStatusLine } from "./presentation.mjs";
import { readScreenshotMemoryStatus } from "./screenshot-proxy.mjs";
import { providerDecision, syncClaudeDesktop, syncCodex } from "./service.mjs";
import {
  readCompactionHandoff,
  writeCompactionHandoff,
} from "./compaction-handoff.mjs";
import { writeQuotaHandover } from "./quota-handover.mjs";

export async function runProviderHook(store, provider, input, options = {}) {
  const eventName = input.hook_event_name || input.hookEventName || options.eventName || "UserPromptSubmit";
  const prompt = input.prompt || input.user_prompt || input.userPrompt || "";
  const sessionId = input.session_id || input.sessionId || null;
  const noticeSurface = `session:${sessionId || "provider"}`;
  const activeRoleSurface = `${noticeSurface}:current-task-role`;
  const activeRole = eventName === "UserPromptSubmit"
    ? input.role
    : store.getNoticeState(provider, activeRoleSurface)?.state;

  if (provider === "codex") {
    try {
      await syncCodex(store, {
        codexPath: options.codexPath,
        timeoutMs: options.timeoutMs ?? 6000,
        model: input.model,
        effort: input.reasoning_effort || input.effort,
      });
    } catch {
      // A stale/missing decision is safer than failing the provider's hook lifecycle.
    }
  } else if (provider === "claude") {
    try {
      syncClaudeDesktop(store, options.claudeDesktop);
    } catch {
      // An absent or changed desktop cache must not break Claude's hook lifecycle.
    }
  }

  const decision = providerDecision(store, provider, { prompt, sessionId, role: activeRole });
  const message = formatStatusLine(decision, { color: false });
  const previous = store.getNoticeState(provider, noticeSurface);
  const stepping = decision.modelStepping === true;
  if (stepping && eventName === "UserPromptSubmit") {
    store.setNoticeState(provider, activeRoleSurface, decision.taskRole);
  }
  const stepSurface = `${noticeSurface}:model-recommendation`;
  const stepSignature = stepping ? recommendationSignature(decision) : null;
  const previousStep = stepping ? store.getNoticeState(provider, stepSurface) : null;

  if (eventName === "SessionStart") {
    const handoff = provider === "claude" && store.getConfig().compactionHandoffEnabled
      ? readCompactionHandoff(input, options.compactionHandoff)
      : null;
    store.setNoticeState(provider, noticeSurface, decision.state);
    if (stepping) store.setNoticeState(provider, stepSurface, stepSignature);
    return removeUndefined({
      systemMessage: decision.state === "safe" ? undefined : `${message}. ${decision.reason}`,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: [
          usageContext(decision),
          handoff
            ? `A recent Usage Guard compaction handoff from another local session follows. `
              + `Use it as continuity context; the user's newest request and current repository state override it.\n\n`
              + handoff.content
            : null,
        ].filter(Boolean).join("\n\n"),
      },
    });
  }

  if (eventName === "PostCompact") {
    if (provider !== "claude" || !store.getConfig().compactionHandoffEnabled) return {};
    const handoff = writeCompactionHandoff(input, options.compactionHandoff);
    if (!handoff) return {};
    return {
      systemMessage: `Usage Guard saved the compacted context handoff locally: ${handoff.path}`,
    };
  }

  if (eventName === "Stop") {
    store.setNoticeState(provider, noticeSurface, decision.state);
    const screenshotMemory = readScreenshotMemoryStatus();
    const screenshotMessage = screenshotMemory
      && screenshotMemory.updatedAt >= Date.now() - 10 * 60_000
      && screenshotMemory.lastRequestImagesReplaced > 0
      ? ` · Screenshot Memory summarized ${screenshotMemory.lastRequestImagesReplaced} old image(s)`
      : "";
    return {
      systemMessage: `${message}${screenshotMessage}`,
    };
  }

  if (eventName === "PreToolUse") {
    const toolSurface = `${noticeSurface}:tool-boundary`;
    const previousToolState = store.getNoticeState(provider, toolSurface);
    store.setNoticeState(provider, toolSurface, decision.state);
    if (decision.blocked) {
      const handover = stepping ? reserveHandover(store, decision, options) : "";
      const reason = `Usage Guard stopped this run at a tool boundary to protect your ${decision.provider} reserve. ${decision.reason}${handover}`;
      return {
        systemMessage: `${message}. ${decision.reason}`,
        hookSpecificOutput: {
          hookEventName: eventName,
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
        continue: false,
        stopReason: reason,
      };
    }
    if (stepping) {
      // A tool call may be in the middle of an edit. Tell the agent what to do
      // at the next task boundary; only UserPromptSubmit carries switch advice.
      if (previousStep?.state !== stepSignature) {
        const pendingSurface = `${stepSurface}:pending`;
        if (store.getNoticeState(provider, pendingSurface)?.state !== stepSignature) {
          store.setNoticeState(provider, pendingSurface, stepSignature);
          return {
            systemMessage: `${message}. Model recommendation changed; finish the current edit and its checks, then use the new recommendation at the next task boundary.`,
            hookSpecificOutput: {
              hookEventName: eventName,
              additionalContext: `At the next task boundary: ${usageContext(decision)}`,
            },
          };
        }
      }
      return {};
    }
    if (
      decision.state === "protect"
      && !["protect", "queue"].includes(previousToolState?.state)
    ) {
      const reason = `${message}. ${decision.reason} Approve this tool only if it belongs to the one active implementation path.`;
      return {
        systemMessage: reason,
        hookSpecificOutput: {
          hookEventName: eventName,
          permissionDecision: "ask",
          permissionDecisionReason: reason,
          additionalContext: usageContext(decision),
        },
      };
    }
    if (
      decision.state === "watch"
      && previousToolState?.state !== decision.state
    ) {
      return {
        systemMessage: `${message}. ${decision.reason}`,
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: usageContext(decision),
        },
      };
    }
    return {};
  }

  if (eventName === "PostToolBatch") {
    if (!decision.blocked) return {};
    const handover = stepping ? reserveHandover(store, decision, options) : "";
    const reason = `Usage Guard stopped this run before another model request to protect your ${decision.provider} reserve. ${decision.reason}${handover}`;
    return {
      systemMessage: `${message}. ${decision.reason}`,
      decision: "block",
      reason,
      continue: false,
      stopReason: reason,
    };
  }

  if (decision.blocked && eventName === "UserPromptSubmit") {
    store.setNoticeState(provider, noticeSurface, decision.state);
    const handover = stepping ? reserveHandover(store, decision, options) : "";
    const reason = `Usage Guard protected your ${decision.provider} reserve. ${decision.reason}${handover}`;
    return {
      systemMessage: `${message}. ${decision.reason}`,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: usageContext(decision),
      },
      decision: "block",
      reason,
      continue: false,
      stopReason: reason,
    };
  }

  if (eventName === "UserPromptSubmit" && stepping && previousStep?.state !== stepSignature) {
    store.setNoticeState(provider, noticeSurface, decision.state);
    store.setNoticeState(provider, stepSurface, stepSignature);
    return {
      systemMessage: `${message}. ${decision.modelReason}`,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: usageContext(decision),
      },
    };
  }

  if (
    eventName === "UserPromptSubmit"
    && ["watch", "protect"].includes(decision.state)
    && previous?.state !== decision.state
  ) {
    store.setNoticeState(provider, noticeSurface, decision.state);
    return {
      systemMessage: `${message}. ${decision.reason}`,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: usageContext(decision),
      },
    };
  }

  store.setNoticeState(provider, noticeSurface, decision.state);
  return {};
}

export function usageContext(decision) {
  if (decision.modelStepping === true) {
    return [
      `[Usage Guard: ${decision.state}]`,
      decision.instructions,
      "Use usage_guard_status for fresh quota, model recommendations, and the overnight summary.",
    ].join("\n");
  }
  const guidance = {
    safe: "Work normally and avoid obvious duplicate context.",
    watch: "Reuse existing evidence, compact at a safe boundary, and keep parallel work bounded.",
    protect: "Use one active implementation path while preserving strong reasoning and verification.",
    queue: "Do not start quota-heavy work until the protected reserve is available.",
    missing: "Do not make quota claims until the provider meter has been refreshed.",
    stale: "Do not make quota claims until the provider meter has been refreshed.",
  }[decision.state] || "Preserve quality and use quota deliberately.";

  return [
    `[Usage Guard: ${decision.state}]`,
    decision.qualityLocked === false
      ? "Model stepping is off: preserve the user's current model and reasoning effort."
      : "Quality lock is on: never lower the active model or reasoning effort.",
    guidance,
    "Use usage_guard_status for live percentages, pace, and reset data.",
  ].join("\n");
}

function recommendationSignature(decision) {
  return [
    decision.recommendedModel || "waiting",
    decision.recommendedEffort || "waiting",
    decision.routineModel || "waiting",
    decision.routineEffort || "waiting",
    decision.taskRole || "unknown",
  ].join("|");
}

function reserveHandover(store, decision, options) {
  try {
    const handover = writeQuotaHandover(store, decision, options.quotaHandover);
    return handover ? ` Quota-only handover saved at ${handover.path}.` : "";
  } catch {
    return " Quota-only handover could not be written; keep work paused and inspect the local state directory.";
  }
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
