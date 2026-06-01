import { readFile } from "node:fs/promises";
import type { HttpDependency, NormalizedCatalog, NormalizedService } from "../types.ts";
import { stableJson, writeText } from "../fs.ts";
import { normalizeEndpointPath } from "./detectors.ts";
import { sha256, stableId } from "./hash.ts";
import { resolveGraph, resolveGraphDb } from "./paths.ts";
import { rebuildProjection } from "./projection.ts";
import { GraphStorage } from "./storage.ts";
import type { EndpointFact, GraphDependencyArtifact, GraphFact, GraphIndexManifest, HttpCallFact, PendingLink } from "./types.ts";

export type GraphEnrichSummary = {
  dependencies: number;
  pending: number;
  indexManifestHash: string;
};

export async function enrichGraph(root: string, catalog: NormalizedCatalog): Promise<GraphEnrichSummary> {
  const indexManifest = await loadIndexManifest(root);
  const inputHash = enrichmentInputHash(indexManifest.hash, catalog);
  const storage = new GraphStorage(resolveGraphDb(root));
  try {
    const facts = storage.allFacts();
    const endpoints = facts.filter((fact): fact is EndpointFact => fact.kind === "endpoint");
    const calls = facts.filter((fact): fact is HttpCallFact => fact.kind === "http_call");
    const decisions = storage.getDecisions();
    const dependencies: HttpDependency[] = [];
    const pending: PendingLink[] = [];

    for (const call of calls.sort((a, b) => a.id.localeCompare(b.id))) {
      const signature = linkSignature(call);
      const decision = decisions.get(signature);
      if (decision?.decision === "rejected") {
        continue;
      }
      if (decision?.decision === "approved" && decision.targetEndpointId) {
        const target = endpoints.find((endpoint) => endpoint.id === decision.targetEndpointId);
        if (target && target.serviceId !== call.serviceId) {
          dependencies.push(toDependency(call, target, 1, "approved", decision.decidedBy));
          continue;
        }
      }

      const result = matchCall(call, endpoints, catalog.services);
      if (result.skip) {
        continue;
      }
      if (result.accepted) {
        dependencies.push(toDependency(call, result.accepted, result.score, "auto_accepted", "auto"));
      } else {
        pending.push({
          id: stableId("pending", signature),
          signature,
          callNodeId: call.id,
          candidateEndpointIds: result.candidates.map((candidate) => candidate.id).sort(),
          score: result.score,
          reason: result.reason,
          evidence: { file: call.file, line: call.line, rawUrl: call.rawUrl },
          reviewStatus: "pending_review"
        });
      }
    }

    dependencies.sort((a, b) => a.id.localeCompare(b.id));
    pending.sort((a, b) => a.id.localeCompare(b.id));
    storage.replacePendingLinks(pending);
    const previous = await loadDependencyArtifact(root);
    const artifact: GraphDependencyArtifact = {
      generatedAt: new Date().toISOString(),
      indexManifestHash: inputHash,
      pendingCount: pending.length,
      dependencies
    };
    if (previous && sameDependencyArtifact(previous, artifact)) {
      artifact.generatedAt = previous.generatedAt;
    }
    await writeText(resolveGraph(root, "dependencies.json"), stableJson(artifact));
    await writeText(resolveGraph(root, "manifest.json"), stableJson({
      generatedAt: artifact.generatedAt,
      indexManifestHash: inputHash,
      dependencies: dependencies.length,
      pending: pending.length
    }));
    await rebuildProjection(root, catalog, facts, dependencies);
    storage.setMeta("enriched_index_manifest_hash", inputHash);
    return { dependencies: dependencies.length, pending: pending.length, indexManifestHash: inputHash };
  } finally {
    storage.close();
  }
}

function sameDependencyArtifact(left: GraphDependencyArtifact, right: GraphDependencyArtifact): boolean {
  return stableJson({
    indexManifestHash: left.indexManifestHash,
    pendingCount: left.pendingCount,
    dependencies: left.dependencies
  }) === stableJson({
    indexManifestHash: right.indexManifestHash,
    pendingCount: right.pendingCount,
    dependencies: right.dependencies
  });
}

export async function loadDependencyArtifact(root: string): Promise<GraphDependencyArtifact | undefined> {
  try {
    return JSON.parse(await readFile(resolveGraph(root, "dependencies.json"), "utf8")) as GraphDependencyArtifact;
  } catch {
    return undefined;
  }
}

export async function loadIndexManifest(root: string): Promise<GraphIndexManifest> {
  try {
    return JSON.parse(await readFile(resolveGraph(root, "index-manifest.json"), "utf8")) as GraphIndexManifest;
  } catch {
    throw new Error('No graph index found. Run "service-parade graph index" before enriching dependencies.');
  }
}

export function enrichmentInputHash(indexManifestHash: string, catalog: NormalizedCatalog): string {
  return sha256(stableJson({
    indexManifestHash,
    services: catalog.services.map((service) => ({
      id: service.id,
      repoId: service.repoId,
      root: service.root,
      aliases: [...service.aliases].sort(),
      baseUrls: [...service.baseUrls].sort()
    })).sort((a, b) => a.id.localeCompare(b.id))
  }));
}

export function listPendingLinks(root: string): PendingLink[] {
  const storage = new GraphStorage(resolveGraphDb(root));
  try {
    return storage.listPendingLinks();
  } finally {
    storage.close();
  }
}

export function saveLinkDecision(
  root: string,
  pendingId: string,
  decision: "approved" | "rejected",
  targetEndpointId: string | undefined,
  decidedBy: "human" | "llm"
): void {
  const storage = new GraphStorage(resolveGraphDb(root));
  try {
    const pending = storage.getPendingLink(pendingId);
    if (!pending) {
      throw new Error(`Unknown pending link "${pendingId}". Run "service-parade graph links list" to inspect the queue.`);
    }
    if (decision === "approved") {
      if (!targetEndpointId) {
        throw new Error('Approving a pending link requires "--target <endpoint-id>".');
      }
      if (!pending.candidateEndpointIds.includes(targetEndpointId)) {
        throw new Error(`Target "${targetEndpointId}" is not a candidate for pending link "${pendingId}".`);
      }
    }
    storage.saveDecision({
      signature: pending.signature,
      decision,
      targetEndpointId: decision === "approved" ? targetEndpointId ?? null : null,
      decidedBy,
      updatedAt: new Date().toISOString()
    });
  } finally {
    storage.close();
  }
}

function matchCall(
  call: HttpCallFact,
  endpoints: EndpointFact[],
  services: NormalizedService[]
): { accepted?: EndpointFact; candidates: EndpointFact[]; score: number; reason: string; skip?: boolean } {
  if (!call.path) {
    return { candidates: [], score: 0, reason: "The outbound URL is fully dynamic and has no stable path template." };
  }
  const compatible = endpoints.filter((endpoint) =>
    (!call.httpMethod || endpoint.httpMethod === "*" || endpoint.httpMethod === call.httpMethod) &&
    pathsCompatible(call.path ?? "", endpoint.path)
  );
  if (compatible.length > 0 && compatible.every((endpoint) => endpoint.serviceId === call.serviceId)) {
    return { candidates: [], score: 0, reason: "Same-service HTTP call; cross-service dependency mapping skipped.", skip: true };
  }
  let candidates = compatible.filter((endpoint) => endpoint.serviceId !== call.serviceId);
  if (call.host) {
    const servicesForHost = services.filter((service) => serviceHosts(service).has(call.host ?? ""));
    if (servicesForHost.length === 0) {
      return { candidates: [], score: 0, reason: `The absolute host "${call.host}" does not match a declared internal service alias.` };
    }
    const ids = new Set(servicesForHost.map((service) => service.id));
    candidates = candidates.filter((endpoint) => ids.has(endpoint.serviceId));
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  if (candidates.length === 0) {
    return { candidates, score: 0, reason: "No endpoint matched the HTTP method and normalized path." };
  }
  if (candidates.length > 1) {
    return { candidates, score: 0.7, reason: "Multiple services expose a compatible endpoint; select the intended target." };
  }
  const hasWildcard = call.dynamic || call.path.includes("*") || candidates[0].path.includes("*");
  const score = hasWildcard ? 0.95 : 1;
  return { accepted: candidates[0], candidates, score, reason: hasWildcard ? "Unique HTTP method and wildcard-template match." : "Unique HTTP method and static-path match." };
}

function pathsCompatible(left: string, right: string): boolean {
  const a = normalizeEndpointPath(left).split("/").filter(Boolean);
  const b = normalizeEndpointPath(right).split("/").filter(Boolean);
  return a.length === b.length && a.every((segment, index) => segment === "*" || b[index] === "*" || segment === b[index]);
}

function serviceHosts(service: NormalizedService): Set<string> {
  const hosts = new Set(service.aliases.map((alias) => alias.toLowerCase()));
  for (const baseUrl of service.baseUrls) {
    try {
      hosts.add(new URL(baseUrl).host.toLowerCase());
    } catch {
      hosts.add(baseUrl.toLowerCase());
    }
  }
  return hosts;
}

function linkSignature(call: HttpCallFact): string {
  return sha256([call.file, call.enclosingSymbol, call.httpMethod ?? "", call.host ?? "", call.path ?? ""].join("\u0000"));
}

function toDependency(
  call: HttpCallFact,
  endpoint: EndpointFact,
  confidence: number,
  reviewStatus: "auto_accepted" | "approved",
  decidedBy: "auto" | "human" | "llm"
): HttpDependency {
  return {
    id: stableId("dependency", call.id, endpoint.id),
    sourceServiceId: call.serviceId,
    targetServiceId: endpoint.serviceId,
    httpMethod: call.httpMethod ?? endpoint.httpMethod,
    endpointPath: endpoint.path,
    callPath: call.path ?? "",
    callNodeId: call.id,
    endpointNodeId: endpoint.id,
    confidence,
    reviewStatus,
    decidedBy,
    evidence: { file: call.file, line: call.line, rawUrl: call.rawUrl }
  };
}
