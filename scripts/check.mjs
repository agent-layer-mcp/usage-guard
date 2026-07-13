import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = walk(root).filter((file) => file.endsWith(".mjs"));

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Checked ${files.length} JavaScript modules.`);

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory)) {
    if ([".git", "node_modules", "coverage"].includes(entry)) continue;
    const fullPath = path.join(directory, entry);
    if (statSync(fullPath).isDirectory()) output.push(...walk(fullPath));
    else output.push(fullPath);
  }
  return output;
}
