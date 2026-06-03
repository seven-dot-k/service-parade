import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assembleWorkspaceBundle,
  createRepoAgentHandoffs,
  createWorkspaceManifest
} from "../src/workspace/index.ts";
import type { ChangeSet, NormalizedCatalog } from "../src/types.ts";

test("workspace manifest carries dependency evidence and executable verification commands", () => {
  const { catalog, changeSet } = fixture("/tmp/service-parade-workspace");
  changeSet.affectedRepos[0].commands = [{ name: "tampered", run: "rm -rf /" }];
  changeSet.affectedServices[0].commands = [{ name: "tampered", run: "rm -rf /" }];

  const manifest = createWorkspaceManifest(catalog, changeSet);

  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.repositories.map((repo) => repo.id), ["billing"]);
  assert.deepEqual(manifest.services.map((service) => service.id), ["billing-api"]);
  assert.deepEqual(manifest.dependencies[0].evidence, {
    file: "src/client.ts",
    line: 12,
    rawUrl: "`/accounts/${id}`"
  });
  assert.deepEqual(
    manifest.verificationCommands.map((command) => [command.targetType, command.targetId, command.name, command.cwd]),
    [
      ["repo", "billing", "lint", "/tmp/service-parade-workspace/billing"],
      ["service", "billing-api", "test", "/tmp/service-parade-workspace/billing/services/api"]
    ]
  );
});

test("workspace assembly writes a manifest and repo-specific agent handoffs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-workspace-"));
  const { catalog, changeSet } = fixture(root);
  const output = path.join(root, ".service-parade", "workspace");

  const bundle = await assembleWorkspaceBundle(catalog, changeSet, output);
  const manifest = await readFile(path.join(output, "workspace-manifest.json"), "utf8");
  const agents = await readFile(path.join(output, "repos", "billing", "AGENTS.md"), "utf8");
  const claude = await readFile(path.join(output, "repos", "billing", "CLAUDE.md"), "utf8");

  assert.equal(bundle.files.length, 3);
  assert.match(manifest, /"dependencies": \[/);
  assert.equal(manifest.includes('"rawUrl": "`/accounts/${id}`"'), true);
  assert.match(agents, /Generated repository handoff for `billing`/);
  assert.match(agents, /billing-api -> identity-api: GET \/accounts\/\{id\}; evidence src\/client\.ts:12/);
  assert.match(claude, /Use the structured workspace manifest as the source of truth/);
  assert.doesNotMatch(agents, /identity repo reason/);
});

test("repo handoff directories encode unsafe path segments", () => {
  const { catalog, changeSet } = fixture("/tmp/service-parade-workspace");
  catalog.repos[0].id = "..";
  catalog.services[0].repoId = "..";
  changeSet.affectedRepos[0].id = "..";
  changeSet.affectedServices[0].repoId = "..";

  const [handoff] = createRepoAgentHandoffs(catalog, changeSet);

  assert.equal(handoff.directory, "repos/%2E%2E");
});

function fixture(root: string): { catalog: NormalizedCatalog; changeSet: ChangeSet } {
  const repoRoot = path.join(root, "billing");
  const serviceRoot = path.join(repoRoot, "services", "api");
  const repoCommand = { name: "lint", run: "npm run lint", scope: "repo" as const, repoId: "billing" };
  const serviceCommand = { name: "test", run: "npm test", scope: "service" as const, serviceId: "billing-api" };
  const catalog: NormalizedCatalog = {
    generatedAt: "2026-05-31T12:00:00.000Z",
    root,
    repos: [{
      id: "billing",
      path: "billing",
      absolutePath: repoRoot,
      defaultBranch: "main",
      owner: "payments",
      inferred: { languages: ["typescript"], manifests: [], dockerCompose: [] },
      commands: [repoCommand],
      httpDiscovery: { sdkPackages: [] }
    }],
    services: [{
      id: "billing-api",
      repoId: "billing",
      root: "services/api",
      absolutePath: serviceRoot,
      language: "typescript",
      tags: ["billing"],
      aliases: ["billing-api"],
      baseUrls: [],
      commands: [serviceCommand]
    }],
    sdkSources: [],
    commands: []
  };
  const changeSet: ChangeSet = {
    generatedAt: "2026-05-31T12:05:00.000Z",
    specPath: path.join(root, "feature.md"),
    summary: "Add identity account checks to billing.",
    affectedServices: [{
      id: "billing-api",
      repoId: "billing",
      reasons: ["Spec mentions billing-api"],
      commands: [serviceCommand, repoCommand]
    }],
    affectedRepos: [{
      id: "billing",
      path: "billing",
      reasons: ["Contains matched service billing-api"],
      commands: [repoCommand]
    }],
    dependencyEdges: [{
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
    }],
    recommendedOrder: ["billing-api"],
    risks: []
  };
  return { catalog, changeSet };
}
