import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCatalog } from "../src/catalog.ts";
import { enrichmentInputHash } from "../src/graph/enrich.ts";
import { planChangeSet } from "../src/planner.ts";

test("planner selects direct matches and dependency neighbors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-plan-"));
  const specPath = path.join(root, "feature.md");
  await writeFile(specPath, "Add billing-api support for identity account checks.", "utf8");

  const catalog = await normalizeCatalog(
    {
      repos: [
        { id: "billing", path: "." },
        { id: "identity", path: "." }
      ],
      services: [
        { id: "billing-api", repoId: "billing", tags: ["invoices"] },
        { id: "identity-api", repoId: "identity", tags: ["accounts"] }
      ]
    },
    root
  );
  await mkdir(path.join(root, ".service-parade", "graph"), { recursive: true });
  await writeFile(path.join(root, ".service-parade", "graph", "index-manifest.json"), JSON.stringify({ hash: "abc" }), "utf8");
  await writeFile(
    path.join(root, ".service-parade", "graph", "dependencies.json"),
    JSON.stringify({
      indexManifestHash: enrichmentInputHash("abc", catalog),
      pendingCount: 0,
      dependencies: [{
        id: "dep-1",
        sourceServiceId: "billing-api",
        targetServiceId: "identity-api",
        httpMethod: "GET",
        endpointPath: "/accounts/{id}",
        callPath: "/accounts/*",
        callNodeId: "call-1",
        endpointNodeId: "endpoint-1",
        confidence: 0.95,
        reviewStatus: "auto_accepted",
        decidedBy: "auto",
        evidence: { file: "billing.ts", line: 1, rawUrl: "`/accounts/${id}`" }
      }]
    }),
    "utf8"
  );

  const plan = await planChangeSet(catalog, specPath);

  assert.deepEqual(
    plan.affectedServices.map((service) => service.id).sort(),
    ["billing-api", "identity-api"]
  );
  assert.equal(plan.dependencyEdges.length, 1);
  assert.equal(plan.recommendedOrder[0], "identity-api");
});

test("planner matches aliases and refuses stale graph expansion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-plan-stale-"));
  const specPath = path.join(root, "feature.md");
  await writeFile(specPath, "Update checkout behavior in storefront.", "utf8");
  const catalog = await normalizeCatalog({
    repos: [
      { id: "web", path: "." },
      { id: "orders", path: "." }
    ],
    services: [
      { id: "web-api", repoId: "web", aliases: ["storefront"] },
      { id: "orders-api", repoId: "orders" }
    ]
  }, root);
  await mkdir(path.join(root, ".service-parade", "graph"), { recursive: true });
  await writeFile(path.join(root, ".service-parade", "graph", "index-manifest.json"), JSON.stringify({ hash: "new" }), "utf8");
  await writeFile(path.join(root, ".service-parade", "graph", "dependencies.json"), JSON.stringify({
    indexManifestHash: enrichmentInputHash("old", catalog),
    pendingCount: 0,
    dependencies: [{
      id: "dep-stale",
      sourceServiceId: "web-api",
      targetServiceId: "orders-api",
      httpMethod: "GET",
      endpointPath: "/orders",
      callPath: "/orders",
      callNodeId: "call-stale",
      endpointNodeId: "endpoint-stale",
      confidence: 1,
      reviewStatus: "auto_accepted",
      decidedBy: "auto",
      evidence: { file: "web.ts", line: 1, rawUrl: "\"/orders\"" }
    }]
  }), "utf8");

  const plan = await planChangeSet(catalog, specPath);

  assert.deepEqual(plan.affectedServices.map((service) => service.id), ["web-api"]);
  assert.equal(plan.dependencyEdges.length, 0);
  assert.match(plan.risks.join("\n"), /stale/);
});

test("planner reports cycles in affected dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-plan-cycle-"));
  const specPath = path.join(root, "feature.md");
  await writeFile(specPath, "Change alpha-api and beta-api.", "utf8");
  const catalog = await normalizeCatalog({
    repos: [{ id: "alpha", path: "." }, { id: "beta", path: "." }],
    services: [{ id: "alpha-api", repoId: "alpha" }, { id: "beta-api", repoId: "beta" }]
  }, root);
  await mkdir(path.join(root, ".service-parade", "graph"), { recursive: true });
  await writeFile(path.join(root, ".service-parade", "graph", "index-manifest.json"), JSON.stringify({ hash: "cycle" }), "utf8");
  const edge = (id: string, from: string, to: string) => ({
    id,
    sourceServiceId: from,
    targetServiceId: to,
    httpMethod: "GET",
    endpointPath: "/status",
    callPath: "/status",
    callNodeId: `call-${id}`,
    endpointNodeId: `endpoint-${id}`,
    confidence: 1,
    reviewStatus: "auto_accepted",
    decidedBy: "auto",
    evidence: { file: `${from}.ts`, line: 1, rawUrl: "\"/status\"" }
  });
  await writeFile(path.join(root, ".service-parade", "graph", "dependencies.json"), JSON.stringify({
    indexManifestHash: enrichmentInputHash("cycle", catalog),
    pendingCount: 0,
    dependencies: [edge("a", "alpha-api", "beta-api"), edge("b", "beta-api", "alpha-api")]
  }), "utf8");

  const plan = await planChangeSet(catalog, specPath);

  assert.match(plan.risks.join("\n"), /contains a cycle/);
});

test("planner falls back to repo triage when nothing matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-plan-fallback-"));
  const specPath = path.join(root, "feature.md");
  await writeFile(specPath, "Rewrite the moonbeam allocator.", "utf8");

  const catalog = await normalizeCatalog(
    {
      repos: [{ id: "billing", path: "." }],
      services: [{ id: "billing-api", repoId: "billing" }]
    },
    root
  );

  const plan = await planChangeSet(catalog, specPath);

  assert.deepEqual(plan.affectedRepos.map((repo) => repo.id), ["billing"]);
  assert.equal(plan.affectedServices.length, 0);
  assert.match(plan.risks.join("\n"), /No service-level match/);
});
