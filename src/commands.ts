import path from "node:path";
import type { CatalogCommand, NormalizedCatalog, NormalizedRepo, NormalizedService } from "./types.ts";

export type ResolvedCommand = {
  command: CatalogCommand;
  cwd: string;
  target: string;
};

export function normalizeCommands(commands: CatalogCommand[]): CatalogCommand[] {
  return commands.map((command) => normalizeCommand(command));
}

export function normalizeRepoCommands(commands: CatalogCommand[], repoId: string): CatalogCommand[] {
  return commands.map((command) => ({
    ...normalizeCommand(command),
    scope: "repo",
    repoId,
    serviceId: undefined
  }));
}

export function normalizeServiceCommands(commands: CatalogCommand[], serviceId: string): CatalogCommand[] {
  return commands.map((command) => ({
    ...normalizeCommand(command),
    scope: "service",
    repoId: undefined,
    serviceId
  }));
}

export function validateCommand(command: CatalogCommand): void {
  requireString(command.name, "command.name");
  requireString(command.run, `command(${command.name}).run`);
  if (command.scope && command.scope !== "repo" && command.scope !== "service") {
    throw new Error(`Command "${command.name}" has unsupported scope "${command.scope}".`);
  }
}

export function validateGlobalCommandOwners(
  commands: CatalogCommand[],
  repos: NormalizedRepo[],
  services: NormalizedService[]
): void {
  const repoIds = new Set(repos.map((repo) => repo.id));
  const serviceById = new Map(services.map((service) => [service.id, service]));

  for (const command of commands) {
    if (command.scope === "repo") {
      if (!command.repoId || !repoIds.has(command.repoId)) {
        throw new Error(`Global repo command "${command.name}" references unknown repo "${command.repoId ?? ""}".`);
      }
      if (command.serviceId) {
        throw new Error(`Global repo command "${command.name}" must not reference service "${command.serviceId}".`);
      }
    }
    if (command.scope === "service") {
      const service = command.serviceId ? serviceById.get(command.serviceId) : undefined;
      if (!service) {
        throw new Error(`Global service command "${command.name}" references unknown service "${command.serviceId ?? ""}".`);
      }
      if (command.repoId && command.repoId !== service.repoId) {
        throw new Error(`Global service command "${command.name}" references repo "${command.repoId}" instead of "${service.repoId}".`);
      }
    }
  }
}

export function resolveVerificationCommands(
  catalog: NormalizedCatalog,
  affectedRepoIds: string[],
  affectedServiceIds: string[]
): ResolvedCommand[] {
  const items: ResolvedCommand[] = [];
  for (const repoId of affectedRepoIds) {
    const repo = findOwner(catalog.repos, repoId, "repo");
    for (const command of repo.commands) {
      items.push(resolveCommand(command, repo.absolutePath, repo.id));
    }
  }
  for (const serviceId of affectedServiceIds) {
    const service = findOwner(catalog.services, serviceId, "service");
    for (const command of service.commands) {
      items.push(resolveCommand(command, service.absolutePath, service.id));
    }
  }
  return dedupeResolvedCommands(items);
}

export function validateCommandCwds(commands: CatalogCommand[], ownerPath: string, target: string): void {
  for (const command of commands) {
    resolveCommand(command, ownerPath, target);
  }
}

function normalizeCommand(command: CatalogCommand): CatalogCommand {
  validateCommand(command);
  return {
    ...command,
    name: command.name.trim(),
    run: command.run.trim()
  };
}

function resolveCommand(command: CatalogCommand, ownerPath: string, target: string): ResolvedCommand {
  const cwd = path.resolve(ownerPath, command.cwd ?? ".");
  const relative = path.relative(ownerPath, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Command "${command.name}" cwd "${command.cwd ?? "."}" escapes ${target} root "${ownerPath}".`);
  }
  return { command, cwd, target };
}

function findOwner<T extends { id: string }>(items: T[], id: string, label: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`Verification plan references unknown ${label} "${id}".`);
  }
  return item;
}

function dedupeResolvedCommands(items: ResolvedCommand[]): ResolvedCommand[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.target}:${item.cwd}:${item.command.name}:${item.command.run}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}
