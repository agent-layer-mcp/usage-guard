#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { usageGuardInvocation } from "./runtime.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;

let payload = {};
try {
  payload = input.trim() ? JSON.parse(input) : {};
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

const provider = process.env.PLUGIN_ROOT ? "codex" : "claude";
const event = payload.hook_event_name || payload.hookEventName || "UserPromptSubmit";
const invocation = usageGuardInvocation();
const childEnv = {
  ...process.env,
  ...(invocation.providerPaths.codex
    ? { CODEX_PATH: invocation.providerPaths.codex }
    : {}),
};
const result = spawnSync(invocation.command, [
  ...invocation.argsPrefix,
  "hook",
  provider,
  event,
], {
  input: JSON.stringify(payload),
  encoding: "utf8",
  env: childEnv,
});

if (result.status === 0 && result.stdout.trim()) process.stdout.write(result.stdout);
else process.stdout.write("{}\n");
