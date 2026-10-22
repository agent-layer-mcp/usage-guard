import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guardHome } from "./config.mjs";
import { HERMES_KINDS, HERMES_MAX_ATTEMPTS, localDay, repoAllowed, routeJob } from "./route.mjs";

// Topics that never go to a third-party lane (docs/hermes-jobs.md, "Never to Hermes").
// Matched on normalised text (see normaliseTask), so these are lowercase word stems.
const NEVER_TOPICS = [
  [/(?<!process|meta)\.env\b|secret|passw(or)?d|passphrase|api ?key|(?<!design |lexer )\btokens?\b|credential|private ?key|ssh ?key|\bjwt\b|\bbearer\b|\bcookies?\b/, "secrets"],
  // "auth", "authn", "authz", "authenticate/-or/-ion", "authorize/-ation"; not "author" or "authoring".
  [/\bauth(entic\w*|ori[sz]\w*|[nz]?\b)|\blog ?in\b|\bsign ?in\b|oauth/, "auth"],
  [/billing|payment|stripe|invoice|pricing/, "billing"],
  [/\bchild(ren)?\b|\bkids?\b|student|pupil/, "children's data"],
  [/godot/, "Godot work"],
  [/\bdemo\b/, "demo-critical work"],
];
// Files that must not be in the scratch worktree.
const SECRET_FILE = new RegExp(`^(${[
  "\\.env(\\..*)?", ".*\\.pem", ".*\\.key", "id_rsa.*", "id_ecdsa.*", "id_ed25519.*", "credentials(\\..*)?", "credentials.*\\.json",
  ".*\\.p12", ".*\\.pfx", ".*\\.keystore", ".*\\.jks", "\\.npmrc", "\\.netrc", "\\.pgpass", "\\.git-credentials",
  ".*\\.tfvars", "service-account.*\\.json",
].join("|")})$`, "i");
const SKIP_DIRS = new Set([".git", "node_modules"]);
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
// The only environment Hermes sees: its OpenRouter key lives in the "dstest" profile under HOME (~/.hermes/profiles/dstest/.env),
// so HOME must pass; OPENROUTER_API_KEY passes too in case the profile relies on it. No other tokens (Anthropic, GitHub, ...) leak.
const HERMES_ENV = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "TZ", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "OPENROUTER_API_KEY", "USAGE_GUARD_HOME",
  "HERMES_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
  ...(process.platform === "win32" ? ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"] : [])];

export class HermesJobRefused extends Error {}

export function hermesEnv(env) {
  return Object.fromEntries(HERMES_ENV.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
}

// "fixPrivateKey", "private_key" and "private-key" all become "private key".
export function normaliseTask(task) {
  return task.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/[_-]/g, " ").toLowerCase();
}

export function checkTask(kind, task) {
  if (!HERMES_KINDS.includes(kind)) {
    throw new HermesJobRefused(`${kind} is not a Hermes job kind (${HERMES_KINDS.join(", ")}); planning and review never go to Hermes.`);
  }
  const text = normaliseTask(task);
  const hit = NEVER_TOPICS.find(([pattern]) => pattern.test(text));
  if (hit) throw new HermesJobRefused(`The task mentions ${hit[1]}, which never goes to Hermes.`);
}

// Walks the whole tree (minus .git and node_modules). Symlinks are not followed; one whose target
// leaves `root` (or cannot be resolved) would hand Hermes files outside the worktree.
export function scanWorktree(root) {
  const secrets = [];
  const escapingLinks = [];
  const realRoot = realpathSync(root);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try { target = realpathSync(full); } catch { target = path.resolve(dir, readlinkSync(full)); }
        if (target !== realRoot && !target.startsWith(realRoot + path.sep)) escapingLinks.push(path.relative(root, full));
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (SECRET_FILE.test(entry.name)) {
        secrets.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return { secrets, escapingLinks };
}

export function findSecretFiles(root) {
  return scanWorktree(root).secrets;
}

// Run one Hermes job in a scratch worktree of `repo`. Refuses unless every rule passes.
export async function runHermesJob(store, { kind, taskFile, repo, failedAttempts = 0, payAsYouGo, env = process.env, now = Date.now(), hermesBin = "hermes", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const task = readFileSync(taskFile, "utf8").trim();
  if (!task) throw new HermesJobRefused("The task file is empty.");
  checkTask(kind, task);
  const config = store.getConfig();
  const repoRoot = git(repo, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (!repoAllowed(repoRoot, config.hermesRepos)) {
    throw new HermesJobRefused(`${repoRoot} is not in hermesRepos. Opt it in with \`usage-guard config hermesRepos '["${repoRoot}"]'\`.`);
  }
  const route = routeJob(store, kind, { now, config, payAsYouGo, repo: repoRoot, failedAttempts });
  if (route.lane !== "hermes") {
    throw new HermesJobRefused(`Route says ${route.lane}, not hermes: ${route.reason}`);
  }

  const id = `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${kind}`;
  const jobDir = path.join(guardHome(env), "jobs", id);
  const worktree = path.join(jobDir, "worktree");
  mkdirSync(jobDir, { recursive: true });
  // A detached worktree of committed files only: untracked .env files and local data are not copied.
  // Whatever goes wrong before Hermes runs (a refusal, EACCES while scanning), the worktree must not be left behind.
  try {
    git(repoRoot, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const { secrets, escapingLinks } = scanWorktree(worktree);
    if (secrets.length) {
      throw new HermesJobRefused(`The repo has committed secret-like files (${secrets.slice(0, 5).join(", ")}); Hermes jobs cannot run on it.`);
    }
    if (escapingLinks.length) {
      throw new HermesJobRefused(`The repo has symlinks that leave it (${escapingLinks.slice(0, 5).join(", ")}); Hermes jobs cannot run on it.`);
    }
  } catch (error) {
    spawnSync("chmod", ["-R", "u+rwx", worktree], { stdio: "ignore" }); // an unreadable directory would block the removal
    spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", worktree], { stdio: "ignore" });
    spawnSync("git", ["-C", repoRoot, "worktree", "prune"], { stdio: "ignore" });
    throw error;
  }

  const args = ["-p", "dstest", "--provider", "openrouter", "-m", config.hermesModel, "-z", task];
  // shortcut: the task is in argv (visible in `ps`); hermes -z has no stdin or file form, so switch if it gains one.
  const result = await runHermes(hermesBin, args, { cwd: worktree, env: hermesEnv(env), timeoutMs });
  const timedOut = result.error?.code === "ETIMEDOUT";
  const logFile = path.join(jobDir, "hermes.log");
  writeFileSync(logFile, `${result.stdout || ""}${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`, { mode: 0o600 });
  // Mark new files as intended, so a job that only adds files (e.g. a new test) still shows in the diff.
  git(worktree, ["add", "--intent-to-add", "--all"], true);
  const diffStat = git(worktree, ["diff", "--stat"], true).stdout.trim();
  const noCredit = /HTTP 402|credits exhausted/i.test(`${result.stdout}${result.stderr}`);
  if (noCredit) store.setNoticeState("hermes", "credit-closed", localDay(now), now);
  const summary = {
    kind,
    // Hermes can exit 0 after OpenRouter refuses the turn for lack of credit.
    ok: !result.error && result.status === 0 && !noCredit,
    timedOut,
    exitCode: result.status ?? null,
    model: config.hermesModel,
    attempt: failedAttempts + 1,
    worktree,
    logFile,
    diffStat,
    next: diffStat
      ? "Run the job's check (lint, type check or tests) in the worktree, then have Claude review the diff before applying it."
      : "Hermes made no file changes.",
    retry: `If the check fails, rerun with --failed ${failedAttempts + 1}; after ${HERMES_MAX_ATTEMPTS} failed attempts the route escalates to Claude or Codex.`,
  };
  writeFileSync(path.join(jobDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

// Hermes gets its own process group (POSIX) so a timeout kills the tools it started too, not just the direct child.
function runHermes(bin, args, { cwd, env, timeoutMs }) {
  const posix = process.platform !== "win32";
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, detached: posix, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let error;
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { posix ? process.kill(-child.pid, "SIGKILL") : child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("error", (e) => { error = e; });
    // "close" waits for the pipes, which a surviving grandchild would hold open; the group kill above ends them.
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) error = Object.assign(new Error(`hermes timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" });
      resolve({ stdout, stderr, status, error });
    });
  });
}

export function formatHermesJob(summary) {
  return [
    `${summary.ok ? "Done" : summary.timedOut ? "Hermes timed out and was killed" : "Hermes failed"} (${summary.kind}, ${summary.model}, attempt ${summary.attempt})`,
    `Worktree: ${summary.worktree}`,
    summary.diffStat ? `Changes:\n${summary.diffStat}` : "Changes: none",
    `Full log: ${summary.logFile}`,
    summary.next,
    summary.retry,
  ].join("\n");
}

function git(cwd, args, allowFailure = false) {
  if (!existsSync(cwd)) throw new HermesJobRefused(`${cwd} does not exist.`);
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new HermesJobRefused(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  }
  return result;
}
