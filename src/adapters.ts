import type { NormalizedCatalog } from "./types.ts";

export function renderAgentsMd(catalog: NormalizedCatalog): string {
  return renderAgentFile("AGENTS.md", catalog, [
    "Respect existing repo boundaries and avoid unrelated refactors.",
    "Before editing, inspect the affected service root and dependency neighbors.",
    "Run the configured verification commands for each affected repo or service when feasible.",
    "Update the change-set and verification report when scope changes."
  ]);
}

export function renderClaudeMd(catalog: NormalizedCatalog): string {
  return renderAgentFile("CLAUDE.md", catalog, [
    "Use the service catalog as the source of truth for multi-repo boundaries.",
    "Plan cross-service changes before implementing.",
    "Prefer explicit catalog commands over guessed package scripts.",
    "Call out missing catalog data as follow-up rather than inventing ownership or dependency facts."
  ]);
}

function renderAgentFile(title: string, catalog: NormalizedCatalog, guidance: string[]): string {
  return [
    `# ${title}`,
    ``,
    `Generated from the Service Parade catalog.`,
    ``,
    `## Repositories`,
    ...catalog.repos.map((repo) => `- ${repo.id}: ${repo.path} (${repo.owner ?? "unowned"})`),
    ``,
    `## Services`,
    ...catalog.services.map(
      (service) => `- ${service.id}: repo ${service.repoId}, root ${service.root}, language ${service.language ?? "unknown"}`
    ),
    ``,
    `## Dependencies`,
    `- HTTP dependencies are discovered by \`multirepo graph enrich\`; use \`multirepo graph deps\` to inspect accepted edges.`,
    ``,
    `## Operating Guidance`,
    ...guidance.map((item) => `- ${item}`)
  ].join("\n") + "\n";
}
