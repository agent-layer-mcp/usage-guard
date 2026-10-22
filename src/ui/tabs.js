// Tab state and keyboard handling shared by the tray panel and the localhost dashboard.
// Pure helpers first (testable without a DOM); initTabs is the only part that touches the page.
export const TABS = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "history", label: "History" },
  { id: "settings", label: "Settings" },
];
export const DEFAULT_TAB = "overview";
export const TAB_KEY = "usage-guard.tab";

export const normalizeTab = (value) => (TABS.some((tab) => tab.id === value) ? value : DEFAULT_TAB);

// Storage can be missing or throw (private windows, blocked site data), so every access is guarded.
export function loadTab(storage) {
  try { return normalizeTab(storage?.getItem(TAB_KEY)); } catch { return DEFAULT_TAB; }
}
export function saveTab(storage, tab) {
  try { storage?.setItem(TAB_KEY, normalizeTab(tab)); } catch { /* the choice just will not persist */ }
}

// Arrow keys move and wrap, Home/End jump; any other key returns null.
export function tabFromKey(current, key) {
  const index = TABS.findIndex((tab) => tab.id === current);
  if (index < 0) return null;
  const last = TABS.length - 1;
  const target = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[key];
  return target == null ? null : TABS[target].id;
}

export const tabsHtml = () => `<div class="tabs" role="tablist" aria-label="Usage Guard sections">${TABS.map((tab) =>
  `<button type="button" class="tab" role="tab" id="tab-${tab.id}" data-tab="${tab.id}" aria-controls="panel-${tab.id}" aria-selected="${tab.id === DEFAULT_TAB}" tabindex="${tab.id === DEFAULT_TAB ? 0 : -1}">${tab.label}</button>`).join("")}</div>`;

export const panelsHtml = () => TABS.map((tab) =>
  `<section class="tabpanel" role="tabpanel" id="panel-${tab.id}" data-tab="${tab.id}" aria-labelledby="tab-${tab.id}" tabindex="0"${tab.id === DEFAULT_TAB ? "" : " hidden"}></section>`).join("");

export function initTabs(root, storage) {
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const panels = [...root.querySelectorAll('[role="tabpanel"]')];
  const select = (id, { focus = false, save = true } = {}) => {
    const name = normalizeTab(id);
    for (const tab of tabs) {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    for (const panel of panels) panel.hidden = panel.dataset.tab !== name;
    if (save) saveTab(storage, name);
  };
  for (const tab of tabs) tab.addEventListener("click", () => select(tab.dataset.tab));
  root.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
    const next = tabFromKey(event.target.closest?.('[role="tab"]')?.dataset.tab, event.key);
    if (!next) return;
    event.preventDefault();
    select(next, { focus: true });
  });
  select(loadTab(storage), { save: false });
  return select;
}
