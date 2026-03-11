import http from "node:http";
import path from "node:path";

import { saveConfig, type MonitorConfig, type RecoveryStep } from "./config";
import { installLaunchdService } from "./launchd";
import { runCheck, type RunOptions } from "./monitor";
import {
  getGatewayHealth,
  runGatewayRecoveryStep,
  type CollectorSnapshot,
  type GatewayHealthSnapshot,
  type GatewayProbeResult,
  type UsageCostSnapshot,
} from "./openclaw";
import { ensureDataDir, loadState, readEvents, readSnapshot, readUsageImports } from "./storage";

interface UsageSource {
  sourceId: string;
  label: string;
  category: string;
  collectedAt?: string;
  payload: UsageCostSnapshot;
}

interface SeriesPoint {
  bucket: string;
  value: number;
  total?: number;
  failed?: number;
  annotation?: string;
  success?: number;
  steps?: number;
}

interface UsageTrendSeries {
  category: string;
  label: string;
  points: SeriesPoint[];
}

interface EventPage {
  items: ReturnType<typeof readEvents>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

type DashboardAction = RecoveryStep | "check";

const ACTIONS: DashboardAction[] = ["check", "start", "stop", "restart", "install"];

export function startDashboardServer(options: RunOptions): http.Server {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && requestUrl.pathname === "/api/summary") {
      respondJson(response, buildDashboardData(options));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/events") {
      const page = positiveInteger(requestUrl.searchParams.get("page"), 1);
      const pageSize = positiveInteger(requestUrl.searchParams.get("pageSize"), 12);
      respondJson(
        response,
        buildEventPage(
          options,
          page,
          pageSize,
          requestUrl.searchParams.get("level"),
          requestUrl.searchParams.get("type"),
          requestUrl.searchParams.get("q"),
        ),
      );
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/config") {
      const body = await readJsonBody(request);
      try {
        const updatedConfig = applyConfigPatch(options, body ?? {});
        respondJson(response, {
          ok: true,
          config: buildUiConfig(updatedConfig),
          message: "Configuration saved and launchd schedule reloaded.",
        });
      } catch (error) {
        respondJson(
          response,
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          400,
        );
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/actions") {
      const body = await readJsonBody(request);
      const action = typeof body?.action === "string" ? body.action : "";
      if (!ACTIONS.includes(action as DashboardAction)) {
        respondJson(response, { ok: false, error: "Unsupported action" }, 400);
        return;
      }

      try {
        let stdout = "";
        let stderr = "";
        if (action === "check") {
          const exitCode = await runCheck(options);
          stdout = `One-time health check finished with exit code ${exitCode}.`;
        } else {
          const result = await runGatewayRecoveryStep(action as RecoveryStep, options.config.statusTimeoutMs);
          stdout = result.stdout.trim();
          stderr = result.stderr.trim();
        }
        const health = await getGatewayHealth(options.config.statusTimeoutMs);
        respondJson(response, {
          ok: true,
          action,
          stdout,
          stderr,
          health: {
            ok: health.ok,
            summary: health.summary,
          },
        });
      } catch (error) {
        respondJson(
          response,
          {
            ok: false,
            action,
            error: error instanceof Error ? error.message : String(error),
          },
          500,
        );
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
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
  const probe = readSnapshot<CollectorSnapshot<GatewayProbeResult>>(dataDir, "probe");
  const health = readSnapshot<CollectorSnapshot<GatewayHealthSnapshot>>(dataDir, "health");
  const usageSources = loadUsageSources(dataDir, options.config.usageImportDir);
  const now = Date.now();

  const checks24h = allEvents.filter(
    (event) =>
      (event.type === "health_check" || event.type === "health_check_error") &&
      Date.parse(event.timestamp) >= now - 24 * 60 * 60 * 1000,
  );
  const healthyChecks24h = checks24h.filter((event) => event.level === "info").length;
  const failures24h = checks24h.length - healthyChecks24h;
  const uptime24h = checks24h.length > 0 ? (healthyChecks24h / checks24h.length) * 100 : 100;
  const currentDowntimeMinutes = state.failureStreakStartedAt
    ? Math.max(0, Math.round((now - Date.parse(state.failureStreakStartedAt)) / 60_000))
    : 0;
  const usageByCategory = buildUsageByCategory(usageSources);
  const totalUsageCost = usageByCategory.reduce((sum, item) => sum + item.totalCost, 0);
  const totalUsageTokens = usageByCategory.reduce((sum, item) => sum + item.totalTokens, 0);
  const activeTarget = probe?.payload?.targets?.find((target) => target.active);
  const activeLatencyMs = activeTarget?.connect?.latencyMs ?? null;
  const sessionCount = activeTarget?.summary?.sessions?.count ?? health?.payload?.sessions?.count ?? 0;
  const connectedChannels = Object.values(health?.payload?.channels ?? {}).filter((channel) => channel.connected).length;

  return {
    generatedAt: new Date(now).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    state,
    config: buildUiConfig(options.config),
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
      healthTimeline: buildHealthTimeline(allEvents, 48),
      recoveryCadence: buildRecoverySeries(allEvents, 7),
      eventActivity: buildEventActivity(allEvents, 7),
      usageTrend: buildUsageTrend(usageSources, 14),
    },
    usageByCategory,
    actions: ACTIONS,
    eventTypes: listEventTypes(allEvents),
    latest: {
      probeCollectedAt: probe?.collectedAt,
      healthCollectedAt: health?.collectedAt,
    },
  };
}

function buildEventPage(
  options: RunOptions,
  page: number,
  pageSize: number,
  level: string | null,
  type: string | null,
  query: string | null,
): EventPage {
  const dataDir = ensureDataDir(path.resolve(options.config.dataDir));
  const search = query?.trim().toLowerCase() ?? "";
  const items = readEvents(dataDir)
    .filter((event) => (level ? event.level === level : true))
    .filter((event) => (type ? event.type === type : true))
    .filter((event) =>
      search.length > 0
        ? `${event.type} ${event.level} ${event.message}`.toLowerCase().includes(search)
        : true,
    )
    .slice()
    .reverse();
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize;

  return {
    items: items.slice(start, end),
    page: safePage,
    pageSize,
    total,
    totalPages,
  };
}

function listEventTypes(events: Array<{ type: string }>): string[] {
  return Array.from(new Set(events.map((event) => event.type))).sort();
}

function buildUiConfig(config: MonitorConfig): Record<string, number> {
  return {
    checkIntervalMinutes: config.checkIntervalMinutes,
    failureThreshold: config.failureThreshold,
    recoveryCooldownMinutes: config.recoveryCooldownMinutes,
    statusTimeoutMs: config.statusTimeoutMs,
  };
}

function applyConfigPatch(options: RunOptions, payload: Record<string, unknown>): MonitorConfig {
  const nextConfig: MonitorConfig = {
    ...options.config,
    checkIntervalMinutes: boundedNumber(payload.checkIntervalMinutes, options.config.checkIntervalMinutes, 1, 1440),
    failureThreshold: boundedNumber(payload.failureThreshold, options.config.failureThreshold, 1, 20),
    recoveryCooldownMinutes: boundedNumber(
      payload.recoveryCooldownMinutes,
      options.config.recoveryCooldownMinutes,
      0,
      1440,
    ),
    statusTimeoutMs: boundedNumber(payload.statusTimeoutMs, options.config.statusTimeoutMs, 1000, 120000),
  };

  saveConfig(options.configPath, nextConfig);
  options.config = nextConfig;

  if (process.platform === "darwin") {
    void installLaunchdService(options);
  }

  return nextConfig;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(value)));
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

function buildUsageByCategory(
  usageSources: UsageSource[],
): Array<{ category: string; totalCost: number; totalTokens: number; sources: number }> {
  const grouped = new Map<string, { totalCost: number; totalTokens: number; sources: number }>();

  for (const source of usageSources) {
    const current = grouped.get(source.category) ?? { totalCost: 0, totalTokens: 0, sources: 0 };
    current.totalCost += source.payload.totals?.totalCost ?? 0;
    current.totalTokens += source.payload.totals?.totalTokens ?? 0;
    current.sources += 1;
    grouped.set(source.category, current);
  }

  return Array.from(grouped.entries()).map(([category, value]) => ({ category, ...value }));
}

function buildRecoverySeries(events: Array<{ timestamp: string; type: string; level: string }>, days: number): SeriesPoint[] {
  const points = createDailyBuckets(days);
  const pointMap = new Map(points.map((point) => [point.bucket, point]));

  for (const event of events) {
    if (event.type !== "recovery_result" && event.type !== "recovery_step") {
      continue;
    }

    const bucket = localDateKey(event.timestamp);
    const point = pointMap.get(bucket);
    if (!point) {
      continue;
    }

    if (event.type === "recovery_step") {
      point.steps = (point.steps ?? 0) + 1;
    }
    if (event.type === "recovery_result") {
      point.success = (point.success ?? 0) + (event.level === "info" ? 1 : 0);
      point.failed = (point.failed ?? 0) + (event.level === "error" ? 1 : 0);
    }
    point.value = (point.steps ?? 0) + (point.success ?? 0) + (point.failed ?? 0);
    point.annotation = `${point.steps ?? 0} steps, ${point.success ?? 0} healthy completions, ${point.failed ?? 0} unhealthy completions`;
  }

  return points;
}

function buildHealthTimeline(
  events: Array<{ timestamp: string; type: string; level: string; message: string }>,
  hours: number,
): SeriesPoint[] {
  return events
    .filter((event) => event.type === "health_check" || event.type === "health_check_error")
    .slice(-hours)
    .map((event) => ({
      bucket: event.timestamp,
      value: event.level === "info" ? 1 : 0,
      total: 1,
      failed: event.level === "info" ? 0 : 1,
      annotation: event.message,
    }));
}

function buildEventActivity(
  events: Array<{ timestamp: string; type: string }>,
  days: number,
): Array<{ key: string; label: string; value: number; description: string }> {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  const counts = new Map<string, number>();

  for (const event of events) {
    if (Date.parse(event.timestamp) < threshold) {
      continue;
    }

    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }

  const descriptions: Record<string, string> = {
    health_check: "Routine health checks that completed",
    health_check_error: "Health checks that could not run cleanly",
    recovery_step: "Gateway commands executed during recovery",
    recovery_result: "Final recovery outcomes",
    collector_snapshot: "Successful collector snapshot writes",
    collector_error: "Collector failures",
    notification: "Alerts delivered to the local desktop",
  };

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, value]) => ({
      key,
      label: prettifyEventType(key),
      value,
      description: descriptions[key] ?? "Recorded dashboard event",
    }));
}

function buildUsageTrend(usageSources: UsageSource[], days: number): UsageTrendSeries[] {
  return usageSources.map((source) => {
    const points = createDailyBuckets(days);
    const pointMap = new Map(points.map((point) => [point.bucket, point]));

    for (const day of source.payload.daily ?? []) {
      if (!day.date) {
        continue;
      }

      const point = pointMap.get(day.date);
      if (!point) {
        continue;
      }

      point.value += day.totalCost ?? 0;
      point.annotation = `${source.label}: $${(day.totalCost ?? 0).toFixed(2)} on ${day.date}`;
    }

    return {
      category: source.category,
      label: source.label,
      points,
    };
  });
}

function createDailyBuckets(days: number): SeriesPoint[] {
  const buckets: SeriesPoint[] = [];
  const now = new Date();

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    buckets.push({
      bucket: localDateKey(date),
      value: 0,
    });
  }

  return buckets;
}

function localDateKey(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function prettifyEventType(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function positiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function respondJson(response: http.ServerResponse, payload: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
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
        --bg: #edf3ef;
        --panel: rgba(255,255,255,0.82);
        --ink: #122229;
        --muted: #5e6f77;
        --line: rgba(18,34,41,0.12);
        --accent: #0f766e;
        --accent-2: #2563eb;
        --good: #15803d;
        --warn: #b45309;
        --error: #b91c1c;
        --shadow: rgba(18,34,41,0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(15,118,110,0.16), transparent 24%),
          radial-gradient(circle at top right, rgba(37,99,235,0.12), transparent 18%),
          linear-gradient(180deg, #f8fbf9 0%, var(--bg) 100%);
      }
      main {
        max-width: 1360px;
        margin: 0 auto;
        padding: 26px 20px 52px;
      }
      .hero { margin-bottom: 18px; }
      .eyebrow {
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font: 600 12px/1.4 "SF Mono", "Menlo", monospace;
      }
      h1 {
        margin: 6px 0 8px;
        font-size: clamp(2.5rem, 5.4vw, 4.6rem);
        letter-spacing: -0.05em;
        line-height: 0.92;
      }
      .subtitle {
        max-width: 900px;
        color: var(--muted);
        font-size: 1.05rem;
      }
      .topbar {
        display: block;
        margin-top: 14px;
      }
      .meta {
        color: var(--muted);
        font: 600 12px/1.4 "SF Mono", "Menlo", monospace;
      }
      .meta strong {
        color: var(--ink);
      }
      .action-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .action-panel {
        padding: 16px 18px;
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(255,255,255,0.95), rgba(243,247,246,0.94));
        border: 1px solid rgba(18,34,41,0.08);
        box-shadow: 0 18px 40px var(--shadow);
      }
      .action-button {
        border: 0;
        padding: 10px 14px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent), #14958b);
        color: white;
        cursor: pointer;
        font: 600 12px/1 "SF Mono", "Menlo", monospace;
        box-shadow: 0 10px 22px rgba(15,118,110,0.18);
      }
      .action-button.secondary {
        background: linear-gradient(135deg, #475569, #64748b);
      }
      .action-button:disabled {
        opacity: 0.6;
        cursor: progress;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 14px;
        margin: 18px 0;
      }
      .layout {
        display: grid;
        grid-template-columns: 1.25fr 0.75fr;
        gap: 14px;
      }
      .stack {
        display: grid;
        gap: 14px;
      }
      .panel {
        background: linear-gradient(180deg, rgba(255,255,255,0.94), rgba(243,247,246,0.95));
        border: 1px solid rgba(18,34,41,0.08);
        border-radius: 24px;
        padding: 18px;
        box-shadow: 0 18px 40px var(--shadow);
      }
      .metric {
        font: 600 12px/1.4 "SF Mono", "Menlo", monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .value {
        margin-top: 8px;
        font-size: 2.2rem;
        font-weight: 700;
        letter-spacing: -0.04em;
      }
      .label {
        margin-top: 4px;
        color: var(--muted);
      }
      .status-box {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-top: 12px;
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
      .mini-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .mini-card {
        padding: 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.8);
        border: 1px solid rgba(18,34,41,0.08);
      }
      .mini-title {
        color: var(--muted);
        font: 600 11px/1.4 "SF Mono", "Menlo", monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .mini-value {
        margin-top: 8px;
        font-size: 1.3rem;
        font-weight: 700;
      }
      .chart-shell {
        margin-top: 14px;
        padding: 12px;
        border-radius: 20px;
        border: 1px solid rgba(18,34,41,0.08);
        background: linear-gradient(180deg, rgba(248,252,251,0.98), rgba(241,247,245,0.9));
      }
      .chart-help {
        margin-top: 10px;
        color: var(--muted);
        font-size: 13px;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        margin-top: 10px;
        color: var(--muted);
        font-size: 12px;
      }
      .legend span::before {
        content: "";
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        margin-right: 6px;
        background: var(--legend-color);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        font-family: "SF Mono", "Menlo", monospace;
        font-size: 12px;
      }
      .table th, .table td {
        padding: 10px 0;
        text-align: left;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      .pill {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(15,118,110,0.12);
        font: 600 11px/1 "SF Mono", "Menlo", monospace;
      }
      .muted { color: var(--muted); }
      .good { color: var(--good); }
      .warn { color: var(--warn); }
      .error { color: var(--error); }
      .events-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
      }
      .pager {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .pager button {
        border: 1px solid var(--line);
        background: white;
        border-radius: 999px;
        padding: 8px 12px;
        cursor: pointer;
        font: 600 11px/1 "SF Mono", "Menlo", monospace;
      }
      .tooltip {
        position: fixed;
        pointer-events: none;
        z-index: 20;
        max-width: 280px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(18,34,41,0.94);
        color: white;
        font-size: 12px;
        line-height: 1.45;
        box-shadow: 0 18px 36px rgba(0,0,0,0.2);
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .tooltip.visible {
        opacity: 1;
        transform: translateY(0);
      }
      .action-result {
        margin-top: 12px;
        font: 600 12px/1.5 "SF Mono", "Menlo", monospace;
        color: var(--muted);
        white-space: pre-wrap;
        min-height: 72px;
        padding: 12px;
        border-radius: 16px;
        background: rgba(255,255,255,0.78);
        border: 1px solid rgba(18,34,41,0.08);
        overflow-wrap: anywhere;
      }
      .controls-grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: 14px;
        margin-bottom: 14px;
      }
      .controls-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .field-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .field {
        display: grid;
        gap: 6px;
      }
      .field label {
        color: var(--muted);
        font: 600 11px/1.4 "SF Mono", "Menlo", monospace;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .field input, .field select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.85);
        color: var(--ink);
        font: 500 14px/1.3 "Avenir Next", "Segoe UI", sans-serif;
      }
      .filter-row {
        display: grid;
        grid-template-columns: 140px 180px 1fr;
        gap: 10px;
        align-items: end;
        margin-bottom: 12px;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.34);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 20px;
        z-index: 30;
      }
      .modal-backdrop.open {
        display: flex;
      }
      .modal {
        width: min(760px, 100%);
        background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(243,247,246,0.98));
        border: 1px solid rgba(18,34,41,0.08);
        border-radius: 26px;
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.18);
        padding: 20px;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .close-button {
        border: 1px solid rgba(18,34,41,0.1);
        background: white;
        border-radius: 999px;
        padding: 8px 12px;
        cursor: pointer;
        font: 600 11px/1 "SF Mono", "Menlo", monospace;
      }
      .availability-wrap {
        position: relative;
      }
      .availability-axis {
        display: flex;
        justify-content: space-between;
        margin-top: 8px;
        color: var(--muted);
        font: 600 10px/1.2 "SF Mono", "Menlo", monospace;
      }
      .bar-stack {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(44px, 1fr));
        gap: 10px;
        align-items: end;
        min-height: 216px;
      }
      .bar-col {
        display: grid;
        gap: 8px;
        justify-items: center;
        align-items: end;
      }
      .bar-stack-inner {
        width: 100%;
        max-width: 44px;
        height: 176px;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        gap: 3px;
      }
      .bar-seg {
        width: 100%;
        border-radius: 10px 10px 6px 6px;
      }
      .bar-seg.steps { background: linear-gradient(180deg, #cbd5e1, #94a3b8); }
      .bar-seg.ok { background: linear-gradient(180deg, #60a5fa, #2563eb); }
      .bar-seg.fail { background: linear-gradient(180deg, #fdba74, #d97706); }
      .bar-label {
        color: var(--muted);
        font: 600 10px/1.2 "SF Mono", "Menlo", monospace;
        text-align: center;
      }
      .chart-svg {
        width: 100%;
        height: 240px;
        display: block;
      }
      .chart-legend {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-top: 12px;
        color: var(--muted);
        font: 600 11px/1.3 "SF Mono", "Menlo", monospace;
      }
      .chart-legend span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .chart-legend i {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        display: inline-block;
      }
      @media (max-width: 1000px) {
        .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .layout { grid-template-columns: 1fr; }
        .mini-grid { grid-template-columns: 1fr; }
        .topbar { grid-template-columns: 1fr; }
        .controls-grid { grid-template-columns: 1fr; }
        .filter-row { grid-template-columns: 1fr; }
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
        <div class="subtitle">Everything is shown in your local time zone. Hover charts for annotations, page through recent events, and trigger gateway actions directly from this dashboard.</div>
        <div class="topbar">
          <div class="meta" id="meta"></div>
        </div>
      </section>

      <section id="summary" class="grid"></section>

      <section class="controls-grid">
        <div class="panel">
          <div class="controls-head">
            <div>
              <div class="metric">Monitor controls</div>
              <div class="label">Open config overrides only when you need them, to keep the dashboard compact.</div>
            </div>
            <button class="action-button secondary" id="openConfig" type="button">Override config</button>
          </div>
        </div>
        <div class="action-panel">
          <div class="metric">Quick actions</div>
          <div class="label">Run one-time checks or gateway commands without leaving the dashboard.</div>
          <div class="action-row" id="actions" style="margin-top:14px;"></div>
          <div class="action-result" id="actionResult"></div>
        </div>
      </section>

      <section class="layout">
        <div class="stack">
          <div class="panel">
            <div class="metric">System posture</div>
            <div id="posture"></div>
            <div class="mini-grid" id="secondary"></div>
          </div>
          <div class="panel">
            <div class="metric">Availability trend</div>
            <div class="chart-shell" id="healthTimeline"></div>
            <div class="chart-help">Line view of recent checks. High means healthy, low means unhealthy. Hover any point for the exact local timestamp and result.</div>
          </div>
          <div class="panel">
            <div class="metric">Daily usage cost</div>
            <div class="chart-shell" id="usageTrend"></div>
            <div class="chart-help">Daily bar view of total tracked cost across the last 14 local days. Hover a row for the exact day and amount.</div>
            <div class="legend" id="usageLegend"></div>
          </div>
        </div>

        <div class="stack">
          <div class="panel">
            <div class="metric">Recovery activity</div>
            <div class="chart-shell" id="recoveryBars"></div>
            <div class="chart-help">Daily recovery work in the last 7 local days. Gray is executed steps, blue is healthy completion, and amber is unhealthy completion.</div>
          </div>
          <div class="panel">
            <div class="metric">Event activity by type</div>
            <div class="chart-shell" id="eventActivity"></div>
            <div class="chart-help">This shows which kinds of monitor activity happened most often in the last 7 days. Hover each bar for a plain-English explanation.</div>
          </div>
          <div class="panel">
            <div class="metric">Usage by category</div>
            <table class="table" id="usage"></table>
          </div>
        </div>
      </section>

      <section class="panel" style="margin-top: 14px;">
        <div class="filter-row">
          <div class="field">
            <label for="levelFilter">Level</label>
            <select id="levelFilter">
              <option value="">All levels</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </div>
          <div class="field">
            <label for="typeFilter">Type</label>
            <select id="typeFilter">
              <option value="">All types</option>
            </select>
          </div>
          <div class="field">
            <label for="queryFilter">Message search</label>
            <input id="queryFilter" type="text" placeholder="Search event type or message" />
          </div>
        </div>
        <div class="events-toolbar">
          <div>
            <div class="metric">Recent events</div>
            <div class="muted" id="eventsMeta"></div>
          </div>
          <div class="pager">
            <button id="prevPage" type="button">Prev</button>
            <span id="pageLabel" class="muted"></span>
            <button id="nextPage" type="button">Next</button>
          </div>
        </div>
        <table class="table" id="events"></table>
      </section>
    </main>

    <div id="tooltip" class="tooltip"></div>
    <div id="configModal" class="modal-backdrop">
      <div class="modal">
        <div class="modal-head">
          <div>
            <div class="metric">Config override</div>
            <div class="label">Save monitor settings and reload the launchd schedule on macOS.</div>
          </div>
          <button class="close-button" id="closeConfig" type="button">Close</button>
        </div>
        <div class="field-grid">
          <div class="field">
            <label for="checkIntervalMinutes">Check interval (minutes)</label>
            <input id="checkIntervalMinutes" type="number" min="1" max="1440" />
          </div>
          <div class="field">
            <label for="failureThreshold">Failure threshold</label>
            <input id="failureThreshold" type="number" min="1" max="20" />
          </div>
          <div class="field">
            <label for="recoveryCooldownMinutes">Recovery cooldown (minutes)</label>
            <input id="recoveryCooldownMinutes" type="number" min="0" max="1440" />
          </div>
          <div class="field">
            <label for="statusTimeoutMs">Status timeout (ms)</label>
            <input id="statusTimeoutMs" type="number" min="1000" max="120000" step="1000" />
          </div>
        </div>
        <div class="action-row" style="margin-top:12px;">
          <button class="action-button" id="saveConfig" type="button">Save settings</button>
        </div>
        <div class="action-result" id="configResult"></div>
      </div>
    </div>

    <script>
      const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
      const number = new Intl.NumberFormat();
      const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
      const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
      const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric"
      });
      const hourFormatter = new Intl.DateTimeFormat(undefined, {
        hour: "numeric"
      });

      let currentPage = 1;
      let totalPages = 1;
      let refreshIntervalSeconds = 30;
      let refreshCountdown = refreshIntervalSeconds;
      let refreshTimer = null;
      let refreshBusy = false;
      let actionBusy = false;
      let configBusy = false;
      const eventFilters = { level: "", type: "", q: "" };
      let filterTimer = null;

      const tooltip = document.getElementById("tooltip");
      document.addEventListener("mouseover", (event) => {
        const target = event.target.closest("[data-tip]");
        if (!target) return;
        tooltip.innerHTML = target.getAttribute("data-tip");
        tooltip.classList.add("visible");
      });
      document.addEventListener("mousemove", (event) => {
        if (!tooltip.classList.contains("visible")) return;
        tooltip.style.left = event.clientX + 16 + "px";
        tooltip.style.top = event.clientY + 16 + "px";
      });
      document.addEventListener("mouseout", (event) => {
        const target = event.target.closest("[data-tip]");
        if (!target) return;
        tooltip.classList.remove("visible");
      });

      document.getElementById("prevPage").addEventListener("click", () => loadEvents(Math.max(1, currentPage - 1)));
      document.getElementById("nextPage").addEventListener("click", () => loadEvents(Math.min(totalPages, currentPage + 1)));
      document.getElementById("levelFilter").addEventListener("change", queueFilterUpdate);
      document.getElementById("typeFilter").addEventListener("change", queueFilterUpdate);
      document.getElementById("queryFilter").addEventListener("input", queueFilterUpdate);
      document.getElementById("saveConfig").addEventListener("click", saveSettings);
      document.getElementById("openConfig").addEventListener("click", () => document.getElementById("configModal").classList.add("open"));
      document.getElementById("closeConfig").addEventListener("click", () => document.getElementById("configModal").classList.remove("open"));
      document.getElementById("configModal").addEventListener("click", (event) => {
        if (event.target.id === "configModal") {
          document.getElementById("configModal").classList.remove("open");
        }
      });

      refreshDashboard({ page: 1, resetTimer: true });

      function renderSummary(data) {
        const overview = data.overview || {};
        const degraded = (data.state?.consecutiveFailures || 0) > 0;

        updateMeta(data.generatedAt, data.timezone);

        document.getElementById("summary").innerHTML = [
          metricCard("Gateway", degraded ? "Degraded" : "Healthy", degraded ? data.state.consecutiveFailures + " failed checks in a row" : "No active failure streak"),
          metricCard("24h uptime", percent(overview.uptime24h || 0), number.format(overview.checks24h || 0) + " checks sampled"),
          metricCard("Failures", number.format(overview.failures24h || 0), "24h failed checks"),
          metricCard("Recoveries", number.format(data.state.totalRecoveries || 0), "Automatic recoveries so far"),
          metricCard("Latency", overview.activeLatencyMs ? overview.activeLatencyMs + " ms" : "n/a", "Latest active probe target"),
          metricCard("Usage", money.format(overview.totalUsageCost || 0), compact.format(overview.totalUsageTokens || 0) + " tokens tracked")
        ].join("");

        document.getElementById("posture").innerHTML =
          "<div class='status-box'><span class='status-dot " + (degraded ? "error" : "") + "'></span><div><div class='value'>" +
          (degraded ? "Attention needed" : "Within operating target") +
          "</div><div class='label'>" +
          (degraded
            ? "Current downtime: " + number.format(overview.currentDowntimeMinutes || 0) + " minutes"
            : "Latest healthy state observed at " + formatDateTime(data.state?.lastSuccessAt || data.generatedAt)) +
          "</div></div></div>";

        document.getElementById("secondary").innerHTML = [
          miniCard("Sessions", number.format(overview.sessionCount || 0)),
          miniCard("Connected channels", number.format(overview.connectedChannels || 0)),
          miniCard("Collector snapshots", formatDateTime(data.latest?.healthCollectedAt || data.generatedAt))
        ].join("");

        document.getElementById("actions").innerHTML = (data.actions || []).map((action) => {
          const secondary = action === "install" || action === "stop" ? " secondary" : "";
          const label = action === "check" ? "CHECK NOW" : action.toUpperCase();
          return "<button class='action-button" + secondary + "' data-action='" + action + "' type='button'>" + label + "</button>";
        }).join("");
        document.querySelectorAll("[data-action]").forEach((button) => {
          button.addEventListener("click", () => runAction(button.getAttribute("data-action"), button));
        });

        document.getElementById("healthTimeline").innerHTML = renderHealthTimeline(data.charts?.healthTimeline || []);
        document.getElementById("recoveryBars").innerHTML = renderRecoveryBars(data.charts?.recoveryCadence || []);
        document.getElementById("eventActivity").innerHTML = renderEventActivity(data.charts?.eventActivity || []);
        document.getElementById("usageTrend").innerHTML = renderUsageTrend(data.charts?.usageTrend || []);
        document.getElementById("usageLegend").innerHTML = (data.charts?.usageTrend || []).map((series, index) => {
          return "<span style='--legend-color:" + palette(index) + ";'>" + series.label + "</span>";
        }).join("");

        document.getElementById("usage").innerHTML =
          "<thead><tr><th>Category</th><th>Cost</th><th>Tokens</th><th>Sources</th></tr></thead><tbody>" +
          (data.usageByCategory || []).map((item) => {
            return "<tr><td><span class='pill'>" + item.category + "</span></td><td>" + money.format(item.totalCost || 0) + "</td><td>" + number.format(item.totalTokens || 0) + "</td><td>" + number.format(item.sources || 0) + "</td></tr>";
          }).join("") +
          "</tbody>";

        setConfigInputs(data.config || {});
        setTypeFilterOptions(data.eventTypes || []);
      }

      function loadEvents(page) {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: "12"
        });
        if (eventFilters.level) params.set("level", eventFilters.level);
        if (eventFilters.type) params.set("type", eventFilters.type);
        if (eventFilters.q) params.set("q", eventFilters.q);
        return fetch("/api/events?" + params.toString())
          .then((response) => response.json())
          .then((payload) => {
            currentPage = payload.page;
            totalPages = payload.totalPages;
            document.getElementById("eventsMeta").textContent = payload.total + " total events";
            document.getElementById("pageLabel").textContent = "Page " + payload.page + " / " + payload.totalPages;
            document.getElementById("prevPage").disabled = payload.page <= 1;
            document.getElementById("nextPage").disabled = payload.page >= payload.totalPages;
            document.getElementById("events").innerHTML =
              "<thead><tr><th>When</th><th>Level</th><th>Type</th><th>Message</th></tr></thead><tbody>" +
              payload.items.map((event) => {
                const levelClass = event.level === "error" ? "error" : event.level === "warn" ? "warn" : "good";
                return "<tr><td>" + formatDateTime(event.timestamp) + "</td><td class='" + levelClass + "'>" + event.level + "</td><td>" + prettify(event.type) + "</td><td>" + event.message + "</td></tr>";
              }).join("") +
              "</tbody>";
            return payload;
          });
      }

      function runAction(action, button) {
        if (!action) return;
        actionBusy = true;
        document.querySelectorAll("[data-action]").forEach((node) => { node.disabled = true; });
        button.disabled = true;
        document.getElementById("actionResult").textContent = "Running " + action + "...";
        fetch("/api/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action })
        })
          .then((response) => response.json())
          .then((payload) => {
            const lines = payload.ok
              ? [
                  "Action: " + action,
                  "Health: " + (payload.health?.summary || "unknown"),
                  payload.stdout ? "stdout: " + payload.stdout : "",
                  payload.stderr ? "stderr: " + payload.stderr : ""
                ].filter(Boolean)
              : ["Action failed: " + (payload.error || "unknown error")];
            document.getElementById("actionResult").textContent = lines.join("\\n");
            return refreshDashboard({ page: 1, resetTimer: true });
          })
          .finally(() => {
            actionBusy = false;
            document.querySelectorAll("[data-action]").forEach((node) => { node.disabled = false; });
          });
      }

      function saveSettings() {
        configBusy = true;
        const button = document.getElementById("saveConfig");
        button.disabled = true;
        const payload = {
          checkIntervalMinutes: Number(document.getElementById("checkIntervalMinutes").value),
          failureThreshold: Number(document.getElementById("failureThreshold").value),
          recoveryCooldownMinutes: Number(document.getElementById("recoveryCooldownMinutes").value),
          statusTimeoutMs: Number(document.getElementById("statusTimeoutMs").value)
        };
        document.getElementById("configResult").textContent = "Saving settings...";
        fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then((response) => response.json())
          .then((result) => {
            document.getElementById("configResult").textContent = result.ok ? result.message : "Save failed: " + (result.error || "unknown error");
            if (result.ok) {
              document.getElementById("configModal").classList.remove("open");
            }
            return refreshDashboard({ page: currentPage || 1, resetTimer: true });
          })
          .finally(() => {
            configBusy = false;
            button.disabled = false;
          });
      }

      function refreshDashboard(options = {}) {
        if (refreshBusy || actionBusy || configBusy) {
          return Promise.resolve();
        }

        refreshBusy = true;
        const page = options.page || currentPage || 1;
        return Promise.all([
          fetch("/api/summary").then((response) => response.json()),
          loadEvents(page)
        ])
          .then(([summary]) => {
            renderSummary(summary);
            if (options.resetTimer) {
              resetRefreshTimer();
            }
          })
          .finally(() => {
            refreshBusy = false;
          });
      }

      function resetRefreshTimer() {
        refreshCountdown = refreshIntervalSeconds;
        updateMeta();
      }

      function ensureRefreshTimer() {
        if (refreshTimer) {
          return;
        }

        refreshTimer = window.setInterval(() => {
          if (actionBusy) {
            updateMeta();
            return;
          }

          refreshCountdown = Math.max(0, refreshCountdown - 1);
          updateMeta();

          if (refreshCountdown === 0) {
            refreshDashboard({ page: currentPage || 1, resetTimer: true });
          }
        }, 1000);
      }

      function updateMeta(generatedAtValue, timezoneValue) {
        const existingGeneratedAt = generatedAtValue || document.body.dataset.generatedAt || "";
        const existingTimezone = timezoneValue || document.body.dataset.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (generatedAtValue) {
          document.body.dataset.generatedAt = generatedAtValue;
        }
        if (timezoneValue) {
          document.body.dataset.timezone = timezoneValue;
        }

        const stateText = actionBusy
          ? "auto-refresh paused during action"
          : configBusy
          ? "auto-refresh paused during settings save"
          : "next refresh in " + refreshCountdown + "s";
        document.getElementById("meta").innerHTML =
          "Local zone: <strong>" + existingTimezone + "</strong>" +
          " | Last refresh: <strong>" + formatDateTime(existingGeneratedAt) + "</strong>" +
          " | " + stateText;
      }

      function metricCard(metric, value, label) {
        return "<article class='panel'><div class='metric'>" + metric + "</div><div class='value'>" + value + "</div><div class='label'>" + label + "</div></article>";
      }

      function queueFilterUpdate() {
        eventFilters.level = document.getElementById("levelFilter").value;
        eventFilters.type = document.getElementById("typeFilter").value;
        eventFilters.q = document.getElementById("queryFilter").value.trim();
        if (filterTimer) {
          window.clearTimeout(filterTimer);
        }
        filterTimer = window.setTimeout(() => loadEvents(1), 220);
      }

      function miniCard(label, value) {
        return "<article class='mini-card'><div class='mini-title'>" + label + "</div><div class='mini-value'>" + value + "</div></article>";
      }

      function renderHealthTimeline(points) {
        if (!points.length) return emptyChart("No health data yet");
        const width = 760;
        const height = 220;
        const xStep = points.length === 1 ? 0 : (width - 42) / (points.length - 1);
        const coords = points.map((point, index) => {
          const x = 22 + index * xStep;
          const y = point.value === 1 ? 34 : height - 42;
          return { x, y, point };
        });
        const polyline = coords.map((coord) => coord.x + "," + coord.y).join(" ");
        return "<div class='availability-wrap'><svg class='chart-svg' viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
          "<line x1='22' y1='34' x2='" + (width - 18) + "' y2='34' stroke='rgba(18,34,41,0.08)' stroke-dasharray='4 6'></line>" +
          "<line x1='22' y1='" + (height - 42) + "' x2='" + (width - 18) + "' y2='" + (height - 42) + "' stroke='rgba(18,34,41,0.08)' stroke-dasharray='4 6'></line>" +
          "<polyline points='" + polyline + "' fill='none' stroke='#2563eb' stroke-width='4' stroke-linejoin='round' stroke-linecap='round'></polyline>" +
          coords.map((coord) => {
            const tooltip = "<strong>" + formatDateTime(coord.point.bucket) + "</strong><br>" + (coord.point.value === 1 ? "Healthy" : "Unhealthy") + "<br>" + (coord.point.annotation || "");
            const fill = coord.point.value === 1 ? "#15803d" : "#b91c1c";
            return "<circle data-tip='" + escapeAttr(tooltip) + "' cx='" + coord.x + "' cy='" + coord.y + "' r='5' fill='" + fill + "' stroke='white' stroke-width='2'></circle>";
          }).join("") +
          "</svg><div class='availability-axis'><span>Down</span><span>Recent checks</span><span>Up</span></div></div>" +
          "<div class='chart-legend'><span><i style='background:#2563eb'></i>Availability line</span><span><i style='background:#15803d'></i>Healthy point</span><span><i style='background:#b91c1c'></i>Unhealthy point</span></div>";
      }

      function renderRecoveryBars(points) {
        if (!points.length || points.every((point) => point.value === 0)) return emptyChart("No recovery activity in the last 7 local days");
        const max = Math.max(...points.map((point) => (point.steps || 0) + (point.success || 0) + (point.failed || 0)), 1);
        return "<div class='bar-stack'>" + points.map((point) => {
          const steps = Math.round(((point.steps || 0) / max) * 160);
          const ok = Math.round(((point.success || 0) / max) * 160);
          const fail = Math.round(((point.failed || 0) / max) * 160);
          const tooltip = "<strong>" + formatShortDate(point.bucket) + "</strong><br>" + (point.annotation || "");
          return "<div class='bar-col' data-tip='" + escapeAttr(tooltip) + "'><div class='bar-stack-inner'>" +
            ((point.steps || 0) > 0 ? "<div class='bar-seg steps' style='height:" + Math.max(10, steps) + "px'></div>" : "") +
            ((point.success || 0) > 0 ? "<div class='bar-seg ok' style='height:" + Math.max(10, ok) + "px'></div>" : "") +
            ((point.failed || 0) > 0 ? "<div class='bar-seg fail' style='height:" + Math.max(10, fail) + "px'></div>" : "") +
            "</div><div class='bar-label'>" + formatShortDate(point.bucket) + "</div></div>";
        }).join("") + "</div>" +
          "<div class='chart-legend'><span><i style='background:#94a3b8'></i>Recovery steps</span><span><i style='background:#2563eb'></i>Healthy completion</span><span><i style='background:#d97706'></i>Unhealthy completion</span></div>";
      }

      function renderEventActivity(items) {
        if (!items.length) return emptyChart("No event activity yet");
        const max = Math.max(...items.map((item) => item.value), 1);
        return "<div>" + items.map((item, index) => {
          const width = Math.max(6, (item.value / max) * 100);
          const tooltip = "<strong>" + item.label + "</strong><br>" + item.description + "<br>Count: " + item.value;
          return "<div style='margin:12px 0;'><div style='display:flex; justify-content:space-between; gap:8px; margin-bottom:6px;'><span>" + item.label + "</span><span class='muted'>" + item.value + "</span></div>" +
            "<div data-tip='" + escapeAttr(tooltip) + "' style='height:14px; background:rgba(18,34,41,0.06); border-radius:999px; overflow:hidden;'><div style='height:100%; width:" + width + "%; background:" + palette(index) + "; border-radius:999px;'></div></div>" +
            "<div class='muted' style='margin-top:4px; font-size:12px;'>" + item.description + "</div></div>";
        }).join("") + "</div>";
      }

      function renderUsageTrend(seriesList) {
        if (!seriesList.length) return emptyChart("No usage data available");
        const merged = new Map();
        for (const series of seriesList) {
          for (const point of series.points) {
            merged.set(point.bucket, (merged.get(point.bucket) || 0) + point.value);
          }
        }
        const items = Array.from(merged.entries()).map(([bucket, value]) => ({ bucket, value }));
        const max = Math.max(...items.map((item) => item.value), 1);
        const width = 760;
        const height = 240;
        const slot = (width - 44) / items.length;
        const barWidth = Math.max(16, slot - 10);
        return "<svg class='chart-svg' viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
          items.map((item, index) => {
            const x = 24 + index * slot;
            const barHeight = (item.value / max) * 164;
            const y = height - 46 - barHeight;
            const tooltip = "<strong>" + formatShortDate(item.bucket) + "</strong><br>Total cost: " + money.format(item.value);
            return "<g><rect data-tip='" + escapeAttr(tooltip) + "' x='" + x + "' y='" + y + "' width='" + barWidth + "' height='" + barHeight + "' rx='10' fill='url(#usageGradient)'></rect>" +
              "<text x='" + (x + barWidth / 2) + "' y='" + (height - 18) + "' text-anchor='middle' fill='#5e6f77' font-size='10'>" + formatShortDate(item.bucket) + "</text></g>";
          }).join("") +
          "<defs><linearGradient id='usageGradient' x1='0' x2='0' y1='0' y2='1'><stop offset='0%' stop-color='#2563eb'/><stop offset='100%' stop-color='#0f766e'/></linearGradient></defs>" +
          "</svg>";
      }

      function emptyChart(label) {
        return "<div style='height:180px; display:grid; place-items:center; color:#5e6f77; font:600 12px/1.4 SF Mono, Menlo, monospace;'>" + label + "</div>";
      }

      function formatDateTime(value) {
        if (!value) return "n/a";
        return dateTimeFormatter.format(new Date(value));
      }

      function formatShortDate(value) {
        if (!value) return "n/a";
        return shortDateFormatter.format(new Date(value));
      }

      function formatHour(value) {
        if (!value) return "n/a";
        return hourFormatter.format(new Date(value));
      }

      function percent(value) {
        return value.toFixed(1) + "%";
      }

      function prettify(value) {
        return (value || "").split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
      }

      function palette(index) {
        const colors = ["#0f766e", "#2563eb", "#d97706", "#b91c1c", "#7c3aed", "#0891b2"];
        return colors[index % colors.length];
      }

      function escapeAttr(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      }

      function setConfigInputs(config) {
        document.getElementById("checkIntervalMinutes").value = config.checkIntervalMinutes ?? "";
        document.getElementById("failureThreshold").value = config.failureThreshold ?? "";
        document.getElementById("recoveryCooldownMinutes").value = config.recoveryCooldownMinutes ?? "";
        document.getElementById("statusTimeoutMs").value = config.statusTimeoutMs ?? "";
      }

      function setTypeFilterOptions(types) {
        const select = document.getElementById("typeFilter");
        const current = eventFilters.type;
        select.innerHTML = "<option value=''>All types</option>" + types.map((type) => {
          const selected = type === current ? " selected" : "";
          return "<option value='" + escapeAttr(type) + "'" + selected + ">" + prettify(type) + "</option>";
        }).join("");
      }

      ensureRefreshTimer();
    </script>
  </body>
</html>`;
}
