import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HttpDependency, NormalizedCatalog } from "../types.ts";
import type { GraphFact } from "./types.ts";

export async function rebuildProjection(
  root: string,
  catalog: NormalizedCatalog,
  facts: GraphFact[],
  dependencies: HttpDependency[]
): Promise<void> {
  const worker = fileURLToPath(new URL("./projection-worker.ts", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, root], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`SurrealDB projection worker exited with ${code}: ${stderr.trim()}`));
      }
    });
    child.stdin.end(JSON.stringify({ catalog, facts, dependencies }));
  });
}

// The embedded engine is isolated in a worker, so there is no parent-process
// connection to release. Keep this API stable for callers that use finally().
export async function closeProjection(_root: string): Promise<void> {}
