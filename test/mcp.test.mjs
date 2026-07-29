import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/mcp.mjs";
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
  assert.equal(configure.inputSchema.properties.contextWatchPercent.maximum, 99);
  assert.equal(configure.inputSchema.properties.contextProtectPercent.maximum, 100);
  assert.equal(configure.inputSchema.properties.compactionHandoffEnabled.type, "boolean");

  const result = await handleRequest(store, {
    method: "tools/call",
    params: { name: "usage_guard_status", arguments: {} },
  });
  assert.equal(result.structuredContent.privacy.promptStored, false);
  assert.equal(result.isError, false);
  store.close();
});
