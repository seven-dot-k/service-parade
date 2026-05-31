import path from "node:path";
import type { GraphFact, HttpCallFact } from "./types.ts";
import { stableId } from "./hash.ts";

type DetectContext = {
  serviceId: string;
  file: string;
  content: string;
};

type Detector = {
  name: string;
  detect(context: DetectContext): GraphFact[];
};

const methods = "get|post|put|patch|delete|options|head";

const detectors: Detector[] = [
  { name: "aspnet", detect: detectAspNet },
  { name: "config-json", detect: detectConfigJson },
  { name: "csharp-http-client", detect: detectCSharpHttpCalls },
  { name: "nextjs", detect: detectNextJs },
  { name: "nestjs", detect: detectNestJs },
  { name: "node-http-client", detect: detectNodeHttpCalls },
  { name: "node-routes", detect: detectNodeRoutes },
  { name: "refit", detect: detectRefit }
].sort((a, b) => a.name.localeCompare(b.name));

export function detectFacts(context: DetectContext): GraphFact[] {
  const byId = new Map<string, GraphFact>();
  for (const detector of detectors) {
    for (const fact of detector.detect(context)) {
      byId.set(fact.id, fact);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeHttpUrl(raw: string): { path: string | null; host: string | null; dynamic: boolean } {
  let value = raw.trim();
  const quoted = value.match(/^(?:\$)?(["'`])([\s\S]*)\1$/);
  if (!quoted) {
    return { path: null, host: null, dynamic: true };
  }
  value = quoted[2];
  const dynamic = /\$\{[^}]+\}|\{[^}/]+\}/.test(value);
  value = value.replace(/\$\{[^}]+\}/g, "*").replace(/\{[^}/]+\}/g, "*");
  let host: string | null = null;
  const absolute = value.match(/^https?:\/\/([^/]+)(\/.*)?$/i);
  if (absolute) {
    host = absolute[1].toLowerCase();
    value = absolute[2] ?? "/";
  }
  value = value.split(/[?#]/, 1)[0].replace(/\/+/g, "/");
  if (!value.startsWith("/")) {
    return { path: null, host, dynamic: true };
  }
  if (value.length > 1) {
    value = value.replace(/\/$/, "");
  }
  return { path: value, host, dynamic };
}

export function normalizeEndpointPath(value: string): string {
  let normalized = value.trim().replace(/^["'`]|["'`]$/g, "");
  normalized = normalized.split(/[?#]/, 1)[0].replace(/\/+/g, "/");
  normalized = normalized.replace(/:[^/]+/g, "*").replace(/\{[^}/]+\}/g, "*").replace(/<[^>/]+>/g, "*");
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function detectNodeRoutes({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!isNode(file)) return [];
  const facts: GraphFact[] = [];
  const regex = new RegExp(`\\b(?:app|router|server|fastify)\\.(${methods})\\s*\\(\\s*(["'\`])([^"'\\n\`]+)\\2`, "gi");
  for (const match of content.matchAll(regex)) {
    facts.push(endpoint(serviceId, file, lineOf(content, match.index), "node", match[1], match[3]));
  }
  return facts;
}

function detectNestJs({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!isNode(file) || !/@Controller\b/.test(content)) return [];
  const prefix = content.match(/@Controller\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/)?.[1] ?? "";
  const facts: GraphFact[] = [];
  const regex = new RegExp(`@(Get|Post|Put|Patch|Delete|Options|Head)\\s*\\(\\s*(?:["'\`]([^"'\`]*)["'\`])?\\s*\\)`, "g");
  for (const match of content.matchAll(regex)) {
    facts.push(endpoint(serviceId, file, lineOf(content, match.index), "nestjs", match[1], joinRoute(prefix, match[2] ?? "")));
  }
  return facts;
}

function detectNextJs({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!isNode(file)) return [];
  const normalized = file.replace(/\\/g, "/");
  const appMatch = normalized.match(/(?:^|\/)app\/(.+)\/route\.(?:[cm]?[jt]sx?)$/);
  if (appMatch) {
    const route = `/${appMatch[1].replace(/\[(?:\.\.\.)?([^\]]+)\]/g, "{$1}").replace(/\/\([^/]+\)/g, "")}`;
    return [...content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)]
      .map((match) => endpoint(serviceId, file, lineOf(content, match.index), "nextjs-app-router", match[1], route));
  }
  const pagesMatch = normalized.match(/(?:^|\/)pages\/api\/(.+)\.(?:[cm]?[jt]sx?)$/);
  if (pagesMatch) {
    const route = `/api/${pagesMatch[1].replace(/\/index$/, "").replace(/\[(?:\.\.\.)?([^\]]+)\]/g, "{$1}")}`;
    return [endpoint(serviceId, file, 1, "nextjs-pages-router", "*", route)];
  }
  return [];
}

function detectAspNet({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!file.toLowerCase().endsWith(".cs")) return [];
  const facts: GraphFact[] = [];
  for (const match of content.matchAll(/\.Map(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*"([^"]+)"/g)) {
    facts.push(endpoint(serviceId, file, lineOf(content, match.index), "aspnet-minimal-api", match[1], match[2]));
  }
  const className = content.match(/\bclass\s+(\w+Controller)\b/)?.[1]?.replace(/Controller$/, "") ?? "";
  const controllerRoute = content.match(/\[Route\s*\(\s*"([^"]+)"\s*\)\s*\]/)?.[1]?.replace(/\[controller\]/gi, className) ?? "";
  for (const match of content.matchAll(/\[Http(Get|Post|Put|Patch|Delete|Options|Head)(?:\s*\(\s*"([^"]*)"\s*\))?\s*\]/g)) {
    facts.push(endpoint(serviceId, file, lineOf(content, match.index), "aspnet-mvc", match[1], joinRoute(controllerRoute, match[2] ?? "")));
  }
  return facts;
}

function detectNodeHttpCalls({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!isNode(file)) return [];
  const facts: GraphFact[] = [];
  for (const match of content.matchAll(/\baxios\.(get|post|put|patch|delete|options|head)\s*\(\s*([^,\n)]+)/gi)) {
    facts.push(call(serviceId, file, content, match.index, "axios", match[1], match[2]));
  }
  for (const match of content.matchAll(/\bfetch\s*\(\s*([^,\n)]+)(?:,\s*\{([\s\S]*?)\})?\s*\)/g)) {
    const method = match[2]?.match(/\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/)?.[1] ?? "GET";
    facts.push(call(serviceId, file, content, match.index, "fetch", method, match[1]));
  }
  return facts;
}

function detectCSharpHttpCalls({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!file.toLowerCase().endsWith(".cs")) return [];
  const facts: GraphFact[] = [];
  const regex = /\.(GetAsync|PostAsync|PutAsync|PatchAsync|DeleteAsync|GetFromJsonAsync|PostAsJsonAsync)\s*(?:<[^>]+>)?\s*\(\s*([^,\n)]+)/g;
  for (const match of content.matchAll(regex)) {
    facts.push(call(serviceId, file, content, match.index, "httpclient", methodFromClientCall(match[1]), match[2]));
  }
  return facts;
}

function detectRefit({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!file.toLowerCase().endsWith(".cs") || !/\binterface\b/.test(content)) return [];
  const facts: GraphFact[] = [];
  for (const match of content.matchAll(/\[(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*\)\s*\]/g)) {
    facts.push(call(serviceId, file, content, match.index, "refit", match[1], `"${match[2]}"`));
  }
  return facts;
}

function detectConfigJson({ serviceId, file, content }: DetectContext): GraphFact[] {
  if (!/appsettings(?:\.[^.]+)?\.json$/i.test(file)) return [];
  try {
    const values: Array<[string, string]> = [];
    flattenJson(JSON.parse(content), "", values);
    return values.map(([key, value], index) => ({
      id: stableId("config", serviceId, file, key, index),
      kind: "config_key",
      serviceId,
      file,
      line: 1,
      key,
      value
    }));
  } catch {
    return [];
  }
}

function endpoint(serviceId: string, file: string, line: number, framework: string, method: string, route: string): GraphFact {
  const normalized = normalizeEndpointPath(route);
  return {
    id: stableId("endpoint", serviceId, file, line, method.toUpperCase(), normalized),
    kind: "endpoint",
    serviceId,
    file,
    line,
    framework,
    httpMethod: method.toUpperCase(),
    path: normalized
  };
}

function call(serviceId: string, file: string, content: string, index: number | undefined, framework: string, method: string, rawUrl: string): HttpCallFact {
  const normalized = normalizeHttpUrl(rawUrl);
  const line = lineOf(content, index);
  return {
    id: stableId("http-call", serviceId, file, line, method.toUpperCase(), rawUrl),
    kind: "http_call",
    serviceId,
    file,
    line,
    framework,
    enclosingSymbol: `${path.basename(file)}:${line}`,
    httpMethod: method.toUpperCase(),
    rawUrl: rawUrl.trim(),
    path: normalized.path,
    host: normalized.host,
    dynamic: normalized.dynamic
  };
}

function joinRoute(prefix: string, suffix: string): string {
  return `/${[prefix, suffix].map((item) => item.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
}

function lineOf(content: string, index: number | undefined): number {
  return content.slice(0, index ?? 0).split("\n").length;
}

function methodFromClientCall(name: string): string {
  return name.replace(/FromJsonAsync|AsJsonAsync|Async/g, "").replace(/^Get$/, "GET").replace(/^Post$/, "POST").toUpperCase();
}

function flattenJson(value: unknown, prefix: string, output: Array<[string, string]>): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      flattenJson(item, prefix ? `${prefix}:${key}` : key, output);
    }
  } else if (typeof value === "string") {
    output.push([prefix, value]);
  }
}

function isNode(file: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(file);
}
