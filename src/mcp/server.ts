import { access } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeCatalog } from "../catalog.ts";
import { loadConfig } from "../config.ts";
import { stableJson } from "../fs.ts";
import { listPendingLinks, loadDependencyArtifact } from "../graph/enrich.ts";
import { resolveGraphDb } from "../graph/paths.ts";
import { planChangeSet } from "../planner.ts";
import type { NormalizedCatalog } from "../types.ts";

export type MultiRepoMcpOptions = {
  root: string;
  config?: string;
};

export function createMultiRepoMcpServer(options: MultiRepoMcpOptions): McpServer {
  const root = path.resolve(options.root);
  const server = new McpServer({
    name: "multirepo-control-plane",
    version: "0.1.0"
  });

  server.registerResource(
    "catalog",
    "multirepo://catalog",
    {
      description: "Normalized repository and service catalog.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri, await loadCatalog(root, options.config))
  );

  server.registerResource(
    "dependency-graph",
    "multirepo://graph/dependencies",
    {
      description: "Accepted HTTP dependency graph. Empty until graph enrichment has run.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri, await loadDependencyArtifact(root) ?? {
      dependencies: [],
      pendingCount: 0
    })
  );

  server.registerResource(
    "pending-links",
    "multirepo://graph/pending-links",
    {
      description: "Discovered HTTP links awaiting review. Empty until graph enrichment has run.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri, await loadPendingLinks(root))
  );

  server.registerTool(
    "multirepo_plan_change_set",
    {
      description: "Produce an explainable likely change-set plan from an inline feature specification.",
      inputSchema: {
        spec: z.string().min(1).describe("Feature specification text.")
      },
      annotations: {
        readOnlyHint: true
      }
    },
    async ({ spec }) => {
      const catalog = await loadCatalog(root, options.config);
      const plan = await planInlineSpec(catalog, spec);
      return {
        content: [{
          type: "text",
          text: stableJson(plan)
        }]
      };
    }
  );

  return server;
}

async function loadCatalog(root: string, config?: string): Promise<NormalizedCatalog> {
  const loaded = await loadConfig(root, config);
  return normalizeCatalog(loaded.config, root);
}

async function loadPendingLinks(root: string): Promise<ReturnType<typeof listPendingLinks>> {
  try {
    await access(resolveGraphDb(root));
  } catch {
    return [];
  }
  return listPendingLinks(root);
}

async function planInlineSpec(catalog: NormalizedCatalog, spec: string) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "multirepo-mcp-spec-"));
  const specPath = path.join(tempDir, "spec.md");
  try {
    await writeFile(specPath, spec, "utf8");
    return await planChangeSet(catalog, specPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: stableJson(value)
    }]
  };
}
