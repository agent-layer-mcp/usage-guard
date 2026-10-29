// HTML pieces shared by the tray panel and the dashboard. Pure string builders, so they can be tested without a DOM.
import { hermesText, paceText, staleText, statusPill, todayText, weeklyWindow, weekText } from "./format.js";

export const NAMES = { claude: "Claude", codex: "Codex", hermes: "Hermes" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function bar(fraction, reserveFraction = 0, over = false) {
  const width = Math.min(100, Math.max(0, fraction * 100));
  return `<div class="bar"><div class="fill${over ? " over" : ""}" style="width:${width}%"></div>`
    + (reserveFraction ? `<div class="reserve" style="width:${reserveFraction * 100}%"></div>` : "") + "</div>";
}

// Say where today's starting figure came from when it is not a reading from just before the day began.
export function baselineNote(d) {
  if (!d?.baselineAt) return null;
  if (d.baselineEstimated) return `No reading from before ${clock(d.dayStartAt)}, so today counts from ${clock(d.baselineAt)}.`;
  if (d.dayStartAt - d.baselineAt > 2 * 60 * 60_000) {
    const day = new Date(d.baselineAt).toDateString() === new Date(d.dayStartAt).toDateString() ? "" : " yesterday";
    return `The last reading before ${clock(d.dayStartAt)} was at ${clock(d.baselineAt)}${day}; usage since then counts as today.`;
  }
  return null;
}

export const pill = ({ tone, text }) => `<span class="stamp ${tone}">${esc(text)}</span>`;
const metric = (label, barHtml, figure) =>
  `<div class="metric"><span class="m-label" title="${esc(label)}">${esc(label)}</span>${barHtml}<span class="m-figure">${esc(figure)}</span></div>`;
const detail = (label, text) => `<p class="detail"><b>${label}</b>${esc(text)}</p>`;

const laneShell = (id, name, stamp, body, more, open) =>
  `<article class="lane lane-${esc(id)}" data-lane="${esc(id)}"><header class="lane-head"><span class="lane-name"><i class="lane-dot"></i>${name}</span>${stamp}</header>${body}`
  + (more ? `<details class="more" data-lane="${esc(id)}"${open ? " open" : ""}><summary>details</summary>${more}</details>` : "") + "</article>";

// Extra rows the wide dashboard keeps from its earlier layout: other windows, session context and the guard's current choice.
function extrasHtml(provider) {
  const others = (provider.windows || []).filter((w) => w !== weeklyWindow(provider))
    .map((w) => metric(w.label, bar(w.usedPercent / 100, (w.reservePercent ?? 0) / 100), `${Math.round(w.usedPercent)}%`)).join("");
  const context = provider.context ? metric("context", bar(provider.context.contextPercent / 100), `${Math.round(provider.context.contextPercent)}% · ${provider.contextState}`) : "";
  const choice = provider.action ? `<p class="choice"><span class="eyebrow">deliberate choice</span><strong>${esc(provider.action)}</strong>${esc(provider.reason)}</p>` : "";
  return { rows: others + context, choice };
}

export function laneHtml(provider, { paused = false, wide = false, open = wide } = {}) {
  const d = provider.daily;
  const weekly = weeklyWindow(provider);
  const today = todayText(d, { stale: provider.stale });
  const week = weekText(weekly);
  const notes = [staleText(provider), baselineNote(d), provider.state === "queue" ? provider.reason : paceText(provider)].filter(Boolean).join(" ");
  const extras = wide ? extrasHtml(provider) : { rows: "", choice: "" };
  const body = metric("today", bar(d && d.todayBudgetPercent ? d.usedTodayPercent / d.todayBudgetPercent : 0, 0, d?.spent), today.figure)
    + (week ? metric("week", bar(weekly.usedPercent / 100, (weekly.reservePercent ?? 0) / 100), week.figure) : "")
    + extras.rows + extras.choice;
  const more = detail("today", today.detail) + (week ? detail("week", week.detail) : "") + (notes ? `<p class="note">${esc(notes)}</p>` : "");
  return laneShell(provider.provider, NAMES[provider.provider], pill(statusPill(provider, { paused })), body, more, open);
}

export function payAsYouGoHtml(lane, { open = false } = {}) {
  if (!lane) return "";
  const text = hermesText(lane);
  const spent = lane.spentTodayUsd ?? 0;
  return laneShell("hermes", "Hermes (OpenRouter)", pill({ tone: text.tone, text: text.pill }),
    metric("today", bar(lane.dailyCapUsd ? spent / lane.dailyCapUsd : 0, 0, !lane.available && lane.spentTodayUsd != null), text.figure),
    detail("today", text.detail), open);
}

export function routeTitle(route) {
  if (route.lane === "off") return "Your own rules (Usage Guard is off)";
  if (route.lane === "wait") return "Wait for the next share";
  const model = route.model ? ` · ${route.model}` : "";
  const preset = route.ladder && route.ladder !== "standard" && route.model ? ` (your ${route.ladder === "custom" ? "custom ladder" : `${route.ladder} preset`})` : "";
  return `${NAMES[route.lane] || route.lane}${model}${preset}`;
}

export const ladderHtml = (ladders = {}) => Object.entries(ladders).map(([lane, rungs]) =>
  `<div class="ladder lane-${esc(lane)}"><span class="lane-name"><i class="lane-dot"></i>${esc(NAMES[lane] || lane)}</span><ol class="rungs">${rungs.map((r) => `<li>${esc(r.model)} <small>${esc(r.effort)}</small></li>`).join("")}</ol></div>`).join("");

// Success rate per model and task type; only checked results count.
export function outcomeRatesHtml(rows = []) {
  const checked = rows.filter((row) => row.rate != null).sort((a, b) => a.rate - b.rate);
  if (!checked.length) return `<li class="empty">No checked results yet.</li>`;
  return checked.map((row) =>
    `<li><span class="who lane-${esc(row.lane)}"><i class="lane-dot"></i>${esc(row.model)}</span><span class="act">${esc(row.kind)} · ${esc(row.difficulty)}</span><span class="why">${Math.round(row.rate * 100)}% pass of ${row.total}</span></li>`).join("");
}

// Back-to-back identical decisions collapse into one line with a count, so repeats don't crowd out the rest.
export function decisionsHtml(decisions = [], limit = 6) {
  const runs = [];
  for (const d of decisions) {
    const last = runs.at(-1);
    if (last && last.provider === d.provider && last.action === d.action && last.reason === d.reason) last.count += 1;
    else runs.push({ ...d, count: 1 });
  }
  return runs.slice(0, limit).map((d) =>
    `<li><span class="when">${clock(d.createdAt)}</span><span class="who lane-${esc(d.provider)}"><i class="lane-dot"></i>${esc(d.provider)}</span><span class="act">${esc(d.action)}${d.count > 1 ? ` <small>×${d.count}</small>` : ""}</span><span class="why">${esc(d.reason)}</span></li>`).join("");
}

const money = (value) => (value == null ? "?" : `$${value}`);
export const modelOptionsHtml = (models, query = "") => {
  const q = query.trim().toLowerCase();
  return models.filter((m) => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)).slice(0, 200)
    .map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${money(m.inputPerMillionUsd)} / ${money(m.outputPerMillionUsd)} per M · ${m.contextLength ? Math.round(m.contextLength / 1000) + "k" : "?"} context</option>`).join("");
};

// The dashboard's per-provider model recommendation (main thread and routine subagents).
export function recommendationsHtml(providers) {
  const model = (name, effort) => (name ? `${esc(name)} (${esc(effort || "default")})` : "waiting for fresh quota");
  return providers.filter((p) => p.modelStepping).map((p) =>
    `<div class="rec lane-${esc(p.provider)}"><span class="lane-name"><i class="lane-dot"></i>${NAMES[p.provider]}</span>`
    + `<dl><dt>Main thread</dt><dd>${model(p.recommendedModel, p.recommendedEffort)}</dd><dt>Routine subagents</dt><dd>${model(p.routineModel, p.routineEffort)}</dd></dl>`
    + `<p class="caption">${esc(p.modelReason)}</p></div>`).join("");
}

export const PRIVACY = ["No prompt storage", "No source-code storage", "No credential storage", "No telemetry"];
