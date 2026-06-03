import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCatalog } from "../src/catalog.ts";
import { enrichGraph, listPendingLinks, loadDependencyArtifact, saveLinkDecision } from "../src/graph/enrich.ts";
import { indexGraph } from "../src/graph/indexer.ts";
import { closeProjection } from "../src/graph/projection.ts";
import { planChangeSet } from "../src/planner.ts";

test("indexes, enriches, reviews, and plans from discovered HTTP dependencies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-graph-"));
  t.after(() => closeProjection(root));
  await write(root, "storefront/server.ts", [
    `app.get("/local", () => {});`,
    `fetch("http://orders-svc/health");`,
    `fetch("http://inventory-svc/inventory");`,
    "axios.get(`/orders/${id}`);",
    `fetch("/status");`,
    `fetch(dynamicUrl);`,
    `fetch("https://external.example/health");`,
    `fetch("/local");`
  ].join("\n"));
  await write(root, "storefront/app/api/cart/route.ts", `export async function GET() { return Response.json({ ok: true }); }\n`);
  await write(root, "orders/Program.cs", [
    `app.MapGet("/health", () => "ok");`,
    `app.MapGet("/orders/{id}", (string id) => id);`,
    `app.MapGet("/status", () => "ok");`,
    `client.GetAsync("http://storefront-api/api/cart");`,
    `client.GetAsync("http://fulfillment-svc/fulfill");`
  ].join("\n"));
  await write(root, "inventory/server.ts", `app.get("/status", () => {});\napp.get("/inventory", () => {});\n`);
  await write(root, "fulfillment/Program.cs", `app.MapGet("/fulfill", () => "ok");\n`);
  await write(root, "orders/appsettings.json", JSON.stringify({ Services: { Storefront: "http://storefront-api" } }));

  const catalog = await normalizeCatalog({
    repos: [
      { id: "storefront", path: "storefront" },
      { id: "orders", path: "orders" },
      { id: "inventory", path: "inventory" },
      { id: "fulfillment", path: "fulfillment" }
    ],
    services: [
      { id: "storefront-api", repoId: "storefront", aliases: ["storefront-api"] },
      { id: "orders-api", repoId: "orders", aliases: ["orders-svc"] },
      { id: "inventory-api", repoId: "inventory", aliases: ["inventory-svc"] },
      { id: "fulfillment-api", repoId: "fulfillment", aliases: ["fulfillment-svc"] }
    ]
  }, root);

  const firstIndex = await indexGraph(root, catalog);
  const firstManifest = await readFile(path.join(root, ".service-parade", "graph", "index-manifest.json"), "utf8");
  assert.equal(firstIndex.parsed, 6);
  const secondIndex = await indexGraph(root, catalog);
  const secondManifest = await readFile(path.join(root, ".service-parade", "graph", "index-manifest.json"), "utf8");
  assert.equal(secondIndex.cacheHits, firstIndex.files);
  assert.equal(secondIndex.manifestHash, firstIndex.manifestHash);
  assert.equal(secondManifest, firstManifest);
  await write(root, "fulfillment/Program.cs", `app.MapGet("/fulfill", () => "ok");\n// changed\n`);
  const thirdIndex = await indexGraph(root, catalog);
  assert.equal(thirdIndex.parsed, 1);

  const firstEnrich = await enrichGraph(root, catalog);
  assert.equal(firstEnrich.dependencies, 5);
  const firstDependencies = await readFile(path.join(root, ".service-parade", "graph", "dependencies.json"), "utf8");
  await enrichGraph(root, catalog);
  const secondDependencies = await readFile(path.join(root, ".service-parade", "graph", "dependencies.json"), "utf8");
  assert.equal(secondDependencies, firstDependencies);
  const artifact = await loadDependencyArtifact(root);
  assert.ok(artifact);
  assert.equal(artifact.dependencies.some((edge) => edge.sourceServiceId === "storefront-api" && edge.endpointPath === "/orders/*"), true);
  assert.equal(artifact.dependencies.some((edge) => edge.sourceServiceId === "orders-api" && edge.targetServiceId === "storefront-api"), true);
  assert.equal(artifact.dependencies.some((edge) => edge.sourceServiceId === "orders-api" && edge.targetServiceId === "fulfillment-api"), true);
  assert.equal(artifact.dependencies.some((edge) => edge.sourceServiceId === "storefront-api" && edge.targetServiceId === "inventory-api"), true);

  const pending = listPendingLinks(root);
  assert.equal(pending.length, 3);
  assert.equal(pending.some((link) => link.reason.includes("external.example")), true);
  const ambiguous = pending.find((link) => link.candidateEndpointIds.length === 2);
  const unresolved = pending.find((link) => link.reason.includes("fully dynamic"));
  assert.ok(ambiguous);
  assert.ok(unresolved);

  saveLinkDecision(root, ambiguous.id, "approved", ambiguous.candidateEndpointIds[0], "human");
  saveLinkDecision(root, unresolved.id, "rejected", undefined, "llm");
  const secondEnrich = await enrichGraph(root, catalog);
  assert.equal(secondEnrich.dependencies, 6);
  assert.equal(secondEnrich.pending, 1);

  const spec = path.join(root, "spec.md");
  await writeFile(spec, "Update fulfillment-api behavior.", "utf8");
  const plan = await planChangeSet(catalog, spec);
  assert.equal(plan.affectedServices.some((service) => service.id === "orders-api"), true);
  assert.equal(plan.dependencyEdges.some((edge) => edge.targetServiceId === "fulfillment-api"), true);
});

test("indexes configured SDK source clients as outbound HTTP dependencies", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-sdk-graph-"));
  t.after(() => closeProjection(root));
  await write(root, "login/Login.csproj", `<Project><ItemGroup><PackageReference Include="Mozu.AdminUser.Contracts" Version="1.0.0" /></ItemGroup></Project>`);
  await write(root, "login/App_Start/AutoFacSetup.cs", [
    "using Mozu.AdminUser.Contracts.Clients;",
    "public class AutoFacSetup { }"
  ].join("\n"));
  await write(root, "admin/Mozu.AdminUser.Contracts/CCG.targets", [
    "<Project>",
    "  <Target Name=\"BuildServiceClients\">",
    "    <Exec Command=\"$(CodeGenExe) -t $(SourceNS).MultiScopeAdminAuthTicketController -a $(ServiceAssembly) -ns $(Target_Namespace) -o $(ClientDir)\" />",
    "  </Target>",
    "</Project>"
  ].join("\n"));
  await write(root, "admin/Mozu.AdminUser.Contracts/Clients/MultiScopeAdminAuthTicketWebApiClient.cs", [
    "namespace Mozu.AdminUser.Contracts.Clients {",
    "  public partial class MultiScopeAdminAuthTicketWebApiClient {",
    "    public override string ServiceId { get { return \"MultiScopeAdminAuthTicketWebApi\"; } }",
    "    public object GetTokenInfo(string token) {",
    "      var relpath = \"tokeninfo?responseFields=\" + Format(null, true);",
    "      return Handler.SendAsync<string>(\"POST\", relpath, ServiceId, Options);",
    "    }",
    "  }",
    "}"
  ].join("\n"));

  const catalog = await normalizeCatalog({
    repos: [
      { id: "login", path: "login", httpDiscovery: { sdkPackages: ["Mozu.*.Contracts"] } },
      { id: "admin", path: "admin" }
    ],
    services: [
      { id: "login-api", repoId: "login" },
      { id: "admin-user-api", repoId: "admin" }
    ],
    sdkSources: [{
      id: "admin-user-contract-clients",
      packages: ["Mozu.AdminUser.Contracts", "Mozu.AdminUser.Contracts.Clients"],
      source: "admin/Mozu.AdminUser.Contracts",
      targetServiceId: "admin-user-api",
      detector: "mozu-service-client",
      options: { clientDir: "Clients", codegenTargets: "CCG.targets" }
    }]
  }, root);

  const index = await indexGraph(root, catalog);
  assert.equal(index.facts, 2);
  const enrich = await enrichGraph(root, catalog);
  assert.equal(enrich.dependencies, 1);
  assert.equal(enrich.pending, 0);
  const artifact = await loadDependencyArtifact(root);
  assert.ok(artifact);
  assert.equal(artifact.dependencies[0].sourceServiceId, "login-api");
  assert.equal(artifact.dependencies[0].targetServiceId, "admin-user-api");
  assert.equal(artifact.dependencies[0].httpMethod, "POST");
  assert.equal(artifact.dependencies[0].endpointPath, "/MultiScopeAdminAuthTicketWebApi/tokeninfo");
  assert.equal(artifact.dependencies[0].evidence.derivedFrom?.packageName, "Mozu.AdminUser.Contracts");
  assert.equal(artifact.dependencies[0].evidence.derivedFrom?.consumerFile, "login/Login.csproj");
});

test("does not scan SDK sources without a repo package opt-in", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-sdk-disabled-"));
  t.after(() => closeProjection(root));
  await write(root, "login/Login.csproj", `<Project><ItemGroup><PackageReference Include="Mozu.AdminUser.Contracts" Version="1.0.0" /></ItemGroup></Project>`);
  await write(root, "admin/Mozu.AdminUser.Contracts/CCG.targets", "<Project />");
  await write(root, "admin/Mozu.AdminUser.Contracts/Clients/MultiScopeAdminAuthTicketWebApiClient.cs", [
    "public partial class MultiScopeAdminAuthTicketWebApiClient {",
    "  public override string ServiceId { get { return \"MultiScopeAdminAuthTicketWebApi\"; } }",
    "}"
  ].join("\n"));
  const catalog = await normalizeCatalog({
    repos: [
      { id: "login", path: "login" },
      { id: "admin", path: "admin" }
    ],
    services: [
      { id: "login-api", repoId: "login" },
      { id: "admin-user-api", repoId: "admin" }
    ],
    sdkSources: [{
      id: "admin-user-contract-clients",
      packages: ["Mozu.AdminUser.Contracts"],
      source: "admin/Mozu.AdminUser.Contracts",
      targetServiceId: "admin-user-api",
      detector: "mozu-service-client"
    }]
  }, root);

  const index = await indexGraph(root, catalog);
  assert.equal(index.facts, 0);
});

async function write(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}
