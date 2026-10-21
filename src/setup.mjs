// Guided setup: `usage-guard setup`. Runs on the user's own machine, lets them pick
// any mix of Claude, Codex and Hermes, and leaves a background check that reads
// usage every 10 minutes. All side effects come in through `deps`, so tests stay offline.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SETUP_INTERVAL_MINUTES = 10;
export const TOOLS = Object.freeze(["claude", "codex", "hermes"]);
const NAMES = { claude: "Claude", codex: "Codex", hermes: "Hermes (OpenRouter)" };

// Known cloud-session markers. Codex cloud has no documented marker; it runs in a container
// with no desktop, which detectCloud asks about. shortcut: add markers as they are confirmed.
const CLOUD_MARKERS = [
  ["CLAUDE_CODE_REMOTE", "Claude Code on the web"],
  ["CODESPACES", "GitHub Codespaces"],
  ["GITPOD_WORKSPACE_ID", "Gitpod"],
  ["CLOUD_SHELL", "a cloud shell"],
];

// { cloud: name } for a known cloud session, { unsure: true } for a container with
// no desktop (worth asking), or {} for what looks like the user's own machine.
export function detectCloud({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  for (const [key, name] of CLOUD_MARKERS) {
    if (env[key] && env[key] !== "false" && env[key] !== "0") return { cloud: name };
  }
  const desktop = platform !== "linux" || env.DISPLAY || env.WAYLAND_DISPLAY;
  if (!desktop && (exists("/.dockerenv") || exists("/run/.containerenv"))) return { unsure: true };
  return {};
}

// Tools that look installed here, so they start ticked.
export function detectTools({ which, homeDir, exists = existsSync, env = process.env }) {
  return TOOLS.filter((tool) => {
    if (tool === "hermes") return Boolean(env.OPENROUTER_API_KEY || which("hermes"));
    return Boolean(which(tool) || exists(path.join(homeDir, `.${tool}`)));
  });
}

export function writeOpenRouterKey(stateHome, key) {
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const file = path.join(stateHome, "openrouter.env");
  writeFileSync(file, `OPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
  return file;
}

const LOCAL_COMMAND = "npx @agent-layer/usage-guard setup";

export async function runSetup(deps) {
  const { ui, options = {} } = deps;
  const unknown = (options.tools || []).filter((tool) => !TOOLS.includes(tool));
  if (unknown.length || options.tools?.length === 0) throw new TypeError(`--tools takes any of: ${TOOLS.join(", ")}.`);
  const ask = async (prompt) => {
    const answer = await prompt;
    if (ui.isCancel(answer)) throw new SetupCancelled();
    return answer;
  };
  ui.intro("Usage Guard setup");

  // 1. Own machine only: usage is read from the tools' local logins.
  const where = detectCloud(deps);
  const ownMachine = where.cloud ? false
    : where.unsure && !options.yes
      ? await ask(ui.confirm({ message: "This looks like a container. Is it your own computer?", initialValue: false }))
      : true;
  if (!ownMachine) {
    ui.note([
      `${where.cloud ? `This is ${where.cloud}.` : "This isn't your own computer."} Usage Guard reads usage from the`,
      "logins on your own machine, so it has to be installed there.",
      "",
      "On your computer, run:",
      `  ${LOCAL_COMMAND}`,
      "",
      "Once it's there, it tracks your cloud sessions too: they use the same accounts.",
    ].join("\n"), "Run this on your own machine");
    ui.outro("Nothing was changed here.");
    return { status: "cloud", where };
  }

  // 2. Which tools to track.
  const found = detectTools(deps);
  const tools = options.tools || await ask(ui.multiselect({
    message: "Which tools should Usage Guard track?",
    options: TOOLS.map((tool) => ({
      value: tool, label: NAMES[tool], hint: found.includes(tool) ? "found on this machine" : undefined,
    })),
    initialValues: found.length ? found : ["claude"],
    required: true,
  }));

  // 3. Per-tool checks and consent.
  const notes = [];
  if (tools.includes("claude")) {
    const allowed = options.yes || await ask(ui.confirm({
      message: "Read Claude usage with your Claude Code login? It is read at each check, sent only to api.anthropic.com, and never stored.",
      initialValue: true,
    }));
    if (!allowed) notes.push("Claude: reads usage only when a session reports it (login not used).");
    else if (!deps.claudeLoginFound()) {
      ui.log.warn("No Claude Code login found. Run `claude` in a terminal and sign in with /login; Usage Guard picks it up on the next check.");
    }
  }
  let hermesKeyFile = null;
  if (tools.includes("hermes")) {
    const existing = deps.env?.OPENROUTER_API_KEY || deps.openRouterKeySaved();
    if (!existing) {
      const key = options.openRouterKey || await ask(ui.password({
        message: "OpenRouter API key (saved only on this machine, readable only by you)",
        validate: (value) => (/^sk-or-[\w-]{10,}$/.test(value || "") ? undefined : "That doesn't look like an OpenRouter key (sk-or-…)."),
      }));
      const check = await deps.readOpenRouterSpend({ env: { OPENROUTER_API_KEY: key } });
      if (check.error || check.spentTodayUsd == null) throw new Error(`OpenRouter didn't accept that key: ${check.error || "no spend returned"}`);
      hermesKeyFile = deps.writeOpenRouterKey(key);
    }
  }
  const subscriptions = tools.filter((tool) => tool !== "hermes");
  const integrate = subscriptions.length > 0 && (options.yes || await ask(ui.confirm({
    message: `Also show Usage Guard inside ${subscriptions.map((tool) => NAMES[tool]).join(" and ")} (status line, hooks and plugin)?`,
    initialValue: true,
  })));

  // 4. Install: config, integrations and the 10-minute background check.
  const spin = ui.spinner();
  spin.start("Setting up the background check");
  // Readings arrive every 10 minutes, so allow one missed check before a lane counts as stale.
  deps.store.setConfig({ trackedProviders: tools, staleAfterMinutes: SETUP_INTERVAL_MINUTES * 2 + 5 });
  const record = deps.install({
    integrations: integrate,
    claude: tools.includes("claude"),
    codex: tools.includes("codex"),
    monitorIntervalMinutes: SETUP_INTERVAL_MINUTES,
  });
  spin.stop(record.monitor?.enabled
    ? `Background check runs every ${SETUP_INTERVAL_MINUTES} minutes`
    : "No background check on this system: readings come only from sessions");

  // 5. First reading, so the user sees it work.
  spin.start("Taking a first reading");
  const readings = [];
  for (const tool of tools) readings.push(`${NAMES[tool]}: ${await firstReading(tool, deps)}`);
  spin.stop("First reading done");
  ui.note([...readings, ...notes, ...(hermesKeyFile ? [`OpenRouter key saved to ${hermesKeyFile}`] : [])].join("\n"), "Usage now");
  ui.outro("All set. Usage Guard checks quietly in the background. `usage-guard status` shows it any time.");
  return { status: "installed", tools, integrate, record };
}

async function firstReading(tool, deps) {
  try {
    if (tool === "hermes") {
      const spend = await deps.readOpenRouterSpend({});
      return spend.spentTodayUsd == null ? `not read (${spend.error || "no key"})` : `$${spend.spentTodayUsd.toFixed(2)} spent today`;
    }
    const snapshot = tool === "claude" ? await deps.syncClaude() : await deps.syncCodex();
    if (!snapshot?.windows?.length) return "no reading yet (it will try again at the next check)";
    return snapshot.windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(", ");
  } catch (error) {
    return `no reading yet (${error.message})`;
  }
}

export class SetupCancelled extends Error {
  constructor() { super("Setup cancelled; nothing more was changed."); }
}
