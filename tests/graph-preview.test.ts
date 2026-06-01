import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCatalog } from "../src/catalog.ts";
import { enrichGraph } from "../src/graph/enrich.ts";
import { indexGraph } from "../src/graph/indexer.ts";
import { startGraphPreview } from "../src/graph/preview.ts";

test("graph preview serves a read-only HTML view and graph JSON", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-preview-"));
  await mkdir(path.join(root, "web"));
  await mkdir(path.join(root, "orders"));
  await writeFile(path.join(root, "web", "server.ts"), 'fetch("http://orders-svc/health");\n', "utf8");
  await writeFile(path.join(root, "orders", "server.ts"), 'app.get("/health", () => "ok");\n', "utf8");
  const catalog = await normalizeCatalog({
    repos: [{ id: "web", path: "web" }, { id: "orders", path: "orders" }],
    services: [
      { id: "web-api", repoId: "web" },
      { id: "orders-api", repoId: "orders", aliases: ["orders-svc"] }
    ]
  }, root);
  await indexGraph(root, catalog);
  await enrichGraph(root, catalog);
  const preview = await startGraphPreview(root, catalog, { port: 0 });
  t.after(() => preview.server.close());

  const html = await fetch(preview.url).then((response) => response.text());
  const model = await fetch(`${preview.url}/api/graph`).then((response) => response.json());

  assert.match(html, /Service Parade/);
  assert.match(html, /marker-end/);
  assert.match(html, /marker-start/);
  assert.match(html, /group\.left \+ arrowText \+ group\.right/);
  assert.deepEqual(model.services.map((service: { id: string }) => service.id), ["orders-api", "web-api"]);
  assert.equal(model.dependencies.length, 1);
  assert.equal(model.dependencies[0].sourceServiceId, "web-api");
  assert.equal(model.dependencies[0].targetServiceId, "orders-api");
});

test("graph preview does not create storage in an unindexed workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-preview-empty-"));
  const catalog = await normalizeCatalog({
    repos: [{ id: "web", path: "." }],
    services: [{ id: "web-api", repoId: "web" }]
  }, root);
  const preview = await startGraphPreview(root, catalog, { port: 0 });
  t.after(() => preview.server.close());

  const model = await fetch(`${preview.url}/api/graph`).then((response) => response.json());
  await assert.rejects(() => access(path.join(root, ".service-parade", "graph", "graph.sqlite")));
  assert.equal(model.status.indexed, false);
  assert.equal(model.dependencies.length, 0);
});

test("graph preview rejects writes and unknown paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-preview-routing-"));
  const catalog = await normalizeCatalog({
    repos: [{ id: "web", path: "." }],
    services: [{ id: "web-api", repoId: "web" }]
  }, root);
  const preview = await startGraphPreview(root, catalog, { port: 0 });
  t.after(() => preview.server.close());

  assert.equal((await fetch(`${preview.url}/missing`)).status, 404);
  assert.equal((await fetch(`${preview.url}/api/graph`, { method: "POST" })).status, 405);
});
