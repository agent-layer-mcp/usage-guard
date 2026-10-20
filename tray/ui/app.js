// Panel for the Usage Guard tray. All data comes through the app's own Rust commands.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NAMES = { claude: "Claude", codex: "Codex", deepseek: "DeepSeek" };
const pct = (value) => `${Number(value).toFixed(1)}%`;

function countdown(at) {
  if (!at) return "reset unknown";
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function bar(fraction, reserveFraction = 0, over = false) {
  const width = Math.min(100, Math.max(0, fraction * 100));
  return `<div class="bar"><div class="fill${over ? " over" : ""}" style="width:${width}%"></div>`
    + (reserveFraction ? `<div class="reserve" style="width:${reserveFraction * 100}%"></div>` : "") + "</div>";
}

function laneHtml(provider, routeLane) {
  const d = provider.daily;
  const weekly = provider.windows.find((w) => w.windowMinutes > 360);
  const today = d
    ? `<div class="row"><span>today</span>${bar(d.todayBudgetPercent ? d.usedTodayPercent / d.todayBudgetPercent : 1, 0, d.spent)}<span>${pct(d.usedTodayPercent)} / ${pct(d.todayBudgetPercent)}</span></div>`
    : `<div class="row"><span>today</span>${bar(0)}<span>no share yet</span></div>`;
  const week = weekly
    ? `<div class="row"><span>week</span>${bar(weekly.usedPercent / 100, weekly.reservePercent / 100)}<span>${Math.round(weekly.usedPercent)}%</span></div>`
    : "";
  const notes = [
    weekly ? `Resets in ${countdown(weekly.resetsAt)}` : null,
    d?.borrowedPercent > 0 ? `${pct(d.borrowedPercent)} borrowed from later days` : null,
    routeLane?.reason,
  ].filter(Boolean).join(" · ");
  return `<article class="lane"><div class="lane-head"><span>${NAMES[provider.provider]}</span><span class="state ${esc(provider.state)}">${esc(provider.state)}</span></div>${today}${week}<p class="note">${esc(notes)}</p></article>`;
}

function payAsYouGoHtml(lane) {
  if (!lane) return "";
  const spent = lane.spentTodayUsd;
  const row = spent == null
    ? `<div class="row"><span>today</span>${bar(0)}<span>—</span></div>`
    : `<div class="row"><span>today</span>${bar(spent / lane.dailyCapUsd, 0, spent >= lane.dailyCapUsd)}<span>$${spent.toFixed(2)} / $${lane.dailyCapUsd}</span></div>`;
  return `<article class="lane"><div class="lane-head"><span>DeepSeek</span><span class="state ${lane.available ? "safe" : "stale"}">${lane.available ? "open" : "closed"}</span></div>${row}<p class="note">${esc(lane.reason)}</p></article>`;
}

function trayLabel(status, route) {
  const parts = status.providers.map((p) => {
    const d = p.daily;
    const share = d && d.todayBudgetPercent > 0 ? `${Math.round((d.usedTodayPercent / d.todayBudgetPercent) * 100)}%` : "–";
    return `${NAMES[p.provider][0]} ${share}`;
  });
  const deepseek = route.lanes.find((l) => l.lane === "deepseek");
  if (deepseek?.spentTodayUsd != null) parts.push(`D $${deepseek.spentTodayUsd.toFixed(2)}`);
  return (route.paused ? "⏸ " : "") + parts.join(" · ");
}

async function refresh() {
  try {
    const [status, route] = await Promise.all([
      invoke("guard_status").then(JSON.parse),
      invoke("guard_route", { kind: "code" }).then(JSON.parse),
    ]);
    $("error").hidden = true;
    const lanes = Object.fromEntries(route.lanes.map((lane) => [lane.lane, lane]));
    $("lanes").innerHTML = status.providers.map((p) => laneHtml(p, lanes[p.provider])).join("") + payAsYouGoHtml(lanes.deepseek);
    $("route-lane").textContent = route.lane === "wait" ? "Wait" : `${NAMES[route.lane] || route.lane}${route.model ? ` · ${route.model}` : ""}`;
    $("route-reason").textContent = route.reason;
    $("pause").checked = Boolean(status.config.routingPaused);
    const on = status.config.enabled !== false;
    $("enabled").checked = on;
    $("enabled-label").textContent = on ? "On" : "Off";
    $("off").hidden = on;
    document.body.classList.toggle("is-off", !on);
    $("decisions").innerHTML = status.recentDecisions.slice(0, 6).map((d) =>
      `<li><span>${new Date(d.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${esc(d.provider)}</span> ${esc(d.action)}<br>${esc(d.reason)}</li>`).join("");
    invoke("set_tray_label", { label: on ? trayLabel(status, route) : "UG off" });
  } catch (error) {
    $("error").textContent = String(error);
    $("error").hidden = false;
    invoke("set_tray_label", { label: "UG offline" });
  }
}

$("enabled").addEventListener("change", async (event) => {
  try { await invoke("set_enabled", { enabled: event.target.checked }); } catch (error) { $("error").textContent = String(error); $("error").hidden = false; }
  refresh();
});
$("pause").addEventListener("change", async (event) => {
  try { await invoke("set_paused", { paused: event.target.checked }); } catch (error) { $("error").textContent = String(error); $("error").hidden = false; }
  refresh();
});
$("banked").addEventListener("click", () => {
  if (window.confirm("Open Codex's usage page? Spending the banked reset there is your choice; Usage Guard never does it.")) invoke("open_codex_usage");
});

refresh();
setInterval(refresh, 30_000);
