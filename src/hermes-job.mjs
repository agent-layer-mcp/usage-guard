import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guardHome } from "./config.mjs";
import { HERMES_KINDS, HERMES_MAX_ATTEMPTS, repoAllowed, routeJob } from "./route.mjs";

// Topics that never go to a third-party lane (docs/hermes-jobs.md, "Never to Hermes").
const NEVER_TOPICS = [
  [/\.env\b|secret|password|api[ _-]?key|\btokens?\b|credential|private key/i, "secrets"],
  [/\bauth(entication|orization)?\b|\blog ?in\b|sign[ -]?in|oauth|session cookie/i, "auth"],
  [/billing|payment|stripe|invoice|pricing|subscription/i, "billing"],
  [/\bchild(ren)?\b|\bkids?\b|student|pupil/i, "children's data"],
  [/godot/i, "Godot work"],
  [/\bdemo\b/i, "demo-critical work"],
];
// Files that must not be in the scratch worktree.
const SECRET_FILE = /^(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|credentials(\..*)?|.*\.p12)$/i;
const SKIP_DIRS = new Set([".git", "node_modules"]);

export class HermesJobRefused extends Error {}

export function checkTask(kind, task) {
  if (!HERMES_KINDS.includes(kind)) {
    throw new HermesJobRefused(`${kind} is not a Hermes job kind (${HERMES_KINDS.join(", ")}); planning and review never go to Hermes.`);
  }
  const hit = NEVER_TOPICS.find(([pattern]) => pattern.test(task));
  if (hit) throw new HermesJobRefused(`The task mentions ${hit[1]}, which never goes to Hermes.`);
}

export function findSecretFiles(root, depth = 6) {
  const found = [];
  const walk = (dir, level) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && level < depth) walk(path.join(dir, entry.name), level + 1);
      } else if (SECRET_FILE.test(entry.name)) {
        found.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  };
  walk(root, 0);
  return found;
}

// Run one Hermes job in a scratch worktree of `repo`. Refuses unless every rule passes.
export function runHermesJob(store, { kind, taskFile, repo, failedAttempts = 0, payAsYouGo, env = process.env, now = Date.now(), hermesBin = "hermes" }) {
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
  git(repoRoot, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const secrets = findSecretFiles(worktree);
  if (secrets.length) {
    git(repoRoot, ["worktree", "remove", "--force", worktree]);
    throw new HermesJobRefused(`The repo has committed secret-like files (${secrets.slice(0, 5).join(", ")}); Hermes jobs cannot run on it.`);
  }

  const args = ["-p", "dstest", "--provider", "openrouter", "-m", config.hermesModel, "-z", task];
  const result = spawnSync(hermesBin, args, { cwd: worktree, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const logFile = path.join(jobDir, "hermes.log");
  writeFileSync(logFile, `${result.stdout || ""}${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`, { mode: 0o600 });
  const diffStat = git(worktree, ["diff", "--stat"], true).stdout.trim();
  const summary = {
    kind,
    ok: !result.error && result.status === 0,
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

export function formatHermesJob(summary) {
  return [
    `${summary.ok ? "Done" : "Hermes failed"} (${summary.kind}, ${summary.model}, attempt ${summary.attempt})`,
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
