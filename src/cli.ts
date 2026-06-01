#!/usr/bin/env node
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { renderAgentsMd, renderClaudeMd } from "./adapters.ts";
import { normalizeCatalog } from "./catalog.ts";
import { loadConfig } from "./config.ts";
import { readText, stableJson, writeText } from "./fs.ts";
import { initProject } from "./init.ts";
import { resolveOutput } from "./paths.ts";
import { planChangeSet } from "./planner.ts";
import { renderChangeSet, renderVerification, renderWorkspace } from "./render.ts";
import type { ChangeSet, NormalizedCatalog } from "./types.ts";
import { verifyPlan } from "./verify.ts";
import { enrichGraph, saveLinkDecision } from "./graph/enrich.ts";
import { indexGraph } from "./graph/indexer.ts";
import { closeProjection } from "./graph/projection.ts";
import { getGraphStatus, listDependencies, listEndpoints, listPendingLinkDetails, queryTransitiveImpact } from "./graph/query.ts";
import { startGraphPreview } from "./graph/preview.ts";
import { assembleWorkspaceBundle } from "./workspace/index.ts";
import { startMultiRepoStdioServer } from "./mcp/stdio.ts";
import { createPrOrchestrationPlan, renderPrOrchestrationPlan } from "./pr/orchestrator.ts";
import type { WorkspaceManifest } from "./workspace/types.ts";

type Args = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

async function main(): Promise<void> {
  const root = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "init": {
      const created = await initProject(root);
      print(`Initialized Service Parade:\n${created.map((item) => `- ${item}`).join("\n")}`);
      return;
    }
    case "scan":
    case "catalog": {
      const catalog = await loadNormalizedCatalog(root, args.flags.config);
      await writeJson(root, "catalog.json", catalog);
      print(`Wrote ${resolveOutput(root, "catalog.json")}`);
      return;
    }
    case "plan": {
      const spec = requireFlag(args.flags, "spec");
      const catalog = await loadNormalizedCatalog(root, args.flags.config);
      const plan = await planChangeSet(catalog, path.resolve(root, spec));
      await writeJson(root, "change-set.json", plan);
      await writeText(resolveOutput(root, "change-set.md"), renderChangeSet(plan));
      print(`Wrote ${resolveOutput(root, "change-set.json")} and ${resolveOutput(root, "change-set.md")}`);
      return;
    }
    case "assemble": {
      const catalog = await loadCatalogArtifact(root, args.flags.config);
      const plan = await loadPlan(root, args.flags.plan);
      const bundle = await assembleWorkspaceBundle(catalog, plan, resolveOutput(root, "workspace"));
      await writeText(resolveOutput(root, "workspace.md"), renderWorkspace(catalog, plan));
      print(`Wrote ${resolveOutput(root, "workspace.md")} and ${bundle.files.length} structured workspace handoff file(s) under ${bundle.outputDirectory}`);
      return;
    }
    case "instructions": {
      const catalog = await loadCatalogArtifact(root, args.flags.config);
      await writeText(resolveOutput(root, "AGENTS.md"), renderAgentsMd(catalog));
      await writeText(resolveOutput(root, "CLAUDE.md"), renderClaudeMd(catalog));
      print(`Wrote ${resolveOutput(root, "AGENTS.md")} and ${resolveOutput(root, "CLAUDE.md")}`);
      return;
    }
    case "verify": {
      const catalog = await loadCatalogArtifact(root, args.flags.config);
      const planPath = path.resolve(root, String(args.flags.plan ?? resolveOutput(root, "change-set.json")));
      const plan = JSON.parse(await readText(planPath)) as ChangeSet;
      const report = await verifyPlan(catalog, plan, planPath);
      await writeJson(root, "verification-report.json", report);
      await writeText(resolveOutput(root, "verification-report.md"), renderVerification(report));
      print(`Wrote ${resolveOutput(root, "verification-report.json")} and ${resolveOutput(root, "verification-report.md")}`);
      if (!report.passed) {
        process.exitCode = 1;
      }
      return;
    }
    case "graph": {
      await runGraphCommand(root, args);
      return;
    }
    case "mcp": {
      await startMultiRepoStdioServer({
        root,
        config: typeof args.flags.config === "string" ? args.flags.config : undefined
      });
      return;
    }
    case "pr": {
      await runPrCommand(root, args);
      return;
    }
    case "help":
    default:
      print(help());
  }
}

async function runPrCommand(root: string, args: Args): Promise<void> {
  const action = args.positionals[0] ?? "help";
  if (action !== "plan") {
    print(prHelp());
    return;
  }
  const catalog = await loadCatalogArtifact(root, args.flags.config);
  const plan = await loadPlan(root, args.flags.plan);
  const workspace = await loadWorkspaceManifest(root);
  const orchestration = createPrOrchestrationPlan(catalog, plan, workspace);
  await writeJson(root, "pr-plan.json", orchestration);
  await writeText(resolveOutput(root, "pr-plan.md"), renderPrOrchestrationPlan(orchestration));
  print(`Wrote ${resolveOutput(root, "pr-plan.json")} and ${resolveOutput(root, "pr-plan.md")}`);
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return { command, positionals, flags };
}

async function runGraphCommand(root: string, args: Args): Promise<void> {
  const action = args.positionals[0] ?? "help";
  if (action === "index") {
    const catalog = await loadNormalizedCatalog(root, args.flags.config);
    const summary = await indexGraph(root, catalog);
    print(`Indexed ${summary.files} file(s), ${summary.facts} fact(s): ${summary.parsed} parsed, ${summary.cacheHits} cache hit(s), ${summary.deleted} deleted.`);
    return;
  }
  if (action === "enrich") {
    const catalog = await loadNormalizedCatalog(root, args.flags.config);
    const summary = await enrichGraph(root, catalog).finally(() => closeProjection(root));
    print(`Enriched graph: ${summary.dependencies} accepted HTTP dependency edge(s), ${summary.pending} pending review.`);
    return;
  }
  if (action === "deps") {
    const dependencies = await listDependencies(root, {
      serviceId: optionalStringFlag(args.flags, "service"),
      direction: optionalDirectionFlag(args.flags.direction)
    });
    if (args.flags.json) {
      process.stdout.write(stableJson(dependencies));
    } else {
      print(dependencies.length > 0
        ? dependencies.map((edge) => `${edge.sourceServiceId} -> ${edge.targetServiceId}: ${edge.httpMethod} ${edge.endpointPath} (${edge.reviewStatus})`).join("\n")
        : "No accepted HTTP dependencies.");
    }
    return;
  }
  if (action === "status") {
    const catalog = await loadNormalizedCatalog(root, args.flags.config);
    const status = await getGraphStatus(root, catalog);
    if (args.flags.json) {
      process.stdout.write(stableJson(status));
    } else {
      print(`Graph status: indexed=${status.indexed} enriched=${status.enriched} fresh=${status.fresh} dependencies=${status.dependencies} pending=${status.pendingLinks}`);
    }
    return;
  }
  if (action === "impact") {
    const serviceId = requirePositional(args.positionals, 1, "service id");
    const impact = await queryTransitiveImpact(root, serviceId, optionalDepthFlag(args.flags.depth));
    if (args.flags.json) {
      process.stdout.write(stableJson(impact));
    } else {
      print(impact.impactedServices.length > 0
        ? impact.impactedServices.map((service) => `${service.serviceId}: depth ${service.depth}`).join("\n")
        : `No dependent services found for ${serviceId}.`);
    }
    return;
  }
  if (action === "endpoints") {
    const endpoints = listEndpoints(root, { serviceId: optionalStringFlag(args.flags, "service") });
    if (args.flags.json) {
      process.stdout.write(stableJson(endpoints));
    } else {
      print(endpoints.length > 0
        ? endpoints.map((endpoint) => `${endpoint.serviceId}: ${endpoint.httpMethod} ${endpoint.path} (${endpoint.file}:${endpoint.line})`).join("\n")
        : "No indexed HTTP endpoints.");
    }
    return;
  }
  if (action === "preview") {
    const catalog = await loadNormalizedCatalog(root, args.flags.config);
    const host = optionalStringFlag(args.flags, "host") ?? "127.0.0.1";
    const port = optionalPortFlag(args.flags.port);
    const preview = await startGraphPreview(root, catalog, { host, port });
    print(`Serving read-only graph preview at ${preview.url}`);
    return;
  }
  if (action === "links") {
    await runGraphLinksCommand(root, args);
    return;
  }
  print(graphHelp());
}

async function runGraphLinksCommand(root: string, args: Args): Promise<void> {
  const action = args.positionals[1] ?? "list";
  if (action === "list") {
    const catalog = await loadNormalizedCatalog(root, args.flags.config);
    const links = listPendingLinkDetails(root, catalog);
    if (args.flags.json) {
      process.stdout.write(stableJson(links));
    } else {
      print(links.length > 0
        ? links.map((link) => `${link.id}: ${link.sourceLabel}; ${link.reason}; candidates=${link.candidates.map((candidate) => candidate.label).join(", ") || "none"}`).join("\n")
        : "No pending HTTP links.");
    }
    return;
  }
  if (action === "approve" || action === "reject") {
    const id = requirePositional(args.positionals, 2, "pending link id");
    const decidedBy = requireDecidedBy(args.flags["decided-by"]);
    const target = typeof args.flags.target === "string" ? args.flags.target : undefined;
    saveLinkDecision(root, id, action === "approve" ? "approved" : "rejected", target, decidedBy);
    const catalog = await loadNormalizedCatalog(root, args.flags.config);
    const summary = await enrichGraph(root, catalog).finally(() => closeProjection(root));
    print(`${action === "approve" ? "Approved" : "Rejected"} ${id}. Graph now has ${summary.dependencies} accepted edge(s) and ${summary.pending} pending review.`);
    return;
  }
  print(graphHelp());
}

function requireDecidedBy(value: string | boolean | undefined): "human" | "llm" {
  if (value === undefined) return "human";
  if (value === "human" || value === "llm") return value;
  throw new Error('The "--decided-by" flag must be either "human" or "llm".');
}

function optionalStringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalDirectionFlag(value: string | boolean | undefined): "in" | "out" | "both" | undefined {
  if (value === undefined) return undefined;
  if (value === "in" || value === "out" || value === "both") return value;
  throw new Error('The "--direction" flag must be "in", "out", or "both".');
}

function optionalDepthFlag(value: string | boolean | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error('The "--depth" flag must be a non-negative integer.');
  }
  return Number(value);
}

function optionalPortFlag(value: string | boolean | undefined): number {
  if (value === undefined) return 4173;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error('The "--port" flag must be an integer between 0 and 65535.');
  }
  const port = Number(value);
  if (port < 0 || port > 65535) {
    throw new Error('The "--port" flag must be an integer between 0 and 65535.');
  }
  return port;
}

async function loadNormalizedCatalog(root: string, configFlag: string | boolean | undefined): Promise<NormalizedCatalog> {
  const { config } = await loadConfig(root, typeof configFlag === "string" ? configFlag : undefined);
  return normalizeCatalog(config, root);
}

async function loadCatalogArtifact(root: string, configFlag: string | boolean | undefined): Promise<NormalizedCatalog> {
  try {
    return JSON.parse(await readText(resolveOutput(root, "catalog.json"))) as NormalizedCatalog;
  } catch {
    return loadNormalizedCatalog(root, configFlag);
  }
}

async function loadPlan(root: string, planFlag: string | boolean | undefined): Promise<ChangeSet> {
  const planPath = path.resolve(root, typeof planFlag === "string" ? planFlag : resolveOutput(root, "change-set.json"));
  return JSON.parse(await readText(planPath)) as ChangeSet;
}

async function loadWorkspaceManifest(root: string): Promise<WorkspaceManifest | undefined> {
  try {
    return JSON.parse(await readText(resolveOutput(root, path.join("workspace", "workspace-manifest.json")))) as WorkspaceManifest;
  } catch {
    return undefined;
  }
}

async function writeJson(root: string, file: string, value: unknown): Promise<void> {
  await mkdir(resolveOutput(root, "."), { recursive: true });
  await writeText(resolveOutput(root, file), stableJson(value));
}

function requireFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required --${name} <path> flag.`);
  }
  return value;
}

function requirePositional(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value) {
    throw new Error(`Missing required ${label}.`);
  }
  return value;
}

function help(): string {
  return `Usage: multirepo <command> [options]

Commands:
  init                    Create multirepo.yaml and .multirepo/
  scan                    Infer repo metadata and write .multirepo/catalog.json
  catalog                 Validate and write normalized catalog
  plan --spec <file>      Create .multirepo/change-set.{json,md}
  assemble [--plan file]  Create .multirepo/workspace.md
  instructions            Create .multirepo/AGENTS.md and .multirepo/CLAUDE.md
  verify [--plan file]    Run configured commands and write verification reports
  graph index             Incrementally index HTTP facts under declared services
  graph enrich            Match HTTP calls to endpoints and rebuild the graph
  graph deps [--json]     Print accepted HTTP dependencies
  graph status [--json]   Print graph indexing and enrichment freshness
  graph impact <service>  Print transitive dependent services
  graph endpoints         Print indexed HTTP endpoints
  graph preview           Serve a read-only local HTTP graph visualization
  graph links ...         List, approve, or reject uncertain HTTP links
  mcp                     Start the read-only MCP context server over stdio
  pr plan [--plan file]   Write a local-first multi-PR dry-run plan

Options:
  --config <file>         Use a specific catalog file
`;
}

function prHelp(): string {
  return `Usage: multirepo pr <command>

Commands:
  plan [--plan file]      Write .multirepo/pr-plan.{json,md}
`;
}

function graphHelp(): string {
  return `Usage: multirepo graph <command>

Commands:
  index
  enrich
  deps [--service id] [--direction in|out|both] [--json]
  status [--json]
  impact <service-id> [--depth N] [--json]
  endpoints [--service id] [--json]
  links list [--json]
  links approve <pending-id> --target <endpoint-id> [--decided-by human|llm]
  links reject <pending-id> [--decided-by human|llm]
`;
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
