import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function usageGuardInvocation(env = process.env) {
  const stateHome = env.USAGE_GUARD_HOME
    ? path.resolve(env.USAGE_GUARD_HOME)
    : path.join(os.homedir(), ".usage-guard");
  const recordPath = path.join(stateHome, "install-record.json");
  if (existsSync(recordPath)) {
    try {
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      if (record.runtime?.command && typeof record.runtime.command === "string") {
        return {
          command: record.runtime.command,
          argsPrefix: Array.isArray(record.runtime.argsPrefix)
            ? record.runtime.argsPrefix.map(String)
            : [],
          providerPaths: {
            claude: typeof record.providers?.claude === "string"
              ? record.providers.claude
              : null,
            codex: typeof record.providers?.codex === "string"
              ? record.providers.codex
              : null,
          },
        };
      }
    } catch {
      // Fall through to PATH lookup for older or damaged install records.
    }
  }
  return {
    command: "usage-guard",
    argsPrefix: [],
    providerPaths: { claude: null, codex: null },
  };
}
