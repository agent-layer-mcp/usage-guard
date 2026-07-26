import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { guardHome } from "./config.mjs";
import { formatStatusLine } from "./presentation.mjs";
import { providerDecision, syncClaudeDesktop, syncCodex } from "./service.mjs";

const STATE_ORDER = Object.freeze({
  missing: -1,
  stale: 0,
  safe: 1,
  watch: 2,
  protect: 3,
  queue: 4,
});

export async function runMonitorCycle(store, options = {}) {
  const providers = options.providers || ["claude"];
  const notifier = options.notifier || notifyMacOS;
  const results = [];

  for (const provider of providers) {
    try {
      if (provider === "claude") syncClaudeDesktop(store, options.claudeDesktop);
      else if (provider === "codex") await syncCodex(store, options.codex);
    } catch {
      // Missing or changed provider signals remain visible as stale/missing state.
    }

    const decision = providerDecision(store, provider, { now: options.now });
    const previous = store.getAlertState(provider);
    const controlling = controllingWindow(decision);
    const shouldNotify = isAlertState(decision.state)
      && (!previous || STATE_ORDER[decision.state] > STATE_ORDER[previous.state]);

    if (shouldNotify) {
      notifier({
        title: "Usage Guard",
        subtitle: `${providerName(provider)}: ${decision.state.toUpperCase()}`,
        message: `${formatStatusLine(decision, { color: false })}. ${decision.reason}`,
        state: decision.state,
      });
    }

    store.setAlertState(provider, decision.state, {
      windowKey: controlling?.key,
      observedAt: controlling?.observedAt,
      updatedAt: options.now ?? Date.now(),
    });
    results.push({ provider, decision, notified: shouldNotify });
  }

  return results;
}

export function notifyMacOS(notification, options = {}) {
  if ((options.platform || process.platform) !== "darwin") return false;
  const run = options.commandRunner || execFileSync;
  const nativeNotifier = Object.hasOwn(options, "nativeNotifierPath")
    ? options.nativeNotifierPath
    : findNativeNotifier(options);
  if (nativeNotifier) {
    const args = [
      "--title", notification.title,
      "--subtitle", notification.subtitle,
      "--message", notification.message,
      "--identifier", `sh.agentlayer.usage-guard.${notification.state}`,
    ];
    if (["protect", "queue"].includes(notification.state)) args.push("--sound");
    run(nativeNotifier, args, {
      encoding: "utf8",
      stdio: "ignore",
    });
    return true;
  }

  const terminalNotifier = Object.hasOwn(options, "terminalNotifierPath")
    ? options.terminalNotifierPath
    : findTerminalNotifier();
  if (terminalNotifier) {
    const args = [
      "-title", notification.title,
      "-subtitle", notification.subtitle,
      "-message", notification.message,
      "-group", "sh.agentlayer.usage-guard",
    ];
    if (["protect", "queue"].includes(notification.state)) {
      args.push("-sound", "Glass");
    }
    run(terminalNotifier, args, {
      encoding: "utf8",
      stdio: "ignore",
    });
    return true;
  }

  const script = [
    `display notification "${escapeAppleScript(notification.message)}"`,
    `with title "${escapeAppleScript(notification.title)}"`,
    `subtitle "${escapeAppleScript(notification.subtitle)}"`,
    ...(["protect", "queue"].includes(notification.state) ? ['sound name "Glass"'] : []),
  ].join(" ");
  run("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
    stdio: "ignore",
  });
  return true;
}

export function findNativeNotifier(options = {}) {
  const exists = options.exists || existsSync;
  const stateHome = options.stateHome || guardHome(options.env);
  const executable = path.join(
    stateHome,
    "Usage Guard.app",
    "Contents",
    "MacOS",
    "UsageGuardNotifier",
  );
  return exists(executable) ? executable : null;
}

export function findTerminalNotifier(options = {}) {
  const exists = options.exists || existsSync;
  return [
    "/opt/homebrew/bin/terminal-notifier",
    "/usr/local/bin/terminal-notifier",
  ].find((candidate) => exists(candidate)) || null;
}

function controllingWindow(decision) {
  return [...(decision.windows || [])]
    .sort((a, b) => STATE_ORDER[b.state] - STATE_ORDER[a.state])[0] || null;
}

function isAlertState(state) {
  return ["watch", "protect", "queue"].includes(state);
}

function providerName(provider) {
  return provider === "claude" ? "Claude" : "Codex";
}

function escapeAppleScript(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
