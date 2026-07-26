import { formatStatusLine } from "./presentation.mjs";
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
  if (eventName === "PreToolUse") {
    const noticeSurface = `tool:${sessionId || "provider"}`;
    const previous = store.getNoticeState(provider, noticeSurface);
    store.setNoticeState(provider, noticeSurface, decision.state);
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
  const output = {
    systemMessage: decision.state === "safe" ? undefined : `${message}. ${decision.reason}`,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: usageContext(decision),
    },
  };

  if (decision.blocked && eventName === "UserPromptSubmit") {
    output.decision = "block";
    output.reason = `Usage Guard protected your ${decision.provider} reserve. ${decision.reason}`;
    output.continue = false;
    output.stopReason = output.reason;
  }
  return removeUndefined(output);
}

export function usageContext(decision) {
  return [
    `[Usage Guard: ${decision.state}]`,
    decision.instructions,
    `Deliberate choice: ${decision.action}.`,
    `Reason: ${decision.reason}`,
    "Do not claim Usage Guard changed the model; it never does so silently.",
  ].join("\n");
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
