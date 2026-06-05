import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Surreal, createRemoteEngines, RecordId, Table } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { stableJson, writeText } from "../fs.ts";
import type { HttpDependency, NormalizedCatalog } from "../types.ts";
import { sha256 } from "./hash.ts";
import { resolveGraph, resolveSurrealGraph } from "./paths.ts";
import type { GraphFact } from "./types.ts";

type Payload = {
  catalog: NormalizedCatalog;
  facts: GraphFact[];
  dependencies: HttpDependency[];
};

type ProjectionPreviewModel = {
  generatedAt: string;
  counts: {
    nodes: number;
    edges: number;
  };
  nodes: Array<{ data: ProjectionNodeData }>;
  edges: Array<{ data: ProjectionEdgeData }>;
};

type ProjectionNodeData = {
  id: string;
  label: string;
  kind: string;
  serviceId?: string;
  file?: string;
  line?: number;
  rawId: string;
  properties?: unknown;
};

type ProjectionEdgeData = {
  id: string;
  source: string;
  target: string;
  kind: "contains" | "consumes_endpoint";
  label: string;
  properties?: unknown;
};

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) throw new Error("Projection worker requires a workspace root.");
  const payload = JSON.parse(await readStdin()) as Payload;
  const graphPath = resolveSurrealGraph(root);
  await mkdir(path.dirname(graphPath), { recursive: true });
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  await db.connect(`rocksdb://${graphPath}`, { namespace: "service_parade", database: "graph" });
  try {
    await db.query(`
      REMOVE TABLE IF EXISTS consumes_endpoint;
      REMOVE TABLE IF EXISTS contains;
      REMOVE TABLE IF EXISTS code_node;
      DEFINE TABLE code_node SCHEMALESS;
      DEFINE INDEX code_node_raw_id ON code_node FIELDS raw_id UNIQUE;
      DEFINE TABLE contains TYPE RELATION FROM code_node TO code_node;
      DEFINE TABLE consumes_endpoint TYPE RELATION FROM code_node TO code_node;
    `);
    const table = new Table("code_node");
    const ids = new Map<string, RecordId>();
    const previewNodeIds = new Map<string, string>();
    const previewNodes: ProjectionPreviewModel["nodes"] = [];
    const previewEdges: ProjectionPreviewModel["edges"] = [];
    const createNode = async (rawId: string, content: Record<string, unknown>) => {
      const id = new RecordId(table, sha256(rawId).slice(0, 24));
      ids.set(rawId, id);
      const previewId = recordId(id);
      previewNodeIds.set(rawId, previewId);
      previewNodes.push({ data: toPreviewNode(previewId, rawId, content) });
      await db.create(id).content({ raw_id: rawId, ...content });
    };
    for (const service of [...payload.catalog.services].sort((a, b) => a.id.localeCompare(b.id))) {
      await createNode(`service:${service.id}`, { kind: "service", service_id: service.id });
    }
    for (const fact of [...payload.facts].sort((a, b) => a.id.localeCompare(b.id))) {
      await createNode(fact.id, { kind: fact.kind, service_id: fact.serviceId, properties: fact });
      await relate(db, ids.get(`service:${fact.serviceId}`), "contains", ids.get(fact.id), {});
      previewEdges.push(toPreviewEdge(
        previewNodeIds.get(`service:${fact.serviceId}`),
        previewNodeIds.get(fact.id),
        "contains",
        {}
      ));
    }
    for (const dependency of [...payload.dependencies].sort((a, b) => a.id.localeCompare(b.id))) {
      await relate(db, ids.get(dependency.callNodeId), "consumes_endpoint", ids.get(dependency.endpointNodeId), dependency);
      previewEdges.push(toPreviewEdge(
        previewNodeIds.get(dependency.callNodeId),
        previewNodeIds.get(dependency.endpointNodeId),
        "consumes_endpoint",
        dependency
      ));
    }
    await writeText(resolveGraph(root, "projection-preview.json"), stableJson({
      generatedAt: new Date().toISOString(),
      counts: { nodes: previewNodes.length, edges: previewEdges.length },
      nodes: previewNodes.sort((a, b) => a.data.id.localeCompare(b.data.id)),
      edges: previewEdges.filter((edge) => edge.data.source && edge.data.target).sort((a, b) => a.data.id.localeCompare(b.data.id))
    } satisfies ProjectionPreviewModel));
  } finally {
    await db.close();
  }
  await writeText(resolveGraph(root, "projection.json"), stableJson({ path: graphPath }));
}

function toPreviewNode(id: string, rawId: string, content: Record<string, unknown>): ProjectionNodeData {
  const properties = content.properties as Partial<GraphFact> | undefined;
  return {
    id,
    rawId,
    kind: String(content.kind),
    serviceId: typeof content.service_id === "string" ? content.service_id : undefined,
    file: properties && "file" in properties && typeof properties.file === "string" ? properties.file : undefined,
    line: properties && "line" in properties && typeof properties.line === "number" ? properties.line : undefined,
    label: nodeLabel(content, properties),
    properties
  };
}

function toPreviewEdge(
  source: string | undefined,
  target: string | undefined,
  kind: "contains" | "consumes_endpoint",
  properties: Record<string, unknown>
): { data: ProjectionEdgeData } {
  const label = kind === "contains"
    ? "contains"
    : [properties.httpMethod, properties.endpointPath].filter(Boolean).join(" ") || "consumes";
  return {
    data: {
      id: `${kind}:${sha256(`${source ?? ""}\u0000${target ?? ""}\u0000${label}`).slice(0, 24)}`,
      source: source ?? "",
      target: target ?? "",
      kind,
      label,
      properties: kind === "consumes_endpoint" ? properties : undefined
    }
  };
}

function nodeLabel(content: Record<string, unknown>, properties: Partial<GraphFact> | undefined): string {
  if (content.kind === "service") return String(content.service_id);
  if (properties?.kind === "endpoint") return `${properties.httpMethod} ${properties.path}`;
  if (properties?.kind === "http_call") return `${properties.httpMethod ?? "*"} ${properties.rawUrl}`;
  if (properties?.kind === "config_key") return properties.key ?? "config";
  return String(content.kind);
}

function recordId(value: RecordId): string {
  return String(value);
}

async function relate(
  db: Surreal,
  from: RecordId | undefined,
  kind: "contains" | "consumes_endpoint",
  to: RecordId | undefined,
  content: Record<string, unknown>
): Promise<void> {
  if (!from || !to) return;
  await db.query(`RELATE $from->${kind}->$to CONTENT $content;`, { from, to, content });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      content += chunk;
    });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", reject);
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  }
);
