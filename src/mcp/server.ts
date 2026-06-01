import { access } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeCatalog } from "../catalog.ts";
import { loadConfig } from "../config.ts";
import { stableJson } from "../fs.ts";
import { loadDependencyArtifact } from "../graph/enrich.ts";
import { resolveGraphDb } from "../graph/paths.ts";
import { planChangeSet } from "../planner.ts";
import type { NormalizedCatalog } from "../types.ts";
import { getGraphStatus, listDependencies, listEndpoints, listPendingLinkDetails, queryTransitiveImpact } from "../graph/query.ts";

export type MultiRepoMcpOptions = {
  root: string;
  config?: string;
};

export function createMultiRepoMcpServer(options: MultiRepoMcpOptions): McpServer {
  const root = path.resolve(options.root);
  const server = new McpServer({
    name: "service-parade-control-plane",
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
    "graph-status",
    "multirepo://graph/status",
    {
      description: "Graph indexing and enrichment freshness status.",
      mimeType: "application/json"
    },
    async (uri) => jsonResource(uri, await getGraphStatus(root, await loadCatalog(root, options.config)))
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
    async (uri) => jsonResource(uri, await loadPendingLinkDetails(root, options.config))
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

  server.registerTool(
    "multirepo_graph_dependencies",
    {
      description: "List accepted HTTP dependencies, optionally filtered by service and direction.",
      inputSchema: {
        serviceId: z.string().min(1).optional(),
        direction: z.enum(["in", "out", "both"]).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ serviceId, direction }) => textResult(await listDependencies(root, { serviceId, direction }))
  );

  server.registerTool(
    "multirepo_graph_impact",
    {
      description: "Find services transitively impacted by a change to the target service.",
      inputSchema: {
        serviceId: z.string().min(1),
        maxDepth: z.number().int().nonnegative().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ serviceId, maxDepth }) => textResult(await queryTransitiveImpact(root, serviceId, maxDepth))
  );

  server.registerTool(
    "multirepo_graph_endpoints",
    {
      description: "List indexed HTTP endpoints, optionally filtered by service.",
      inputSchema: {
        serviceId: z.string().min(1).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ serviceId }) => textResult(listEndpoints(root, { serviceId }))
  );

  return server;
}

async function loadCatalog(root: string, config?: string): Promise<NormalizedCatalog> {
  const loaded = await loadConfig(root, config);
  return normalizeCatalog(loaded.config, root);
}

async function loadPendingLinkDetails(root: string, config?: string) {
  try {
    await access(resolveGraphDb(root));
  } catch {
    return [];
  }
  return listPendingLinkDetails(root, await loadCatalog(root, config));
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

function textResult(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: stableJson(value)
    }]
  };
}
