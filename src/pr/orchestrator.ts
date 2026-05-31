import type { ChangeSet, HttpDependency, NormalizedCatalog } from "../types.ts";
import type { WorkspaceManifest, WorkspaceVerificationCommand } from "../workspace/types.ts";
import type { PrDependencyRelationship, PrOrchestrationPlan, RepoPrPlan } from "./types.ts";

export type { PrDependencyRelationship, PrOrchestrationPlan, RepoPrPlan } from "./types.ts";

export function createPrOrchestrationPlan(
  catalog: NormalizedCatalog,
  changeSet: ChangeSet,
  workspaceManifest?: WorkspaceManifest
): PrOrchestrationPlan {
  const affectedRepoIds = new Set(changeSet.affectedRepos.map((repo) => repo.id));
  const serviceRepoIds = new Map(catalog.services.map((service) => [service.id, service.repoId]));
  const implementationOrder = repoImplementationOrder(changeSet, serviceRepoIds);
  const relationships = dependencyRelationships(changeSet.dependencyEdges, serviceRepoIds, affectedRepoIds, implementationOrder);
  const globalRisks = [...changeSet.risks];

  if (!workspaceManifest) {
    globalRisks.push("No workspace manifest was supplied; verification commands are unavailable.");
  }

  const pullRequests = implementationOrder.map((repoId) => {
    const repo = requireRepo(catalog, repoId);
    const affectedServiceIds = changeSet.affectedServices
      .filter((service) => service.repoId === repoId)
      .map((service) => service.id);
    const dependencyEvidence = relevantDependencies(changeSet.dependencyEdges, affectedServiceIds);
    const verificationCommands = verificationCommandsForRepo(workspaceManifest, repoId, affectedServiceIds);
    const dependsOnRepoIds = relationships
      .filter((item) => item.dependentRepoId === repoId)
      .map((item) => item.prerequisiteRepoId);
    const dependentRepoIds = relationships
      .filter((item) => item.prerequisiteRepoId === repoId)
      .map((item) => item.dependentRepoId);
    const readinessRisks: string[] = [];

    if (affectedServiceIds.length === 0) {
      readinessRisks.push("No affected service is mapped to this repository; confirm the repository-level scope manually.");
    }
    if (workspaceManifest && verificationCommands.length === 0) {
      readinessRisks.push("No verification commands are configured for this repository or its affected services.");
    }
    if (dependencyEvidence.some((edge) => dependencyOutsidePlan(edge, serviceRepoIds, affectedRepoIds))) {
      readinessRisks.push("Dependency evidence references a repository outside this plan; confirm whether additional coordination is required.");
    }
    return {
      repoId,
      repoPath: repo.absolutePath,
      branchSuggestion: `multirepo/${slug(changeSet.summary)}-${slug(repoId)}`,
      title: `[${repoId}] ${changeSet.summary}`,
      affectedServiceIds,
      dependencyEvidence,
      verificationCommands,
      dependsOnRepoIds,
      dependentRepoIds,
      readinessRisks
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dryRun: true,
    specPath: changeSet.specPath,
    summary: changeSet.summary,
    implementationOrder,
    relationships,
    pullRequests,
    readinessRisks: unique(globalRisks)
  };
}

export function renderPrOrchestrationPlan(plan: PrOrchestrationPlan): string {
  return [
    "# Pull Request Orchestration Plan",
    "",
    `Generated: ${plan.generatedAt}`,
    `Dry run: ${plan.dryRun ? "yes" : "no"}`,
    `Spec: ${plan.specPath}`,
    "",
    "## Summary",
    plan.summary,
    "",
    "## Implementation Order",
    ...bullets(plan.implementationOrder),
    "",
    "## Dependent PR Relationships",
    ...bullets(plan.relationships.map((item) =>
      `${item.dependentRepoId} depends on ${item.prerequisiteRepoId} via ${item.dependencyEdgeIds.join(", ")}`
    )),
    "",
    "## Pull Requests",
    ...plan.pullRequests.flatMap(renderRepoPr),
    "",
    "## Readiness Risks",
    ...bullets(plan.readinessRisks.length > 0 ? plan.readinessRisks : ["No global readiness risks detected."])
  ].join("\n") + "\n";
}

function repoImplementationOrder(changeSet: ChangeSet, serviceRepoIds: Map<string, string>): string[] {
  const affectedRepoIds = new Set(changeSet.affectedRepos.map((repo) => repo.id));
  const ordered = [
    ...changeSet.recommendedOrder.map((serviceId) => serviceRepoIds.get(serviceId)),
    ...changeSet.affectedServices.map((service) => service.repoId),
    ...changeSet.affectedRepos.map((repo) => repo.id)
  ].filter((repoId): repoId is string => typeof repoId === "string" && affectedRepoIds.has(repoId));
  return unique(ordered);
}

function dependencyRelationships(
  edges: HttpDependency[],
  serviceRepoIds: Map<string, string>,
  affectedRepoIds: Set<string>,
  implementationOrder: string[]
): PrDependencyRelationship[] {
  const grouped = new Map<string, PrDependencyRelationship>();
  for (const edge of edges) {
    const dependentRepoId = serviceRepoIds.get(edge.sourceServiceId);
    const prerequisiteRepoId = serviceRepoIds.get(edge.targetServiceId);
    if (!dependentRepoId || !prerequisiteRepoId || dependentRepoId === prerequisiteRepoId) continue;
    if (!affectedRepoIds.has(dependentRepoId) || !affectedRepoIds.has(prerequisiteRepoId)) continue;
    const key = `${prerequisiteRepoId}\0${dependentRepoId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.dependencyEdgeIds.push(edge.id);
    } else {
      grouped.set(key, { prerequisiteRepoId, dependentRepoId, dependencyEdgeIds: [edge.id] });
    }
  }
  const order = new Map(implementationOrder.map((repoId, index) => [repoId, index]));
  return [...grouped.values()]
    .map((item) => ({ ...item, dependencyEdgeIds: [...item.dependencyEdgeIds].sort() }))
    .sort((left, right) =>
      (order.get(left.prerequisiteRepoId) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.prerequisiteRepoId) ?? Number.MAX_SAFE_INTEGER) ||
      left.prerequisiteRepoId.localeCompare(right.prerequisiteRepoId) ||
      left.dependentRepoId.localeCompare(right.dependentRepoId)
    );
}

function relevantDependencies(edges: HttpDependency[], serviceIds: string[]): HttpDependency[] {
  const affected = new Set(serviceIds);
  return edges
    .filter((edge) => affected.has(edge.sourceServiceId) || affected.has(edge.targetServiceId))
    .map((edge) => ({ ...edge, evidence: { ...edge.evidence } }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function verificationCommandsForRepo(
  workspaceManifest: WorkspaceManifest | undefined,
  repoId: string,
  serviceIds: string[]
): WorkspaceVerificationCommand[] {
  if (!workspaceManifest) return [];
  const affected = new Set(serviceIds);
  return workspaceManifest.verificationCommands
    .filter((command) => command.targetType === "repo"
      ? command.targetId === repoId
      : affected.has(command.targetId))
    .map((command) => ({ ...command }));
}

function dependencyOutsidePlan(
  edge: HttpDependency,
  serviceRepoIds: Map<string, string>,
  affectedRepoIds: Set<string>
): boolean {
  const sourceRepoId = serviceRepoIds.get(edge.sourceServiceId);
  const targetRepoId = serviceRepoIds.get(edge.targetServiceId);
  return Boolean(sourceRepoId && !affectedRepoIds.has(sourceRepoId) || targetRepoId && !affectedRepoIds.has(targetRepoId));
}

function renderRepoPr(pr: RepoPrPlan): string[] {
  return [
    "",
    `### ${pr.repoId}`,
    `- Path: ${pr.repoPath}`,
    `- Branch: ${pr.branchSuggestion}`,
    `- Title: ${pr.title}`,
    `- Affected services: ${pr.affectedServiceIds.join(", ") || "None"}`,
    `- Depends on PRs: ${pr.dependsOnRepoIds.join(", ") || "None"}`,
    `- Dependent PRs: ${pr.dependentRepoIds.join(", ") || "None"}`,
    `- Dependency evidence: ${pr.dependencyEvidence.map(renderDependency).join("; ") || "None"}`,
    `- Verification commands: ${pr.verificationCommands.map((command) => `${command.name} -> ${command.run} (cwd: ${command.cwd})`).join("; ") || "None"}`,
    `- Readiness risks: ${pr.readinessRisks.join("; ") || "None"}`
  ];
}

function renderDependency(edge: HttpDependency): string {
  return `${edge.sourceServiceId} -> ${edge.targetServiceId}: ${edge.httpMethod} ${edge.endpointPath} (${edge.evidence.file}:${edge.evidence.line})`;
}

function requireRepo(catalog: NormalizedCatalog, repoId: string) {
  const repo = catalog.repos.find((item) => item.id === repoId);
  if (!repo) throw new Error(`Change set references unknown repo "${repoId}".`);
  return repo;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "change";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function bullets(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None"];
}
