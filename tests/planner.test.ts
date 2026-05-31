import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCatalog } from "../src/catalog.ts";
import { planChangeSet } from "../src/planner.ts";

test("planner selects direct matches and dependency neighbors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-plan-"));
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
  await mkdir(path.join(root, ".multirepo", "graph"), { recursive: true });
  await writeFile(path.join(root, ".multirepo", "graph", "index-manifest.json"), JSON.stringify({ hash: "abc" }), "utf8");
  await writeFile(
    path.join(root, ".multirepo", "graph", "dependencies.json"),
    JSON.stringify({
      indexManifestHash: "abc",
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
  assert.equal(plan.recommendedOrder[0], "billing-api");
});

test("planner falls back to repo triage when nothing matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-plan-fallback-"));
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
