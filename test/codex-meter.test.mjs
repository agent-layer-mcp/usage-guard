import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchCodexSnapshot, parseCodexRateLimits, readCodexRateLimits } from "../src/providers/codex.mjs";

const rateLimits = {
  rateLimitsByLimitId: {
    "gpt-5.3-codex-spark": {
      limitId: "gpt-5.3-codex-spark",
      limitName: "GPT-5.3 Codex Spark",
      primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: null,
    },
  },
};

function withFakeCodex(t, { configError = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "usage-guard-codex-meter-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "fake-codex.mjs");
  const script = `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
const respond = (id, field, value) => process.stdout.write(JSON.stringify({ id, [field]: value }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) respond(1, "result", {});
  if (message.id === 2) respond(2, "result", ${JSON.stringify(rateLimits)});
  if (message.id === 3) {
    setTimeout(() => {
      ${configError
        ? 'respond(3, "error", { message: "Method not found" });'
        : 'respond(3, "result", { config: { model: "gpt-6-sol", model_reasoning_effort: "medium" } });'}
    }, 10);
  }
});
`;
  writeFileSync(executable, script, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { codexPath: executable, env: { PATH: process.env.PATH }, timeoutMs: 5000 };
}

test("Codex meter reads the configured model separately from quota bucket names", async (t) => {
  const snapshot = await fetchCodexSnapshot(withFakeCodex(t));
  assert.equal(snapshot.model, "gpt-6-sol");
  assert.equal(snapshot.effort, "medium");
  assert.equal(snapshot.modelSource, "configured-default");
  assert.deepEqual(snapshot.windows.map(({ key, label }) => ({ key, label })), [{
    key: "gpt-5.3-codex-spark:primary",
    label: "GPT-5.3 Codex Spark 5 hour",
  }]);
});

test("an explicitly observed session model takes precedence over config", async (t) => {
  const snapshot = await fetchCodexSnapshot({
    ...withFakeCodex(t),
    model: "gpt-6-astra",
    effort: "high",
  });
  assert.equal(snapshot.model, "gpt-6-astra");
  assert.equal(snapshot.effort, "high");
  assert.equal(snapshot.modelSource, "session-provided");
});

test("an older Codex config/read error leaves the quota meter available", async (t) => {
  const snapshot = await fetchCodexSnapshot(withFakeCodex(t, { configError: true }));
  assert.equal(snapshot.model, null);
  assert.equal(snapshot.effort, null);
  assert.equal(snapshot.modelSource, null);
  assert.equal(snapshot.windows[0].usedPercent, 18);
});

test("the rate-limit only API remains unchanged", async (t) => {
  assert.deepEqual(await readCodexRateLimits(withFakeCodex(t)), rateLimits);
});

test("a bucket name never becomes the snapshot model", () => {
  const snapshot = parseCodexRateLimits(rateLimits);
  assert.equal(snapshot.model, null);
  assert.equal(snapshot.windows[0].label, "GPT-5.3 Codex Spark 5 hour");
});

test("a null usage percentage is not treated as zero", () => {
  const snapshot = parseCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: null, windowDurationMins: 300 },
      secondary: { usedPercent: 8, windowDurationMins: 10_080 },
    },
  });
  assert.deepEqual(snapshot.windows.map((window) => window.key), ["codex:secondary"]);
});
