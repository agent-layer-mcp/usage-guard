import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { CONFIG_SCHEMA, VERSION } from "./config.mjs";
import { HermesJobRefused, runHermesJob } from "./hermes-job.mjs";
import { TASK_ROLES } from "./model-stepping.mjs";
import { HERMES_KINDS, OUTCOME_LANES, readOpenRouterSpend, recordRouteOutcome, ROUTE_KINDS, routeJob } from "./route.mjs";
import { completeStatus, providerDecision, syncCodex } from "./service.mjs";
import { OUTCOME_RESULTS } from "./store.mjs";
import { DIFFICULTIES } from "./task-fit.mjs";

const TOOLS = [
  {
    name: "usage_guard_status",
    description: "Read local quota windows, model recommendations, overnight steps, and pacing choices.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["claude", "codex"] },
        role: { type: "string", enum: ["planning", "architecture", "review", "sensitive", "routine", "standard"] },
        task: { type: "string", description: "Optional task description classified in memory; never stored." },
        sessionId: { type: "string", description: "Optional current session identifier for context readings." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "usage_guard_decision",
    description: "Get a quota pacing and role-aware model recommendation for a provider and task. Task text is classified in memory and never stored.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["claude", "codex"] },
        task: { type: "string", description: "Optional task description used only for transient classification." },
        role: { type: "string", enum: ["planning", "architecture", "review", "sensitive", "routine", "standard"] },
        sessionId: { type: "string" },
      },
      required: ["provider"],
      additionalProperties: false,
    },
  },
  {
    name: "usage_guard_sync_codex",
    description: "Refresh Codex quota windows through the local documented Codex app-server protocol.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "usage_guard_route",
    description: "Pick the lane, model and effort for one delegated task from its kind and difficulty. Quota can only make the pick cheaper. No task text is taken or stored.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...ROUTE_KINDS] },
        difficulty: { type: "string", enum: [...DIFFICULTIES] },
        role: { type: "string", enum: TASK_ROLES, description: "Pass planning, architecture, review or sensitive for protected work." },
        failed: { type: "integer", minimum: 0, description: "Failed attempts so far for this task." },
        repo: { type: "string", description: "Repo path (needed for Hermes)." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "usage_guard_hermes_job",
    description: "Run one task on Hermes (OpenRouter) when usage_guard_route says hermes. It works in a scratch git worktree of the repo's committed files, runs the optional check there, records the result and returns the worktree path and diff summary. Nothing is applied to the repo: review the diff, then apply it. Refuses planning, review, secrets, auth, billing and children's data.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...HERMES_KINDS] },
        task: { type: "string", maxLength: 20000, description: "Full instructions for Hermes: files, the change, how to check it." },
        repo: { type: "string", description: "Repo path; must be in hermesRepos." },
        difficulty: { type: "string", enum: ["easy", "medium"] },
        check: { type: "array", items: { type: "string" }, maxItems: 50, description: "Test command and arguments, e.g. [\"npm\", \"test\"]." },
        failed: { type: "integer", minimum: 0, description: "Failed Hermes attempts so far for this task." },
      },
      required: ["kind", "task", "repo"],
      additionalProperties: false,
    },
  },
  {
    name: "usage_guard_outcome",
    description: "Record how a routed task went after its check, so success rates per model and task type can be tuned. No task text is stored.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", enum: [...OUTCOME_LANES] },
        model: { type: "string" },
        kind: { type: "string", enum: [...ROUTE_KINDS] },
        difficulty: { type: "string", enum: [...DIFFICULTIES] },
        result: { type: "string", enum: [...OUTCOME_RESULTS] },
      },
      required: ["lane", "model", "kind", "result"],
      additionalProperties: false,
    },
  },
  {
    name: "usage_guard_configure",
    description: "Change any local Usage Guard setting, including model ladders, thresholds, quiet hours, reserves, and quality lock.",
    inputSchema: CONFIG_SCHEMA,
  },
];

export function runMcpServer(store, streams = {}) {
  const input = streams.input || process.stdin;
  const output = streams.output || process.stdout;
  const lines = readline.createInterface({ input });

  lines.on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.id == null) return;
    try {
      const result = await handleRequest(store, request);
      write({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } });
    }
  });

  function write(message) {
    output.write(`${JSON.stringify(message)}\n`);
  }
  return lines;
}

export async function handleRequest(store, request, options = {}) {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "usage-guard", version: VERSION },
      instructions: store.getConfig().modelStepping && !store.getConfig().qualityLock
        ? "Use Usage Guard model recommendations at task boundaries. Switch the current session model when supported; otherwise use recommended-model subagents. Never switch mid-edit."
        : "Use Usage Guard to preserve quota without silently lowering model quality.",
    };
  }
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools: TOOLS };
  if (request.method === "tools/call") return callTool(store, request.params || {}, options);
  throw new Error(`Unsupported MCP method: ${request.method}`);
}

async function callTool(store, params, options = {}) {
  const args = params.arguments || {};
  let value;
  if (params.name === "usage_guard_hermes_job") {
    // The task text goes to a private temp file only for the run; it is never stored in Usage Guard's database.
    const dir = mkdtempSync(path.join(os.tmpdir(), "usage-guard-task-"));
    try {
      const taskFile = path.join(dir, "task.txt");
      writeFileSync(taskFile, String(args.task ?? ""), { mode: 0o600 });
      value = await runHermesJob(store, {
        kind: args.kind, taskFile, repo: args.repo, difficulty: args.difficulty, check: args.check,
        failedAttempts: args.failed ?? 0, payAsYouGo: await (options.readSpend || readOpenRouterSpend)(),
        ...(options.hermesBin && { hermesBin: options.hermesBin }), ...(options.env && { env: options.env }),
      });
    } catch (error) {
      if (!(error instanceof HermesJobRefused || error instanceof TypeError)) throw error;
      return { content: [{ type: "text", text: `Refused: ${error.message}` }], isError: true };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else if (params.name === "usage_guard_route" || params.name === "usage_guard_outcome") {
    // Bad input is the caller's to fix: report it as a tool error, not a server failure.
    try {
      value = params.name === "usage_guard_route"
        ? routeJob(store, args.kind, {
          difficulty: args.difficulty, role: args.role, failedAttempts: args.failed ?? 0,
          repo: args.repo || process.cwd(), payAsYouGo: await (options.readSpend || readOpenRouterSpend)(),
        })
        : recordRouteOutcome(store, { lane: args.lane, model: args.model, kind: args.kind, difficulty: args.difficulty, result: args.result });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
  } else if (params.name === "usage_guard_status") {
    value = completeStatus(store, {
      providers: args.provider ? [args.provider] : undefined,
      role: args.role,
      prompt: args.task || "",
      sessionId: args.sessionId,
    });
  }
  else if (params.name === "usage_guard_decision") {
    value = providerDecision(store, args.provider, {
      prompt: args.task || "",
      role: args.role,
      sessionId: args.sessionId,
    });
  } else if (params.name === "usage_guard_sync_codex") {
    await syncCodex(store);
    value = providerDecision(store, "codex");
  } else if (params.name === "usage_guard_configure") value = store.setConfig(args);
  else throw new Error(`Unknown Usage Guard tool: ${params.name}`);

  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}
