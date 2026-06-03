# Human TLDR;

maybe niche, but some orgs have a large number of microservices in various languages, frameworks, stacks etc.

agentic harnesses still struggle with cross-service / cross-repo development 

this repo is an attempt to solve that via a cli/mcp server that auto-discovers micro service connections/edges between services through requests and libraries.  

that graph is then used to enhance, guide and improve spec driven development.

# Service Parade

Coordinated movement across microservices, with a hint of managed chaos.

Service Parade is a local-first control plane for helping agentic coding tools understand and operate across multiple repositories and microservices.

V1 is a TypeScript/Node CLI that reads a small `service-parade.yaml`, scans existing local clones, emits a normalized service catalog, plans likely change sets from a feature spec, generates agent instructions for Codex and Claude Code, assembles workspace guidance, and records verification results.

## Quick Start

```bash
service-parade init
service-parade scan
service-parade catalog
service-parade plan --spec feature.md
service-parade assemble
service-parade instructions
service-parade verify
service-parade graph index
service-parade graph enrich
service-parade graph deps
service-parade graph preview
service-parade mcp
service-parade pr plan
```

Generated artifacts are written to `.service-parade/`.

## Catalog Shape

`service-parade.yaml` declares local repositories, services, HTTP matching hints, optional SDK source discovery, and optional commands. Scanner inference fills gaps, but explicit catalog values win. HTTP dependencies are discovered from source code rather than maintained manually.

```yaml
repos:
  - id: billing
    path: ../billing
    defaultBranch: main
    owner: payments
    httpDiscovery:
      sdkPackages:
        - Acme.Identity.Contracts
services:
  - id: billing-api
    repoId: billing
    root: services/api
    language: typescript
    tags: [billing, api]
    aliases: [billing, billing-api]
    baseUrls: [http://billing-api]
sdkSources:
  - id: identity-contract-clients
    packages: [Acme.Identity.Contracts, Acme.Identity.Contracts.Clients]
    source: ../identity/contracts
    targetServiceId: identity-api
    detector: mozu-service-client
    options:
      clientDir: Clients
      codegenTargets: CCG.targets
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

SDK source discovery is opt-in per repo. Use `repos[].httpDiscovery.sdkPackages` to name package references worth inspecting, then map those package names to local source under `sdkSources`. The core resolver is vendor-neutral; organization-specific semantics live behind detector names such as `mozu-service-client`.

```bash
service-parade graph index
service-parade graph enrich
service-parade graph deps --json
service-parade graph status --json
service-parade graph impact orders-api --depth 2 --json
service-parade graph endpoints --service orders-api --json
service-parade graph links list --json
service-parade graph links approve <pending-id> --target <endpoint-id>
service-parade graph links reject <pending-id>
service-parade graph preview [--host 127.0.0.1] [--port 4173]
```

Durable SQLite state, deterministic dependency artifacts, and the rebuildable embedded SurrealDB projection live under `.service-parade/graph/`.
The `graph preview` command serves a dependency-free, read-only HTML visualization from those artifacts. It defaults to `http://127.0.0.1:4173`.

## Workspace Handoff

`assemble` writes the human-readable `.service-parade/workspace.md` summary and a structured `.service-parade/workspace/workspace-manifest.json` bundle. The bundle contains affected repositories, services, dependency evidence, canonical verification commands, risks, and repository-scoped `AGENTS.md` and `CLAUDE.md` handoffs under `.service-parade/workspace/repos/`.

## MCP Context Server

Start the local read-only MCP server over stdio:

```bash
service-parade mcp
```

It exposes catalog, accepted dependency, and pending-link resources plus an inline spec-to-change-set planning tool. Indexing, approvals, and verification remain explicit CLI operations because they mutate workspace state or execute commands.

## Pull Request Dry Run

Generate a vendor-neutral local orchestration report after planning and workspace assembly:

```bash
service-parade pr plan
```

The command writes `.service-parade/pr-plan.json` and `.service-parade/pr-plan.md` with suggested branches, PR titles, repository implementation order, cross-repo prerequisites, dependency evidence, verification commands, and readiness risks. It does not create branches, commits, or hosted pull requests.
