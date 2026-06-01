import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { OUTPUT_DIR } from "./paths.ts";
import { writeText } from "./fs.ts";

export async function initProject(root: string): Promise<string[]> {
  const created: string[] = [];
  const configPath = path.join(root, "service-parade.yaml");
  try {
    await access(configPath);
  } catch {
    await writeText(configPath, starterConfig());
    created.push(configPath);
  }
  const outputDir = path.join(root, OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  created.push(outputDir);
  return created;
}

function starterConfig(): string {
  return `# Service Parade catalog.
# Declare existing local clones. Run "service-parade scan" to infer package scripts and manifests.
repos:
  - id: example
    path: ../example
    defaultBranch: main
    owner: platform

services:
  - id: example-api
    repoId: example
    root: .
    language: typescript
    tags: [api, example]
    aliases: [example, example-api]
    baseUrls: [http://example-api]

commands:
  - name: test
    run: npm test
    scope: repo
    repoId: example
`;
}
