import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Inference } from "./types.ts";

export async function scanRepo(repoPath: string): Promise<Inference> {
  const manifests: string[] = [];
  const dockerCompose: string[] = [];
  const languages = new Set<string>();
  let packageManager: string | undefined;
  let scripts: Record<string, string> | undefined;

  if (!(await exists(repoPath))) {
    return { languages: [], manifests, dockerCompose };
  }

  for (const file of await safeReadDir(repoPath)) {
    if (["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].includes(file)) {
      dockerCompose.push(file);
    }
  }

  if (await exists(path.join(repoPath, "package.json"))) {
    manifests.push("package.json");
    languages.add("typescript");
    const packageJson = JSON.parse(await readFile(path.join(repoPath, "package.json"), "utf8"));
    scripts = packageJson.scripts ?? {};
    packageManager = await detectPackageManager(repoPath);
  }
  if (await exists(path.join(repoPath, "go.mod"))) {
    manifests.push("go.mod");
    languages.add("go");
  }
  if (await exists(path.join(repoPath, "pyproject.toml"))) {
    manifests.push("pyproject.toml");
    languages.add("python");
  }
  if (await exists(path.join(repoPath, "pom.xml"))) {
    manifests.push("pom.xml");
    languages.add("java");
  }
  if (await exists(path.join(repoPath, "build.gradle")) || await exists(path.join(repoPath, "settings.gradle"))) {
    manifests.push("gradle");
    languages.add("java");
  }
  if (await exists(path.join(repoPath, "Cargo.toml"))) {
    manifests.push("Cargo.toml");
    languages.add("rust");
  }
  if ((await safeReadDir(repoPath)).some((file) => file.endsWith(".csproj") || file.endsWith(".sln"))) {
    manifests.push("dotnet");
    languages.add("csharp");
  }

  return {
    packageManager,
    scripts,
    languages: [...languages].sort(),
    manifests: manifests.sort(),
    dockerCompose: dockerCompose.sort()
  };
}

async function detectPackageManager(repoPath: string): Promise<string> {
  if (await exists(path.join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(path.join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}
