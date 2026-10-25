import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/mcp.mjs";
import { DEFAULT_CONFIG } from "../src/config.mjs";
import { GuardStore } from "../src/store.mjs";

test("MCP exposes local status and structured content", async () => {
  const store = new GuardStore({ filename: ":memory:" });
  const initialized = await handleRequest(store, {
    method: "initialize",
    params: { protocolVersion: "test-version" },
  });
  assert.equal(initialized.protocolVersion, "test-version");

  const tools = await handleRequest(store, { method: "tools/list" });
  assert.ok(tools.tools.some((tool) => tool.name === "usage_guard_status"));
  const configure = tools.tools.find((tool) => tool.name === "usage_guard_configure");
  assert.deepEqual(
    Object.keys(configure.inputSchema.properties).sort(),
    Object.keys(DEFAULT_CONFIG).sort(),
  );
  assert.equal(configure.inputSchema.properties.contextWatchPercent.maximum, 99);
  assert.equal(configure.inputSchema.properties.contextProtectPercent.maximum, 100);
  assert.equal(configure.inputSchema.properties.compactionHandoffEnabled.type, "boolean");

  const result = await handleRequest(store, {
    method: "tools/call",
    params: { name: "usage_guard_status", arguments: {} },
  });
  assert.equal(result.structuredContent.privacy.promptStored, false);
  assert.equal(result.structuredContent.config.modelStepping, true);
  assert.match(result.structuredContent.overnightSummary, /Last 12 hours/i);
  assert.equal(result.isError, false);
  store.close();
});

test("MCP configure changes every setting and returns the effective policy", async () => {
  const store = new GuardStore({ filename: ":memory:" });
  const patch = {
    ...structuredClone(DEFAULT_CONFIG),
    enforcement: "observe",
    modelStepping: true,
    qualityLock: false,
    fiveHourStepDownThresholds: [45, 27, 13],
    weeklyStepDownThresholds: [35, 11],
    stepUpMarginPercent: 11,
    rapidBurnStepDown: false,
    quietHours: { start: "22:00", end: "07:00", timeZone: "Australia/Brisbane", extraRungs: 1 },
    routineStepDownRungs: 2,
    protectedMaxRung: 2,
    overnightSummaryHours: 10,
    fiveHourReservePercent: 9,
    weeklyReservePercent: 6,
    rapidBurnWatchMinutes: 100,
    rapidBurnProtectMinutes: 35,
    contextWatchPercent: 72,
    contextProtectPercent: 88,
    compactionHandoffEnabled: false,
    staleAfterMinutes: 20,
    dashboardPort: 4770,
  };
  const configured = await handleRequest(store, {
    method: "tools/call",
    params: { name: "usage_guard_configure", arguments: patch },
  });
  assert.deepEqual(configured.structuredContent, store.getConfig());
  assert.equal(configured.structuredContent.quietHours.start, "22:00");
  assert.deepEqual(configured.structuredContent.fiveHourStepDownThresholds, [45, 27, 13]);
  await assert.rejects(() => handleRequest(store, {
    method: "tools/call",
    params: { name: "usage_guard_configure", arguments: { unsupported: true } },
  }), /Unknown setting/i);
  store.close();
});

test("MCP status and decision accept a role without storing task text", async () => {
  const now = Date.now();
  const store = new GuardStore({ filename: ":memory:" });
  store.saveSnapshot({
    provider: "codex", source: "test", observedAt: now,
    windows: [{ key: "five-hour", label: "5 hour", usedPercent: 70, windowMinutes: 300, resetsAt: now + 60 * 60_000 }],
  });
  const response = await handleRequest(store, {
    method: "tools/call",
    params: { name: "usage_guard_status", arguments: { provider: "codex", role: "review", task: "Review secret plan" } },
  });
  assert.equal(response.structuredContent.providers.length, 1);
  assert.equal(response.structuredContent.providers[0].taskRole, "review");
  assert.ok(response.structuredContent.providers[0].recommendedRung <= 2);
  assert.equal(response.structuredContent.privacy.promptStored, false);
  assert.doesNotMatch(JSON.stringify(response.structuredContent.recentDecisions), /secret plan/i);
  store.close();
});

test("MCP routes a task by difficulty and records its outcome", async (t) => {
  const store = new GuardStore({ filename: ":memory:" });
  t.after(() => store.close());
  const options = { readSpend: async () => ({ configured: false }) };
  const tools = await handleRequest(store, { method: "tools/list" });
  for (const name of ["usage_guard_route", "usage_guard_outcome"]) assert.ok(tools.tools.some((tool) => tool.name === name), name);

  const route = await handleRequest(store, { method: "tools/call", params: { name: "usage_guard_route", arguments: { kind: "file-scan", difficulty: "easy" } } }, options);
  assert.equal(route.isError, false);
  assert.equal(route.structuredContent.difficulty, "easy");
  assert.ok(route.structuredContent.lane);

  const saved = await handleRequest(store, { method: "tools/call", params: { name: "usage_guard_outcome",
    arguments: { lane: "claude", model: "claude-haiku-5-5", kind: "file-scan", difficulty: "easy", result: "pass" } } }, options);
  assert.equal(saved.isError, false);
  assert.equal(store.outcomeRates()[0].pass, 1);

  const bad = await handleRequest(store, { method: "tools/call", params: { name: "usage_guard_outcome",
    arguments: { lane: "claude", model: "claude-haiku-5-5", kind: "file-scan", difficulty: "trivial", result: "pass" } } }, options);
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Difficulty must be one of/);
});

test("MCP runs a Hermes job from task text and reports refusals as tool errors", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } = await import("node:fs");
  const os = (await import("node:os")).default;
  const path = (await import("node:path")).default;
  const dir = (prefix) => {
    const d = mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };
  const repo = dir("ug-mcp-repo-");
  const git = (...args) => assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0, args.join(" "));
  git("init", "-q");
  writeFileSync(path.join(repo, "a.js"), "export const a = 1;\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const home = dir("ug-mcp-home-");
  const bin = path.join(home, "fake-hermes");
  writeFileSync(bin, "#!/bin/sh\necho \"// edit\" >> a.js\n");
  chmodSync(bin, 0o755);

  const store = new GuardStore({ filename: ":memory:" });
  t.after(() => store.close());
  store.setConfig({ hermesRepos: [repo] });
  const options = { readSpend: async () => ({ configured: true, spentTodayUsd: 0 }), hermesBin: bin, env: { ...process.env, USAGE_GUARD_HOME: home } };
  const call = (args) => handleRequest(store, { method: "tools/call", params: { name: "usage_guard_hermes_job", arguments: args } }, options);

  const tools = await handleRequest(store, { method: "tools/list" });
  assert.ok(tools.tools.some((tool) => tool.name === "usage_guard_hermes_job"));

  const done = await call({ kind: "code", difficulty: "easy", task: "Tidy a.js", repo, check: ["true"] });
  assert.equal(done.isError, false);
  assert.equal(done.structuredContent.result, "pass");
  assert.match(done.structuredContent.diffStat, /a\.js/);
  t.after(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", done.structuredContent.worktree]));
  assert.equal(existsSync(path.join(home, "jobs")), true);

  const refused = await call({ kind: "code", task: "rotate the API key", repo });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /secrets/);
});
