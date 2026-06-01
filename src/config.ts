import { access } from "node:fs/promises";
import path from "node:path";
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
  const config = configPath.endsWith(".json") ? JSON.parse(text) : parseSimpleYaml(text);
  return { path: configPath, config: config as CatalogConfig };
}

export function parseSimpleYaml(text: string): unknown {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => stripComment(raw))
    .filter((raw) => raw.trim().length > 0);
  const root: Record<string, unknown> = {};
  let currentKey = "";
  let currentItem: Record<string, unknown> | undefined;

  for (const line of lines) {
    if (!line.startsWith(" ") && line.endsWith(":")) {
      currentKey = line.slice(0, -1).trim();
      root[currentKey] = [];
      currentItem = undefined;
      continue;
    }
    if (!currentKey) {
      throw new Error(`Unsupported YAML line before a section: ${line}`);
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      currentItem = {};
      (root[currentKey] as unknown[]).push(currentItem);
      const inline = trimmed.slice(2).trim();
      if (inline) {
        assignPair(currentItem, inline);
      }
      continue;
    }
    if (!currentItem) {
      throw new Error(`Unsupported YAML property without list item: ${line}`);
    }
    assignPair(currentItem, trimmed);
  }

  return root;
}

function stripComment(raw: string): string {
  let inQuote = false;
  let quote = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === "\"" || char === "'") && raw[index - 1] !== "\\") {
      if (!inQuote) {
        inQuote = true;
        quote = char;
      } else if (quote === char) {
        inQuote = false;
      }
    }
    if (char === "#" && !inQuote) {
      return raw.slice(0, index).trimEnd();
    }
  }
  return raw.trimEnd();
}

function assignPair(target: Record<string, unknown>, line: string): void {
  const separator = line.indexOf(":");
  if (separator === -1) {
    throw new Error(`Unsupported YAML property: ${line}`);
  }
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  target[key] = parseScalar(value);
}

function parseScalar(value: string): unknown {
  if (value === "") {
    return "";
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const body = value.slice(1, -1).trim();
    return body ? body.split(",").map((item) => parseScalar(item.trim())) : [];
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
