import fs from "node:fs";
import path from "node:path";

export type RecoveryStep = "install" | "restart" | "start" | "stop";

export interface MonitorConfig {
  checkIntervalMinutes: number;
  failureThreshold: number;
  recoveryCooldownMinutes: number;
  statusTimeoutMs: number;
  dataDir: string;
  recoverySteps: RecoveryStep[];
}

const DEFAULT_CONFIG: MonitorConfig = {
  checkIntervalMinutes: 5,
  failureThreshold: 3,
  recoveryCooldownMinutes: 15,
  statusTimeoutMs: 10_000,
  dataDir: "./data",
  recoverySteps: ["restart", "install", "restart"],
};

export function loadConfig(configPath?: string): { config: MonitorConfig; configPath: string } {
  const resolvedPath = path.resolve(configPath ?? "openclawmonitor.config.json");
  if (!fs.existsSync(resolvedPath)) {
    return { config: DEFAULT_CONFIG, configPath: resolvedPath };
  }

  const rawConfig = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as Partial<MonitorConfig>;
  const config: MonitorConfig = {
    checkIntervalMinutes: positiveNumber(rawConfig.checkIntervalMinutes, DEFAULT_CONFIG.checkIntervalMinutes),
    failureThreshold: positiveInteger(rawConfig.failureThreshold, DEFAULT_CONFIG.failureThreshold),
    recoveryCooldownMinutes: nonNegativeNumber(
      rawConfig.recoveryCooldownMinutes,
      DEFAULT_CONFIG.recoveryCooldownMinutes,
    ),
    statusTimeoutMs: positiveInteger(rawConfig.statusTimeoutMs, DEFAULT_CONFIG.statusTimeoutMs),
    dataDir: typeof rawConfig.dataDir === "string" ? rawConfig.dataDir : DEFAULT_CONFIG.dataDir,
    recoverySteps: sanitizeRecoverySteps(rawConfig.recoverySteps),
  };

  return { config, configPath: resolvedPath };
}

function sanitizeRecoverySteps(value: Partial<MonitorConfig>["recoverySteps"]): RecoveryStep[] {
  if (!Array.isArray(value)) {
    return DEFAULT_CONFIG.recoverySteps;
  }

  const validSteps = value.filter(
    (step): step is RecoveryStep =>
      step === "install" || step === "restart" || step === "start" || step === "stop",
  );

  return validSteps.length > 0 ? validSteps : DEFAULT_CONFIG.recoverySteps;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
