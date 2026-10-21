import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { guardHome } from "./config.mjs";
import { buildProviderDecision } from "./policy.mjs";

// Small, checkable jobs that go to Hermes first (docs/hermes-jobs.md).
export const HERMES_KINDS = Object.freeze([
  "lint-format", "test-write", "test-triage", "doc-update", "rename-mechanical", "file-scan",
]);
export const ROUTE_KINDS = Object.freeze(["code", "review", "plan", "bulk", ...HERMES_KINDS]);
// Hermes jobs get one retry; after two failed attempts they go to a subscription lane.
export const HERMES_MAX_ATTEMPTS = 2;
const OVER_PACE_RATIO = 1.3; // matches the pace protect threshold in policy.mjs
const ROUTINE_KINDS = new Set(["bulk", "lint-format", "doc-update", "rename-mechanical", "file-scan"]);
const SUBSCRIPTION_LANES = ["claude", "codex"];

// Pick the lane for the next job. Planning and review stay on Claude while its
// daily share allows; other work goes to the lane with the most share left today.
export function routeJob(store, kind, options = {}) {
  if (!ROUTE_KINDS.includes(kind)) throw new TypeError(`Route kind must be one of: ${ROUTE_KINDS.join(", ")}.`);
  const now = options.now ?? Date.now();
  const config = options.config || store.getConfig();
  // Off: a passthrough answer so callers fall back to their own rules.
  if (config.enabled === false) {
    return { kind, lane: "off", disabled: true, reason: "Usage Guard is off.", lanes: [], createdAt: now };
  }
  const role = { review: "review", plan: "planning" }[kind] || (ROUTINE_KINDS.has(kind) ? "routine" : "standard");
  const lanes = SUBSCRIPTION_LANES.map((provider) => subscriptionLane(
    buildProviderDecision(store, provider, { now, config, role }), kind,
  ));
  lanes.push(hermesLane(config, options.payAsYouGo));

  let choice = null;
  let reason;
  if (config.routingPaused) {
    reason = "Routing is paused; start no new delegated work.";
  } else {
    const open = lanes.filter((lane) => lane.available);
    const claude = open.find((lane) => lane.lane === "claude");
    const codexFirst = codexFirstRule(kind, config, lanes);
    if (codexFirst?.applies) {
      choice = lanes.find((lane) => lane.lane === "codex");
      reason = codexFirst.reason;
    } else if ((kind === "plan" || kind === "review") && claude) {
      choice = claude;
      reason = `${kind === "plan" ? "Planning" : "Review"} stays on Claude while its daily share allows.`;
    } else {
      // Third-party lanes never take planning or review, and only take work once both subscriptions are spent.
      const subscriptions = open.filter((lane) => lane.subscription);
      // Both have share: the lane on pace goes first, so an over-pace lane cools off.
      const best = subscriptions.sort((a, b) => (b.verified - a.verified)
        || (a.overPace - b.overPace)
        || b.remainingTodayPercent - a.remainingTodayPercent)[0] || null;
      const passedOver = subscriptions.find((lane) => lane !== best && lane.overPace && best && !best.overPace
        && lane.remainingTodayPercent > best.remainingTodayPercent);
      const hermesJob = HERMES_KINDS.includes(kind);
      const gate = hermesJob ? hermesJobGate(kind, config, options) : null;
      const payAsYouGo = kind === "plan" || kind === "review" || (gate && !gate.ok) ? null
        : open.find((lane) => !lane.subscription) || null;
      // With one subscription spent and the other nearly so, use the capped pay-as-you-go lane before
      // squeezing the last of the other's share (a banked reset is only ever spent by the user).
      const nearlyOut = best && subscriptions.length === 1 && best.todayBudgetPercent != null
        && best.remainingTodayPercent < best.todayBudgetPercent * 0.25;
      choice = (gate?.ok && payAsYouGo) || (nearlyOut && payAsYouGo) || best || payAsYouGo;
      reason = gate?.ok && choice === payAsYouGo
        ? `${kind} goes to ${laneName(choice.lane)} first while it is under its $${config.payAsYouGoDailyCapUsd} daily cap.`
        : !choice ? `No lane has budget for ${kind} work now.${nextShareText(lanes)}`
        : choice.subscription
          ? choice.verified
            ? choice.hasDailyShare
              ? `${laneName(choice.lane)} has the most daily share left (${choice.remainingTodayPercent.toFixed(1)} pts left today).`
              : `${laneName(choice.lane)} has ${choice.remainingTodayPercent.toFixed(1)}% of the week left; its daily share is unknown until a reset time is known.`
            : `${laneName(choice.lane)} has no fresh usage reading, so its share is unknown; no other lane has share left.`
          : best
            ? `${laneName(best.lane)} has under a quarter of today's share left and the other subscription is spent; ${laneName(choice.lane)} is under its $${config.payAsYouGoDailyCapUsd} daily cap.`
            : `Both subscription lanes have spent today's share; ${laneName(choice.lane)} is under its $${config.payAsYouGoDailyCapUsd} daily cap.`;
      if (passedOver && choice === best) {
        reason = `Preferred the lane on pace: ${laneName(passedOver.lane)} is over pace (${passedOver.paceRatio.toFixed(1)}x), so ${laneName(best.lane)} takes it with ${best.remainingTodayPercent.toFixed(1)} pts left today.`;
      }
      if (gate && !gate.ok && choice) reason = `${gate.reason} ${reason}`;
      if (codexFirst) reason = `${codexFirst.reason} ${reason}`;
    }
  }

  const route = {
    kind,
    lane: choice?.lane || "wait",
    model: choice?.model || null,
    effort: choice?.effort || null,
    command: choice?.command || null,
    workdir: choice?.workdir || null,
    reason,
    attempts: options.failedAttempts ?? 0,
    paused: Boolean(config.routingPaused),
    lanes,
    privacy: "Third-party lanes must never receive .env files, secrets, user data or children's data.",
    createdAt: now,
  };
  if (options.record !== false) store.recordDecision({
    provider: route.lane,
    state: choice ? "routed" : "wait",
    action: `route-${kind}`,
    reason,
    taskClass: kind,
    resetAt: null,
    createdAt: now,
  });
  return route;
}

// Optional "lean on Codex" rule: code and bulk go to Codex while its weekly room is at or
// above codexFirstUntilLeftPercent, ignoring Codex's daily share. Only a fresh reading counts.
function codexFirstRule(kind, config, lanes) {
  const line = config.codexFirstUntilLeftPercent;
  if (line == null || (kind !== "code" && kind !== "bulk")) return null;
  const codex = lanes.find((lane) => lane.lane === "codex");
  if (!codex.verified) return { applies: false, reason: `Codex first: no fresh Codex reading, so falling back.` };
  if (codex.state === "queue") return { applies: false, reason: "Codex first: Codex is at its reserve, so falling back." };
  const left = codex.weeklyLeftPercent;
  if (left == null) return { applies: false, reason: "Codex first: no weekly Codex window, so falling back." };
  return left >= line
    ? { applies: true, reason: `Codex first: ${left.toFixed(0)}% of the week left, at or above the ${line}% line.` }
    : { applies: false, reason: `Codex first: ${left.toFixed(0)}% of the week left, below the ${line}% line, so falling back.` };
}

// Whether a Hermes job kind may go to Hermes first for this repo and attempt count.
function hermesJobGate(kind, config, options) {
  if (!config.hermesJobKinds.includes(kind)) return { ok: false, reason: `${kind} is not in hermesJobKinds.` };
  if ((options.failedAttempts ?? 0) >= HERMES_MAX_ATTEMPTS) {
    return { ok: false, reason: `Hermes failed ${options.failedAttempts} times; escalating.` };
  }
  if (!repoAllowed(options.repo, config.hermesRepos)) {
    return { ok: false, reason: "This repo is not in hermesRepos, so it cannot use Hermes." };
  }
  return { ok: true };
}

export function repoAllowed(repo, allowed) {
  if (!repo || !allowed?.length) return false;
  const real = (value) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
  const target = real(repo);
  return allowed.some((entry) => {
    const root = real(entry);
    return target === root || target.startsWith(`${root}${path.sep}`);
  });
}

function subscriptionLane(decision, kind) {
  const daily = decision.daily;
  // Uncertain meters never block; such a lane only ranks after lanes with fresh readings.
  const blocked = decision.state === "queue";
  const verified = decision.state !== "missing" && decision.state !== "stale";
  const spent = Boolean(daily?.spent);
  return {
    lane: decision.provider,
    subscription: true,
    verified,
    available: !blocked && !spent,
    state: decision.state,
    model: ROUTINE_KINDS.has(kind) ? decision.routineModel : decision.recommendedModel,
    effort: ROUTINE_KINDS.has(kind) ? decision.routineEffort : decision.recommendedEffort,
    todayBudgetPercent: daily?.todayBudgetPercent ?? null,
    usedTodayPercent: daily?.usedTodayPercent ?? null,
    // Without a daily share (no reset time yet), fall back to usable weekly percent.
    hasDailyShare: Boolean(daily),
    remainingTodayPercent: daily ? daily.remainingTodayPercent
      : verified ? Math.min(...decision.windows.map((window) => window.usablePercent ?? 0), 100) : 0,
    nextDayAt: daily?.nextDayAt ?? null,
    weeklyLeftPercent: weeklyWindow(decision.windows)?.remainingPercent ?? null,
    // Over pace: the weekly pace warning is active (1.3x+ the steady rate over 3+ hours).
    paceRatio: weeklyWindow(decision.windows)?.paceRatio ?? null,
    overPace: (weeklyWindow(decision.windows)?.paceRatio ?? 0) >= OVER_PACE_RATIO,
    reason: laneReason(decision, { blocked, spent, verified }),
  };
}

function weeklyWindow(windows = []) {
  return windows.filter((window) => window.windowMinutes > 360)
    .sort((a, b) => b.windowMinutes - a.windowMinutes)[0];
}

function laneReason(decision, { blocked, spent, verified }) {
  const daily = decision.daily;
  if (blocked) return decision.reason;
  if (spent) {
    return `Today's share is spent${daily.borrowedPercent > 0 ? `, ${daily.borrowedPercent.toFixed(1)}% borrowed from later days` : ""}.`;
  }
  if (!verified) return `Meter is ${decision.state}; share unknown.`;
  const left = daily
    ? `${daily.remainingTodayPercent.toFixed(1)}% of today's ${daily.todayBudgetPercent.toFixed(1)}% share left.`
    : "No daily share yet (reset time unknown).";
  // Pace pressure can apply while today's share still has room; say both.
  return ["watch", "protect"].includes(decision.state) && !decision.dailyShareOnly ? `${left} ${decision.reason}` : left;
}

function hermesLane(config, spend) {
  const cap = config.payAsYouGoDailyCapUsd;
  const configured = Boolean(spend?.configured);
  const spentUsd = Number.isFinite(spend?.spentTodayUsd) ? spend.spentTodayUsd : null;
  const available = configured && cap > 0 && spentUsd != null && spentUsd < cap;
  return {
    lane: "hermes",
    subscription: false,
    available,
    state: available ? "safe" : "unavailable",
    model: config.hermesModel,
    effort: null,
    // The dstest Hermes profile pins OpenRouter hosts and denies data collection; keep jobs on it.
    command: `hermes -p dstest --provider openrouter -m ${config.hermesModel} -z "<task>"`,
    workdir: "Run it from a scratch directory or a git worktree, never from a folder holding .env files or user data.",
    spentTodayUsd: spentUsd,
    dailyCapUsd: cap,
    remainingTodayUsd: spentUsd == null ? null : Math.max(0, cap - spentUsd),
    reason: !configured ? "No OpenRouter API key: set OPENROUTER_API_KEY or put it in ~/.usage-guard/openrouter.env."
      : spentUsd == null ? "OpenRouter spend could not be read."
        : available ? "Under today's cap." : "Today's cap is spent.",
  };
}

// Reads today's spend for the key from OpenRouter's documented key endpoint.
export async function readOpenRouterSpend(options = {}) {
  const env = options.env || process.env;
  const key = env.OPENROUTER_API_KEY || readKeyFile(path.join(guardHome(env), "openrouter.env"));
  if (!key) return { configured: false };
  try {
    const response = await (options.fetch || fetch)("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    });
    if (!response.ok) return { configured: true, error: `OpenRouter returned ${response.status}.` };
    const body = await response.json();
    // shortcut: OpenRouter's daily usage resets at UTC midnight, not the local day boundary.
    const spentTodayUsd = Number(body?.data?.usage_daily);
    return { configured: true, spentTodayUsd: Number.isFinite(spentTodayUsd) ? spentTodayUsd : null };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

// A KEY=value file the user writes themselves (chmod 600); only OPENROUTER_API_KEY is read.
function readKeyFile(file) {
  if (!existsSync(file)) return null;
  const match = readFileSync(file, "utf8").match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s]+)/m);
  return match ? match[1] : null;
}

function nextShareText(lanes) {
  const next = lanes.map((lane) => lane.nextDayAt).filter(Number.isFinite);
  return next.length ? ` The next daily share starts at ${new Date(Math.min(...next)).toISOString()}.` : "";
}

function laneName(lane) {
  return { claude: "Claude", codex: "Codex", hermes: "Hermes (OpenRouter)" }[lane] || lane;
}
