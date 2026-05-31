import type { HttpEvidence } from "../types.ts";

export type GraphFactKind = "endpoint" | "http_call" | "config_key";

export type EndpointFact = {
  id: string;
  kind: "endpoint";
  serviceId: string;
  file: string;
  line: number;
  framework: string;
  httpMethod: string;
  path: string;
};

export type HttpCallFact = {
  id: string;
  kind: "http_call";
  serviceId: string;
  file: string;
  line: number;
  framework: string;
  enclosingSymbol: string;
  httpMethod: string | null;
  rawUrl: string;
  path: string | null;
  host: string | null;
  dynamic: boolean;
};

export type ConfigKeyFact = {
  id: string;
  kind: "config_key";
  serviceId: string;
  file: string;
  line: number;
  key: string;
  value: string;
};

export type GraphFact = EndpointFact | HttpCallFact | ConfigKeyFact;

export type PendingLink = {
  id: string;
  signature: string;
  callNodeId: string;
  candidateEndpointIds: string[];
  score: number;
  reason: string;
  evidence: HttpEvidence;
  reviewStatus: "pending_review";
};

export type LinkDecision = {
  signature: string;
  decision: "approved" | "rejected";
  targetEndpointId: string | null;
  decidedBy: "human" | "llm";
  updatedAt: string;
};

export type GraphDependencyArtifact = {
  generatedAt: string;
  indexManifestHash: string;
  pendingCount: number;
  dependencies: import("../types.ts").HttpDependency[];
};

export type GraphIndexManifest = {
  generatedAt: string;
  hash: string;
  files: number;
  facts: number;
};
