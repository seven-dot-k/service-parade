import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import type { NormalizedCatalog } from "../types.ts";
import { stableJson } from "../fs.ts";
import { getGraphStatus, listDependencies, listEndpoints } from "./query.ts";
import { resolveGraphDb } from "./paths.ts";

export type GraphPreviewOptions = {
  host?: string;
  port?: number;
};

export type GraphPreviewModel = {
  generatedAt: string;
  status: Awaited<ReturnType<typeof getGraphStatus>>;
  services: Array<{
    id: string;
    repoId: string;
    endpoints: number;
  }>;
  dependencies: Awaited<ReturnType<typeof listDependencies>>;
};

export type GraphPreviewServer = {
  server: Server;
  url: string;
};

export async function buildGraphPreviewModel(root: string, catalog: NormalizedCatalog): Promise<GraphPreviewModel> {
  const [status, dependencies] = await Promise.all([
    getGraphStatus(root, catalog),
    listDependencies(root)
  ]);
  const endpointCount = new Map<string, number>();
  for (const endpoint of existsSync(resolveGraphDb(root)) ? listEndpoints(root) : []) {
    endpointCount.set(endpoint.serviceId, (endpointCount.get(endpoint.serviceId) ?? 0) + 1);
  }
  return {
    generatedAt: new Date().toISOString(),
    status,
    services: catalog.services
      .map((service) => ({
        id: service.id,
        repoId: service.repoId,
        endpoints: endpointCount.get(service.id) ?? 0
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    dependencies
  };
}

export async function startGraphPreview(
  root: string,
  catalog: NormalizedCatalog,
  options: GraphPreviewOptions = {}
): Promise<GraphPreviewServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        response.end("Method not allowed.\n");
        return;
      }
      if (request.url === "/api/graph") {
        const model = await buildGraphPreviewModel(root, catalog);
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
        response.end(stableJson(model));
        return;
      }
      if (request.url === "/" || request.url === "/index.html") {
        response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
        response.end(renderGraphPreviewHtml());
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.\n");
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Graph preview server did not expose a TCP address.");
  }
  return { server, url: `http://${host}:${address.port}` };
}

export function renderGraphPreviewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Service Parade HTTP Graph</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #e7ecff; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #172554, #0b1020 56%); }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -.04em; }
    p { margin: 0; color: #a7b4d6; }
    .badge { border: 1px solid #334155; border-radius: 999px; padding: 7px 11px; color: #cbd5e1; background: #111827cc; }
    .panel { border: 1px solid #263758; border-radius: 16px; background: #0f172acc; box-shadow: 0 18px 60px #02061766; overflow: hidden; }
    #summary { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #263758; }
    .metric { color: #bfdbfe; font-size: 13px; }
    svg { display: block; width: 100%; min-height: 560px; }
    .edge { stroke: #60a5fa; stroke-width: 2.5; opacity: .86; }
    .edge-label { fill: #bfdbfe; font-size: 12px; paint-order: stroke; stroke: #0f172a; stroke-width: 5px; stroke-linejoin: round; }
    .node { fill: #172554; stroke: #93c5fd; stroke-width: 2; }
    .node-title { fill: #eff6ff; font-size: 15px; font-weight: 700; text-anchor: middle; }
    .node-meta { fill: #a7b4d6; font-size: 12px; text-anchor: middle; }
    .empty { fill: #a7b4d6; text-anchor: middle; font-size: 16px; }
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>Service Parade</h1><p>Coordinated movement across microservices, with a hint of managed chaos.</p></div>
      <span class="badge" id="freshness">Loading...</span>
    </header>
    <section class="panel">
      <div id="summary"></div>
      <svg id="graph" viewBox="0 0 1120 560" role="img" aria-label="Service dependency graph"></svg>
    </section>
  </main>
  <script>
    const svg = document.querySelector("#graph");
    const ns = "http://www.w3.org/2000/svg";
    const add = (name, attrs = {}, text = "") => {
      const el = document.createElementNS(ns, name);
      Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
      if (text) el.textContent = text;
      svg.appendChild(el);
      return el;
    };
    const point = (index, total) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2 / Math.max(total, 1));
      return { x: 560 + Math.cos(angle) * 340, y: 280 + Math.sin(angle) * 190 };
    };
    fetch("/api/graph").then((response) => response.json()).then((data) => {
      const freshness = document.querySelector("#freshness");
      freshness.textContent = data.status.fresh ? "Graph artifacts fresh" : "Graph artifacts stale";
      document.querySelector("#summary").innerHTML = [
        data.services.length + " services",
        data.dependencies.length + " accepted dependencies",
        data.status.pendingLinks + " pending links"
      ].map((item) => '<span class="metric">' + item + '</span>').join("");
      const defs = add("defs");
      const marker = document.createElementNS(ns, "marker");
      marker.setAttribute("id", "arrow"); marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9"); marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7"); marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto-start-reverse");
      const arrow = document.createElementNS(ns, "path");
      arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z"); arrow.setAttribute("fill", "#60a5fa");
      marker.appendChild(arrow); defs.appendChild(marker);
      const positions = new Map(data.services.map((service, index) => [service.id, point(index, data.services.length)]));
      const pairKey = (left, right) => [left, right].sort().join("\\u0000");
      const grouped = new Map();
      data.dependencies.forEach((dependency) => {
        const key = pairKey(dependency.sourceServiceId, dependency.targetServiceId);
        const group = grouped.get(key) || { left: dependency.sourceServiceId, right: dependency.targetServiceId, directions: new Map() };
        const direction = dependency.sourceServiceId + "\\u0000" + dependency.targetServiceId;
        const routes = group.directions.get(direction) || [];
        routes.push(dependency.httpMethod + " " + dependency.endpointPath);
        group.directions.set(direction, routes);
        grouped.set(key, group);
      });
      grouped.forEach((group) => {
        const from = positions.get(group.left); const to = positions.get(group.right);
        if (!from || !to) return;
        const reverse = group.right + "\\u0000" + group.left;
        const reciprocal = group.directions.has(reverse);
        const dx = to.x - from.x; const dy = to.y - from.y;
        const length = Math.hypot(dx, dy); const ux = dx / length; const uy = dy / length;
        const attrs = {
          class: "edge",
          x1: from.x + ux * 112, y1: from.y + uy * 48,
          x2: to.x - ux * 112, y2: to.y - uy * 48,
          "marker-end": "url(#arrow)"
        };
        if (reciprocal) attrs["marker-start"] = "url(#arrow)";
        const line = add("line", attrs);
        const count = [...group.directions.values()].reduce((total, routes) => total + routes.length, 0);
        const arrowText = reciprocal ? " <-> " : " -> ";
        const details = [...group.directions.entries()]
          .flatMap(([direction, routes]) => routes.map((route) => direction.replace("\\u0000", " -> ") + ": " + route))
          .sort()
          .join("\\n");
        const title = document.createElementNS(ns, "title");
        title.textContent = details;
        line.appendChild(title);
        add("text", { class: "edge-label", x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 8, "text-anchor": "middle" }, group.left + arrowText + group.right + " · " + count + " call" + (count === 1 ? "" : "s"));
      });
      data.services.forEach((service) => {
        const at = positions.get(service.id);
        add("rect", { class: "node", x: at.x - 102, y: at.y - 38, width: 204, height: 76, rx: 14 });
        add("text", { class: "node-title", x: at.x, y: at.y - 4 }, service.id);
        add("text", { class: "node-meta", x: at.x, y: at.y + 19 }, service.repoId + " · " + service.endpoints + " endpoints");
      });
      if (!data.services.length) add("text", { class: "empty", x: 560, y: 280 }, "No declared services.");
    }).catch((error) => {
      document.querySelector("#freshness").textContent = "Preview failed";
      add("text", { class: "empty", x: 560, y: 280 }, error.message);
    });
  </script>
</body>
</html>`;
}
