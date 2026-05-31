import type { ChangeSet, NormalizedCatalog, VerificationReport } from "./types.ts";

export function renderChangeSet(plan: ChangeSet): string {
  return [
    `# Change Set`,
    ``,
    `Generated: ${plan.generatedAt}`,
    `Spec: ${plan.specPath}`,
    ``,
    `## Summary`,
    plan.summary,
    ``,
    `## Affected Services`,
    ...bullets(plan.affectedServices.map((service) => `${service.id} (${service.repoId}) - ${service.reasons.join("; ")}`)),
    ``,
    `## Affected Repos`,
    ...bullets(plan.affectedRepos.map((repo) => `${repo.id} (${repo.path}) - ${repo.reasons.join("; ")}`)),
    ``,
    `## Recommended Order`,
    ...bullets(plan.recommendedOrder),
    ``,
    `## Risks`,
    ...bullets(plan.risks.length > 0 ? plan.risks : ["No catalog risks detected."])
  ].join("\n") + "\n";
}

export function renderWorkspace(catalog: NormalizedCatalog, plan: ChangeSet): string {
  const services = new Set(plan.affectedServices.map((service) => service.id));
  return [
    `# Multi-Repo Workspace`,
    ``,
    `Use this bundle as the handoff context for an agentic coding session.`,
    ``,
    `## Repositories`,
    ...bullets(plan.affectedRepos.map((repo) => `${repo.id}: ${repo.path}`)),
    ``,
    `## Services`,
    ...bullets(
      catalog.services
        .filter((service) => services.has(service.id))
        .map((service) => `${service.id}: ${service.repoId}/${service.root} (${service.language ?? "unknown"})`)
    ),
    ``,
    `## Dependency Order`,
    ...bullets(plan.recommendedOrder),
    ``,
    `## Commands`,
    ...bullets(commandLines(plan)),
    ``,
    `## Agent Guidance`,
    `Read the spec first, then inspect affected service roots before editing shared contracts. Prefer the catalog commands for verification and record any missing commands as catalog follow-up.`
  ].join("\n") + "\n";
}

export function renderVerification(report: VerificationReport): string {
  return [
    `# Verification Report`,
    ``,
    `Generated: ${report.generatedAt}`,
    `Plan: ${report.planPath}`,
    `Passed: ${report.passed ? "yes" : "no"}`,
    ``,
    `## Results`,
    ...bullets(
      report.results.map(
        (result) => `${result.target} / ${result.name}: exit ${result.exitCode ?? "unknown"} (${result.command})`
      )
    )
  ].join("\n") + "\n";
}

function commandLines(plan: ChangeSet): string[] {
  const lines = [
    ...plan.affectedServices.flatMap((service) =>
      service.commands.map((command) => `${service.id}: ${command.name} -> ${command.run}`)
    ),
    ...plan.affectedRepos.flatMap((repo) => repo.commands.map((command) => `${repo.id}: ${command.name} -> ${command.run}`))
  ];
  return lines.length > 0 ? lines : ["No commands configured."];
}

function bullets(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None"];
}
