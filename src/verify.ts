import { spawn } from "node:child_process";
import path from "node:path";
import type { CatalogCommand, ChangeSet, NormalizedCatalog, VerificationReport } from "./types.ts";

export async function verifyPlan(catalog: NormalizedCatalog, plan: ChangeSet, planPath: string): Promise<VerificationReport> {
  const commands = resolveCommands(catalog, plan);
  const results = [];
  for (const item of commands) {
    results.push(await runCommand(item.command, item.cwd, item.target));
  }
  return {
    generatedAt: new Date().toISOString(),
    planPath,
    results,
    passed: results.every((result) => result.exitCode === 0)
  };
}

function resolveCommands(catalog: NormalizedCatalog, plan: ChangeSet): Array<{ command: CatalogCommand; cwd: string; target: string }> {
  const items: Array<{ command: CatalogCommand; cwd: string; target: string }> = [];
  for (const repoPlan of plan.affectedRepos) {
    const repo = catalog.repos.find((candidate) => candidate.id === repoPlan.id);
    if (!repo) {
      continue;
    }
    for (const command of repoPlan.commands) {
      items.push({ command, cwd: path.resolve(repo.absolutePath, command.cwd ?? "."), target: repo.id });
    }
  }
  for (const servicePlan of plan.affectedServices) {
    const service = catalog.services.find((candidate) => candidate.id === servicePlan.id);
    if (!service) {
      continue;
    }
    for (const command of servicePlan.commands.filter((command) => command.scope === "service")) {
      items.push({ command, cwd: path.resolve(service.absolutePath, command.cwd ?? "."), target: service.id });
    }
  }
  return dedupe(items);
}

function runCommand(command: CatalogCommand, cwd: string, target: string): Promise<VerificationReport["results"][number]> {
  return new Promise((resolve) => {
    const child = spawn(command.run, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        name: command.name,
        target,
        command: command.run,
        cwd,
        exitCode: null,
        stdout,
        stderr: `${stderr}${error.message}`
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        name: command.name,
        target,
        command: command.run,
        cwd,
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

function dedupe(items: Array<{ command: CatalogCommand; cwd: string; target: string }>): Array<{ command: CatalogCommand; cwd: string; target: string }> {
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
