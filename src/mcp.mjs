import readline from "node:readline";
import { VERSION } from "./config.mjs";
import { completeStatus, providerDecision, syncCodex } from "./service.mjs";

const TOOLS = [
  {
    name: "usage_guard_status",
    description: "Read local Claude Code and Codex quota windows, forecasts, and deliberate pacing choices.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "usage_guard_decision",
    description: "Get a quality-preserving pacing decision for a provider and task. Prompt text is classified in memory and never stored.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["claude", "codex"] },
        task: { type: "string", description: "Optional task description used only for transient classification." },
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
    description: "Change local reserve percentages or enforcement mode without changing model quality.",
    inputSchema: {
      type: "object",
      properties: {
        enforcement: { type: "string", enum: ["observe", "protect"] },
        fiveHourReservePercent: { type: "number", minimum: 0, maximum: 30 },
        weeklyReservePercent: { type: "number", minimum: 0, maximum: 30 },
        contextWatchPercent: { type: "number", minimum: 1, maximum: 99 },
        contextProtectPercent: { type: "number", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
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
      instructions: "Use Usage Guard to preserve quota without silently lowering model quality.",
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
  if (params.name === "usage_guard_status") value = completeStatus(store);
  else if (params.name === "usage_guard_decision") {
    value = providerDecision(store, args.provider, { prompt: args.task || "" });
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
