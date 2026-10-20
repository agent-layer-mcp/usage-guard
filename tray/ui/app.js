// Panel for the Usage Guard tray. All data comes through the app's own Rust commands.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NAMES = { claude: "Claude", codex: "Codex", hermes: "Hermes" };
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
    ? `<div class="row"><span>today</span>${bar(d.todayBudgetPercent ? d.usedTodayPercent / d.todayBudgetPercent : 1, 0, d.spent)}<span>${pct(d.usedTodayPercent)} of ${pct(d.todayBudgetPercent)}</span></div>`
    : `<div class="row"><span>today</span>${bar(0)}<span>no share yet</span></div>`;
  const week = weekly
    ? `<div class="row"><span>week</span>${bar(weekly.usedPercent / 100, weekly.reservePercent / 100)}<span>${Math.round(weekly.usedPercent)}% used</span></div>`
    : "";
  const shareUsed = d && d.todayBudgetPercent > 0 ? Math.round((d.usedTodayPercent / d.todayBudgetPercent) * 100) : null;
  const notes = [
    shareUsed != null ? `${shareUsed}% of today's ${pct(d.todayBudgetPercent)} share used.` : null,
    weekly ? `Week resets in ${countdown(weekly.resetsAt)}.` : null,
    d?.borrowedPercent > 0 ? `${pct(d.borrowedPercent)} borrowed from later days.` : null,
    routeLane?.reason,
  ].filter(Boolean).join(" ");
  return `<article class="lane"><div class="lane-head"><span>${NAMES[provider.provider]}</span><span class="state ${esc(provider.state)}">${esc(provider.state)}</span></div>${today}${week}<p class="note">${esc(notes)}</p></article>`;
}

function payAsYouGoHtml(lane) {
  if (!lane) return "";
  const spent = lane.spentTodayUsd;
  const row = spent == null
    ? `<div class="row"><span>today</span>${bar(0)}<span>—</span></div>`
    : `<div class="row"><span>today</span>${bar(spent / lane.dailyCapUsd, 0, spent >= lane.dailyCapUsd)}<span>$${spent.toFixed(2)} / $${lane.dailyCapUsd}</span></div>`;
  return `<article class="lane"><div class="lane-head"><span>Hermes (OpenRouter)</span><span class="state ${lane.available ? "safe" : "stale"}">${lane.available ? "open" : "closed"}</span></div>${row}<p class="note">${esc(lane.reason)}</p></article>`;
}

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

async function refresh() {
  try {
    const [status, route] = await Promise.all([
      invoke("guard_status").then(JSON.parse),
      invoke("guard_route", { kind: "code" }).then(JSON.parse),
    ]);
    $("error").hidden = true;
    const lanes = Object.fromEntries(route.lanes.map((lane) => [lane.lane, lane]));
    $("lanes").innerHTML = status.providers.map((p) => laneHtml(p, lanes[p.provider])).join("") + payAsYouGoHtml(lanes.hermes);
    $("hermes-model").textContent = status.config.hermesModel;
    if (document.activeElement !== $("cap")) $("cap").value = status.config.payAsYouGoDailyCapUsd;
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
let models = [];
const money = (value) => (value == null ? "?" : `$${value}`);
function renderModels() {
  const query = $("model-search").value.trim().toLowerCase();
  const shown = models.filter((m) => !query || m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query)).slice(0, 200);
  $("model-list").innerHTML = shown.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${money(m.inputPerMillionUsd)} / ${money(m.outputPerMillionUsd)} per M · ${m.contextLength ? Math.round(m.contextLength / 1000) + "k" : "?"} context</option>`).join("");
}
async function loadModels(refresh = false) {
  try {
    const list = JSON.parse(await invoke("guard_models", { refresh }));
    models = list.models;
    renderModels();
    if (list.stale) $("model-hint").dataset.stale = "1";
  } catch (error) { $("error").textContent = String(error); $("error").hidden = false; }
}
$("model-search").addEventListener("input", renderModels);
$("model-refresh").addEventListener("click", () => loadModels(true));
$("model-use").addEventListener("click", async () => {
  const id = $("model-list").value;
  if (!id) return;
  try { await invoke("set_config", { patch: { hermesModel: id } }); } catch (error) { $("error").textContent = String(error); $("error").hidden = false; }
  refresh();
});
$("model-list").addEventListener("dblclick", () => $("model-use").click());
$("cap-save").addEventListener("click", async () => {
  const value = Number($("cap").value);
  if (!Number.isFinite(value) || value < 0) return;
  try { await invoke("set_config", { patch: { payAsYouGoDailyCapUsd: value } }); } catch (error) { $("error").textContent = String(error); $("error").hidden = false; }
  refresh();
});
loadModels();

$("pause").addEventListener("change", async (event) => {
  try { await invoke("set_config", { patch: { routingPaused: event.target.checked } }); } catch (error) { $("error").textContent = String(error); $("error").hidden = false; }
  refresh();
});
$("banked").addEventListener("click", () => {
  if (window.confirm("Open Codex's usage page? Spending the banked reset there is your choice; Usage Guard never does it.")) invoke("open_codex_usage");
});

refresh();
setInterval(refresh, 30_000);
