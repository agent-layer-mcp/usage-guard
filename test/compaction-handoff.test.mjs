import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCompactionHandoff, writeCompactionHandoff } from "../src/compaction-handoff.mjs";
import { runProviderHook } from "../src/hooks.mjs";
import { GuardStore } from "../src/store.mjs";

const LEGACY_GUIDANCE = "Continue from this handoff without lowering the selected model or reasoning effort. "
  + "Treat the user's newest request and the current repository state as authoritative.";

function fixture(t, usedPercent = 65) {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-handoff-policy-"));
  const store = new GuardStore({ filename: ":memory:" });
  const stateHome = path.join(root, "state");
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.saveSnapshot({
    provider: "claude", source: "test", observedAt: Date.now(),
    windows: [{ key: "five-hour", label: "5 hour", usedPercent, windowMinutes: 300, resetsAt: null }],
  });
  return {
    root, store, stateHome,
    options: {
      claudeDesktop: { platform: "linux" },
      compactionHandoff: { stateHome },
      quotaHandover: { stateHome },
    },
  };
}

test("new compaction handoffs defer model and reserve choices to current policy", (t) => {
  const { root, stateHome } = fixture(t);
  const written = writeCompactionHandoff({
    cwd: root, session_id: "old", compact_summary: "Next, verify the parser.",
  }, { stateHome });
  const content = readFileSync(written.path, "utf8");
  assert.match(content, /current Usage Guard instructions and configuration/i);
  assert.match(content, /model, effort, and reserve pauses/i);
  assert.doesNotMatch(content, /without lowering the selected model/i);
});

test("legacy handoff footer is updated when read without rewriting the saved summary", (t) => {
  const { root, stateHome } = fixture(t);
  const written = writeCompactionHandoff({
    cwd: root, session_id: "old", compact_summary: "Next, verify the parser.",
  }, { stateHome });
  const content = readFileSync(written.path, "utf8");
  const legacy = content.slice(0, content.lastIndexOf("## Continuation\n\n"))
    + `## Continuation\n\n${LEGACY_GUIDANCE}\n`;
  writeFileSync(written.path, legacy);
  const resumed = readCompactionHandoff({ cwd: root, session_id: "new" }, { stateHome });
  assert.match(resumed.content, /Next, verify the parser/);
  assert.match(resumed.content, /current Usage Guard instructions and configuration/i);
  assert.doesNotMatch(resumed.content, /without lowering the selected model/i);
  assert.equal(readFileSync(written.path, "utf8"), legacy);
});

test("legacy-looking text inside the provider summary is preserved", (t) => {
  const { root, stateHome } = fixture(t);
  const summary = `Discussed this old instruction: ${LEGACY_GUIDANCE}\nNext, run tests.`;
  writeCompactionHandoff({ cwd: root, session_id: "old", compact_summary: summary }, { stateHome });
  const resumed = readCompactionHandoff({ cwd: root, session_id: "new" }, { stateHome });
  assert.ok(resumed.content.includes(summary));
  assert.match(resumed.content, /current Usage Guard instructions and configuration/i);
});

for (const [label, config, expected] of [
  ["stepping", { modelStepping: true, qualityLock: false }, /Model stepping is on and already authorized/],
  ["quality lock", { modelStepping: true, qualityLock: true }, /Quality lock is on: never lower the active model/],
  ["both off", { modelStepping: false, qualityLock: false }, /Model stepping is off: preserve the user's current model/],
]) {
  test(`resumed handoffs honor current ${label} settings`, async (t) => {
    const { root, store, options } = fixture(t);
    store.setConfig({ qualityLock: !config.qualityLock });
    await runProviderHook(store, "claude", {
      hook_event_name: "PostCompact", session_id: "old", cwd: root,
      compact_summary: "Next, verify the parser.",
    }, options);
    store.setConfig(config);
    const resumed = await runProviderHook(store, "claude", {
      hook_event_name: "SessionStart", session_id: "new", cwd: root,
    }, options);
    const context = resumed.hookSpecificOutput.additionalContext;
    assert.match(context, expected);
    assert.match(context, /current Usage Guard policy.*override/i);
    assert.doesNotMatch(context, /without lowering the selected model/i);
    if (label === "stepping") {
      assert.match(context, /claude-sonnet-5-5/);
      assert.match(context, /switch only between tasks/i);
    }
  });
}

test("reserve handovers are written only with effective model stepping", async (t) => {
  for (const config of [
    { modelStepping: true, qualityLock: false },
    { modelStepping: true, qualityLock: true },
    { modelStepping: false, qualityLock: false },
  ]) {
    for (const hook_event_name of ["UserPromptSubmit", "PreToolUse", "PostToolBatch"]) {
      await t.test(`${JSON.stringify(config)} ${hook_event_name}`, async (t) => {
        const { store, stateHome, options } = fixture(t, 94);
        store.setConfig(config);
        const output = await runProviderHook(store, "claude", { hook_event_name }, options);
        assert.equal(output.continue, false);
        const stepping = config.modelStepping && !config.qualityLock;
        assert.equal(existsSync(path.join(stateHome, "handoffs", "quota-claude.json")), stepping);
        assert.equal(/Quota-only handover saved/.test(output.stopReason), stepping);
      });
    }
  }
});

test("disabling compaction handoffs prevents provider summary persistence", async (t) => {
  const { root, store, stateHome, options } = fixture(t);
  store.setConfig({ compactionHandoffEnabled: false });
  const output = await runProviderHook(store, "claude", {
    hook_event_name: "PostCompact", session_id: "old", cwd: root,
    compact_summary: "Code from the conversation: const example = 1;",
  }, options);
  assert.deepEqual(output, {});
  assert.equal(existsSync(path.join(stateHome, "handoffs")), false);
});
