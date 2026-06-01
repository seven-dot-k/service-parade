import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createPrOrchestrationPlan, renderPrOrchestrationPlan } from "../src/pr/orchestrator.ts";
import type { ChangeSet, HttpDependency, NormalizedCatalog } from "../src/types.ts";
import type { WorkspaceManifest } from "../src/workspace/types.ts";

test("PR orchestration maps service order to repos and records cross-repo prerequisites", () => {
  const { catalog, changeSet, workspace } = fixture();

  const plan = createPrOrchestrationPlan(catalog, changeSet, workspace);

  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.implementationOrder, ["identity", "billing"]);
  assert.deepEqual(plan.relationships, [{
    prerequisiteRepoId: "identity",
    dependentRepoId: "billing",
    dependencyEdgeIds: ["dep-1"]
  }]);
  assert.deepEqual(plan.pullRequests.map((pr) => pr.repoId), ["identity", "billing"]);
  assert.deepEqual(plan.pullRequests[1].dependsOnRepoIds, ["identity"]);
  assert.deepEqual(plan.pullRequests[0].dependentRepoIds, ["billing"]);
  assert.deepEqual(plan.pullRequests[1].verificationCommands.map((command) => command.name), ["billing-lint", "billing-test"]);
  assert.match(renderPrOrchestrationPlan(plan), /billing depends on identity via dep-1/);
});

test("PR orchestration emits one PR for a single repo dependency", () => {
  const { catalog, changeSet } = fixture();
  catalog.repos = [catalog.repos[0]];
  catalog.services = [
    catalog.services[0],
    { ...catalog.services[1], repoId: "billing", absolutePath: path.join(catalog.repos[0].absolutePath, "identity") }
  ];
  changeSet.affectedRepos = [changeSet.affectedRepos[0]];
  changeSet.affectedServices[1].repoId = "billing";

  const plan = createPrOrchestrationPlan(catalog, changeSet);

  assert.deepEqual(plan.implementationOrder, ["billing"]);
  assert.equal(plan.pullRequests.length, 1);
  assert.deepEqual(plan.relationships, []);
  assert.deepEqual(plan.pullRequests[0].affectedServiceIds, ["billing-api", "identity-api"]);
  assert.match(plan.readinessRisks.join("\n"), /workspace manifest/);
});

test("PR orchestration is deterministic apart from generatedAt", () => {
  const { catalog, changeSet, workspace } = fixture();

  const first = createPrOrchestrationPlan(catalog, changeSet, workspace);
  const second = createPrOrchestrationPlan(catalog, changeSet, workspace);

  assert.deepEqual(withoutGeneratedAt(first), withoutGeneratedAt(second));
});

function fixture(): { catalog: NormalizedCatalog; changeSet: ChangeSet; workspace: WorkspaceManifest } {
  const root = "/tmp/service-parade-pr";
  const edge: HttpDependency = {
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
    evidence: { file: "src/client.ts", line: 12, rawUrl: "`/accounts/${id}`" }
  };
  const catalog: NormalizedCatalog = {
    generatedAt: "2026-05-31T12:00:00.000Z",
    root,
    repos: [
      repo("billing", root),
      repo("identity", root)
    ],
    services: [
      service("billing-api", "billing", root),
      service("identity-api", "identity", root)
    ],
    commands: []
  };
  const changeSet: ChangeSet = {
    generatedAt: "2026-05-31T12:05:00.000Z",
    specPath: path.join(root, "feature.md"),
    summary: "Add identity account checks to billing.",
    affectedServices: [
      { id: "billing-api", repoId: "billing", reasons: ["Spec mentions billing"], commands: [] },
      { id: "identity-api", repoId: "identity", reasons: ["Dependency neighbor"], commands: [] }
    ],
    affectedRepos: [
      { id: "billing", path: "billing", reasons: ["Affected service billing-api"], commands: [] },
      { id: "identity", path: "identity", reasons: ["Affected service identity-api"], commands: [] }
    ],
    dependencyEdges: [edge],
    recommendedOrder: ["identity-api", "billing-api"],
    risks: []
  };
  const workspace: WorkspaceManifest = {
    schemaVersion: 1,
    generatedAt: "2026-05-31T12:06:00.000Z",
    catalogGeneratedAt: catalog.generatedAt,
    changeSetGeneratedAt: changeSet.generatedAt,
    specPath: changeSet.specPath,
    summary: changeSet.summary,
    repositories: [],
    services: [],
    dependencies: [edge],
    verificationCommands: [
      { targetType: "repo", targetId: "billing", name: "billing-lint", run: "npm run lint", cwd: "/tmp/service-parade-pr/billing" },
      { targetType: "service", targetId: "billing-api", name: "billing-test", run: "npm test", cwd: "/tmp/service-parade-pr/billing" },
      { targetType: "repo", targetId: "identity", name: "identity-test", run: "npm test", cwd: "/tmp/service-parade-pr/identity" }
    ],
    recommendedOrder: changeSet.recommendedOrder,
    risks: []
  };
  return { catalog, changeSet, workspace };
}

function repo(id: string, root: string): NormalizedCatalog["repos"][number] {
  return {
    id,
    path: id,
    absolutePath: path.join(root, id),
    defaultBranch: "main",
    inferred: { languages: ["typescript"], manifests: [], dockerCompose: [] },
    commands: []
  };
}

function service(id: string, repoId: string, root: string): NormalizedCatalog["services"][number] {
  return {
    id,
    repoId,
    root: ".",
    absolutePath: path.join(root, repoId),
    tags: [],
    aliases: [id],
    baseUrls: [],
    commands: []
  };
}

function withoutGeneratedAt(plan: ReturnType<typeof createPrOrchestrationPlan>) {
  const { generatedAt: _generatedAt, ...stable } = plan;
  return stable;
}
