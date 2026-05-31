import { spawn } from "node:child_process";
import type { CatalogCommand, ChangeSet, NormalizedCatalog, VerificationReport } from "./types.ts";
import { resolveVerificationCommands } from "./commands.ts";

export async function verifyPlan(catalog: NormalizedCatalog, plan: ChangeSet, planPath: string): Promise<VerificationReport> {
  const commands = resolveVerificationCommands(
    catalog,
    plan.affectedRepos.map((repo) => repo.id),
    plan.affectedServices.map((service) => service.id)
  );
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
