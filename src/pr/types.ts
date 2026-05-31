import type { HttpDependency } from "../types.ts";
import type { WorkspaceVerificationCommand } from "../workspace/types.ts";

export type PrDependencyRelationship = {
  prerequisiteRepoId: string;
  dependentRepoId: string;
  dependencyEdgeIds: string[];
};

export type RepoPrPlan = {
  repoId: string;
  repoPath: string;
  branchSuggestion: string;
  title: string;
  affectedServiceIds: string[];
  dependencyEvidence: HttpDependency[];
  verificationCommands: WorkspaceVerificationCommand[];
  dependsOnRepoIds: string[];
  dependentRepoIds: string[];
  readinessRisks: string[];
};

export type PrOrchestrationPlan = {
  schemaVersion: 1;
  generatedAt: string;
  dryRun: true;
  specPath: string;
  summary: string;
  implementationOrder: string[];
  relationships: PrDependencyRelationship[];
  pullRequests: RepoPrPlan[];
  readinessRisks: string[];
};
