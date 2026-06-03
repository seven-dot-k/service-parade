export type CommandScope = "repo" | "service";

export type CatalogCommand = {
  name: string;
  run: string;
  scope?: CommandScope;
  repoId?: string;
  serviceId?: string;
  cwd?: string;
};

export type HttpDiscoveryConfig = {
  sdkPackages?: string[];
};

export type RepoConfig = {
  id: string;
  path: string;
  defaultBranch?: string;
  owner?: string;
  httpDiscovery?: HttpDiscoveryConfig;
  commands?: CatalogCommand[];
};

export type ServiceConfig = {
  id: string;
  repoId: string;
  root?: string;
  language?: string;
  runtime?: string;
  tags?: string[];
  aliases?: string[];
  baseUrls?: string[];
  commands?: CatalogCommand[];
};

export type CatalogConfig = {
  repos?: RepoConfig[];
  services?: ServiceConfig[];
  sdkSources?: SdkSourceConfig[];
  commands?: CatalogCommand[];
};

export type SdkSourceConfig = {
  id: string;
  packages: string[];
  source: string;
  targetServiceId: string;
  detector: string;
  options?: Record<string, unknown>;
};

export type Inference = {
  packageManager?: string;
  scripts?: Record<string, string>;
  languages: string[];
  manifests: string[];
  dockerCompose: string[];
};

export type NormalizedRepo = Required<Pick<RepoConfig, "id" | "path">> &
  Omit<RepoConfig, "id" | "path"> & {
    absolutePath: string;
    inferred: Inference;
    commands: CatalogCommand[];
    httpDiscovery: {
      sdkPackages: string[];
    };
  };

export type NormalizedService = Required<Pick<ServiceConfig, "id" | "repoId">> &
  Omit<ServiceConfig, "id" | "repoId"> & {
    root: string;
    absolutePath: string;
    language?: string;
    tags: string[];
    aliases: string[];
    baseUrls: string[];
    commands: CatalogCommand[];
  };

export type NormalizedCatalog = {
  generatedAt: string;
  root: string;
  repos: NormalizedRepo[];
  services: NormalizedService[];
  sdkSources: NormalizedSdkSource[];
  commands: CatalogCommand[];
};

export type NormalizedSdkSource = Required<Pick<SdkSourceConfig, "id" | "source" | "targetServiceId" | "detector">> &
  Omit<SdkSourceConfig, "id" | "source" | "targetServiceId" | "detector"> & {
    absolutePath: string;
    packages: string[];
    options: Record<string, unknown>;
  };

export type HttpEvidence = {
  file: string;
  line: number;
  rawUrl: string;
  derivedFrom?: {
    kind: "sdk_source";
    sdkSourceId: string;
    packageName: string;
    consumerFile: string;
    consumerLine: number;
    sdkFile: string;
    sdkLine: number;
  };
};

export type HttpDependency = {
  id: string;
  sourceServiceId: string;
  targetServiceId: string;
  httpMethod: string;
  endpointPath: string;
  callPath: string;
  callNodeId: string;
  endpointNodeId: string;
  confidence: number;
  reviewStatus: "auto_accepted" | "approved";
  decidedBy: "auto" | "human" | "llm";
  evidence: HttpEvidence;
};

export type ChangeSet = {
  generatedAt: string;
  specPath: string;
  summary: string;
  affectedServices: Array<{
    id: string;
    repoId: string;
    reasons: string[];
    commands: CatalogCommand[];
  }>;
  affectedRepos: Array<{
    id: string;
    path: string;
    reasons: string[];
    commands: CatalogCommand[];
  }>;
  dependencyEdges: HttpDependency[];
  recommendedOrder: string[];
  risks: string[];
};

export type VerificationReport = {
  generatedAt: string;
  planPath: string;
  results: Array<{
    name: string;
    target: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
  passed: boolean;
};
