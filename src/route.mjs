import { buildProviderDecision } from "./policy.mjs";

export const ROUTE_KINDS = Object.freeze(["code", "review", "plan", "bulk"]);
const SUBSCRIPTION_LANES = ["claude", "codex"];

// Pick the lane for the next job. Planning and review stay on Claude while its
// daily share allows; other work goes to the lane with the most share left today.
export function routeJob(store, kind, options = {}) {
  if (!ROUTE_KINDS.includes(kind)) throw new TypeError(`Route kind must be one of: ${ROUTE_KINDS.join(", ")}.`);
  const now = options.now ?? Date.now();
  const config = options.config || store.getConfig();
  const role = { code: "standard", review: "review", plan: "planning", bulk: "routine" }[kind];
  const lanes = SUBSCRIPTION_LANES.map((provider) => subscriptionLane(
    buildProviderDecision(store, provider, { now, config, role }), kind,
  ));
  lanes.push(payAsYouGoLane(config, options.payAsYouGo));

  let choice = null;
  let reason;
  if (config.routingPaused) {
    reason = "Routing is paused; start no new delegated work.";
  } else {
    const open = lanes.filter((lane) => lane.available);
    const claude = open.find((lane) => lane.lane === "claude");
    if ((kind === "plan" || kind === "review") && claude) {
      choice = claude;
      reason = `${kind === "plan" ? "Planning" : "Review"} stays on Claude while its daily share allows.`;
    } else {
      // Third-party lanes never take planning or review, and only take work once both subscriptions are spent.
      const subscriptions = open.filter((lane) => lane.subscription);
      const best = subscriptions.sort((a, b) => (b.verified - a.verified)
        || b.remainingTodayPercent - a.remainingTodayPercent)[0] || null;
      const payAsYouGo = kind === "plan" || kind === "review" ? null : open.find((lane) => !lane.subscription) || null;
      // With one subscription spent and the other nearly so, use the capped pay-as-you-go lane before
      // squeezing the last of the other's share (a banked reset is only ever spent by the user).
      const nearlyOut = best && subscriptions.length === 1 && best.todayBudgetPercent != null
        && best.remainingTodayPercent < best.todayBudgetPercent * 0.25;
      choice = (nearlyOut && payAsYouGo) || best || payAsYouGo;
      reason = !choice ? `No lane has budget for ${kind} work now.${nextShareText(lanes)}`
        : choice.subscription
          ? `${laneName(choice.lane)} has the most daily share left (${choice.remainingTodayPercent.toFixed(1)}%).`
          : best
            ? `${laneName(best.lane)} has under a quarter of today's share left and the other subscription is spent; ${laneName(choice.lane)} is under its $${config.payAsYouGoDailyCapUsd} daily cap.`
            : `Both subscription lanes have spent today's share; ${laneName(choice.lane)} is under its $${config.payAsYouGoDailyCapUsd} daily cap.`;
    }
  }

  const route = {
    kind,
    lane: choice?.lane || "wait",
    model: choice?.model || null,
    effort: choice?.effort || null,
    command: choice?.command || null,
    reason,
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
    model: kind === "bulk" ? decision.routineModel : decision.recommendedModel,
    effort: kind === "bulk" ? decision.routineEffort : decision.recommendedEffort,
    todayBudgetPercent: daily?.todayBudgetPercent ?? null,
    usedTodayPercent: daily?.usedTodayPercent ?? null,
    // Without a daily share (no reset time yet), fall back to usable weekly percent.
    remainingTodayPercent: daily ? daily.remainingTodayPercent
      : verified ? Math.min(...decision.windows.map((window) => window.usablePercent ?? 0), 100) : 0,
    nextDayAt: daily?.nextDayAt ?? null,
    reason: blocked ? decision.reason : spent ? "Today's share is spent."
      : verified ? "Has daily share left." : `Meter is ${decision.state}; share unknown.`,
  };
}

function payAsYouGoLane(config, spend) {
  const cap = config.payAsYouGoDailyCapUsd;
  const configured = Boolean(spend?.configured);
  const spentUsd = Number.isFinite(spend?.spentTodayUsd) ? spend.spentTodayUsd : null;
  const available = configured && cap > 0 && spentUsd != null && spentUsd < cap;
  return {
    lane: "deepseek",
    subscription: false,
    available,
    state: available ? "safe" : "unavailable",
    model: config.payAsYouGoModel,
    effort: null,
    // The dstest Hermes profile pins OpenRouter hosts and denies data collection; keep jobs on it.
    command: `hermes -p dstest --provider openrouter -m ${config.payAsYouGoModel} -z "<task>"`,
    spentTodayUsd: spentUsd,
    dailyCapUsd: cap,
    remainingTodayUsd: spentUsd == null ? null : Math.max(0, cap - spentUsd),
    reason: !configured ? "No OpenRouter API key is set."
      : spentUsd == null ? "OpenRouter spend could not be read."
        : available ? "Under today's cap." : "Today's cap is spent.",
  };
}

// Reads today's spend for the key from OpenRouter's documented key endpoint.
export async function readOpenRouterSpend(options = {}) {
  const env = options.env || process.env;
  const key = env.OPENROUTER_API_KEY;
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

function nextShareText(lanes) {
  const next = lanes.map((lane) => lane.nextDayAt).filter(Number.isFinite);
  return next.length ? ` The next daily share starts at ${new Date(Math.min(...next)).toISOString()}.` : "";
}

function laneName(lane) {
  return { claude: "Claude", codex: "Codex", deepseek: "DeepSeek (OpenRouter)" }[lane] || lane;
}
