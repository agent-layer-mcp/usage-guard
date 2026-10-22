// The whole Usage Guard panel (tabs, screens, behaviour), shared by the tray and the dashboard.
// The host supplies an `api` adapter, so this file never knows whether it runs in Tauri or a browser.
import { parseCap } from "./format.js";
import { PRIVACY, decisionsHtml, esc, ladderHtml, laneHtml, modelOptionsHtml, payAsYouGoHtml, recommendationsHtml, routeTitle } from "./render.js";
import { initTabs, panelsHtml, tabsHtml } from "./tabs.js";

const bannersHtml = `<p class="banner error" id="error" role="alert" hidden></p>
<p class="banner off" id="off" hidden>Usage Guard is off: no hooks, alerts or routing. Turn it on with the switch on the Overview tab.</p>`;

export const shellHtml = () => tabsHtml() + bannersHtml + panelsHtml();

const switchHtml = (id, label, text, cls = "") =>
  `<label class="status-pill switch ${cls}"><input type="checkbox" id="${id}" role="switch" aria-label="${label}"><span class="status-dot" aria-hidden="true"></span><span id="${id}-label">${text}</span></label>`;

const SCREENS = {
  overview: (dayStart) => `
    <p class="eyebrow" id="eyebrow">usage guard · local only · day starts ${esc(dayStart)}</p>
    <h1>Your week, <em>paced.</em></h1>
    <div class="overview-top">
      <section class="ink-card route"><span class="eyebrow on-ink">next job goes to</span><strong id="route-lane">…</strong><p id="route-reason"></p></section>
      <section class="card controls" aria-label="Controls">
        <div class="control"><strong>Usage Guard</strong>${switchHtml("enabled", "Usage Guard on or off", "on")}</div>
        <p class="caption" id="enabled-hint" hidden></p>
        <div class="control"><strong>Routing</strong>${switchHtml("pause", "Pause routing", "pause routing", "caution")}</div>
      </section>
    </div>
    <section id="lanes" class="lanes"></section>
    <p class="legend"><b>Today</b> = your daily share. <b>Week</b> = the whole week's allowance. Shares are in points: 1 pt = 1% of the week. Meters report whole %, so today's use is ±1 pt.</p>`,
  models: () => `
    <div class="models-grid">
      <section class="card hermes">
        <div class="card-head"><h2>Hermes model</h2><span class="stamp">openrouter</span></div>
        <p class="current">Using <strong id="hermes-model">…</strong></p>
        <label for="model-search">Find a model (tool-calling models only)</label>
        <input type="search" id="model-search" placeholder="Search by name or id, e.g. deepseek, qwen, kimi">
        <select id="model-list" size="9" aria-label="OpenRouter models"></select>
        <div class="actions">
          <button type="button" class="btn btn-primary" id="model-use">Use this model</button>
          <button type="button" class="btn btn-secondary" id="model-refresh">Refresh list</button>
        </div>
        <p class="caption" id="model-hint">Prices are US$ per million input / output tokens · jobs run through the Hermes dstest profile (pinned hosts, no data collection) · a model those hosts don't serve will fail</p>
      </section>
      <div class="stack">
        <section class="card">
          <h2>Your plan's models</h2>
          <label for="preset">Model ladder (top model first; steps down as a share runs low)</label>
          <select id="preset" class="select">
            <option value="lower">Lower plan: Sonnet / Sol medium at the top</option>
            <option value="standard">Standard: Opus / Sol high at the top</option>
            <option value="high">High: keeps the top model for longer</option>
            <option value="custom" disabled>Custom (set with usage-guard config modelLadders)</option>
          </select>
          <div class="ladders" id="ladders"></div>
        </section>
        <section class="card" id="recs-card" hidden><h2>Recommended now</h2><div id="recs"></div></section>
      </div>
    </div>`,
  history: () => `
    <p class="overnight" id="overnight" hidden></p>
    <section class="card"><div class="card-head"><h2>Recent decisions</h2></div><ol id="decisions" class="decisions"></ol></section>
    <section class="card banked">
      <h2>Codex banked reset</h2>
      <p class="caption">Usage Guard never spends this · the button opens Codex's usage page so you can choose to</p>
      <div class="actions"><button type="button" class="btn btn-secondary" id="banked">Codex banked reset…</button></div>
    </section>`,
  settings: () => `
    <section class="card">
      <h2>Hermes daily spend cap</h2>
      <label for="cap">Daily spend cap (US$)</label>
      <div class="actions"><input type="number" id="cap" min="0" max="1000" step="0.5"><button type="button" class="btn btn-secondary" id="cap-save">Save cap</button></div>
      <p class="caption cap-error" id="cap-error" role="alert" hidden></p>
    </section>
    <section class="card">
      <h2>How it works</h2>
      <p class="prose">Each AI lane gets an even share of what's left this week. When a share runs out, the next job goes to another lane.</p>
    </section>
    <section class="card">
      <h2>Privacy</h2>
      <ul class="privacy">${PRIVACY.map((item) => `<li>${item}</li>`).join("")}</ul>
    </section>`,
};

export function mountPanel({ api, root = document, wide = false, decisionLimit = 6, storage, onData }) {
  const $ = (id) => root.getElementById(id);
  const panel = (id) => root.getElementById(`panel-${id}`);
  // A failed save's error is "sticky": background refreshes leave it up until the next user action or a successful save.
  let sticky = false;
  const fail = (error, keep = false) => { sticky = keep; $("error").textContent = String(error); $("error").hidden = false; };
  const clearError = () => { sticky = false; $("error").hidden = true; };
  const guard = async (work) => { clearError(); try { await work(); } catch (error) { fail(error, true); } };
  let lanesHtml = "";
  const openLanes = new Map();

  for (const id of Object.keys(SCREENS)) panel(id).innerHTML = SCREENS[id]("08:00");
  initTabs(root, storage);

  panel("overview").addEventListener("toggle", (event) => {
    if (event.target.matches?.("details.more")) openLanes.set(event.target.dataset.lane, event.target.open);
  }, true);
  const isOpen = (id) => (openLanes.has(id) ? openLanes.get(id) : wide);

  async function refresh() {
    try {
      const [status, route] = await Promise.all([api.status(), api.route()]);
      if (!sticky) $("error").hidden = true;
      const config = status.config;
      const lanes = Object.fromEntries(route.lanes.map((lane) => [lane.lane, lane]));
      $("eyebrow").textContent = `usage guard · local only · day starts ${config.dayStartTime || "08:00"}`;
      const html = status.providers.map((p) => laneHtml(p, { paused: Boolean(config.routingPaused), wide, open: isOpen(p.provider) })).join("")
        + payAsYouGoHtml(lanes.hermes, { open: isOpen("hermes") });
      // Only touch the DOM when the lanes changed, and put keyboard focus back on the same lane's summary.
      if (html !== lanesHtml) {
        lanesHtml = html;
        const focused = root.activeElement?.matches?.("details.more > summary") ? root.activeElement.parentElement.dataset.lane : null;
        $("lanes").innerHTML = html;
        if (focused) $("lanes").querySelector(`details.more[data-lane="${focused}"] > summary`)?.focus();
      }
      $("route-lane").textContent = routeTitle(route);
      $("route-reason").textContent = route.reason;
      $("pause").checked = Boolean(config.routingPaused);
      const on = config.enabled !== false;
      $("enabled").checked = on;
      $("enabled-label").textContent = on ? "on · guarding" : "off";
      $("off").hidden = on;
      root.body.classList.toggle("is-off", !on);

      $("hermes-model").textContent = config.hermesModel;
      if (root.activeElement !== $("preset")) $("preset").value = config.planPreset || "standard";
      $("ladders").innerHTML = ladderHtml(config.modelLadders);
      const recs = wide ? recommendationsHtml(status.providers) : "";
      $("recs").innerHTML = recs;
      $("recs-card").hidden = !recs;

      $("overnight").textContent = status.overnightSummary || "";
      $("overnight").hidden = !status.overnightSummary;
      $("decisions").innerHTML = decisionsHtml(status.recentDecisions, decisionLimit)
        || `<li class="empty">Waiting for the first decision. Quota events will appear here.</li>`;
      if (root.activeElement !== $("cap")) $("cap").value = config.payAsYouGoDailyCapUsd;
      onData?.(status, route, on);
    } catch (error) {
      if (!sticky) fail(error);
      onData?.(null, null, null, error);
    }
  }

  const patch = (changes) => guard(async () => { await api.setConfig(changes); }).then(refresh);

  if (api.setEnabled) {
    $("enabled").addEventListener("change", (event) => guard(() => api.setEnabled(event.target.checked)).then(refresh));
  } else {
    // Turning the guard on or off also starts or stops its monitor timer, which only the tray (or `usage-guard enable|disable`) does.
    $("enabled").disabled = true;
    $("enabled-hint").textContent = "Switch it from the tray, or run usage-guard enable / disable.";
    $("enabled-hint").hidden = false;
  }
  $("pause").addEventListener("change", (event) => patch({ routingPaused: event.target.checked }));
  $("preset").addEventListener("change", (event) => patch({ planPreset: event.target.value }));
  const capError = (text) => { $("cap-error").textContent = text || ""; $("cap-error").hidden = !text; };
  $("cap").addEventListener("input", () => capError(""));
  $("cap-save").addEventListener("click", () => {
    const { value, error } = parseCap($("cap").value);
    capError(error);
    if (!error) patch({ payAsYouGoDailyCapUsd: value });
  });
  $("banked").addEventListener("click", () => {
    if (root.defaultView.confirm("Open Codex's usage page? Spending the banked reset there is your choice; Usage Guard never does it.")) api.openCodexUsage();
  });

  let models = [];
  const renderModels = () => { $("model-list").innerHTML = modelOptionsHtml(models, $("model-search").value); };
  const loadModels = (refreshList = false) => guard(async () => {
    const list = await api.models(refreshList);
    models = list.models;
    renderModels();
    if (list.stale) $("model-hint").dataset.stale = "1";
  });
  $("model-search").addEventListener("input", renderModels);
  $("model-refresh").addEventListener("click", () => loadModels(true));
  $("model-use").addEventListener("click", () => { if ($("model-list").value) patch({ hermesModel: $("model-list").value }); });
  $("model-list").addEventListener("dblclick", () => $("model-use").click());

  loadModels();
  refresh();
  setInterval(refresh, wide ? 15_000 : 30_000);
  return { refresh, fail: (error) => fail(error, true), clearError };
}
