import path from "node:path";
import type {
  CatalogCommand,
  CatalogConfig,
  Inference,
  NormalizedCatalog,
  NormalizedRepo,
  NormalizedService,
  RepoConfig,
  ServiceConfig
} from "./types.ts";
import {
  normalizeCommands,
  normalizeRepoCommands,
  normalizeServiceCommands,
  validateCommand,
  validateCommandCwds,
  validateGlobalCommandOwners
} from "./commands.ts";
import { scanRepo } from "./scanner.ts";

export async function normalizeCatalog(config: CatalogConfig, root: string): Promise<NormalizedCatalog> {
  validateConfig(config);
  const globalCommands = normalizeCommands(config.commands ?? []);
  const repos = await Promise.all((config.repos ?? []).map((repo) => normalizeRepo(repo, root, globalCommands)));
  const repoById = new Map(repos.map((repo) => [repo.id, repo]));
  const services = (config.services ?? []).map((service) => normalizeService(service, repoById, globalCommands));

  validateReferences(repos, services);
  validateGlobalCommandOwners(globalCommands, repos, services);

  return {
    generatedAt: new Date().toISOString(),
    root,
    repos,
    services,
    commands: globalCommands
  };
}

export function validateConfig(config: CatalogConfig): void {
  if ("dependencies" in config) {
    throw new Error(
      'The "dependencies" catalog section is no longer supported. Remove it and run "service-parade graph index" followed by "service-parade graph enrich" to discover HTTP dependencies.'
    );
  }
  const repos = config.repos ?? [];
  if (repos.length === 0) {
    throw new Error("Catalog must declare at least one repo.");
  }
  ensureUnique(repos.map((repo) => repo.id), "repo id");
  ensureUnique((config.services ?? []).map((service) => service.id), "service id");
  for (const repo of repos) {
    requireString(repo.id, "repo.id");
    requireString(repo.path, `repo(${repo.id}).path`);
  }
  for (const service of config.services ?? []) {
    requireString(service.id, "service.id");
    requireString(service.repoId, `service(${service.id}).repoId`);
    requireStringList(service.aliases, `service(${service.id}).aliases`);
    requireStringList(service.baseUrls, `service(${service.id}).baseUrls`);
  }
  for (const command of config.commands ?? []) {
    validateCommand(command);
  }
}

async function normalizeRepo(repo: RepoConfig, root: string, globalCommands: CatalogCommand[]): Promise<NormalizedRepo> {
  const absolutePath = path.resolve(root, repo.path);
  const inferred = await scanRepo(absolutePath);
  const commands = [
    ...normalizeRepoCommands(repo.commands ?? [], repo.id),
    ...globalCommands.filter((command) => command.scope === "repo" && command.repoId === repo.id),
    ...inferRepoCommands(repo.id, inferred)
  ];
  validateCommandCwds(commands, absolutePath, repo.id);
  return {
    ...repo,
    defaultBranch: repo.defaultBranch ?? "main",
    absolutePath,
    inferred,
    commands: dedupeCommands(commands)
  };
}

function normalizeService(
  service: ServiceConfig,
  repos: Map<string, NormalizedRepo>,
  globalCommands: CatalogCommand[]
): NormalizedService {
  const repo = repos.get(service.repoId);
  if (!repo) {
    throw new Error(`Service "${service.id}" references unknown repo "${service.repoId}".`);
  }
  const root = service.root ?? ".";
  const absolutePath = path.resolve(repo.absolutePath, root);
  const commands = [
    ...normalizeServiceCommands(service.commands ?? [], service.id),
    ...globalCommands
      .filter((command) => command.scope === "service" && command.serviceId === service.id)
      .map((command) => ({ ...command, repoId: undefined }))
  ];
  validateCommandCwds(commands, absolutePath, service.id);
  return {
    ...service,
    root,
    absolutePath,
    language: service.language ?? repo.inferred.languages[0],
    tags: service.tags ?? [],
    aliases: [...new Set([service.id, ...(service.aliases ?? [])])].sort(),
    baseUrls: [...new Set(service.baseUrls ?? [])].sort(),
    commands: dedupeCommands(commands)
  };
}

function inferRepoCommands(repoId: string, inferred: Inference): CatalogCommand[] {
  const commands: CatalogCommand[] = [];
  const scripts = inferred.scripts ?? {};
  const runner = inferred.packageManager ?? "npm";
  for (const name of ["lint", "test", "build"]) {
    if (scripts[name]) {
      commands.push({
        name,
        run: `${runner} run ${name}`,
        scope: "repo",
        repoId
      });
    }
  }
  return commands;
}

function validateReferences(
  repos: NormalizedRepo[],
  services: NormalizedService[]
): void {
  const repoIds = new Set(repos.map((repo) => repo.id));
  for (const service of services) {
    if (!repoIds.has(service.repoId)) {
      throw new Error(`Service "${service.id}" references unknown repo "${service.repoId}".`);
    }
  }
}

function requireStringList(value: string[] | undefined, label: string): void {
  if (value && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0))) {
    throw new Error(`${label} must contain only non-empty strings.`);
  }
}

function dedupeCommands(commands: CatalogCommand[]): CatalogCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.scope ?? ""}:${command.repoId ?? ""}:${command.serviceId ?? ""}:${command.name}:${command.run}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function ensureUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}
