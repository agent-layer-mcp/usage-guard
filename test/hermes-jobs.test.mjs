import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkTask, findSecretFiles, formatHermesJob, HermesJobRefused, hermesEnv, runHermesJob } from "../src/hermes-job.mjs";
import { routeJob } from "../src/route.mjs";
import { GuardStore } from "../src/store.mjs";
import { formatTestRun, runTests, summarizeTestOutput } from "../src/test-run.mjs";

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
  // The lane stays closed for the rest of the day, then reopens.
  const lane = (at) => routeJob(store, "test-write", { now: at, payAsYouGo: hermes, repo, record: false }).lanes.find((l) => l.lane === "hermes");
  assert.equal(lane(NOW + 60_000).available, false);
  assert.match(lane(NOW + 60_000).reason, /credit is used up/);
  assert.equal(lane(NOW + 48 * 3600_000).available, true);
});

test("task topic refusal survives spelling variants but not look-alike words", () => {
  const refused = ["authenticate the user", "add an authenticator app", "fix authn", "check authz rules", "rotate the private_key", "load privateKey",
    "the private-key path", "validate the JWT", "bearer header", "set the cookie", "copy the ssh key", "update /etc/passwd parser", "login credentials form",
    "Sign-in page", "log in screen", "APIKey helper", "clientSecret field", "authorization header", "OAuth callback"];
  const accepted = ["update the author line in the README", "authoring guide typo", "co-author credit", "authority table", "fix lint errors in src",
    "write unit tests for parseDate", "tokenizer edge cases", "design interface docs"];
  for (const task of refused) assert.throws(() => checkTask("test-write", task), HermesJobRefused, task);
  for (const task of accepted) assert.doesNotThrow(() => checkTask("test-write", task), task);
});

test("secret-like files cover keystores, rc files and cloud credentials, at any depth", (t) => {
  const dir = tempDir(t, "ug-secrets2-");
  const names = [".npmrc", ".netrc", ".pgpass", ".git-credentials", "a.pfx", "a.p12", "a.keystore", "a.jks", "id_ecdsa", "id_ed25519.pub",
    "prod.tfvars", "service-account-prod.json", "credentials-gcp.json", "deep/1/2/3/4/5/6/7/8/.env"];
  for (const name of [...names, "package.json", "notes.md"]) {
    spawnSync("mkdir", ["-p", path.dirname(path.join(dir, name))]);
    writeFileSync(path.join(dir, name), "x");
  }
  assert.deepEqual(findSecretFiles(dir).sort(), [...names].sort());
});

test("hermes gets only an allowlisted environment", (t) => {
  assert.deepEqual(hermesEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "g", CLAUDE_CODE_OAUTH_TOKEN: "c", OPENROUTER_API_KEY: "o" }),
    { PATH: "/bin", HOME: "/h", OPENROUTER_API_KEY: "o" });
  const repo = fakeRepo(t);
  const home = tempDir(t, "ug-env-");
  const bin = path.join(home, "fake-hermes");
  writeFileSync(bin, "#!/bin/sh\nenv > env.txt\n");
  chmodSync(bin, 0o755);
  const taskFile = path.join(home, "task.txt");
  writeFileSync(taskFile, "fix lint errors in src\n");
  const summary = runHermesJob(storeWith(t, { hermesRepos: [repo] }), {
    kind: "lint-format", taskFile, repo, payAsYouGo: hermes, now: NOW, hermesBin: bin,
    env: { ...process.env, USAGE_GUARD_HOME: home, ANTHROPIC_API_KEY: "sk-leak", GITHUB_TOKEN: "gh-leak", CLAUDE_CODE_OAUTH_TOKEN: "oauth-leak" },
  });
  t.after(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", summary.worktree]));
  const seen = readFileSync(path.join(summary.worktree, "env.txt"), "utf8");
  assert.match(seen, /^HOME=/m);
  assert.match(seen, new RegExp(`^USAGE_GUARD_HOME=${home}$`, "m"));
  assert.doesNotMatch(seen, /leak|ANTHROPIC|GITHUB|OAUTH/);
});

test("a hung hermes is killed at the timeout and reported", (t) => {
  const repo = fakeRepo(t);
  const home = tempDir(t, "ug-timeout-");
  const bin = path.join(home, "fake-hermes");
  writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
  chmodSync(bin, 0o755);
  const taskFile = path.join(home, "task.txt");
  writeFileSync(taskFile, "fix lint errors in src\n");
  const started = Date.now();
  const summary = runHermesJob(storeWith(t, { hermesRepos: [repo] }), {
    kind: "lint-format", taskFile, repo, payAsYouGo: hermes, now: NOW, hermesBin: bin, timeoutMs: 300,
    env: { ...process.env, USAGE_GUARD_HOME: home },
  });
  t.after(() => spawnSync("git", ["-C", repo, "worktree", "remove", "--force", summary.worktree]));
  assert.ok(Date.now() - started < 10_000);
  assert.equal(summary.ok, false);
  assert.equal(summary.timedOut, true);
  assert.match(formatHermesJob(summary), /timed out and was killed/);
});

test("test-run kills a hung command at the timeout", (t) => {
  const home = tempDir(t, "ug-trun-");
  const run = runTests(["sleep", "30"], { timeoutMs: 300, env: { ...process.env, USAGE_GUARD_HOME: home } });
  assert.equal(run.timedOut, true);
  assert.equal(run.passed, false);
  assert.match(formatTestRun(run), /Timed out and was killed/);
});

test("the scratch worktree is removed when a refusal or a scan error happens after it is created", (t) => {
  const home = tempDir(t, "ug-leak-");
  const taskFile = path.join(home, "task.txt");
  writeFileSync(taskFile, "fix lint errors in src\n");
  const env = { ...process.env, USAGE_GUARD_HOME: home };
  const worktrees = (repo) => spawnSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).stdout.trim().split("\n").length;

  const leaky = fakeRepo(t, { "src/a.js": "1\n", ".npmrc": "//registry/:_authToken=x\n" });
  assert.throws(() => runHermesJob(storeWith(t, { hermesRepos: [leaky] }), { kind: "lint-format", taskFile, repo: leaky, payAsYouGo: hermes, now: NOW, env, hermesBin: "/bin/false" }), /\.npmrc/);
  assert.equal(worktrees(leaky), 1);

  // An unreadable directory makes the scan throw EACCES (skipped when running as root, which can read it anyway).
  if (process.getuid?.() !== 0) {
    const locked = fakeRepo(t, { "src/a.js": "1\n", "locked/b.js": "2\n" });
    const hook = path.join(locked, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\nchmod 000 "$PWD/locked"\n`);
    chmodSync(hook, 0o755);
    assert.throws(() => runHermesJob(storeWith(t, { hermesRepos: [locked] }), { kind: "lint-format", taskFile, repo: locked, payAsYouGo: hermes, now: NOW, env, hermesBin: "/bin/false" }), /EACCES/);
    assert.equal(worktrees(locked), 1);
  }
});

test("symlinks that leave the worktree are refused, ones that stay inside are fine", (t) => {
  const outside = tempDir(t, "ug-outside-");
  writeFileSync(path.join(outside, "secret.txt"), "top secret");
  const repo = fakeRepo(t, { "src/a.js": "1\n" });
  symlinkSync("a.js", path.join(repo, "src", "inside.js"));
  const run = (...args) => assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  run("add", "-A");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "inside link");
  assert.deepEqual(findSecretFiles(repo), []);

  const home = tempDir(t, "ug-link-");
  const taskFile = path.join(home, "task.txt");
  writeFileSync(taskFile, "fix lint errors in src\n");
  symlinkSync(outside, path.join(repo, "docs-link"));
  symlinkSync("/nonexistent/target", path.join(repo, "dangling"));
  run("add", "-A");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "escaping links");
  assert.throws(() => runHermesJob(storeWith(t, { hermesRepos: [repo] }), {
    kind: "lint-format", taskFile, repo, payAsYouGo: hermes, now: NOW, env: { ...process.env, USAGE_GUARD_HOME: home }, hermesBin: "/bin/false",
  }), /symlinks that leave it \((docs-link, dangling|dangling, docs-link)\)/);
  assert.equal(spawnSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).stdout.trim().split("\n").length, 1);
});

test("Hermes env passes proxy and CA settings but no secrets", () => {
  const env = hermesEnv({ HERMES_HOME: "/h", HTTPS_PROXY: "p", https_proxy: "p", NO_PROXY: "n", SSL_CERT_FILE: "c", REQUESTS_CA_BUNDLE: "b", ANTHROPIC_API_KEY: "x", GITHUB_TOKEN: "y" });
  assert.deepEqual(Object.keys(env).sort(), ["HERMES_HOME", "HTTPS_PROXY", "NO_PROXY", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "https_proxy"]);
});
