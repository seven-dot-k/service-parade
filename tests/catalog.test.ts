import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderAgentsMd, renderClaudeMd } from "../src/adapters.ts";
import { normalizeCatalog } from "../src/catalog.ts";
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
