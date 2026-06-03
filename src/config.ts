import { access } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { CatalogConfig } from "./types.ts";
import { CONFIG_CANDIDATES } from "./paths.ts";
import { readText } from "./fs.ts";

export async function findConfig(root: string, explicit?: string): Promise<string> {
  if (explicit) {
    return path.resolve(root, explicit);
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = path.join(root, candidate);
    try {
      await access(fullPath);
      return fullPath;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`No catalog config found. Run "service-parade init" to create service-parade.yaml.`);
}

export async function loadConfig(root: string, explicit?: string): Promise<{ path: string; config: CatalogConfig }> {
  const configPath = await findConfig(root, explicit);
  const text = await readText(configPath);
  const config = configPath.endsWith(".json") ? JSON.parse(text) : parse(text);
  return { path: configPath, config: config as CatalogConfig };
}
