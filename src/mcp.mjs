import readline from "node:readline";
import { CONFIG_SCHEMA, VERSION } from "./config.mjs";
import { completeStatus, providerDecision, syncCodex } from "./service.mjs";

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

export async function handleRequest(store, request) {
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
  if (request.method === "tools/call") return callTool(store, request.params || {});
  throw new Error(`Unsupported MCP method: ${request.method}`);
}

async function callTool(store, params) {
  const args = params.arguments || {};
  let value;
  if (params.name === "usage_guard_status") {
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
