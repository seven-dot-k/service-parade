# Service Parade

Coordinated movement across microservices, with a hint of managed chaos.

## Project Goal

Build Service Parade: an open-source, local-first engineering control plane that helps agentic
coding tools safely plan, implement, verify, and coordinate software changes
across multiple repositories and microservices.

The project should make cross-repo development legible to tools such as Codex
and Claude Code without requiring teams to replace their existing repositories,
CI systems, ticketing tools, or spec-driven development workflows.

## Problem

Real product changes frequently cross repository and service boundaries. A
single repository may contain one service or many services, while a feature may
require coordinated changes across several repositories. Today, coding agents
often lack the system-level context needed to:

- identify the services affected by a feature;
- understand dependencies and repository ownership;
- assemble the correct local workspace;
- apply consistent repository-specific instructions;
- run meaningful cross-service verification;
- coordinate dependent pull requests; and
- report what changed, what passed, and what remains uncertain.

Spec-driven development helps describe the desired behavior, but a spec alone
does not provide the operational map or orchestration layer needed for reliable
cross-repo execution.

## Product Direction

Develop the control plane incrementally around these capabilities:

1. Service catalog and dependency graph.
2. Spec-to-change-set planner.
3. Cross-repo workspace assembler.
4. MCP server exposing repository, CI, documentation, ticket, and log tools.
5. Agent instruction generator using `AGENTS.md` and compatible adapters.
6. Cross-repo test harness.
7. Multi-PR orchestrator.
8. Verification and reporting layer.

## Current V1 Scope

Keep the first release intentionally small and useful. V1 is a TypeScript/Node
CLI backed by files on disk. It should:

- read `service-parade.yaml` or equivalent JSON configuration;
- scan existing local repository clones without cloning remotes;
- emit a normalized service catalog and dependency graph;
- produce a likely change-set plan from a feature specification;
- assemble workspace guidance for the affected repositories;
- generate explicit instructions for Codex and Claude Code; and
- run configured verification commands and record results in `.service-parade/`.

Build CLI and reusable modules first. Add MCP, CI integrations, ticketing,
logs, and pull-request automation as layers over the same core model rather
than coupling the model to a specific vendor.

## Design Principles

- Prefer local-first workflows and inspectable files.
- Keep catalog declarations explicit; allow scanner inference to fill gaps,
  while explicit configuration always wins.
- Model repositories and services separately because their relationship is
  one-to-many.
- Make every generated plan explainable and reviewable before execution.
- Treat verification evidence as a first-class output, not an afterthought.
- Design extension points for different agent tools and external systems.
- Keep the open-source core vendor-neutral and useful without hosted services.
- Favor incremental, testable improvements over broad speculative scaffolding.

## Definition Of Success

The project is succeeding when a developer can provide a feature spec and a
catalog of local repositories, then receive:

1. an explainable list of likely affected services and repositories;
2. an assembled workspace with appropriate agent guidance;
3. a concrete implementation and verification plan;
4. cross-repo validation results with recorded evidence; and
5. a clear report suitable for coordinating dependent pull requests.

## Working Guidance For Agents

- Read `README.md`, `service-parade.yaml` when present, and relevant tests before
  changing behavior.
- Preserve the V1 local-first boundary unless a task explicitly expands scope.
- Keep core domain logic reusable from both the CLI and a future MCP server.
- Add or update focused tests for behavior changes.
- Avoid introducing vendor-specific assumptions into the core catalog,
  planner, workspace, or verification models.
- Update documentation when commands, generated artifacts, or configuration
  shapes change.
