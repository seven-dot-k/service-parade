import type { CatalogCommand, HttpDependency } from "../types.ts";

export type WorkspaceVerificationCommand = {
  targetType: "repo" | "service";
  targetId: string;
  name: string;
  run: string;
  cwd: string;
  scope?: CatalogCommand["scope"];
};

export type WorkspaceRepository = {
  id: string;
  path: string;
  absolutePath: string;
  defaultBranch?: string;
  owner?: string;
  reasons: string[];
  serviceIds: string[];
  handoffDirectory: string;
};

export type WorkspaceService = {
  id: string;
  repoId: string;
  root: string;
  absolutePath: string;
  language?: string;
  reasons: string[];
};

export type WorkspaceDependencyEvidence = HttpDependency;

export type WorkspaceManifest = {
  schemaVersion: 1;
  generatedAt: string;
  catalogGeneratedAt: string;
  changeSetGeneratedAt: string;
  specPath: string;
  summary: string;
  repositories: WorkspaceRepository[];
  services: WorkspaceService[];
  dependencies: WorkspaceDependencyEvidence[];
  verificationCommands: WorkspaceVerificationCommand[];
  recommendedOrder: string[];
  risks: string[];
};

export type RepoAgentHandoff = {
  repoId: string;
  directory: string;
  agentsMd: string;
  claudeMd: string;
};

export type AssembledWorkspaceBundle = {
  outputDirectory: string;
  manifest: WorkspaceManifest;
  files: string[];
};
