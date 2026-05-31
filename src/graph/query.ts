import type { HttpDependency, NormalizedCatalog, NormalizedService } from "../types.ts";
import { enrichmentInputHash, loadDependencyArtifact, loadIndexManifest } from "./enrich.ts";
import { resolveGraphDb } from "./paths.ts";
import { GraphStorage } from "./storage.ts";
import type { EndpointFact, GraphIndexManifest, HttpCallFact, PendingLink } from "./types.ts";

export type DependencyDirection = "in" | "out" | "both";

export type GraphStatus = {
  indexed: boolean;
  enriched: boolean;
  fresh: boolean;
  indexManifest: GraphIndexManifest | null;
  expectedEnrichmentInputHash: string | null;
  enrichedInputHash: string | null;
  dependencies: number;
  pendingLinks: number;
};

export type DependencyQuery = {
  serviceId?: string;
  direction?: DependencyDirection;
};

export type ImpactedService = {
  serviceId: string;
  depth: number;
};

export type TransitiveImpact = {
  serviceId: string;
  maxDepth: number;
  impactedServices: ImpactedService[];
  dependencies: HttpDependency[];
};

export type EndpointQuery = {
  serviceId?: string;
};

export type GraphServiceSummary = {
  id: string;
  repoId: string;
};

export type PendingLinkCandidate = {
  endpoint: EndpointFact;
  service: GraphServiceSummary | null;
  label: string;
};

export type PendingLinkDetail = PendingLink & {
  sourceCall: HttpCallFact | null;
  sourceService: GraphServiceSummary | null;
  sourceLabel: string;
  candidates: PendingLinkCandidate[];
};

export async function getGraphStatus(root: string, catalog: NormalizedCatalog): Promise<GraphStatus> {
  const indexManifest = await optionalIndexManifest(root);
  const dependencyArtifact = await loadDependencyArtifact(root);
  const expectedHash = indexManifest ? enrichmentInputHash(indexManifest.hash, catalog) : null;
  const enrichedHash = dependencyArtifact?.indexManifestHash ?? null;

  return {
    indexed: indexManifest !== undefined,
    enriched: dependencyArtifact !== undefined,
    fresh: expectedHash !== null && enrichedHash === expectedHash,
    indexManifest: indexManifest ?? null,
    expectedEnrichmentInputHash: expectedHash,
    enrichedInputHash: enrichedHash,
    dependencies: dependencyArtifact?.dependencies.length ?? 0,
    pendingLinks: dependencyArtifact?.pendingCount ?? 0
  };
}

export async function listDependencies(root: string, query: DependencyQuery = {}): Promise<HttpDependency[]> {
  const artifact = await loadDependencyArtifact(root);
  const direction = query.direction ?? "both";
  assertDirection(direction);

  return (artifact?.dependencies ?? [])
    .filter((dependency) => matchesDependency(dependency, query.serviceId, direction))
    .sort(compareDependencies);
}

export async function queryTransitiveImpact(root: string, serviceId: string, maxDepth = Number.MAX_SAFE_INTEGER): Promise<TransitiveImpact> {
  assertDepth(maxDepth);
  const dependencies = await listDependencies(root);
  const incoming = new Map<string, HttpDependency[]>();
  for (const dependency of dependencies) {
    const edges = incoming.get(dependency.targetServiceId) ?? [];
    edges.push(dependency);
    incoming.set(dependency.targetServiceId, edges);
  }

  const depthByService = new Map<string, number>();
  const includedEdges = new Map<string, HttpDependency>();
  const queue: ImpactedService[] = [{ serviceId, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current.depth >= maxDepth) {
      continue;
    }
    for (const dependency of incoming.get(current.serviceId) ?? []) {
      const depth = current.depth + 1;
      includedEdges.set(dependency.id, dependency);
      const previous = depthByService.get(dependency.sourceServiceId);
      if (dependency.sourceServiceId !== serviceId && (previous === undefined || depth < previous)) {
        depthByService.set(dependency.sourceServiceId, depth);
        queue.push({ serviceId: dependency.sourceServiceId, depth });
      }
    }
  }

  return {
    serviceId,
    maxDepth,
    impactedServices: [...depthByService.entries()]
      .map(([id, depth]) => ({ serviceId: id, depth }))
      .sort((a, b) => a.depth - b.depth || a.serviceId.localeCompare(b.serviceId)),
    dependencies: [...includedEdges.values()].sort(compareDependencies)
  };
}

export function listEndpoints(root: string, query: EndpointQuery = {}): EndpointFact[] {
  const storage = new GraphStorage(resolveGraphDb(root));
  try {
    return storage.allFacts()
      .filter((fact): fact is EndpointFact => fact.kind === "endpoint")
      .filter((endpoint) => query.serviceId === undefined || endpoint.serviceId === query.serviceId)
      .sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    storage.close();
  }
}

export function listPendingLinkDetails(root: string, catalog: NormalizedCatalog): PendingLinkDetail[] {
  const storage = new GraphStorage(resolveGraphDb(root));
  try {
    const facts = storage.allFacts();
    const calls = new Map(facts.filter((fact): fact is HttpCallFact => fact.kind === "http_call").map((call) => [call.id, call]));
    const endpoints = new Map(facts.filter((fact): fact is EndpointFact => fact.kind === "endpoint").map((endpoint) => [endpoint.id, endpoint]));
    const services = new Map(catalog.services.map((service) => [service.id, service]));
    return storage.listPendingLinks().map((link) => {
      const sourceCall = calls.get(link.callNodeId) ?? null;
      const sourceService = summarizeService(sourceCall ? services.get(sourceCall.serviceId) : undefined);
      return {
        ...link,
        sourceCall,
        sourceService,
        sourceLabel: sourceCall ? callLabel(sourceCall) : `Unknown call ${link.callNodeId}`,
        candidates: link.candidateEndpointIds
          .map((id) => endpoints.get(id))
          .filter((endpoint): endpoint is EndpointFact => endpoint !== undefined)
          .map((endpoint) => ({
            endpoint,
            service: summarizeService(services.get(endpoint.serviceId)),
            label: endpointLabel(endpoint)
          }))
          .sort((a, b) => a.endpoint.id.localeCompare(b.endpoint.id))
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    storage.close();
  }
}

function matchesDependency(dependency: HttpDependency, serviceId: string | undefined, direction: DependencyDirection): boolean {
  if (!serviceId) {
    return true;
  }
  return (direction !== "in" && dependency.sourceServiceId === serviceId) ||
    (direction !== "out" && dependency.targetServiceId === serviceId);
}

function compareDependencies(a: HttpDependency, b: HttpDependency): number {
  return a.id.localeCompare(b.id);
}

function summarizeService(service: NormalizedService | undefined): GraphServiceSummary | null {
  return service ? { id: service.id, repoId: service.repoId } : null;
}

function callLabel(call: HttpCallFact): string {
  return `${call.serviceId}: ${call.httpMethod ?? "*"} ${call.rawUrl} (${call.file}:${call.line})`;
}

function endpointLabel(endpoint: EndpointFact): string {
  return `${endpoint.serviceId}: ${endpoint.httpMethod} ${endpoint.path} (${endpoint.file}:${endpoint.line})`;
}

function assertDirection(direction: string): asserts direction is DependencyDirection {
  if (direction !== "in" && direction !== "out" && direction !== "both") {
    throw new Error(`Unsupported dependency direction "${direction}". Expected "in", "out", or "both".`);
  }
}

function assertDepth(maxDepth: number): void {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error("Impact maxDepth must be a non-negative safe integer.");
  }
}

async function optionalIndexManifest(root: string): Promise<GraphIndexManifest | undefined> {
  try {
    return await loadIndexManifest(root);
  } catch {
    return undefined;
  }
}
