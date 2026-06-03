import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderAgentsMd, renderClaudeMd } from "../src/adapters.ts";
import { normalizeCatalog } from "../src/catalog.ts";
import { loadConfig } from "../src/config.ts";
import type { CatalogConfig } from "../src/types.ts";

test("normalizes a catalog and keeps explicit service values over inference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-catalog-"));
  const repoPath = path.join(root, "billing");
  await mkdir(repoPath);
  await writeFile(
    path.join(repoPath, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }),
    "utf8"
  );

  const config: CatalogConfig = {
    repos: [{ id: "billing", path: "billing" }],
    services: [
      {
        id: "billing-api",
        repoId: "billing",
        root: ".",
        language: "go",
        tags: ["payments"]
      }
    ],
    commands: [{ name: "lint", run: "npm run lint", scope: "repo", repoId: "billing" }]
  };

  const catalog = await normalizeCatalog(config, root);

  assert.equal(catalog.repos[0].inferred.packageManager, "npm");
  assert.deepEqual(catalog.repos[0].inferred.manifests, ["package.json"]);
  assert.equal(catalog.services[0].language, "go");
  assert.equal(catalog.repos[0].commands.some((command) => command.name === "test"), true);
  assert.equal(catalog.repos[0].commands.some((command) => command.name === "lint"), true);
});

test("loads nested YAML sdk discovery config and normalizes sdk sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-sdk-catalog-"));
  await mkdir(path.join(root, "login"), { recursive: true });
  await mkdir(path.join(root, "admin"), { recursive: true });
  await writeFile(path.join(root, "service-parade.yaml"), `
repos:
  - id: login
    path: login
    httpDiscovery:
      sdkPackages:
        - Mozu.AdminUser.Contracts
        - Mozu.*.Contracts
  - id: admin
    path: admin
services:
  - id: login-api
    repoId: login
  - id: admin-user-api
    repoId: admin
sdkSources:
  - id: admin-user-contract-clients
    packages: [Mozu.AdminUser.Contracts, Mozu.AdminUser.Contracts.Clients]
    source: admin
    targetServiceId: admin-user-api
    detector: mozu-service-client
    options:
      clientDir: Clients
      codegenTargets: CCG.targets
`, "utf8");

  const { config } = await loadConfig(root);
  const catalog = await normalizeCatalog(config, root);

  assert.deepEqual(catalog.repos.find((repo) => repo.id === "login")?.httpDiscovery.sdkPackages, [
    "Mozu.*.Contracts",
    "Mozu.AdminUser.Contracts"
  ]);
  assert.equal(catalog.sdkSources[0].id, "admin-user-contract-clients");
  assert.equal(catalog.sdkSources[0].absolutePath, path.join(root, "admin"));
  assert.equal(catalog.sdkSources[0].options.clientDir, "Clients");
});

test("rejects sdk sources targeting unknown services", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-sdk-invalid-"));
  await mkdir(path.join(root, "repo"), { recursive: true });
  await assert.rejects(() => normalizeCatalog({
    repos: [{ id: "repo", path: "repo" }],
    services: [{ id: "repo-api", repoId: "repo" }],
    sdkSources: [{
      id: "missing-target",
      packages: ["Acme.Contracts"],
      source: "repo",
      targetServiceId: "missing-api",
      detector: "mozu-service-client"
    }]
  }, root), /unknown target service/);
});

test("rejects legacy catalog dependencies with a migration message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-invalid-"));
  const config = {
    repos: [{ id: "billing", path: "." }],
    services: [{ id: "billing-api", repoId: "billing" }],
    dependencies: [{ from: "billing-api", to: "missing" }]
  };

  await assert.rejects(() => normalizeCatalog(config, root), /graph index/);
});

test("generates Codex and Claude instruction files from the same catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-adapters-"));
  const catalog = await normalizeCatalog(
    {
      repos: [{ id: "identity", path: "." }],
      services: [{ id: "identity-api", repoId: "identity", root: "api" }]
    },
    root
  );

  assert.match(renderAgentsMd(catalog), /AGENTS\.md/);
  assert.match(renderAgentsMd(catalog), /identity-api/);
  assert.match(renderClaudeMd(catalog), /CLAUDE\.md/);
  assert.match(renderClaudeMd(catalog), /service catalog/i);
});
