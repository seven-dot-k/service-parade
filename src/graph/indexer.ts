import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { NormalizedCatalog, NormalizedService } from "../types.ts";
import { stableJson, writeText } from "../fs.ts";
import { toPosix } from "../paths.ts";
import { detectFacts } from "./detectors.ts";
import { sha256 } from "./hash.ts";
import { supportsAnalysis, parseSource } from "./parser.ts";
import { resolveGraph, resolveGraphDb } from "./paths.ts";
import { GraphStorage } from "./storage.ts";
import type { GraphIndexManifest } from "./types.ts";

const exec = promisify(execFile);
const excluded = new Set([
  ".git", ".service-parade", ".codeiq", "node_modules", "dist", "build", "out", "bin", "obj",
  "coverage", ".next", ".nuxt", ".cache", "target", "vendor"
]);

export type GraphIndexSummary = {
  files: number;
  facts: number;
  parsed: number;
  cacheHits: number;
  deleted: number;
  manifestHash: string;
};

export async function indexGraph(root: string, catalog: NormalizedCatalog): Promise<GraphIndexSummary> {
  const storage = new GraphStorage(resolveGraphDb(root));
  try {
    const cached = storage.getFileHashes();
    const files = (await Promise.all(catalog.services.map((service) => discoverServiceFiles(catalog, service))))
      .flat()
      .sort((a, b) => a.id.localeCompare(b.id));
    const currentIds = new Set(files.map((file) => file.id));
    let facts = 0;
    let parsed = 0;
    let cacheHits = 0;

    for (const file of files) {
      const content = await readFile(file.absolutePath, "utf8");
      const contentHash = sha256(content);
      if (cached.get(file.id) === contentHash) {
        cacheHits += 1;
        continue;
      }
      parseSource(file.relativePath, content);
      const detected = detectFacts({ serviceId: file.serviceId, file: file.relativePath, content });
      storage.replaceFile({ id: file.id, serviceId: file.serviceId, path: file.relativePath, contentHash }, detected);
      parsed += 1;
    }

    const deleted = storage.purgeMissingFiles(currentIds);
    const allFacts = storage.allFacts();
    facts = allFacts.length;
    const manifestHash = sha256(
      [...storage.getFileHashes().entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, hash]) => `${id}:${hash}`).join("\n")
    );
    storage.recordRun(manifestHash, files.length, facts);
    const previous = await readManifest(root);
    const manifest: GraphIndexManifest = {
      generatedAt: previous?.hash === manifestHash ? previous.generatedAt : new Date().toISOString(),
      hash: manifestHash,
      files: files.length,
      facts
    };
    await writeText(resolveGraph(root, "index-manifest.json"), stableJson(manifest));
    return { files: files.length, facts, parsed, cacheHits, deleted, manifestHash };
  } finally {
    storage.close();
  }
}

async function readManifest(root: string): Promise<GraphIndexManifest | undefined> {
  try {
    return JSON.parse(await readFile(resolveGraph(root, "index-manifest.json"), "utf8")) as GraphIndexManifest;
  } catch {
    return undefined;
  }
}

async function discoverServiceFiles(
  catalog: NormalizedCatalog,
  service: NormalizedService
): Promise<Array<{ id: string; serviceId: string; absolutePath: string; relativePath: string }>> {
  const candidates = await gitFiles(service.absolutePath).catch(() => walkFiles(service.absolutePath));
  return candidates
    .filter(supportsAnalysis)
    .map((relative) => {
      const absolutePath = path.resolve(service.absolutePath, relative);
      const relativePath = toPosix(path.relative(catalog.root, absolutePath));
      return { id: `${service.id}:${relativePath}`, serviceId: service.id, absolutePath, relativePath };
    });
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
