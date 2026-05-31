import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP server exposes catalog, graph resources, and inline planning", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-mcp-"));
  await mkdir(path.join(root, "billing"), { recursive: true });
  await writeFile(path.join(root, "multirepo.yaml"), [
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
    name: "multirepo-mcp-integration-test",
    version: "0.1.0"
  });
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport);

  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
    "multirepo://catalog",
    "multirepo://graph/dependencies",
    "multirepo://graph/pending-links",
    "multirepo://graph/status"
  ]);

  const catalog = await client.readResource({ uri: "multirepo://catalog" });
  assert.equal(JSON.parse(textOf(catalog.contents[0])).services[0].id, "billing-api");

  const dependencies = await client.readResource({ uri: "multirepo://graph/dependencies" });
  assert.deepEqual(JSON.parse(textOf(dependencies.contents[0])), {
    dependencies: [],
    pendingCount: 0
  });

  const pendingLinks = await client.readResource({ uri: "multirepo://graph/pending-links" });
  assert.deepEqual(JSON.parse(textOf(pendingLinks.contents[0])), []);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "multirepo_graph_dependencies",
    "multirepo_graph_endpoints",
    "multirepo_graph_impact",
    "multirepo_plan_change_set"
  ]);
  const result = await client.callTool({
    name: "multirepo_plan_change_set",
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
    name: "multirepo_graph_impact",
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
