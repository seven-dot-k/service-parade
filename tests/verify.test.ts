import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCatalog } from "../src/catalog.ts";
import type { ChangeSet } from "../src/types.ts";
import { verifyPlan } from "../src/verify.ts";

test("verification ignores commands serialized in a tampered plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-verify-plan-"));
  const repoPath = path.join(root, "repo-a");
  await mkdir(repoPath);
  const catalog = await normalizeCatalog(
    {
      repos: [{
        id: "repo-a",
        path: "repo-a",
        commands: [{ name: "canonical", run: "node -e \"console.log('catalog command')\"" }]
      }]
    },
    root
  );
  const plan = changeSet({
    affectedRepos: [{
      id: "repo-a",
      path: "repo-a",
      reasons: [],
      commands: [{ name: "tampered", run: "node -e \"process.exit(19)\"" }]
    }]
  });

  const report = await verifyPlan(catalog, plan, path.join(root, "change-set.json"));

  assert.equal(report.passed, true);
  assert.deepEqual(report.results.map((result) => result.name), ["canonical"]);
  assert.match(report.results[0].stdout, /catalog command/);
});

test("verification rejects a command cwd that escapes its owning repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-verify-cwd-"));
  await mkdir(path.join(root, "repo-a"));
  await assert.rejects(
    () => normalizeCatalog({
      repos: [{
        id: "repo-a",
        path: "repo-a",
        commands: [{ name: "escape", run: "node -e \"process.exit(0)\"", cwd: ".." }]
      }]
    }, root),
    /escapes repo-a root/
  );
});

test("verification rejects unknown affected IDs from a tampered plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-verify-owner-"));
  const catalog = await normalizeCatalog({ repos: [{ id: "repo-a", path: "." }] }, root);

  await assert.rejects(
    () => verifyPlan(catalog, changeSet({
      affectedRepos: [{ id: "missing", path: ".", reasons: [], commands: [] }]
    }), path.join(root, "change-set.json")),
    /unknown repo "missing"/
  );
});

test("catalog rejects globally scoped commands with unknown owners", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-verify-global-"));

  await assert.rejects(
    () => normalizeCatalog({
      repos: [{ id: "repo-a", path: "." }],
      commands: [{ name: "test", run: "node --test", scope: "repo", repoId: "missing" }]
    }, root),
    /unknown repo "missing"/
  );
});

test("nested service commands default to execution from the service root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-verify-service-"));
  const servicePath = path.join(root, "repo-a", "services", "orders");
  await mkdir(servicePath, { recursive: true });
  const catalog = await normalizeCatalog(
    {
      repos: [{ id: "repo-a", path: "repo-a" }],
      services: [{
        id: "orders-api",
        repoId: "repo-a",
        root: "services/orders",
        commands: [{ name: "where", run: "node -e \"console.log(process.cwd())\"" }]
      }]
    },
    root
  );

  const report = await verifyPlan(catalog, changeSet({
    affectedServices: [{ id: "orders-api", repoId: "repo-a", reasons: [], commands: [] }]
  }), path.join(root, "change-set.json"));

  assert.equal(report.passed, true);
  assert.equal(report.results[0].target, "orders-api");
  assert.equal(report.results[0].cwd, servicePath);
  assert.equal(report.results[0].stdout.trim(), servicePath);
  assert.deepEqual(catalog.services[0].commands[0], {
    name: "where",
    run: "node -e \"console.log(process.cwd())\"",
    scope: "service",
    repoId: undefined,
    serviceId: "orders-api"
  });
});

function changeSet(overrides: Partial<ChangeSet>): ChangeSet {
  return {
    generatedAt: new Date().toISOString(),
    specPath: "spec.md",
    summary: "test",
    affectedServices: [],
    affectedRepos: [],
    dependencyEdges: [],
    recommendedOrder: [],
    risks: [],
    ...overrides
  };
}
