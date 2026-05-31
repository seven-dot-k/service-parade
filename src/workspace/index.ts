import path from "node:path";
import { resolveVerificationCommands as resolveCatalogVerificationCommands } from "../commands.ts";
import { stableJson, writeText } from "../fs.ts";
import type { ResolvedCommand } from "../commands.ts";
import type { ChangeSet, NormalizedCatalog } from "../types.ts";
import type {
  AssembledWorkspaceBundle,
  RepoAgentHandoff,
  WorkspaceDependencyEvidence,
  WorkspaceManifest,
  WorkspaceRepository,
  WorkspaceService,
  WorkspaceVerificationCommand
} from "./types.ts";

export type {
  AssembledWorkspaceBundle,
  RepoAgentHandoff,
  WorkspaceDependencyEvidence,
  WorkspaceManifest,
  WorkspaceRepository,
  WorkspaceService,
  WorkspaceVerificationCommand
} from "./types.ts";

export function createWorkspaceManifest(catalog: NormalizedCatalog, changeSet: ChangeSet): WorkspaceManifest {
  const affectedRepoIds = new Set(changeSet.affectedRepos.map((repo) => repo.id));
  const repositories = changeSet.affectedRepos.map((repoPlan) => {
    const repo = requireRepo(catalog, repoPlan.id);
    return {
      id: repo.id,
      path: repo.path,
      absolutePath: repo.absolutePath,
      ...(repo.defaultBranch ? { defaultBranch: repo.defaultBranch } : {}),
      ...(repo.owner ? { owner: repo.owner } : {}),
      reasons: [...repoPlan.reasons],
      serviceIds: changeSet.affectedServices
        .filter((service) => service.repoId === repo.id)
        .map((service) => service.id),
      handoffDirectory: path.posix.join("repos", artifactSegment(repo.id))
    };
  });
  const services = changeSet.affectedServices.map((servicePlan) => {
    const service = requireService(catalog, servicePlan.id);
    return {
      id: service.id,
      repoId: service.repoId,
      root: service.root,
      absolutePath: service.absolutePath,
      ...(service.language ? { language: service.language } : {}),
      reasons: [...servicePlan.reasons]
    };
  });

  for (const service of services) {
    if (!affectedRepoIds.has(service.repoId)) {
      throw new Error(`Affected service "${service.id}" belongs to repo "${service.repoId}", which is missing from the change set.`);
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    catalogGeneratedAt: catalog.generatedAt,
    changeSetGeneratedAt: changeSet.generatedAt,
    specPath: changeSet.specPath,
    summary: changeSet.summary,
    repositories,
    services,
    dependencies: changeSet.dependencyEdges.map(cloneDependency),
    verificationCommands: resolveWorkspaceVerificationCommands(catalog, changeSet),
    recommendedOrder: [...changeSet.recommendedOrder],
    risks: [...changeSet.risks]
  };
}

export function createRepoAgentHandoffs(catalog: NormalizedCatalog, changeSet: ChangeSet): RepoAgentHandoff[] {
  const manifest = createWorkspaceManifest(catalog, changeSet);
  return manifest.repositories.map((repo) => ({
    repoId: repo.id,
    directory: repo.handoffDirectory,
    agentsMd: renderRepoAgentsMd(manifest, repo.id),
    claudeMd: renderRepoClaudeMd(manifest, repo.id)
  }));
}

export function renderRepoAgentsMd(manifest: WorkspaceManifest, repoId: string): string {
  return renderRepoInstructions("AGENTS.md", manifest, repoId, [
    "Read the feature summary, affected services, and dependency evidence before editing.",
    "Keep changes scoped to this repository while coordinating contract changes with the listed dependency neighbors.",
    "Run the listed verification commands when feasible and report missing or failing checks explicitly.",
    "Treat the manifest as generated handoff evidence; update the source catalog or change set when scope changes."
  ]);
}

export function renderRepoClaudeMd(manifest: WorkspaceManifest, repoId: string): string {
  return renderRepoInstructions("CLAUDE.md", manifest, repoId, [
    "Use the structured workspace manifest as the source of truth for this handoff.",
    "Inspect dependency evidence before modifying shared HTTP contracts.",
    "Prefer the listed verification commands over guessed package scripts.",
    "Call out uncertain scope or missing catalog data instead of inventing repository facts."
  ]);
}

export async function assembleWorkspaceBundle(
  catalog: NormalizedCatalog,
  changeSet: ChangeSet,
  outputDirectory: string
): Promise<AssembledWorkspaceBundle> {
  const resolvedOutput = path.resolve(outputDirectory);
  const manifest = createWorkspaceManifest(catalog, changeSet);
  const files = [path.join(resolvedOutput, "workspace-manifest.json")];
  await writeText(files[0], stableJson(manifest));

  for (const repo of manifest.repositories) {
    const agentsPath = path.join(resolvedOutput, repo.handoffDirectory, "AGENTS.md");
    const claudePath = path.join(resolvedOutput, repo.handoffDirectory, "CLAUDE.md");
    await writeText(agentsPath, renderRepoAgentsMd(manifest, repo.id));
    await writeText(claudePath, renderRepoClaudeMd(manifest, repo.id));
    files.push(agentsPath, claudePath);
  }

  return { outputDirectory: resolvedOutput, manifest, files };
}

function renderRepoInstructions(
  title: "AGENTS.md" | "CLAUDE.md",
  manifest: WorkspaceManifest,
  repoId: string,
  guidance: string[]
): string {
  const repo = requireManifestRepo(manifest, repoId);
  const repoServiceIds = new Set(repo.serviceIds);
  const services = manifest.services.filter((service) => service.repoId === repo.id);
  const dependencies = manifest.dependencies.filter(
    (dependency) => repoServiceIds.has(dependency.sourceServiceId) || repoServiceIds.has(dependency.targetServiceId)
  );
  const commands = manifest.verificationCommands.filter((command) =>
    command.targetType === "repo"
      ? command.targetId === repo.id
      : repoServiceIds.has(command.targetId)
  );

  return [
    `# ${title}`,
    ``,
    `Generated repository handoff for \`${repo.id}\`.`,
    ``,
    `## Feature Summary`,
    manifest.summary,
    ``,
    `## Repository`,
    `- Path: ${repo.path}`,
    `- Absolute path: ${repo.absolutePath}`,
    `- Reasons: ${repo.reasons.join("; ") || "No repo-specific reason recorded."}`,
    ``,
    `## Affected Services`,
    ...bullets(services.map((service) => `${service.id}: root ${service.root}, language ${service.language ?? "unknown"} - ${service.reasons.join("; ")}`)),
    ``,
    `## Dependency Evidence`,
    ...bullets(dependencies.map(renderDependency)),
    ``,
    `## Verification Commands`,
    ...bullets(commands.map((command) => `${command.targetType} ${command.targetId}: ${command.name} -> ${command.run} (cwd: ${command.cwd})`)),
    ``,
    `## Recommended Service Order`,
    ...bullets(manifest.recommendedOrder),
    ``,
    `## Operating Guidance`,
    ...guidance.map((item) => `- ${item}`)
  ].join("\n") + "\n";
}

function resolveWorkspaceVerificationCommands(catalog: NormalizedCatalog, changeSet: ChangeSet): WorkspaceVerificationCommand[] {
  return [
    ...resolveCatalogCommands(catalog, changeSet.affectedRepos.map((repo) => repo.id), [], "repo"),
    ...resolveCatalogCommands(catalog, [], changeSet.affectedServices.map((service) => service.id), "service")
  ];
}

function resolveCatalogCommands(
  catalog: NormalizedCatalog,
  affectedRepoIds: string[],
  affectedServiceIds: string[],
  targetType: "repo" | "service",
): WorkspaceVerificationCommand[] {
  return resolveCatalogVerificationCommands(catalog, affectedRepoIds, affectedServiceIds)
    .map((item) => toWorkspaceVerificationCommand(targetType, item));
}

function toWorkspaceVerificationCommand(targetType: "repo" | "service", item: ResolvedCommand): WorkspaceVerificationCommand {
  return {
    targetType,
    targetId: item.target,
    name: item.command.name,
    run: item.command.run,
    cwd: item.cwd,
    ...(item.command.scope ? { scope: item.command.scope } : {})
  };
}

function renderDependency(dependency: WorkspaceDependencyEvidence): string {
  return `${dependency.sourceServiceId} -> ${dependency.targetServiceId}: ${dependency.httpMethod} ${dependency.endpointPath}; evidence ${dependency.evidence.file}:${dependency.evidence.line} (${dependency.evidence.rawUrl})`;
}

function cloneDependency(dependency: WorkspaceDependencyEvidence): WorkspaceDependencyEvidence {
  return { ...dependency, evidence: { ...dependency.evidence } };
}

function requireRepo(catalog: NormalizedCatalog, repoId: string) {
  const repo = catalog.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    throw new Error(`Change set references unknown repo "${repoId}".`);
  }
  return repo;
}

function requireService(catalog: NormalizedCatalog, serviceId: string) {
  const service = catalog.services.find((candidate) => candidate.id === serviceId);
  if (!service) {
    throw new Error(`Change set references unknown service "${serviceId}".`);
  }
  return service;
}

function requireManifestRepo(manifest: WorkspaceManifest, repoId: string): WorkspaceRepository {
  const repo = manifest.repositories.find((candidate) => candidate.id === repoId);
  if (!repo) {
    throw new Error(`Workspace manifest does not include repo "${repoId}".`);
  }
  return repo;
}

function artifactSegment(repoId: string): string {
  return encodeURIComponent(repoId).replace(/\./g, "%2E");
}

function bullets(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None"];
}
