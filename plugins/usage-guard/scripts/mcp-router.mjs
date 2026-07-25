#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { usageGuardInvocation } from "./runtime.mjs";

const invocation = usageGuardInvocation();
const childEnv = {
  ...process.env,
  ...(invocation.providerPaths.codex
    ? { CODEX_PATH: invocation.providerPaths.codex }
    : {}),
};
const result = spawnSync(
  invocation.command,
  [...invocation.argsPrefix, "mcp"],
  {
    stdio: "inherit",
    env: childEnv,
  },
);
process.exit(result.status ?? 1);
