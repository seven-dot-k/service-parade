import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HttpEvidence, NormalizedCatalog, NormalizedSdkSource, NormalizedService } from "../types.ts";
import { toPosix } from "../paths.ts";
import { normalizeEndpointPath, normalizeHttpUrl } from "./detectors.ts";
import { stableId } from "./hash.ts";
import { supportsAnalysis } from "./parser.ts";
import type { EndpointFact, GraphFact, HttpCallFact } from "./types.ts";

const exec = promisify(execFile);
const excluded = new Set([
  ".git", ".service-parade", ".codeiq", "node_modules", "dist", "build", "out", "bin", "obj",
  "coverage", ".next", ".nuxt", ".cache", "target", "vendor"
]);

export type PackageUsage = {
  packageName: string;
  file: string;
  line: number;
};

export type SdkAnalysisFile = {
  id: string;
  serviceId: string;
  absolutePath: string;
  relativePath: string;
  sdkSource: NormalizedSdkSource;
  packageUsage: PackageUsage;
};

export async function discoverSdkAnalysisFiles(
  catalog: NormalizedCatalog,
  service: NormalizedService
): Promise<SdkAnalysisFile[]> {
  const repo = catalog.repos.find((item) => item.id === service.repoId);
  const enabledPatterns = repo?.httpDiscovery.sdkPackages ?? [];
  if (enabledPatterns.length === 0 || catalog.sdkSources.length === 0) {
    return [];
  }

  const usages = (await discoverPackageUsages(catalog.root, service.absolutePath))
    .filter((usage) => matchesAnyPattern(usage.packageName, enabledPatterns))
    .sort(comparePackageUsages);
  if (usages.length === 0) {
    return [];
  }

  const files: SdkAnalysisFile[] = [];
  const sourceFileCache = new Map<string, string[]>();
  for (const sdkSource of catalog.sdkSources) {
    const usage = usages.find((item) => matchesAnyPattern(item.packageName, sdkSource.packages));
    if (!usage) {
      continue;
    }
    const sourceWithLoadedOptions = await loadSdkSourceOptions(sdkSource);
    const sourceFiles = sourceFileCache.get(sdkSource.id) ?? await discoverSdkSourceFiles(sourceWithLoadedOptions);
    sourceFileCache.set(sdkSource.id, sourceFiles);
    for (const sourceFile of sourceFiles) {
      const absolutePath = path.resolve(sourceWithLoadedOptions.absolutePath, sourceFile);
      const relativePath = toPosix(path.relative(catalog.root, absolutePath));
      files.push({
        id: `${service.id}:sdk:${sourceWithLoadedOptions.id}:${relativePath}`,
        serviceId: service.id,
        absolutePath,
        relativePath,
        sdkSource: sourceWithLoadedOptions,
        packageUsage: usage
      });
    }
  }
  return files.sort((a, b) => a.id.localeCompare(b.id));
}

export function detectSdkFacts(context: {
  serviceId: string;
  file: string;
  content: string;
  sdkSource: NormalizedSdkSource;
  packageUsage: PackageUsage;
}): GraphFact[] {
  if (context.sdkSource.detector === "mozu-service-client") {
    return detectMozuServiceClientFacts(context);
  }
  throw new Error(`Unsupported SDK source detector "${context.sdkSource.detector}" for SDK source "${context.sdkSource.id}".`);
}

export function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => packagePatternToRegExp(pattern).test(value));
}

async function discoverPackageUsages(root: string, serviceRoot: string): Promise<PackageUsage[]> {
  const files = await gitFiles(serviceRoot).catch(() => walkFiles(serviceRoot));
  const usages: PackageUsage[] = [];
  for (const file of files.filter((item) => item.toLowerCase().endsWith(".cs") || item.toLowerCase().endsWith(".csproj"))) {
    const absolutePath = path.resolve(serviceRoot, file);
    const relativePath = toPosix(path.relative(root, absolutePath));
    const content = await readFile(absolutePath, "utf8");
    if (file.toLowerCase().endsWith(".csproj")) {
      for (const match of content.matchAll(/<PackageReference\b[^>]*\bInclude\s*=\s*"([^"]+)"/g)) {
        usages.push({ packageName: match[1], file: relativePath, line: lineOf(content, match.index) });
      }
    } else {
      for (const match of content.matchAll(/^\s*using\s+([A-Za-z_][\w.]*)\s*;/gm)) {
        usages.push({ packageName: match[1], file: relativePath, line: lineOf(content, match.index) });
      }
    }
  }
  return dedupePackageUsages(usages);
}

async function discoverSdkSourceFiles(source: NormalizedSdkSource): Promise<string[]> {
  const clientDir = stringOption(source.options.clientDir) ?? "Clients";
  const candidates = await gitFiles(path.resolve(source.absolutePath, clientDir)).catch(() => walkFiles(path.resolve(source.absolutePath, clientDir)));
  return candidates
    .filter(supportsAnalysis)
    .map((file) => toPosix(path.join(clientDir, file)))
    .sort();
}

async function loadSdkSourceOptions(source: NormalizedSdkSource): Promise<NormalizedSdkSource> {
  if (source.detector !== "mozu-service-client") {
    return source;
  }
  const codegenTargets = stringOption(source.options.codegenTargets) ?? "CCG.targets";
  const codegenTargetsPath = path.resolve(source.absolutePath, codegenTargets);
  const codegenTargetsContent = await readFile(codegenTargetsPath, "utf8").catch(() => "");
  return {
    ...source,
    options: {
      ...source.options,
      codegenTargetsContent
    }
  };
}

function detectMozuServiceClientFacts(context: {
  serviceId: string;
  file: string;
  content: string;
  sdkSource: NormalizedSdkSource;
  packageUsage: PackageUsage;
}): GraphFact[] {
  if (!context.file.toLowerCase().endsWith(".cs")) {
    return [];
  }
  const clientName = context.content.match(/\bclass\s+(\w+WebApiClient)\b/)?.[1];
  const allowedClients = mozuGeneratedClientNames(context.sdkSource.options);
  if (!clientName || (allowedClients.size > 0 && !allowedClients.has(clientName))) {
    return [];
  }
  const mozuServiceId = context.content.match(/\bpublic\s+override\s+string\s+ServiceId\b[\s\S]*?return\s+"([^"]+)"/)?.[1];
  if (!mozuServiceId) {
    return [];
  }

  const facts: GraphFact[] = [];
  const regex = /var\s+relpath\s*=\s*([\s\S]*?);\s*return\s+Handler\.SendAsync(?:<[\s\S]*?>)?\s*\(\s*"([A-Za-z]+)"\s*,\s*relpath/g;
  for (const match of context.content.matchAll(regex)) {
    const line = lineOf(context.content, match.index);
    const method = match[2].toUpperCase();
    const path = normalizeEndpointPath(joinRoute(mozuServiceId, normalizeMozuRelpath(match[1])));
    const rawUrl = `http://${context.sdkSource.targetServiceId}${path}`;
    const derivedFrom: NonNullable<HttpEvidence["derivedFrom"]> = {
      kind: "sdk_source",
      sdkSourceId: context.sdkSource.id,
      packageName: context.packageUsage.packageName,
      consumerFile: context.packageUsage.file,
      consumerLine: context.packageUsage.line,
      sdkFile: context.file,
      sdkLine: line
    };
    facts.push(endpoint(context.sdkSource.targetServiceId, context.file, line, "mozu-service-client", method, path));
    facts.push(call(context.serviceId, context.file, line, "mozu-service-client", method, rawUrl, derivedFrom));
  }
  return facts.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeMozuRelpath(expression: string): string {
  const chunks: string[] = [];
  for (const match of expression.matchAll(/(?:\$)?(["'])([\s\S]*?)\1|Format\s*\(\s*[^,]+,\s*false\s*\)/g)) {
    if (match[0].startsWith("Format")) {
      chunks.push("*");
    } else {
      chunks.push(match[2] ?? "");
    }
  }
  const combined = chunks.join("").split(/[?#]/, 1)[0].replace(/\/+/g, "/");
  return combined === "" ? "/" : combined;
}

function mozuGeneratedClientNames(options: Record<string, unknown>): Set<string> {
  const text = stringOption(options.codegenTargetsContent);
  if (!text) {
    return new Set();
  }
  return new Set(
    [...text.matchAll(/-t\s+\$\(SourceNS\)\.(\w+)Controller\b/g)]
      .map((match) => `${match[1]}WebApiClient`)
      .sort()
  );
}

function endpoint(serviceId: string, file: string, line: number, framework: string, method: string, route: string): EndpointFact {
  const normalized = normalizeEndpointPath(route);
  return {
    id: stableId("endpoint", serviceId, file, line, method, normalized),
    kind: "endpoint",
    serviceId,
    file,
    line,
    framework,
    httpMethod: method,
    path: normalized
  };
}

function call(
  serviceId: string,
  file: string,
  line: number,
  framework: string,
  method: string,
  rawUrl: string,
  derivedFrom: NonNullable<HttpEvidence["derivedFrom"]>
): HttpCallFact {
  const normalized = normalizeHttpUrl(`"${rawUrl}"`);
  return {
    id: stableId("http-call", serviceId, file, line, method, rawUrl, derivedFrom.consumerFile, derivedFrom.consumerLine),
    kind: "http_call",
    serviceId,
    file,
    line,
    framework,
    enclosingSymbol: `${path.basename(file)}:${line}`,
    httpMethod: method,
    rawUrl,
    path: normalized.path,
    host: normalized.host,
    dynamic: normalized.dynamic,
    derivedFrom
  };
}

function packagePatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function dedupePackageUsages(usages: PackageUsage[]): PackageUsage[] {
  const seen = new Set<string>();
  return usages.sort(comparePackageUsages).filter((usage) => {
    const key = `${usage.packageName}\u0000${usage.file}\u0000${usage.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function comparePackageUsages(a: PackageUsage, b: PackageUsage): number {
  return a.packageName.localeCompare(b.packageName) || a.file.localeCompare(b.file) || a.line - b.line;
}

function joinRoute(prefix: string, suffix: string): string {
  return `/${[prefix, suffix].map((item) => item.replace(/^\/|\/$/g, "")).filter(Boolean).join("/")}`;
}

function lineOf(content: string, index: number | undefined): number {
  return content.slice(0, index ?? 0).split("\n").length;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function gitFiles(root: string): Promise<string[]> {
  const { stdout } = await exec("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], { encoding: "utf8" });
  const files = stdout.split(/\r?\n/).filter(Boolean).sort();
  if (files.length === 0) {
    throw new Error("No git files found.");
  }
  return files;
}

async function walkFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && excluded.has(entry.name)) {
      continue;
    }
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(root, child));
    } else if (entry.isFile()) {
      files.push(toPosix(child));
    }
  }
  return files.sort();
}
