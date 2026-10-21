// Panel for the Usage Guard tray. All data comes through the app's own Rust commands.
import { hermesText, staleText, paceText, statusPill, todayText, weeklyWindow, weekText } from "./format.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NAMES = { claude: "Claude", codex: "Codex", hermes: "Hermes" };

function bar(fraction, reserveFraction = 0, over = false) {
  const width = Math.min(100, Math.max(0, fraction * 100));
  return `<div class="bar"><div class="fill${over ? " over" : ""}" style="width:${width}%"></div>`
    + (reserveFraction ? `<div class="reserve" style="width:${reserveFraction * 100}%"></div>` : "") + "</div>";
}

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
// Say where today's starting figure came from when it is not a reading from just before the day began.
function baselineNote(d) {
  if (!d?.baselineAt) return null;
  if (d.baselineEstimated) return `No reading from before ${clock(d.dayStartAt)}, so today counts from ${clock(d.baselineAt)}.`;
  if (d.dayStartAt - d.baselineAt > 2 * 60 * 60_000) {
    const day = new Date(d.baselineAt).toDateString() === new Date(d.dayStartAt).toDateString() ? "" : " yesterday";
    return `The last reading before ${clock(d.dayStartAt)} was at ${clock(d.baselineAt)}${day}; usage since then counts as today.`;
  }
  return null;
}

const pill = ({ tone, text }) => `<span class="stamp ${tone}">${esc(text)}</span>`;
const metric = (label, barHtml, figure, detail) =>
  `<div class="metric"><div class="row"><span>${label}</span>${barHtml}<span>${esc(figure)}</span></div><p class="detail">${esc(detail)}</p></div>`;

function laneHtml(provider, paused) {
  const d = provider.daily;
  const weekly = weeklyWindow(provider);
  const today = todayText(d);
  const week = weekText(weekly);
  const notes = [staleText(provider), baselineNote(d), provider.state === "queue" ? provider.reason : paceText(provider)].filter(Boolean).join(" ");
  return `<article class="lane lane-${esc(provider.provider)}"><div class="lane-head"><span class="lane-name"><i class="lane-dot"></i>${NAMES[provider.provider]}</span>${pill(statusPill(provider, { paused }))}</div>`
    + metric("today", bar(d && d.todayBudgetPercent ? d.usedTodayPercent / d.todayBudgetPercent : 0, 0, d?.spent), today.figure, today.detail)
    + (week ? metric("week", bar(weekly.usedPercent / 100, (weekly.reservePercent ?? 0) / 100), week.figure, week.detail) : "")
    + (notes ? `<p class="note">${esc(notes)}</p>` : "") + "</article>";
}

function payAsYouGoHtml(lane) {
  if (!lane) return "";
  const text = hermesText(lane);
  const spent = lane.spentTodayUsd ?? 0;
  return `<article class="lane lane-hermes"><div class="lane-head"><span class="lane-name"><i class="lane-dot"></i>Hermes (OpenRouter)</span>${pill({ tone: text.tone, text: text.pill })}</div>`
    + metric("today", bar(lane.dailyCapUsd ? spent / lane.dailyCapUsd : 0, 0, !lane.available && lane.spentTodayUsd != null), text.figure, text.detail)
    + "</article>";
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
    $("lanes").innerHTML = status.providers.map((p) => laneHtml(p, Boolean(status.config.routingPaused))).join("") + payAsYouGoHtml(lanes.hermes);
    $("hermes-model").textContent = status.config.hermesModel;
    if (document.activeElement !== $("cap")) $("cap").value = status.config.payAsYouGoDailyCapUsd;
    $("route-lane").textContent = route.lane === "off" ? "Your own rules (Usage Guard is off)" : route.lane === "wait" ? "Wait for the next share" : `${NAMES[route.lane] || route.lane}${route.model ? ` · ${route.model}` : ""}${route.ladder && route.ladder !== "standard" && route.model ? ` (your ${route.ladder === "custom" ? "custom ladder" : `${route.ladder} preset`})` : ""}`;
    $("route-reason").textContent = route.reason;
    $("pause").checked = Boolean(status.config.routingPaused);
    if (document.activeElement !== $("preset")) $("preset").value = status.config.planPreset || "standard";
    $("ladders").textContent = Object.entries(status.config.modelLadders || {})
      .map(([lane, rungs]) => `${NAMES[lane]}: ${rungs.map((r) => `${r.model} ${r.effort}`).join(" → ")}`).join(" · ");
    const on = status.config.enabled !== false;
    $("enabled").checked = on;
    $("enabled-label").textContent = on ? "on · guarding" : "off";
    $("off").hidden = on;
    document.body.classList.toggle("is-off", !on);
    $("decisions").innerHTML = status.recentDecisions.slice(0, 6).map((d) =>
      `<li><span class="when">${new Date(d.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${esc(d.provider)} · ${esc(d.action)}</span>${esc(d.reason)}</li>`).join("");
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
$("preset").addEventListener("change", async (event) => {
  try { await invoke("set_config", { patch: { planPreset: event.target.value } }); } catch (error) { $("error").textContent = String(error); $("error").hidden = false; }
  refresh();
});
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
