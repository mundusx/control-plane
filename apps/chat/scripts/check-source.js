import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const sourceFiles = collectJavaScriptFiles(sourceRoot);

for (const sourceFile of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", sourceFile], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Checked ${sourceFiles.length} MundusX Chat source modules.`);

function collectJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectJavaScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
    })
    .sort();
}
