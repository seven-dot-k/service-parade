import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { NormalizedCatalog } from "../types.ts";
import { stableJson } from "../fs.ts";
import { getGraphStatus, listDependencies, listEndpoints } from "./query.ts";
import { resolveGraph, resolveGraphDb } from "./paths.ts";

const require = createRequire(import.meta.url);

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

export type ProjectionPreviewModel = {
  generatedAt: string;
  counts: {
    nodes: number;
    edges: number;
  };
  nodes: Array<{
    data: {
      id: string;
      label: string;
      kind: string;
      serviceId?: string;
      file?: string;
      line?: number;
      rawId?: string;
      properties?: unknown;
    };
  }>;
  edges: Array<{
    data: {
      id: string;
      source: string;
      target: string;
      kind: "contains" | "consumes_endpoint";
      label: string;
      properties?: unknown;
    };
  }>;
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
      if (request.url === "/api/projection") {
        const model = await buildProjectionPreviewModel(root);
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
        response.end(stableJson(model));
        return;
      }
      if (request.url === "/vendor/cytoscape.min.js") {
        const file = require.resolve("cytoscape/dist/cytoscape.min.js");
        response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8" });
        response.end(await readFile(file, "utf8"));
        return;
      }
      if (request.url === "/vendor/3d-force-graph.min.js") {
        const file = require.resolve("3d-force-graph").replace(/3d-force-graph\.mjs$/, "3d-force-graph.min.js");
        response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript; charset=utf-8" });
        response.end(await readFile(file, "utf8"));
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

export async function buildProjectionPreviewModel(root: string): Promise<ProjectionPreviewModel> {
  const artifactPath = resolveGraph(root, "projection-preview.json");
  if (!existsSync(artifactPath)) {
    return { generatedAt: new Date().toISOString(), counts: { nodes: 0, edges: 0 }, nodes: [], edges: [] };
  }
  return JSON.parse(await readFile(artifactPath, "utf8")) as ProjectionPreviewModel;
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
    .panel { border: 1px solid #263758; border-radius: 16px; background: #0f172acc; box-shadow: 0 18px 60px #02061766; overflow: hidden; margin-bottom: 18px; }
    #summary { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #263758; }
    .metric { color: #bfdbfe; font-size: 13px; }
    svg { display: block; width: 100%; min-height: 560px; }
    .edge { stroke: #60a5fa; stroke-width: 2.5; opacity: .86; }
    .edge-label { fill: #bfdbfe; font-size: 12px; paint-order: stroke; stroke: #0f172a; stroke-width: 5px; stroke-linejoin: round; }
    .node { fill: #172554; stroke: #93c5fd; stroke-width: 2; }
    .node-title { fill: #eff6ff; font-size: 15px; font-weight: 700; text-anchor: middle; }
    .node-meta { fill: #a7b4d6; font-size: 12px; text-anchor: middle; }
    .empty { fill: #a7b4d6; text-anchor: middle; font-size: 16px; }
    .panel-title { padding: 14px 16px 0; font-size: 14px; font-weight: 700; color: #eff6ff; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #263758; }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .icon-button { border: 1px solid #334155; border-radius: 999px; padding: 7px 12px; color: #e7ecff; background: #111827; font: inherit; font-size: 13px; cursor: pointer; }
    .icon-button:hover { border-color: #60a5fa; color: #bfdbfe; }
    .filters { display: flex; flex-wrap: wrap; gap: 8px; }
    .filters label { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #334155; border-radius: 999px; padding: 6px 10px; color: #cbd5e1; background: #111827cc; font-size: 13px; }
    .filters input { accent-color: #60a5fa; }
    select { border: 1px solid #334155; border-radius: 999px; padding: 7px 12px; color: #e7ecff; background: #111827; font: inherit; font-size: 13px; }
    .projection-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 680px; }
    #projection { min-height: 680px; background: #08111f; }
    .graph3d-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 720px; }
    #projection-3d { min-height: 720px; background: #030712; position: relative; }
    #projection-3d canvas { display: block; }
    #details { border-left: 1px solid #263758; padding: 16px; color: #cbd5e1; overflow: auto; }
    #details-3d { border-left: 1px solid #263758; padding: 16px; color: #cbd5e1; overflow: auto; }
    #details h2, #details-3d h2 { margin: 0 0 10px; color: #eff6ff; font-size: 16px; }
    #details pre, #details-3d pre { white-space: pre-wrap; word-break: break-word; color: #a7b4d6; font-size: 12px; line-height: 1.45; margin: 0; }
    @media (max-width: 860px) {
      .projection-grid, .graph3d-grid { grid-template-columns: 1fr; }
      #details, #details-3d { border-left: 0; border-top: 1px solid #263758; max-height: 320px; }
    }
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
    <section class="panel">
      <div class="panel-title">Projection Explorer</div>
      <div class="toolbar">
        <div id="projection-summary" class="metric">Loading projection...</div>
        <div class="controls">
          <select id="layout-mode" aria-label="Projection layout">
            <option value="cose" selected>cose</option>
            <option value="breadthfirst">breadthfirst</option>
            <option value="concentric">concentric</option>
            <option value="circle">circle</option>
            <option value="grid">grid</option>
          </select>
          <button class="icon-button" id="readable-zoom" type="button">Readable zoom</button>
          <button class="icon-button" id="fit-graph" type="button">Fit graph</button>
          <div class="filters">
            <label><input type="checkbox" value="service" checked>service</label>
            <label><input type="checkbox" value="endpoint" checked>endpoint</label>
            <label><input type="checkbox" value="http_call" checked>http call</label>
            <label><input type="checkbox" value="config_key" checked>config key</label>
          </div>
        </div>
      </div>
      <div class="projection-grid">
        <div id="projection"></div>
        <aside id="details"><h2>Selection</h2><pre>Click a node or edge to inspect its properties.</pre></aside>
      </div>
    </section>
    <section class="panel">
      <div class="panel-title">Projection Explorer 3D</div>
      <div class="toolbar">
        <div id="projection-3d-summary" class="metric">Loading 3D projection...</div>
        <div class="controls">
          <button class="icon-button" id="reheat-3d" type="button">Reheat</button>
          <button class="icon-button" id="fit-3d" type="button">Fit 3D</button>
          <div class="filters filters-3d">
            <label><input type="checkbox" value="service" checked>service</label>
            <label><input type="checkbox" value="endpoint" checked>endpoint</label>
            <label><input type="checkbox" value="http_call" checked>http call</label>
            <label><input type="checkbox" value="config_key" checked>config key</label>
          </div>
        </div>
      </div>
      <div class="graph3d-grid">
        <div id="projection-3d"></div>
        <aside id="details-3d"><h2>3D Selection</h2><pre>Click a node or link to inspect it. Drag to orbit, scroll to zoom.</pre></aside>
      </div>
    </section>
  </main>
  <script src="/vendor/cytoscape.min.js"></script>
  <script src="/vendor/3d-force-graph.min.js"></script>
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

    const details = document.querySelector("#details pre");
    const details3d = document.querySelector("#details-3d pre");
    const projectionSummary = document.querySelector("#projection-summary");
    const projection3dSummary = document.querySelector("#projection-3d-summary");
    const filters = [...document.querySelectorAll(".filters input")];
    const filters3d = [...document.querySelectorAll(".filters-3d input")];
    const layoutMode = document.querySelector("#layout-mode");
    const readableZoom = document.querySelector("#readable-zoom");
    const fitGraph = document.querySelector("#fit-graph");
    const reheat3d = document.querySelector("#reheat-3d");
    const fit3d = document.querySelector("#fit-3d");
    const graph3dElement = document.querySelector("#projection-3d");
    let projectionData = null;
    let cy = null;
    let graph3d = null;
    let graph3dData = { nodes: [], links: [] };

    const layoutOptions = {
      cose: { name: "cose", animate: false, nodeRepulsion: 9000, idealEdgeLength: 92, componentSpacing: 90 },
      breadthfirst: { name: "breadthfirst", animate: false, directed: true, spacingFactor: 1.25, roots: '[kind = "service"]' },
      concentric: {
        name: "concentric",
        animate: false,
        minNodeSpacing: 32,
        concentric: (node) => node.connectedEdges().length + (node.data("kind") === "service" ? 100 : 0),
        levelWidth: () => 12
      },
      circle: { name: "circle", animate: false, spacingFactor: 1.15 },
      grid: { name: "grid", animate: false, avoidOverlap: true, avoidOverlapPadding: 18 }
    };

    fetch("/api/projection").then((response) => response.json()).then((data) => {
      projectionData = data;
      projectionSummary.textContent = data.counts.nodes + " nodes · " + data.counts.edges + " relations";
      projection3dSummary.textContent = data.counts.nodes + " nodes · " + data.counts.edges + " relations";
      cy = cytoscape({
        container: document.querySelector("#projection"),
        elements: [...data.nodes, ...data.edges],
        wheelSensitivity: 0.18,
        style: [
          { selector: "node", style: {
            "background-color": "#2563eb",
            "border-color": "#bfdbfe",
            "border-width": 1,
            "color": "#e7ecff",
            "font-size": 9,
            "label": "data(label)",
            "text-outline-color": "#08111f",
            "text-outline-width": 3,
            "text-valign": "center",
            "text-halign": "center",
            "width": 34,
            "height": 34
          }},
          { selector: 'node[kind = "service"]', style: { "background-color": "#22c55e", "shape": "round-rectangle", "width": 92, "height": 38, "font-size": 11 }},
          { selector: 'node[kind = "endpoint"]', style: { "background-color": "#38bdf8", "shape": "hexagon" }},
          { selector: 'node[kind = "http_call"]', style: { "background-color": "#f59e0b", "shape": "vee" }},
          { selector: 'node[kind = "config_key"]', style: { "background-color": "#a78bfa", "shape": "diamond" }},
          { selector: "edge", style: {
            "curve-style": "bezier",
            "line-color": "#475569",
            "target-arrow-color": "#475569",
            "target-arrow-shape": "triangle",
            "width": 1.5,
            "label": "data(label)",
            "font-size": 7,
            "color": "#bfdbfe",
            "text-background-color": "#08111f",
            "text-background-opacity": 0.8,
            "text-background-padding": 2
          }},
          { selector: 'edge[kind = "consumes_endpoint"]', style: { "line-color": "#60a5fa", "target-arrow-color": "#60a5fa", "width": 2.4 }},
          { selector: ":selected", style: { "border-color": "#fef3c7", "border-width": 4, "line-color": "#fef3c7", "target-arrow-color": "#fef3c7" }}
        ],
        layout: layoutOptions.cose
      });
      cy.minZoom(0.18);
      cy.maxZoom(3.5);
      cy.on("tap", "node, edge", (event) => {
        const item = event.target.data();
        details.textContent = JSON.stringify(item, null, 2);
      });
      layoutMode.addEventListener("change", runProjectionLayout);
      readableZoom.addEventListener("click", setReadableViewport);
      fitGraph.addEventListener("click", fitVisibleGraph);
      filters.forEach((input) => input.addEventListener("change", applyProjectionFilters));
      applyProjectionFilters();
      setTimeout(setReadableViewport, 120);
      initialize3dProjection(data);
    }).catch((error) => {
      projectionSummary.textContent = "Projection failed";
      projection3dSummary.textContent = "3D projection failed";
      details.textContent = error.message;
      details3d.textContent = error.message;
    });

    function applyProjectionFilters() {
      if (!cy || !projectionData) return;
      const enabled = new Set(filters.filter((input) => input.checked).map((input) => input.value));
      cy.batch(() => {
        cy.nodes().forEach((node) => node.style("display", enabled.has(node.data("kind")) ? "element" : "none"));
        cy.edges().forEach((edge) => {
          const visible = edge.source().style("display") !== "none" && edge.target().style("display") !== "none";
          edge.style("display", visible ? "element" : "none");
        });
      });
    }

    function runProjectionLayout() {
      if (!cy) return;
      applyProjectionFilters();
      const visible = cy.elements().filter((element) => element.style("display") !== "none");
      visible.layout(layoutOptions[layoutMode.value] || layoutOptions.cose).run();
      setTimeout(setReadableViewport, 80);
    }

    function visibleElements() {
      return cy ? cy.elements().filter((element) => element.style("display") !== "none") : null;
    }

    function fitVisibleGraph() {
      const visible = visibleElements();
      if (!visible || visible.empty()) return;
      cy.fit(visible, 64);
    }

    function setReadableViewport() {
      if (!cy) return;
      const visible = visibleElements();
      if (!visible || visible.empty()) return;
      const services = visible.nodes('[kind = "service"]');
      const focus = services.nonempty() ? services : visible.nodes().slice(0, Math.min(12, visible.nodes().length));
      cy.center(focus);
      cy.zoom({
        level: Math.max(0.72, Math.min(1.15, cy.zoom())),
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 }
      });
    }

    function initialize3dProjection(data) {
      const colors = {
        service: "#22c55e",
        endpoint: "#38bdf8",
        http_call: "#f59e0b",
        config_key: "#a78bfa"
      };
      graph3dData = to3dData(data, enabled3dKinds());
      graph3d = ForceGraph3D()(graph3dElement)
        .backgroundColor("#030712")
        .width(graph3dElement.clientWidth)
        .height(graph3dElement.clientHeight)
        .graphData(graph3dData)
        .nodeAutoColorBy("kind")
        .nodeColor((node) => colors[node.kind] || "#93c5fd")
        .nodeLabel((node) => node.label)
        .nodeVal((node) => node.kind === "service" ? 10 : 3.8)
        .linkColor((link) => link.kind === "consumes_endpoint" ? "#60a5fa" : "#475569")
        .linkOpacity(0.42)
        .linkWidth((link) => link.kind === "consumes_endpoint" ? 1.8 : 0.7)
        .linkDirectionalArrowLength((link) => link.kind === "consumes_endpoint" ? 3.5 : 0)
        .linkDirectionalParticles((link) => link.kind === "consumes_endpoint" ? 1 : 0)
        .linkDirectionalParticleWidth(1.4)
        .onNodeClick((node) => {
          details3d.textContent = JSON.stringify(node, null, 2);
          const distance = 140;
          const distRatio = 1 + distance / Math.hypot(node.x || 1, node.y || 1, node.z || 1);
          graph3d.cameraPosition(
            { x: (node.x || 0) * distRatio, y: (node.y || 0) * distRatio, z: (node.z || 0) * distRatio },
            node,
            800
          );
        })
        .onLinkClick((link) => {
          details3d.textContent = JSON.stringify(link, null, 2);
        });
      graph3d.d3Force("charge").strength(-70);
      graph3d.d3Force("link").distance((link) => link.kind === "consumes_endpoint" ? 58 : 36);
      filters3d.forEach((input) => input.addEventListener("change", apply3dFilters));
      reheat3d.addEventListener("click", () => graph3d.d3ReheatSimulation());
      fit3d.addEventListener("click", () => graph3d.zoomToFit(800, 80));
      window.addEventListener("resize", () => {
        if (!graph3d) return;
        graph3d.width(graph3dElement.clientWidth).height(graph3dElement.clientHeight);
      });
      setTimeout(() => graph3d.zoomToFit(900, 80), 900);
    }

    function enabled3dKinds() {
      return new Set(filters3d.filter((input) => input.checked).map((input) => input.value));
    }

    function apply3dFilters() {
      if (!graph3d || !projectionData) return;
      graph3dData = to3dData(projectionData, enabled3dKinds());
      graph3d.graphData(graph3dData);
      projection3dSummary.textContent = graph3dData.nodes.length + " visible nodes · " + graph3dData.links.length + " visible relations";
      graph3d.d3ReheatSimulation();
    }

    function to3dData(data, enabledKinds) {
      const nodes = data.nodes
        .map((node) => ({ ...node.data }))
        .filter((node) => enabledKinds.has(node.kind));
      const nodeIds = new Set(nodes.map((node) => node.id));
      const links = data.edges
        .map((edge) => ({ ...edge.data }))
        .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
      return { nodes, links };
    }
  </script>
</body>
</html>`;
}
