import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP server exposes catalog, graph resources, and inline planning", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-parade-mcp-"));
  await mkdir(path.join(root, "billing"), { recursive: true });
  await writeFile(path.join(root, "service-parade.yaml"), [
    "repos:",
    "  - id: billing",
    "    path: billing",
    "services:",
    "  - id: billing-api",
    "    repoId: billing",
    "    tags: [invoices]"
  ].join("\n"), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp/stdio.ts", "--root", root],
    cwd: path.resolve("."),
    stderr: "pipe"
  });
  const client = new Client({
    name: "service-parade-mcp-integration-test",
    version: "0.1.0"
  });
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport);

  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
    "service-parade://catalog",
    "service-parade://graph/dependencies",
    "service-parade://graph/pending-links",
    "service-parade://graph/status"
  ]);

  const catalog = await client.readResource({ uri: "service-parade://catalog" });
  assert.equal(JSON.parse(textOf(catalog.contents[0])).services[0].id, "billing-api");

  const dependencies = await client.readResource({ uri: "service-parade://graph/dependencies" });
  assert.deepEqual(JSON.parse(textOf(dependencies.contents[0])), {
    dependencies: [],
    pendingCount: 0
  });

  const pendingLinks = await client.readResource({ uri: "service-parade://graph/pending-links" });
  assert.deepEqual(JSON.parse(textOf(pendingLinks.contents[0])), []);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "service_parade_graph_dependencies",
    "service_parade_graph_endpoints",
    "service_parade_graph_impact",
    "service_parade_plan_change_set"
  ]);
  const result = await client.callTool({
    name: "service_parade_plan_change_set",
    arguments: { spec: "Add billing-api invoice adjustments." }
  });
  assert.equal(result.isError, undefined);
  if (!Array.isArray(result.content) || result.content[0]?.type !== "text") {
    throw new Error("Expected a text tool result.");
  }
  const plan = JSON.parse(result.content[0].text);
  assert.deepEqual(plan.affectedServices.map((service: { id: string }) => service.id), ["billing-api"]);
  assert.equal(plan.specPath.startsWith(os.tmpdir()), true);

  const impact = await client.callTool({
    name: "service_parade_graph_impact",
    arguments: { serviceId: "billing-api", maxDepth: 1 }
  });
  if (!Array.isArray(impact.content) || impact.content[0]?.type !== "text") {
    throw new Error("Expected graph impact text.");
  }
  assert.deepEqual(JSON.parse(impact.content[0].text).impactedServices, []);
});

function textOf(content: unknown): string {
  if (!content || typeof content !== "object" || !("text" in content) || typeof content.text !== "string") {
    throw new Error("Expected text resource content.");
  }
  return content.text;
}
