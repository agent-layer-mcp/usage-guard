import { formatStatusLine } from "./presentation.mjs";
import { readScreenshotMemoryStatus } from "./screenshot-proxy.mjs";
import { providerDecision, syncClaudeDesktop, syncCodex } from "./service.mjs";

export async function runProviderHook(store, provider, input, options = {}) {
  const eventName = input.hook_event_name || input.hookEventName || options.eventName || "UserPromptSubmit";
  const prompt = input.prompt || input.user_prompt || input.userPrompt || "";
  const sessionId = input.session_id || input.sessionId || null;

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

  const decision = providerDecision(store, provider, { prompt, sessionId });
  const message = formatStatusLine(decision, { color: false });
  const noticeSurface = `session:${sessionId || "provider"}`;
  const previous = store.getNoticeState(provider, noticeSurface);
  store.setNoticeState(provider, noticeSurface, decision.state);

  if (eventName === "SessionStart") {
    return removeUndefined({
      systemMessage: decision.state === "safe" ? undefined : `${message}. ${decision.reason}`,
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: usageContext(decision),
      },
    });
  }

  if (eventName === "Stop") {
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
    if (decision.blocked) {
      const reason = `Usage Guard stopped this run at a tool boundary to protect your ${decision.provider} reserve. ${decision.reason}`;
      return {
        systemMessage: `${message}. ${decision.reason}`,
        continue: false,
        stopReason: reason,
      };
    }
    if (
      ["watch", "protect"].includes(decision.state)
      && previous?.state !== decision.state
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

  if (decision.blocked && eventName === "UserPromptSubmit") {
    const reason = `Usage Guard protected your ${decision.provider} reserve. ${decision.reason}`;
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

  if (
    eventName === "UserPromptSubmit"
    && ["watch", "protect"].includes(decision.state)
    && previous?.state !== decision.state
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

export function usageContext(decision) {
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
    "Quality lock is on: never lower the active model or reasoning effort.",
    guidance,
    "Use usage_guard_status for live percentages, pace, and reset data.",
  ].join("\n");
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
