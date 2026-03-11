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

interface DashboardPoint {
  label: string;
  value: number;
}

interface UsageTrendSeries {
  category: string;
  points: DashboardPoint[];
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
  const allEvents = readEvents(dataDir);
  const events = allEvents.slice(-50).reverse();
  const probe = readSnapshot<CollectorSnapshot<GatewayProbeResult>>(dataDir, "probe");
  const health = readSnapshot<CollectorSnapshot<GatewayHealthSnapshot>>(dataDir, "health");
  const usageSources = loadUsageSources(dataDir, options.config.usageImportDir);
  const now = Date.now();

  const groupedUsage = new Map<string, { totalCost: number; totalTokens: number; sources: number }>();
  for (const source of usageSources) {
    const key = source.category;
    const current = groupedUsage.get(key) ?? { totalCost: 0, totalTokens: 0, sources: 0 };
    current.totalCost += source.payload.totals?.totalCost ?? 0;
    current.totalTokens += source.payload.totals?.totalTokens ?? 0;
    current.sources += 1;
    groupedUsage.set(key, current);
  }

  const checks24h = allEvents.filter(
    (event) =>
      (event.type === "health_check" || event.type === "health_check_error") &&
      Date.parse(event.timestamp) >= now - 24 * 60 * 60 * 1000,
  );
  const healthyChecks24h = checks24h.filter((event) => event.level === "info").length;
  const failures24h = checks24h.length - healthyChecks24h;
  const uptime24h = checks24h.length > 0 ? (healthyChecks24h / checks24h.length) * 100 : 100;
  const recoveries7d = buildRecoverySeries(allEvents, 7);
  const healthTimeline = buildHealthTimeline(allEvents, 24);
  const eventTypeMix = buildEventTypeMix(allEvents, 7);
  const usageTrend = buildUsageTrend(usageSources, 14);
  const currentDowntimeMinutes = state.failureStreakStartedAt
    ? Math.max(0, Math.round((now - Date.parse(state.failureStreakStartedAt)) / 60_000))
    : 0;
  const totalUsageCost = usageSources.reduce((sum, source) => sum + (source.payload.totals?.totalCost ?? 0), 0);
  const totalUsageTokens = usageSources.reduce((sum, source) => sum + (source.payload.totals?.totalTokens ?? 0), 0);
  const activeTarget = probe?.payload?.targets?.find((target) => target.active);
  const activeLatencyMs = activeTarget?.connect?.latencyMs ?? null;
  const sessionCount = activeTarget?.summary?.sessions?.count ?? health?.payload?.sessions?.count ?? 0;
  const connectedChannels = Object.values(health?.payload?.channels ?? {}).filter((channel) => channel.connected).length;

  return {
    generatedAt: new Date(now).toISOString(),
    state,
    probe,
    health,
    usageSources,
    overview: {
      uptime24h,
      checks24h: checks24h.length,
      failures24h,
      currentDowntimeMinutes,
      totalUsageCost,
      totalUsageTokens,
      activeLatencyMs,
      sessionCount,
      connectedChannels,
    },
    charts: {
      recoveries7d,
      healthTimeline,
      eventTypeMix,
      usageTrend,
    },
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
        --bg: #eef3f1;
        --bg-2: #d9e4df;
        --panel: rgba(255,255,255,0.78);
        --ink: #102127;
        --muted: #52636a;
        --line: rgba(16,33,39,0.11);
        --accent: #0f766e;
        --accent-2: #d97706;
        --good: #15803d;
        --warn: #b45309;
        --error: #b91c1c;
        --shadow: rgba(16,33,39,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(15,118,110,0.18), transparent 24%),
          radial-gradient(circle at top right, rgba(217,119,6,0.14), transparent 18%),
          linear-gradient(180deg, #f8fbfa 0%, var(--bg) 52%, var(--bg-2) 100%);
      }
      main {
        max-width: 1320px;
        margin: 0 auto;
        padding: 28px 20px 56px;
      }
      .hero {
        display: grid;
        gap: 8px;
        margin-bottom: 18px;
      }
      .eyebrow {
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font: 600 12px/1.4 "SF Mono", "Menlo", monospace;
        color: var(--accent);
      }
      h1 {
        margin: 0;
        font-size: clamp(2.4rem, 5.4vw, 4.5rem);
        line-height: 0.92;
        letter-spacing: -0.04em;
      }
      .subtitle {
        max-width: 840px;
        color: var(--muted);
        font-size: 1.05rem;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid rgba(255,255,255,0.65);
        border-radius: 24px;
        padding: 18px;
        backdrop-filter: blur(12px);
        box-shadow: 0 18px 40px var(--shadow);
      }
      .metric {
        font: 600 12px/1.4 "SF Mono", "Menlo", monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .value {
        margin-top: 10px;
        font-size: 2.1rem;
        font-weight: 700;
        letter-spacing: -0.04em;
      }
      .label {
        color: var(--muted);
        margin-top: 4px;
      }
      .layout {
        display: grid;
        grid-template-columns: 1.2fr 0.8fr;
        gap: 14px;
      }
      .stack {
        display: grid;
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
        background: rgba(15,118,110,0.12);
      }
      .good { color: var(--good); }
      .warn { color: var(--warn); }
      .error { color: var(--error); }
      .chart {
        margin-top: 14px;
        border-radius: 18px;
        background: linear-gradient(180deg, rgba(255,255,255,0.62), rgba(255,255,255,0.28));
        border: 1px solid var(--line);
        padding: 12px;
      }
      .legend {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        margin-top: 10px;
        color: var(--muted);
        font-size: 12px;
      }
      .swatch {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        display: inline-block;
        margin-right: 6px;
      }
      .mini {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .mini .panel {
        padding: 14px;
        border-radius: 18px;
      }
      .micro {
        font-size: 11px;
        color: var(--muted);
        font-family: "SF Mono", "Menlo", monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .big-status {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 10px;
      }
      .status-dot {
        width: 14px;
        height: 14px;
        border-radius: 999px;
        background: var(--good);
        box-shadow: 0 0 0 8px rgba(21,128,61,0.12);
      }
      .status-dot.error {
        background: var(--error);
        box-shadow: 0 0 0 8px rgba(185,28,28,0.12);
      }
      @media (max-width: 900px) {
        .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .layout { grid-template-columns: 1fr; }
        .mini { grid-template-columns: 1fr; }
      }
      @media (max-width: 640px) {
        .grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">OpenClaw Monitor</div>
        <h1>Gateway control room</h1>
        <div class="subtitle">Metrics-first local observability for health, recovery, collector signals, and cost behavior. Built to answer the current state in one glance, then let you drill into the recent evidence.</div>
      </section>
      <section id="summary" class="grid"></section>
      <section class="layout">
        <div class="stack">
          <div class="panel">
            <div class="metric">System posture</div>
            <div id="posture"></div>
            <div class="mini" id="secondary"></div>
          </div>
          <div class="panel">
            <div class="metric">24h health timeline</div>
            <div class="chart" id="healthTimeline"></div>
            <div class="legend" id="healthLegend"></div>
          </div>
          <div class="panel">
            <div class="metric">Usage trend</div>
            <div class="chart" id="usageTrend"></div>
            <div class="legend" id="usageLegend"></div>
          </div>
        </div>
        <div class="stack">
          <div class="panel">
            <div class="metric">Recovery cadence</div>
            <div class="chart" id="recoveryBars"></div>
          </div>
          <div class="panel">
            <div class="metric">Signal mix</div>
            <div class="chart" id="signalMix"></div>
          </div>
          <div class="panel">
            <div class="metric">Usage by category</div>
            <table class="table" id="usage"></table>
          </div>
        </div>
      </section>
      <section class="panel" style="margin-top: 14px;">
        <div class="metric">Recent events</div>
        <table class="table" id="events"></table>
      </section>
    </main>
    <script>
      const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
      const number = new Intl.NumberFormat();

      fetch("/api/summary")
        .then((response) => response.json())
        .then((data) => {
          const usageByCategory = data.usageByCategory || [];
          const overview = data.overview || {};
          const healthTimeline = data.charts?.healthTimeline || [];
          const recoverySeries = data.charts?.recoveries7d || [];
          const signalMix = data.charts?.eventTypeMix || [];
          const usageTrend = data.charts?.usageTrend || [];
          const degraded = (data.state?.consecutiveFailures || 0) > 0;

          document.getElementById("summary").innerHTML = [
            card("Gateway", degraded ? "Degraded" : "Healthy", degraded ? data.state.consecutiveFailures + " failed checks in a row" : "No active failure streak"),
            card("24h uptime", percent(overview.uptime24h || 0), number.format(overview.checks24h || 0) + " checks sampled"),
            card("Recoveries", number.format(data.state.totalRecoveries || 0), number.format(recoverySeries.reduce((sum, point) => sum + point.value, 0)) + " in last 7d"),
            card("Latency", overview.activeLatencyMs ? overview.activeLatencyMs + " ms" : "n/a", "Latest active probe target"),
            card("Usage", money.format(overview.totalUsageCost || 0), compactNumber(overview.totalUsageTokens || 0) + " tokens tracked"),
            card("Sessions", number.format(overview.sessionCount || 0), number.format(overview.connectedChannels || 0) + " connected channels")
          ].join("");

          document.getElementById("posture").innerHTML =
            "<div class='big-status'><span class='status-dot " + (degraded ? "error" : "") + "'></span><div><div class='value'>" +
            (degraded ? "Recovery attention needed" : "System within target") +
            "</div><div class='label'>" +
            (degraded
              ? "Current downtime " + number.format(overview.currentDowntimeMinutes || 0) + " minutes"
              : "Gateway healthy at " + (data.generatedAt || "")) +
            "</div></div></div>";

          document.getElementById("secondary").innerHTML = [
            miniCard("Failed checks / 24h", number.format(overview.failures24h || 0)),
            miniCard("Usage sources", number.format((data.usageSources || []).length)),
            miniCard("Last success", relativeStamp(data.state?.lastSuccessAt))
          ].join("");

          document.getElementById("healthTimeline").innerHTML = areaChart(healthTimeline, {
            stroke: "#15803d",
            fill: "rgba(21,128,61,0.18)",
            empty: "No health data yet"
          });
          document.getElementById("healthLegend").innerHTML = [
            legend("#15803d", "Healthy checks"),
            legend("#b91c1c", "Failures"),
            legend("#0f766e", "Each point is one check")
          ].join("");

          document.getElementById("usageTrend").innerHTML = multiLineChart(usageTrend);
          document.getElementById("usageLegend").innerHTML = usageTrend.map((series, index) => legend(colorAt(index), series.category)).join("");

          document.getElementById("recoveryBars").innerHTML = barChart(recoverySeries, "#d97706", "No recoveries in the last 7 days");
          document.getElementById("signalMix").innerHTML = horizontalBars(signalMix);

          const eventsRows = (data.recentEvents || []).map((event) => {
            const levelClass = event.level === "error" ? "error" : event.level === "warn" ? "warn" : "";
            return "<tr><td>" + event.timestamp + "</td><td class='" + levelClass + "'>" + event.level + "</td><td>" + event.message + "</td></tr>";
          }).join("");
          document.getElementById("events").innerHTML = "<thead><tr><th>When</th><th>Level</th><th>Message</th></tr></thead><tbody>" + eventsRows + "</tbody>";

          const usageRows = usageByCategory.map((item) => {
            return "<tr><td><span class='pill'>" + item.category + "</span></td><td>" + money.format(item.totalCost || 0) + "</td><td>" + number.format(item.totalTokens || 0) + "</td><td>" + number.format(item.sources || 0) + "</td></tr>";
          }).join("");
          document.getElementById("usage").innerHTML = "<thead><tr><th>Category</th><th>Cost</th><th>Tokens</th><th>Sources</th></tr></thead><tbody>" + usageRows + "</tbody>";
        });

      function card(metric, value, label) {
        return "<article class='panel'><div class='metric'>" + metric + "</div><div class='value'>" + value + "</div><div class='label'>" + label + "</div></article>";
      }

      function miniCard(label, value) {
        return "<article class='panel'><div class='micro'>" + label + "</div><div class='value' style='font-size:1.35rem; margin-top:8px;'>" + value + "</div></article>";
      }

      function percent(value) {
        return value.toFixed(1) + "%";
      }

      function compactNumber(value) {
        return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
      }

      function relativeStamp(value) {
        if (!value) return "n/a";
        return new Date(value).toLocaleString();
      }

      function legend(color, label) {
        return "<span><span class='swatch' style='background:" + color + ";'></span>" + label + "</span>";
      }

      function areaChart(points, options) {
        if (!points.length) return emptyChart(options.empty || "No data");
        const width = 640;
        const height = 180;
        const max = Math.max(...points.map((point) => point.value), 1);
        const xStep = points.length === 1 ? 0 : (width - 32) / (points.length - 1);
        const coords = points.map((point, index) => {
          const x = 16 + index * xStep;
          const y = height - 20 - ((point.value / max) * (height - 44));
          return [x, y];
        });
        const line = coords.map((pair) => pair.join(",")).join(" ");
        const area = "16," + (height - 20) + " " + line + " " + (16 + (points.length - 1) * xStep) + "," + (height - 20);
        const dots = coords.map((pair, index) => {
          const point = points[index];
          const fill = point.value > 0.5 ? "#15803d" : "#b91c1c";
          return "<circle cx='" + pair[0] + "' cy='" + pair[1] + "' r='4' fill='" + fill + "'></circle>";
        }).join("");
        const labels = [points[0], points[Math.floor(points.length / 2)], points[points.length - 1]]
          .filter(Boolean)
          .map((point, index, arr) => {
            const x = index === 0 ? 16 : index === arr.length - 1 ? width - 60 : width / 2 - 18;
            return "<text x='" + x + "' y='" + (height - 2) + "' fill='#52636a' font-size='11'>" + point.label + "</text>";
          })
          .join("");
        return "<svg viewBox='0 0 " + width + " " + height + "' width='100%' height='180' preserveAspectRatio='none'>" +
          "<polygon points='" + area + "' fill='" + options.fill + "'></polygon>" +
          "<polyline points='" + line + "' fill='none' stroke='" + options.stroke + "' stroke-width='3' stroke-linecap='round'></polyline>" +
          dots + labels +
          "</svg>";
      }

      function barChart(points, color, emptyLabel) {
        if (!points.length || points.every((point) => point.value === 0)) return emptyChart(emptyLabel);
        const width = 420;
        const height = 200;
        const max = Math.max(...points.map((point) => point.value), 1);
        const barWidth = Math.max(18, Math.floor((width - 30) / points.length) - 8);
        return "<svg viewBox='0 0 " + width + " " + height + "' width='100%' height='200'>" +
          points.map((point, index) => {
            const x = 18 + index * ((width - 30) / points.length);
            const barHeight = (point.value / max) * 132;
            const y = height - 38 - barHeight;
            return "<g><rect x='" + x + "' y='" + y + "' width='" + barWidth + "' height='" + barHeight + "' rx='8' fill='" + color + "' opacity='0.88'></rect>" +
              "<text x='" + (x + barWidth / 2) + "' y='" + (height - 18) + "' text-anchor='middle' fill='#52636a' font-size='10'>" + point.label + "</text>" +
              "<text x='" + (x + barWidth / 2) + "' y='" + (y - 6) + "' text-anchor='middle' fill='#102127' font-size='11'>" + point.value + "</text></g>";
          }).join("") +
          "</svg>";
      }

      function horizontalBars(points) {
        if (!points.length) return emptyChart("No event data yet");
        const max = Math.max(...points.map((point) => point.value), 1);
        return "<div>" + points.map((point, index) => {
          const pct = Math.max(4, (point.value / max) * 100);
          return "<div style='margin:10px 0;'><div style='display:flex; justify-content:space-between; font:600 11px/1.4 SF Mono, Menlo, monospace; color:#52636a;'><span>" + point.label + "</span><span>" + point.value + "</span></div>" +
            "<div style='height:12px; background:rgba(16,33,39,0.06); border-radius:999px; overflow:hidden;'><div style='height:100%; width:" + pct + "%; background:" + colorAt(index) + "; border-radius:999px;'></div></div></div>";
        }).join("") + "</div>";
      }

      function multiLineChart(seriesList) {
        if (!seriesList.length) return emptyChart("No usage series available");
        const width = 640;
        const height = 220;
        const allPoints = seriesList.flatMap((series) => series.points);
        const max = Math.max(...allPoints.map((point) => point.value), 1);
        const longest = Math.max(...seriesList.map((series) => series.points.length), 1);
        const xStep = longest === 1 ? 0 : (width - 40) / (longest - 1);
        const lines = seriesList.map((series, index) => {
          const color = colorAt(index);
          const coords = series.points.map((point, pointIndex) => {
            const x = 20 + pointIndex * xStep;
            const y = height - 28 - ((point.value / max) * (height - 52));
            return [x, y];
          });
          return "<polyline points='" + coords.map((pair) => pair.join(",")).join(" ") + "' fill='none' stroke='" + color + "' stroke-width='3' stroke-linecap='round'></polyline>" +
            coords.map((pair) => "<circle cx='" + pair[0] + "' cy='" + pair[1] + "' r='3.5' fill='" + color + "'></circle>").join("");
        }).join("");
        const labels = (seriesList[0]?.points || [])
          .filter((_, index, arr) => index === 0 || index === arr.length - 1 || index === Math.floor(arr.length / 2))
          .map((point, index, arr) => {
            const x = index === 0 ? 18 : index === arr.length - 1 ? width - 44 : width / 2 - 12;
            return "<text x='" + x + "' y='" + (height - 6) + "' fill='#52636a' font-size='11'>" + point.label + "</text>";
          }).join("");
        return "<svg viewBox='0 0 " + width + " " + height + "' width='100%' height='220' preserveAspectRatio='none'>" + lines + labels + "</svg>";
      }

      function emptyChart(label) {
        return "<div style='height:180px; display:grid; place-items:center; color:#52636a; font:600 12px/1.4 SF Mono, Menlo, monospace;'>" + label + "</div>";
      }

      function colorAt(index) {
        const palette = ["#0f766e", "#d97706", "#2563eb", "#b91c1c", "#7c3aed", "#0891b2"];
        return palette[index % palette.length];
      }
    </script>
  </body>
</html>`;
}

function buildRecoverySeries(events: Array<{ timestamp: string; type: string }>, days: number): DashboardPoint[] {
  const points = createDailyBuckets(days);
  const pointMap = new Map(points.map((point) => [point.label, point]));

  for (const event of events) {
    if (event.type !== "recovery_result") {
      continue;
    }
    const label = isoDate(event.timestamp);
    const point = pointMap.get(label);
    if (point) {
      point.value += 1;
    }
  }

  return points;
}

function buildHealthTimeline(
  events: Array<{ timestamp: string; type: string; level: string }>,
  hours: number,
): DashboardPoint[] {
  const now = Date.now();
  const points: DashboardPoint[] = [];

  for (let offset = hours - 1; offset >= 0; offset -= 1) {
    const from = now - (offset + 1) * 60 * 60 * 1000;
    const to = now - offset * 60 * 60 * 1000;
    const bucket = events.filter(
      (event) =>
        (event.type === "health_check" || event.type === "health_check_error") &&
        Date.parse(event.timestamp) >= from &&
        Date.parse(event.timestamp) < to,
    );

    let value = 0;
    if (bucket.length > 0) {
      value = bucket.some((event) => event.level === "info") ? 1 : 0;
    }

    points.push({
      label: new Date(to).toLocaleTimeString([], { hour: "numeric" }),
      value,
    });
  }

  return points;
}

function buildEventTypeMix(
  events: Array<{ timestamp: string; type: string }>,
  days: number,
): DashboardPoint[] {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  const counts = new Map<string, number>();

  for (const event of events) {
    if (Date.parse(event.timestamp) < threshold) {
      continue;
    }
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({ label, value }));
}

function buildUsageTrend(usageSources: UsageSource[], days: number): UsageTrendSeries[] {
  return usageSources.map((source) => {
    const buckets = createDailyBuckets(days);
    const pointMap = new Map(buckets.map((point) => [point.label, point]));

    for (const day of source.payload.daily ?? []) {
      if (!day.date) {
        continue;
      }
      const point = pointMap.get(day.date);
      if (point) {
        point.value += day.totalCost ?? 0;
      }
    }

    return {
      category: source.category,
      points: buckets,
    };
  });
}

function createDailyBuckets(days: number): DashboardPoint[] {
  const buckets: DashboardPoint[] = [];
  const now = new Date();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    buckets.push({
      label: date.toISOString().slice(0, 10),
      value: 0,
    });
  }

  return buckets;
}

function isoDate(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}
