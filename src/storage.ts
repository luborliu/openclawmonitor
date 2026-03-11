import fs from "node:fs";
import path from "node:path";

export interface MonitorState {
  consecutiveFailures: number;
  totalChecks: number;
  totalRecoveries: number;
  failureStreakStartedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastRecoveryAt?: string;
  lastDowntimeAlertAt?: string;
  lastRecoveryFailureAlertAt?: string;
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
  if (typeof parsed.failureStreakStartedAt === "string") {
    state.failureStreakStartedAt = parsed.failureStreakStartedAt;
  }
  if (typeof parsed.lastFailureAt === "string") {
    state.lastFailureAt = parsed.lastFailureAt;
  }
  if (typeof parsed.lastRecoveryAt === "string") {
    state.lastRecoveryAt = parsed.lastRecoveryAt;
  }
  if (typeof parsed.lastDowntimeAlertAt === "string") {
    state.lastDowntimeAlertAt = parsed.lastDowntimeAlertAt;
  }
  if (typeof parsed.lastRecoveryFailureAlertAt === "string") {
    state.lastRecoveryFailureAlertAt = parsed.lastRecoveryFailureAlertAt;
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

export function writeSnapshot(dataDir: string, name: string, payload: unknown): void {
  const snapshotDir = path.join(dataDir, "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function readSnapshot<T>(dataDir: string, name: string): T | null {
  const snapshotPath = path.join(dataDir, "snapshots", `${name}.json`);
  if (!fs.existsSync(snapshotPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as T;
}

export function readUsageImports(dataDir: string, importDir: string): unknown[] {
  const resolvedImportDir = path.resolve(importDir);
  if (!fs.existsSync(resolvedImportDir)) {
    fs.mkdirSync(resolvedImportDir, { recursive: true });
    return [];
  }

  return fs
    .readdirSync(resolvedImportDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(resolvedImportDir, entry), "utf8")) as unknown);
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
