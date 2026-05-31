import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = path.resolve("src/cli.ts");

test("CLI runs init, catalog, plan, assemble, instructions, and verify", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-cli-"));
  const repoPath = path.join(root, "repo-a");
  await mkdir(repoPath);
  await writeFile(path.join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }), "utf8");
  await writeFile(
    path.join(root, "multirepo.yaml"),
    [
      "repos:",
      "  - id: repo-a",
      "    path: repo-a",
      "services:",
      "  - id: orders-api",
      "    repoId: repo-a",
      "    root: .",
      "    tags: [orders]",
      "commands:",
      "  - name: test",
      "    run: node -e \"process.exit(0)\"",
      "    scope: repo",
      "    repoId: repo-a",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(root, "spec.md"), "Change orders-api checkout behavior.", "utf8");

  await exec("node", [cli, "catalog"], { cwd: root });
  await exec("node", [cli, "plan", "--spec", "spec.md"], { cwd: root });
  await exec("node", [cli, "assemble"], { cwd: root });
  await exec("node", [cli, "instructions"], { cwd: root });
  await exec("node", [cli, "verify"], { cwd: root });

  assert.match(await readFile(path.join(root, ".multirepo", "catalog.json"), "utf8"), /orders-api/);
  assert.match(await readFile(path.join(root, ".multirepo", "workspace.md"), "utf8"), /orders-api/);
  assert.match(await readFile(path.join(root, ".multirepo", "workspace", "workspace-manifest.json"), "utf8"), /orders-api/);
  assert.match(await readFile(path.join(root, ".multirepo", "workspace", "repos", "repo-a", "AGENTS.md"), "utf8"), /Generated repository handoff/);
  assert.match(await readFile(path.join(root, ".multirepo", "AGENTS.md"), "utf8"), /AGENTS\.md/);
  assert.match(await readFile(path.join(root, ".multirepo", "verification-report.json"), "utf8"), /"passed": true/);
});

test("CLI verify captures failed commands without hiding the report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-cli-fail-"));
  await writeFile(
    path.join(root, "multirepo.json"),
    JSON.stringify({
      repos: [{ id: "repo-a", path: "." }],
      services: [{ id: "orders-api", repoId: "repo-a" }],
      commands: [{ name: "test", run: "node -e \"process.exit(7)\"", scope: "repo", repoId: "repo-a" }]
    }),
    "utf8"
  );
  await writeFile(path.join(root, "spec.md"), "Change orders-api checkout behavior.", "utf8");

  await exec("node", [cli, "catalog"], { cwd: root });
  await exec("node", [cli, "plan", "--spec", "spec.md"], { cwd: root });
  await assert.rejects(() => exec("node", [cli, "verify"], { cwd: root }));

  const report = await readFile(path.join(root, ".multirepo", "verification-report.json"), "utf8");
  assert.match(report, /"exitCode": 7/);
  assert.match(report, /"passed": false/);
});

test("CLI indexes, enriches, and prints discovered HTTP dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multirepo-cli-graph-"));
  await mkdir(path.join(root, "web"));
  await mkdir(path.join(root, "orders"));
  await writeFile(path.join(root, "web", "server.ts"), `fetch("http://orders-svc/health");\n`, "utf8");
  await writeFile(path.join(root, "orders", "Program.cs"), `app.MapGet("/health", () => "ok");\n`, "utf8");
  await writeFile(
    path.join(root, "multirepo.json"),
    JSON.stringify({
      repos: [
        { id: "web", path: "web" },
        { id: "orders", path: "orders" }
      ],
      services: [
        { id: "web-api", repoId: "web" },
        { id: "orders-api", repoId: "orders", aliases: ["orders-svc"] }
      ]
    }),
    "utf8"
  );

  await exec("node", [cli, "graph", "index"], { cwd: root });
  await exec("node", [cli, "graph", "enrich"], { cwd: root });
  const { stdout } = await exec("node", [cli, "graph", "deps", "--json"], { cwd: root });

  assert.match(stdout, /"sourceServiceId": "web-api"/);
  assert.match(stdout, /"targetServiceId": "orders-api"/);
  assert.equal(stdout.includes('"endpointPath": "/health"'), true);
});
