import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTask, findSecretFiles, HermesJobRefused, runHermesJob } from "../src/hermes-job.mjs";
import { routeJob } from "../src/route.mjs";
import { GuardStore } from "../src/store.mjs";
import { summarizeTestOutput } from "../src/test-run.mjs";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 20, 1, 0);
const DAY_START = Date.UTC(2026, 9, 19, 22, 0);
const RESET = DAY_START + 3 * 24 * HOUR;
const hermes = { configured: true, spentTodayUsd: 0 };

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function storeWith(t, config = {}) {
  const store = new GuardStore({ filename: ":memory:" });
  t.after(() => store.close());
  store.setConfig({ dayTimeZone: "Australia/Brisbane", ...config });
  for (const provider of ["claude", "codex"]) {
    for (const [observedAt, usedPercent] of [[DAY_START - HOUR, 40], [NOW, 41]]) {
      store.saveSnapshot({
        provider, source: "test", observedAt,
        windows: [{ key: "seven-day", label: "weekly", usedPercent, windowMinutes: 10_080, resetsAt: RESET }],
      });
    }
  }
  return store;
}

function fakeRepo(t, files = { "src/a.js": "export const a = 1;\n" }) {
  const repo = tempDir(t, "ug-repo-");
  const run = (...args) => assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0, args.join(" "));
  run("init", "-q");
  for (const [name, body] of Object.entries(files)) {
    spawnSync("mkdir", ["-p", path.dirname(path.join(repo, name))]);
    writeFileSync(path.join(repo, name), body);
  }
  run("add", "-A");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return repo;
}

test("Hermes job kinds go to Hermes first, only for opted-in repos", (t) => {
  const repo = tempDir(t, "ug-allowed-");
  const store = storeWith(t, { hermesRepos: [repo] });
  const route = routeJob(store, "test-write", { now: NOW, payAsYouGo: hermes, repo, record: false });
  assert.equal(route.lane, "hermes");
  assert.match(route.reason, /goes to Hermes \(OpenRouter\) first/);

  const other = routeJob(store, "test-write", { now: NOW, payAsYouGo: hermes, repo: os.tmpdir(), record: false });
  assert.notEqual(other.lane, "hermes");
  assert.match(other.reason, /not in hermesRepos/);
  // Plain code work keeps the old rule: subscriptions first while they have share.
  assert.notEqual(routeJob(store, "code", { now: NOW, payAsYouGo: hermes, repo, record: false }).lane, "hermes");
});

test("a Hermes job escalates to a subscription after two failed attempts", (t) => {
  const repo = tempDir(t, "ug-esc-");
  const store = storeWith(t, { hermesRepos: [repo] });
  const at = (failedAttempts) => routeJob(store, "lint-format", { now: NOW, payAsYouGo: hermes, repo, failedAttempts, record: false });
  assert.equal(at(1).lane, "hermes");
  const escalated = at(2);
  assert.ok(["claude", "codex"].includes(escalated.lane));
  assert.match(escalated.reason, /failed 2 times; escalating/);
});

test("Hermes kinds skip Hermes past the cap and when removed from hermesJobKinds", (t) => {
  const repo = tempDir(t, "ug-cap-");
  const store = storeWith(t, { hermesRepos: [repo], hermesJobKinds: ["file-scan"] });
  const capped = { configured: true, spentTodayUsd: 5 };
  assert.notEqual(routeJob(store, "file-scan", { now: NOW, payAsYouGo: capped, repo, record: false }).lane, "hermes");
  assert.notEqual(routeJob(store, "test-write", { now: NOW, payAsYouGo: hermes, repo, record: false }).lane, "hermes");
});

test("the never-Hermes rules refuse planning, review and sensitive topics", () => {
  assert.throws(() => checkTask("plan", "plan the feature"), HermesJobRefused);
  assert.throws(() => checkTask("review", "review it"), HermesJobRefused);
  for (const task of ["read the .env file", "fix the auth flow", "update Stripe billing", "tests for the children's names",
    "move the Godot scene", "rotate the API key"]) {
    assert.throws(() => checkTask("test-write", task), HermesJobRefused, task);
  }
  assert.doesNotThrow(() => checkTask("doc-update", "update the author line in the README"));
});

test("secret-like files are found anywhere outside node_modules", (t) => {
  const dir = tempDir(t, "ug-secrets-");
  for (const name of ["a/.env.local", "b/server.pem", "node_modules/x/.env", "ok.txt"]) {
    spawnSync("mkdir", ["-p", path.dirname(path.join(dir, name))]);
    writeFileSync(path.join(dir, name), "x");
  }
  assert.deepEqual(findSecretFiles(dir).sort(), ["a/.env.local", "b/server.pem"]);
});

test("hermes-job runs in a scratch worktree without untracked .env files", (t) => {
  const repo = fakeRepo(t);
  writeFileSync(path.join(repo, ".env"), "SECRET=1\n"); // untracked: must not reach the worktree
  const home = tempDir(t, "ug-home-");
  const bin = path.join(home, "fake-hermes");
  writeFileSync(bin, `#!/bin/sh\necho "args: $*"\nls -a > seen.txt\necho "// test" >> src/a.js\n`);
  chmodSync(bin, 0o755);
  const taskFile = path.join(home, "task.txt");
  writeFileSync(taskFile, "Add a unit test for src/a.js\n");
  const store = storeWith(t, { hermesRepos: [repo] });

  const summary = runHermesJob(store, {
    kind: "test-write", taskFile, repo, payAsYouGo: hermes, now: NOW, hermesBin: bin,
    env: { ...process.env, USAGE_GUARD_HOME: home },
  });
  t.after(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", summary.worktree]));
  assert.equal(summary.ok, true);
  assert.ok(summary.worktree.startsWith(path.join(home, "jobs")));
  assert.doesNotMatch(readFileSync(path.join(summary.worktree, "seen.txt"), "utf8"), /\.env/);
  assert.match(summary.diffStat, /src\/a\.js/);
  assert.match(summary.diffStat, /seen\.txt/); // new files count as changes
  assert.match(readFileSync(summary.logFile, "utf8"), /-p dstest --provider openrouter/);
  assert.ok(existsSync(path.join(path.dirname(summary.logFile), "summary.json")));
});

test("hermes-job refuses repos that are not opted in or that commit secrets", (t) => {
  const home = tempDir(t, "ug-home2-");
  const taskFile = path.join(home, "task.txt");
  writeFileSync(taskFile, "fix lint errors in src\n");
  const env = { ...process.env, USAGE_GUARD_HOME: home };
  const plain = fakeRepo(t);
  assert.throws(() => runHermesJob(storeWith(t), { kind: "lint-format", taskFile, repo: plain, payAsYouGo: hermes, now: NOW, env }),
    /not in hermesRepos/);
  const leaky = fakeRepo(t, { "src/a.js": "1\n", "config/.env": "KEY=1\n" });
  assert.throws(() => runHermesJob(storeWith(t, { hermesRepos: [leaky] }), {
    kind: "lint-format", taskFile, repo: leaky, payAsYouGo: hermes, now: NOW, env, hermesBin: "/bin/false",
  }), /secret-like files \(config\/\.env\)/);
});

test("test output is cut to failing test names and short errors", () => {
  const tap = [
    "ok 1 - adds", "not ok 2 - divides by zero", "  ---", "  duration_ms: 1.2",
    "  error: 'Expected values to be strictly equal'", "  ...", "ok 3 - other",
  ].join("\n");
  const summary = summarizeTestOutput(tap, 1);
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.failures.map((f) => f.name), ["divides by zero"]);
  assert.match(summary.failures[0].error.join(" "), /strictly equal/);

  const jest = "  ● Cart › totals\n\n    expect(received).toBe(expected)\n    Expected: 3\n    Received: 4\n";
  assert.equal(summarizeTestOutput(jest, 1).failures[0].name, "Cart › totals");
  const pytest = "FAILED tests/test_a.py::test_b - AssertionError: 1 != 2\n";
  assert.deepEqual(summarizeTestOutput(pytest, 1).failures[0], { name: "tests/test_a.py::test_b", error: ["AssertionError: 1 != 2"] });
  const unknown = summarizeTestOutput("compiling\nboom: something broke\n", 2);
  assert.deepEqual(unknown.tail, ["compiling", "boom: something broke"]);
  assert.equal(summarizeTestOutput("all good\n", 0).passed, true);
});

test("a Hermes job that OpenRouter refuses for lack of credit is reported as failed", (t) => {
  const repo = fakeRepo(t);
  const home = tempDir(t, "ug-home-");
  const bin = path.join(home, "fake-hermes");
  writeFileSync(bin, `#!/bin/sh\necho "Billing or credits exhausted: HTTP 402"\nexit 0\n`);
  chmodSync(bin, 0o755);
  const taskFile = path.join(home, "task.txt");
  writeFileSync(taskFile, "Add a unit test for src/a.js\n");
  const store = storeWith(t, { hermesRepos: [repo] });
  const summary = runHermesJob(store, {
    kind: "test-write", taskFile, repo, payAsYouGo: hermes, now: NOW, hermesBin: bin,
    env: { ...process.env, USAGE_GUARD_HOME: home },
  });
  t.after(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", summary.worktree]));
  assert.equal(summary.ok, false);
});
