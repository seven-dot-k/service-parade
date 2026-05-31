import path from "node:path";
import type { CatalogCommand, ChangeSet, HttpDependency, NormalizedCatalog, NormalizedRepo, NormalizedService } from "./types.ts";
import { readText } from "./fs.ts";
import { loadDependencyArtifact, loadIndexManifest } from "./graph/enrich.ts";

export async function planChangeSet(catalog: NormalizedCatalog, specPath: string): Promise<ChangeSet> {
  const spec = await readText(specPath);
  const terms = tokenize(spec);
  const serviceReasons = new Map<string, string[]>();
  const repoReasons = new Map<string, string[]>();
  const graph = await loadGraphState(catalog.root);

  for (const service of catalog.services) {
    const matches = matchEntity(terms, [
      service.id,
      service.repoId,
      service.root,
      service.language ?? "",
      ...service.tags
    ]);
    if (matches.length > 0) {
      serviceReasons.set(service.id, [`Spec mentions ${matches.join(", ")}`]);
      addReason(repoReasons, service.repoId, `Contains matched service ${service.id}`);
    }
  }

  for (const repo of catalog.repos) {
    const matches = matchEntity(terms, [repo.id, repo.path, repo.owner ?? "", ...repo.inferred.languages]);
    if (matches.length > 0) {
      addReason(repoReasons, repo.id, `Spec mentions ${matches.join(", ")}`);
    }
  }

  const directServices = new Set(serviceReasons.keys());
  for (const dependency of graph.dependencies) {
    if (directServices.has(dependency.sourceServiceId)) {
      addReason(
        serviceReasons,
        dependency.targetServiceId,
        `${dependency.sourceServiceId} calls ${dependency.httpMethod} ${dependency.endpointPath} on ${dependency.targetServiceId}`
      );
    }
    if (directServices.has(dependency.targetServiceId)) {
      addReason(
        serviceReasons,
        dependency.sourceServiceId,
        `${dependency.sourceServiceId} calls ${dependency.httpMethod} ${dependency.endpointPath} on ${dependency.targetServiceId}`
      );
    }
  }

  if (serviceReasons.size === 0 && repoReasons.size === 0) {
    for (const repo of catalog.repos) {
      addReason(repoReasons, repo.id, "No direct match; include repo for manual triage");
    }
  }

  const affectedServices = catalog.services
    .filter((service) => serviceReasons.has(service.id))
    .map((service) => ({
      id: service.id,
      repoId: service.repoId,
      reasons: serviceReasons.get(service.id) ?? [],
      commands: commandsForService(catalog, service)
    }));

  for (const service of affectedServices) {
    addReason(repoReasons, service.repoId, `Affected service ${service.id}`);
  }

  const affectedRepos = catalog.repos
    .filter((repo) => repoReasons.has(repo.id))
    .map((repo) => ({
      id: repo.id,
      path: repo.path,
      reasons: repoReasons.get(repo.id) ?? [],
      commands: commandsForRepo(repo)
    }));

  const affectedIds = new Set([...affectedServices.map((item) => item.id), ...affectedRepos.map((item) => item.id)]);
  const dependencyEdges = graph.dependencies.filter(
    (edge) => affectedIds.has(edge.sourceServiceId) || affectedIds.has(edge.targetServiceId)
  );

  return {
    generatedAt: new Date().toISOString(),
    specPath: path.resolve(specPath),
    summary: summarize(spec),
    affectedServices,
    affectedRepos,
    dependencyEdges,
    recommendedOrder: orderServices(affectedServices.map((service) => service.id), graph.dependencies),
    risks: buildRisks(affectedServices.length, graph)
  };
}

function commandsForService(catalog: NormalizedCatalog, service: NormalizedService): CatalogCommand[] {
  const repo = catalog.repos.find((item) => item.id === service.repoId);
  return [...service.commands, ...(repo?.commands ?? [])];
}

function commandsForRepo(repo: NormalizedRepo): CatalogCommand[] {
  return repo.commands;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .filter((term) => term.length >= 3)
  );
}

function matchEntity(terms: Set<string>, fields: string[]): string[] {
  const matches = new Set<string>();
  for (const field of fields) {
    for (const token of tokenize(field)) {
      if (terms.has(token)) {
        matches.add(token);
      }
    }
  }
  return [...matches].sort();
}

function addReason(map: Map<string, string[]>, id: string, reason: string): void {
  map.set(id, [...(map.get(id) ?? []), reason]);
}

function summarize(spec: string): string {
  return spec
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 180) ?? "No summary available.";
}

function orderServices(ids: string[], dependencies: HttpDependency[]): string[] {
  const remaining = new Set(ids);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const next = [...remaining].find((id) =>
      dependencies.filter((edge) => edge.targetServiceId === id).every((edge) => !remaining.has(edge.sourceServiceId))
    ) ?? [...remaining][0];
    ordered.push(next);
    remaining.delete(next);
  }
  return ordered;
}

function buildRisks(
  affectedServiceCount: number,
  graph: { dependencies: HttpDependency[]; pendingCount: number; missing: boolean; stale: boolean }
): string[] {
  const risks: string[] = [];
  if (affectedServiceCount === 0) {
    risks.push("No service-level match was found; human triage should confirm scope.");
  }
  if (graph.missing) {
    risks.push('No discovered dependency graph is available; run "multirepo graph index" and "multirepo graph enrich".');
  } else if (graph.stale) {
    risks.push('The discovered dependency graph is stale; run "multirepo graph enrich" before relying on blast-radius analysis.');
  }
  if (graph.dependencies.length === 0) {
    risks.push("The discovered graph has no accepted HTTP dependencies, so blast-radius analysis is limited.");
  }
  if (graph.pendingCount > 0) {
    risks.push(`${graph.pendingCount} discovered HTTP link(s) are pending review and were excluded from automatic scope expansion.`);
  }
  return risks;
}

async function loadGraphState(root: string): Promise<{
  dependencies: HttpDependency[];
  pendingCount: number;
  missing: boolean;
  stale: boolean;
}> {
  const artifact = await loadDependencyArtifact(root);
  if (!artifact) {
    return { dependencies: [], pendingCount: 0, missing: true, stale: false };
  }
  let stale = false;
  try {
    stale = (await loadIndexManifest(root)).hash !== artifact.indexManifestHash;
  } catch {
    stale = true;
  }
  return { dependencies: artifact.dependencies, pendingCount: artifact.pendingCount, missing: false, stale };
}
