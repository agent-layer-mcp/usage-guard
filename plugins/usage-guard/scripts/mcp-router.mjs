#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { usageGuardInvocation } from "./runtime.mjs";

const invocation = usageGuardInvocation();
const result = spawnSync(
  invocation.command,
  [...invocation.argsPrefix, "mcp"],
  {
    stdio: "inherit",
    env: process.env,
  },
);
process.exit(result.status ?? 1);
