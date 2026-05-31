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

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) throw new Error("Projection worker requires a workspace root.");
  const payload = JSON.parse(await readStdin()) as Payload;
  const graphPath = resolveSurrealGraph(root);
  await mkdir(path.dirname(graphPath), { recursive: true });
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  await db.connect(`rocksdb://${graphPath}`, { namespace: "multirepo", database: "graph" });
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
    const createNode = async (rawId: string, content: Record<string, unknown>) => {
      const id = new RecordId(table, sha256(rawId).slice(0, 24));
      ids.set(rawId, id);
      await db.create(id).content({ raw_id: rawId, ...content });
    };
    for (const service of [...payload.catalog.services].sort((a, b) => a.id.localeCompare(b.id))) {
      await createNode(`service:${service.id}`, { kind: "service", service_id: service.id });
    }
    for (const fact of [...payload.facts].sort((a, b) => a.id.localeCompare(b.id))) {
      await createNode(fact.id, { kind: fact.kind, service_id: fact.serviceId, properties: fact });
      await relate(db, ids.get(`service:${fact.serviceId}`), "contains", ids.get(fact.id), {});
    }
    for (const dependency of [...payload.dependencies].sort((a, b) => a.id.localeCompare(b.id))) {
      await relate(db, ids.get(dependency.callNodeId), "consumes_endpoint", ids.get(dependency.endpointNodeId), dependency);
    }
  } finally {
    await db.close();
  }
  await writeText(resolveGraph(root, "projection.json"), stableJson({ path: graphPath }));
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
