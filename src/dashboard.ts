import http from "node:http";
import path from "node:path";

import type { RunOptions } from "./monitor";
import type {
  CollectorSnapshot,
  GatewayHealthSnapshot,
  GatewayProbeResult,
  UsageCostSnapshot,
} from "./openclaw";
import { ensureDataDir, loadState, readEvents, readSnapshot, readUsageImports } from "./storage";

interface UsageSource {
  sourceId: string;
  label: string;
  category: string;
  collectedAt?: string;
  payload: UsageCostSnapshot;
}

export function startDashboardServer(options: RunOptions): http.Server {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (requestUrl.pathname === "/api/summary") {
      respondJson(response, buildDashboardData(options));
      return;
    }

    if (requestUrl.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderHtml());
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  server.listen(options.config.dashboardPort, "127.0.0.1");
  return server;
}

function buildDashboardData(options: RunOptions): Record<string, unknown> {
  const dataDir = ensureDataDir(path.resolve(options.config.dataDir));
  const state = loadState(dataDir);
  const events = readEvents(dataDir).slice(-50).reverse();
  const probe = readSnapshot<CollectorSnapshot<GatewayProbeResult>>(dataDir, "probe");
  const health = readSnapshot<CollectorSnapshot<GatewayHealthSnapshot>>(dataDir, "health");
  const usageSources = loadUsageSources(dataDir, options.config.usageImportDir);

  const groupedUsage = new Map<string, { totalCost: number; totalTokens: number; sources: number }>();
  for (const source of usageSources) {
    const key = source.category;
    const current = groupedUsage.get(key) ?? { totalCost: 0, totalTokens: 0, sources: 0 };
    current.totalCost += source.payload.totals?.totalCost ?? 0;
    current.totalTokens += source.payload.totals?.totalTokens ?? 0;
    current.sources += 1;
    groupedUsage.set(key, current);
  }

  return {
    generatedAt: new Date().toISOString(),
    state,
    probe,
    health,
    usageSources,
    usageByCategory: Array.from(groupedUsage.entries()).map(([category, value]) => ({ category, ...value })),
    recentEvents: events,
  };
}

function loadUsageSources(dataDir: string, usageImportDir: string): UsageSource[] {
  const local = readSnapshot<CollectorSnapshot<UsageCostSnapshot>>(dataDir, "usage-cost");
  const imports = readUsageImports(dataDir, usageImportDir) as UsageSource[];
  return [...(local ? [normalizeUsageSource(local)] : []), ...imports.map(normalizeUsageSource)];
}

function normalizeUsageSource(value: CollectorSnapshot<UsageCostSnapshot> | UsageSource): UsageSource {
  const normalized: UsageSource = {
    sourceId: value.sourceId,
    label: value.label,
    category: value.category ?? "unclassified",
    payload: value.payload,
  };
  if (typeof value.collectedAt === "string") {
    normalized.collectedAt = value.collectedAt;
  }
  return normalized;
}

function respondJson(response: http.ServerResponse, payload: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenClaw Monitor</title>
    <style>
      :root {
        --bg: #f5efe3;
        --panel: rgba(255,255,255,0.72);
        --ink: #1f2a2e;
        --muted: #5b6b73;
        --line: rgba(31,42,46,0.12);
        --accent: #d9633b;
        --accent-2: #2f7f73;
        --warn: #b54708;
        --error: #b42318;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(217,99,59,0.22), transparent 28%),
          radial-gradient(circle at right, rgba(47,127,115,0.18), transparent 24%),
          linear-gradient(180deg, #fbf8f2 0%, var(--bg) 100%);
      }
      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .hero {
        display: grid;
        gap: 10px;
        margin-bottom: 24px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font: 600 12px/1.4 "SF Mono", "Menlo", monospace;
        color: var(--accent-2);
      }
      h1 {
        margin: 0;
        font-size: clamp(2.6rem, 6vw, 4.8rem);
        line-height: 0.95;
      }
      .subtitle {
        max-width: 760px;
        color: var(--muted);
        font-size: 1.05rem;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 18px;
        backdrop-filter: blur(12px);
        box-shadow: 0 18px 40px rgba(76, 58, 32, 0.08);
      }
      .metric {
        font: 600 12px/1.4 "SF Mono", "Menlo", monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .value {
        margin-top: 10px;
        font-size: 2rem;
      }
      .label {
        color: var(--muted);
      }
      .wide {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 14px;
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        font-family: "SF Mono", "Menlo", monospace;
        font-size: 12px;
      }
      .table td, .table th {
        padding: 10px 0;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      .pill {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        font: 600 11px/1 "SF Mono", "Menlo", monospace;
        background: rgba(47,127,115,0.12);
      }
      .warn { color: var(--warn); }
      .error { color: var(--error); }
      @media (max-width: 900px) {
        .wide { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">OpenClaw Monitor</div>
        <h1>Local gateway reliability cockpit</h1>
        <div class="subtitle">Health, restart history, collector snapshots, and usage-cost rollups from a single local dashboard.</div>
      </section>
      <section id="summary" class="grid"></section>
      <section class="wide">
        <div class="panel">
          <div class="metric">Recent events</div>
          <table class="table" id="events"></table>
        </div>
        <div class="panel">
          <div class="metric">Usage by category</div>
          <table class="table" id="usage"></table>
        </div>
      </section>
      <section class="panel" style="margin-top: 14px;">
        <div class="metric">Collector details</div>
        <pre id="details" style="white-space: pre-wrap; color: var(--muted); margin: 12px 0 0;"></pre>
      </section>
    </main>
    <script>
      const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
      const number = new Intl.NumberFormat();

      fetch("/api/summary")
        .then((response) => response.json())
        .then((data) => {
          const probeTarget = data.probe?.payload?.targets?.find((target) => target.active) || {};
          const healthChannels = data.health?.payload?.channels || {};
          const connectedChannels = Object.values(healthChannels).filter((channel) => channel.connected).length;
          const usageByCategory = data.usageByCategory || [];

          document.getElementById("summary").innerHTML = [
            card("Gateway", data.state.consecutiveFailures === 0 ? "Healthy" : "Degraded", data.state.consecutiveFailures === 0 ? "No active failure streak" : data.state.consecutiveFailures + " consecutive failures"),
            card("Recoveries", number.format(data.state.totalRecoveries || 0), "Automatic recovery runs"),
            card("Latency", probeTarget.connect?.latencyMs ? probeTarget.connect.latencyMs + " ms" : "n/a", "Active probe target"),
            card("Sessions", number.format(probeTarget.summary?.sessions?.count || data.health?.payload?.sessions?.count || 0), "Observed OpenClaw sessions"),
            card("Channels", number.format(connectedChannels), "Currently connected channels"),
            card("Usage sources", number.format((data.usageSources || []).length), "Gateway snapshot plus imported sources")
          ].join("");

          const eventsRows = (data.recentEvents || []).map((event) => {
            const levelClass = event.level === "error" ? "error" : event.level === "warn" ? "warn" : "";
            return "<tr><td>" + event.timestamp + "</td><td class='" + levelClass + "'>" + event.level + "</td><td>" + event.message + "</td></tr>";
          }).join("");
          document.getElementById("events").innerHTML = "<thead><tr><th>When</th><th>Level</th><th>Message</th></tr></thead><tbody>" + eventsRows + "</tbody>";

          const usageRows = usageByCategory.map((item) => {
            return "<tr><td><span class='pill'>" + item.category + "</span></td><td>" + money.format(item.totalCost || 0) + "</td><td>" + number.format(item.totalTokens || 0) + "</td><td>" + number.format(item.sources || 0) + "</td></tr>";
          }).join("");
          document.getElementById("usage").innerHTML = "<thead><tr><th>Category</th><th>Cost</th><th>Tokens</th><th>Sources</th></tr></thead><tbody>" + usageRows + "</tbody>";

          document.getElementById("details").textContent = JSON.stringify({
            probe: data.probe,
            health: data.health,
            usageSources: data.usageSources
          }, null, 2);
        });

      function card(metric, value, label) {
        return "<article class='panel'><div class='metric'>" + metric + "</div><div class='value'>" + value + "</div><div class='label'>" + label + "</div></article>";
      }
    </script>
  </body>
</html>`;
}
