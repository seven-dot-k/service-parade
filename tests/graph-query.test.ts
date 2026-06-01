import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCatalog } from "../src/catalog.ts";
import { enrichmentInputHash } from "../src/graph/enrich.ts";
import { resolveGraph, resolveGraphDb } from "../src/graph/paths.ts";
import {
  getGraphStatus,
  listDependencies,
  listEndpoints,
  listPendingLinkDetails,
  queryTransitiveImpact
} from "../src/graph/query.ts";
import { GraphStorage } from "../src/graph/storage.ts";
import type { EndpointFact, HttpCallFact, PendingLink } from "../src/graph/types.ts";
import type { HttpDependency } from "../src/types.ts";

test("reports catalog-aware graph freshness", async () => {
  const fixture = await createFixture();
  const expectedHash = enrichmentInputHash("index-hash", fixture.catalog);
  await writeJson(resolveGraph(fixture.root, "dependencies.json"), {
    generatedAt: "2026-01-01T00:00:00.000Z",
    indexManifestHash: expectedHash,
    pendingCount: 1,
    dependencies: fixture.dependencies
  });

  assert.deepEqual(await getGraphStatus(fixture.root, fixture.catalog), {
    indexed: true,
    enriched: true,
    fresh: true,
    indexManifest: {
      generatedAt: "2026-01-01T00:00:00.000Z",
      hash: "index-hash",
      files: 3,
      facts: 5
    },
    expectedEnrichmentInputHash: expectedHash,
    enrichedInputHash: expectedHash,
    dependencies: 3,
    pendingLinks: 1
  });

  fixture.catalog.services[0].aliases.push("changed-alias");
  assert.equal((await getGraphStatus(fixture.root, fixture.catalog)).fresh, false);
});

test("filters dependencies and computes deterministic bounded transitive impact", async () => {
  const fixture = await createFixture();
  await writeJson(resolveGraph(fixture.root, "dependencies.json"), {
    generatedAt: "2026-01-01T00:00:00.000Z",
    indexManifestHash: "stale",
    pendingCount: 0,
    dependencies: [...fixture.dependencies].reverse()
  });

  assert.deepEqual((await listDependencies(fixture.root, { serviceId: "orders", direction: "in" })).map((edge) => edge.id), ["dep-cart-orders"]);
  assert.deepEqual((await listDependencies(fixture.root, { serviceId: "orders", direction: "out" })).map((edge) => edge.id), ["dep-orders-inventory"]);
  assert.deepEqual((await listDependencies(fixture.root, { serviceId: "orders" })).map((edge) => edge.id), ["dep-cart-orders", "dep-orders-inventory"]);

  assert.deepEqual(await queryTransitiveImpact(fixture.root, "inventory", 1), {
    serviceId: "inventory",
    maxDepth: 1,
    impactedServices: [
      { serviceId: "checkout", depth: 1 },
      { serviceId: "orders", depth: 1 }
    ],
    dependencies: [fixture.dependencies[2], fixture.dependencies[1]]
  });
  assert.deepEqual((await queryTransitiveImpact(fixture.root, "inventory", 2)).impactedServices, [
    { serviceId: "checkout", depth: 1 },
    { serviceId: "orders", depth: 1 },
    { serviceId: "cart", depth: 2 }
  ]);
});

test("lists endpoint facts and enriches pending links with readable details", async () => {
  const fixture = await createFixture();
  const storage = new GraphStorage(resolveGraphDb(fixture.root));
  try {
    storage.replaceFile(
      { id: "cart:server.ts", serviceId: "cart", path: "cart/server.ts", contentHash: "cart" },
      [fixture.call]
    );
    storage.replaceFile(
      { id: "orders:server.ts", serviceId: "orders", path: "orders/server.ts", contentHash: "orders" },
      [fixture.endpoints[1], fixture.endpoints[0]]
    );
    storage.replacePendingLinks([fixture.pending]);
  } finally {
    storage.close();
  }

  assert.deepEqual(listEndpoints(fixture.root, { serviceId: "orders" }).map((endpoint) => endpoint.id), ["endpoint-orders-health", "endpoint-orders-items"]);
  const details = listPendingLinkDetails(fixture.root, fixture.catalog);
  assert.equal(details.length, 1);
  assert.equal(details[0].sourceCall?.id, "call-cart-orders");
  assert.equal(details[0].sourceService?.id, "cart");
  assert.match(details[0].sourceLabel, /cart: GET http:\/\/orders-svc\/items/);
  assert.deepEqual(details[0].candidates.map((candidate) => candidate.endpoint.id), ["endpoint-orders-health", "endpoint-orders-items"]);
  assert.deepEqual(details[0].candidates.map((candidate) => candidate.service?.repoId), ["orders-repo", "orders-repo"]);
  assert.match(details[0].candidates[1].label, /orders: GET \/items/);
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-graph-query-"));
  for (const repo of ["cart", "orders", "inventory"]) {
    await mkdir(path.join(root, repo), { recursive: true });
  }
  const catalog = await normalizeCatalog({
    repos: [
      { id: "cart-repo", path: "cart" },
      { id: "orders-repo", path: "orders" },
      { id: "inventory-repo", path: "inventory" }
    ],
    services: [
      { id: "cart", repoId: "cart-repo" },
      { id: "orders", repoId: "orders-repo", aliases: ["orders-svc"] },
      { id: "inventory", repoId: "inventory-repo" }
    ]
  }, root);
  await writeJson(resolveGraph(root, "index-manifest.json"), {
    generatedAt: "2026-01-01T00:00:00.000Z",
    hash: "index-hash",
    files: 3,
    facts: 5
  });

  const dependencies: HttpDependency[] = [
    dependency("dep-cart-orders", "cart", "orders"),
    dependency("dep-orders-inventory", "orders", "inventory"),
    dependency("dep-checkout-inventory", "checkout", "inventory")
  ];
  const call: HttpCallFact = {
    id: "call-cart-orders",
    kind: "http_call",
    serviceId: "cart",
    file: "cart/server.ts",
    line: 4,
    framework: "fetch",
    enclosingSymbol: "checkout",
    httpMethod: "GET",
    rawUrl: "http://orders-svc/items",
    path: "/items",
    host: "orders-svc",
    dynamic: false
  };
  const endpoints: EndpointFact[] = [
    endpoint("endpoint-orders-items", "/items", 8),
    endpoint("endpoint-orders-health", "/health", 2)
  ];
  const pending: PendingLink = {
    id: "pending-cart-orders",
    signature: "signature",
    callNodeId: call.id,
    candidateEndpointIds: ["endpoint-orders-items", "endpoint-orders-health"],
    score: 0.7,
    reason: "Multiple candidates.",
    evidence: { file: call.file, line: call.line, rawUrl: call.rawUrl },
    reviewStatus: "pending_review"
  };
  return { root, catalog, dependencies, call, endpoints, pending };
}

function dependency(id: string, sourceServiceId: string, targetServiceId: string): HttpDependency {
  return {
    id,
    sourceServiceId,
    targetServiceId,
    httpMethod: "GET",
    endpointPath: "/items",
    callPath: "/items",
    callNodeId: `call-${id}`,
    endpointNodeId: `endpoint-${id}`,
    confidence: 1,
    reviewStatus: "auto_accepted",
    decidedBy: "auto",
    evidence: { file: `${sourceServiceId}/server.ts`, line: 1, rawUrl: "/items" }
  };
}

function endpoint(id: string, endpointPath: string, line: number): EndpointFact {
  return {
    id,
    kind: "endpoint",
    serviceId: "orders",
    file: "orders/server.ts",
    line,
    framework: "express",
    httpMethod: "GET",
    path: endpointPath
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
