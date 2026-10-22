// Tray host for the shared panel (panel.js). All data comes through the app's own Rust commands.
import { mountPanel, shellHtml } from "./panel.js";
import { NAMES } from "./render.js";

const { invoke } = window.__TAURI__.core;
const call = async (command, args) => JSON.parse(await invoke(command, args));

function trayLabel(status, route) {
  const parts = status.providers.map((p) => {
    const d = p.daily;
    const share = d && d.todayBudgetPercent > 0 ? `${Math.round((d.usedTodayPercent / d.todayBudgetPercent) * 100)}%` : "–";
    return `${NAMES[p.provider][0]} ${share}`;
  });
  const hermes = route.lanes.find((l) => l.lane === "hermes");
  if (hermes?.spentTodayUsd != null) parts.push(`H $${hermes.spentTodayUsd.toFixed(2)}`);
  return (route.paused ? "⏸ " : "") + parts.join(" · ");
}

document.getElementById("app").innerHTML = shellHtml();
mountPanel({
  api: {
    status: () => call("guard_status"),
    route: () => call("guard_route", { kind: "code" }),
    models: (refresh) => call("guard_models", { refresh }),
    setConfig: (patch) => invoke("set_config", { patch }),
    setEnabled: (enabled) => invoke("set_enabled", { enabled }),
    openCodexUsage: () => invoke("open_codex_usage"),
  },
  storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  onData: (status, route, on, error) => {
    invoke("set_tray_label", { label: error ? "UG offline" : on ? trayLabel(status, route) : "UG off" });
  },
});
