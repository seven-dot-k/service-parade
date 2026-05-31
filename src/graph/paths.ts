import path from "node:path";
import { resolveOutput } from "../paths.ts";

export function resolveGraph(root: string, file: string): string {
  return resolveOutput(root, path.join("graph", file));
}

export function resolveGraphDb(root: string): string {
  return resolveGraph(root, "graph.sqlite");
}

export function resolveSurrealGraph(root: string): string {
  return resolveGraph(root, "surreal");
}
