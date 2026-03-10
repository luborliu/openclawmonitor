import fs from "node:fs";
import path from "node:path";

export interface MonitorState {
  consecutiveFailures: number;
  totalChecks: number;
  totalRecoveries: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastRecoveryAt?: string;
}

export interface LogEvent {
  timestamp: string;
  type: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
}

const DEFAULT_STATE: MonitorState = {
  consecutiveFailures: 0,
  totalChecks: 0,
  totalRecoveries: 0,
};

export function ensureDataDir(dataDir: string): string {
  const resolvedDataDir = path.resolve(dataDir);
  fs.mkdirSync(resolvedDataDir, { recursive: true });
  return resolvedDataDir;
}

export function loadState(dataDir: string): MonitorState {
  const statePath = getStatePath(dataDir);
  if (!fs.existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }

  const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<MonitorState>;
  const state: MonitorState = {
    consecutiveFailures: numberValue(parsed.consecutiveFailures),
    totalChecks: numberValue(parsed.totalChecks),
    totalRecoveries: numberValue(parsed.totalRecoveries),
  };

  if (typeof parsed.lastSuccessAt === "string") {
    state.lastSuccessAt = parsed.lastSuccessAt;
  }
  if (typeof parsed.lastFailureAt === "string") {
    state.lastFailureAt = parsed.lastFailureAt;
  }
  if (typeof parsed.lastRecoveryAt === "string") {
    state.lastRecoveryAt = parsed.lastRecoveryAt;
  }

  return state;
}

export function saveState(dataDir: string, state: MonitorState): void {
  fs.writeFileSync(getStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function appendEvent(dataDir: string, event: LogEvent): void {
  fs.appendFileSync(getEventsPath(dataDir), `${JSON.stringify(event)}\n`, "utf8");
}

export function readEvents(dataDir: string): LogEvent[] {
  const eventsPath = getEventsPath(dataDir);
  if (!fs.existsSync(eventsPath)) {
    return [];
  }

  return fs
    .readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEvent);
}

function getStatePath(dataDir: string): string {
  return path.join(dataDir, "state.json");
}

function getEventsPath(dataDir: string): string {
  return path.join(dataDir, "events.jsonl");
}

function numberValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
