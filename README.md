# Multi-Repo Agent Control Plane

A local-first control plane for helping agentic coding tools understand and operate across multiple repositories and services.

V1 is a TypeScript/Node CLI that reads a small `multirepo.yaml`, scans existing local clones, emits a normalized service catalog, plans likely change sets from a feature spec, generates agent instructions for Codex and Claude Code, assembles workspace guidance, and records verification results.

## Quick Start

```bash
node src/cli.ts init
node src/cli.ts scan
node src/cli.ts catalog
node src/cli.ts plan --spec feature.md
node src/cli.ts assemble
node src/cli.ts instructions
node src/cli.ts verify
node src/cli.ts graph index
node src/cli.ts graph enrich
node src/cli.ts graph deps
node src/cli.ts mcp
```

Generated artifacts are written to `.multirepo/`.

## Catalog Shape

`multirepo.yaml` declares local repositories, services, HTTP matching hints, and optional commands. Scanner inference fills gaps, but explicit catalog values win. HTTP dependencies are discovered from source code rather than maintained manually.

```yaml
repos:
  - id: billing
    path: ../billing
    defaultBranch: main
    owner: payments
services:
  - id: billing-api
    repoId: billing
    root: services/api
    language: typescript
    tags: [billing, api]
    aliases: [billing, billing-api]
    baseUrls: [http://billing-api]
commands:
  - name: test
    run: npm test
    scope: service
    serviceId: billing-api
```

## Design Defaults

- Existing local clones only; no remote cloning in v1.
- CLI and files first; MCP can wrap the same modules later.
- Codex and Claude Code adapters are generated explicitly.
- JSON config files are also accepted for teams that prefer strict machine-readable input.

## HTTP Dependency Graph

The `graph` commands incrementally index declared service roots, detect inbound HTTP endpoints and outbound calls, match accepted links, and queue ambiguous links for review.

```bash
node src/cli.ts graph index
node src/cli.ts graph enrich
node src/cli.ts graph deps --json
node src/cli.ts graph links list --json
node src/cli.ts graph links approve <pending-id> --target <endpoint-id>
node src/cli.ts graph links reject <pending-id>
```

Durable SQLite state, deterministic dependency artifacts, and the rebuildable embedded SurrealDB projection live under `.multirepo/graph/`.

## Workspace Handoff

`assemble` writes the human-readable `.multirepo/workspace.md` summary and a structured `.multirepo/workspace/workspace-manifest.json` bundle. The bundle contains affected repositories, services, dependency evidence, canonical verification commands, risks, and repository-scoped `AGENTS.md` and `CLAUDE.md` handoffs under `.multirepo/workspace/repos/`.

## MCP Context Server

Start the local read-only MCP server over stdio:

```bash
node src/cli.ts mcp
```

It exposes catalog, accepted dependency, and pending-link resources plus an inline spec-to-change-set planning tool. Indexing, approvals, and verification remain explicit CLI operations because they mutate workspace state or execute commands.
