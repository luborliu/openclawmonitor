import fs from "node:fs";
import path from "node:path";

export type RecoveryStep = "install" | "restart" | "start" | "stop";

export interface NotificationConfig {
  enabled: boolean;
  title: string;
  downtimeAlertMinutes: number;
  repeatAlertMinutes: number;
}

export interface CollectorConfig {
  probe: boolean;
  health: boolean;
  usageCost: boolean;
  usageCostDays: number;
}

export interface LaunchdConfig {
  label: string;
  runAtLoad: boolean;
}

export interface MonitorConfig {
  checkIntervalMinutes: number;
  failureThreshold: number;
  recoveryCooldownMinutes: number;
  statusTimeoutMs: number;
  dataDir: string;
  openclawBin: string;
  dashboardPort: number;
  usageImportDir: string;
  usageGatewayCategory: string;
  notifications: NotificationConfig;
  collectors: CollectorConfig;
  launchd: LaunchdConfig;
  recoverySteps: RecoveryStep[];
}

const DEFAULT_CONFIG: MonitorConfig = {
  checkIntervalMinutes: 5,
  failureThreshold: 3,
  recoveryCooldownMinutes: 15,
  statusTimeoutMs: 10_000,
  dataDir: "./data",
  openclawBin: detectOpenClawBinary(),
  dashboardPort: 4317,
  usageImportDir: "./data/usage-imports",
  usageGatewayCategory: "gateway",
  notifications: {
    enabled: true,
    title: "OpenClaw Monitor",
    downtimeAlertMinutes: 15,
    repeatAlertMinutes: 30,
  },
  collectors: {
    probe: true,
    health: true,
    usageCost: true,
    usageCostDays: 30,
  },
  launchd: {
    label: "ai.openclaw.monitor",
    runAtLoad: true,
  },
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
    openclawBin:
      typeof rawConfig.openclawBin === "string" && rawConfig.openclawBin.trim().length > 0
        ? rawConfig.openclawBin
        : DEFAULT_CONFIG.openclawBin,
    dashboardPort: positiveInteger(rawConfig.dashboardPort, DEFAULT_CONFIG.dashboardPort),
    usageImportDir:
      typeof rawConfig.usageImportDir === "string" ? rawConfig.usageImportDir : DEFAULT_CONFIG.usageImportDir,
    usageGatewayCategory:
      typeof rawConfig.usageGatewayCategory === "string" && rawConfig.usageGatewayCategory.trim().length > 0
        ? rawConfig.usageGatewayCategory
        : DEFAULT_CONFIG.usageGatewayCategory,
    notifications: sanitizeNotifications(rawConfig.notifications),
    collectors: sanitizeCollectors(rawConfig.collectors),
    launchd: sanitizeLaunchd(rawConfig.launchd),
    recoverySteps: sanitizeRecoverySteps(rawConfig.recoverySteps),
  };

  return { config, configPath: resolvedPath };
}

export function saveConfig(configPath: string, config: MonitorConfig): void {
  const resolvedPath = path.resolve(configPath);
  fs.writeFileSync(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

function sanitizeNotifications(value: Partial<NotificationConfig> | undefined): NotificationConfig {
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : DEFAULT_CONFIG.notifications.enabled,
    title:
      typeof value?.title === "string" && value.title.trim().length > 0
        ? value.title
        : DEFAULT_CONFIG.notifications.title,
    downtimeAlertMinutes: nonNegativeNumber(
      value?.downtimeAlertMinutes,
      DEFAULT_CONFIG.notifications.downtimeAlertMinutes,
    ),
    repeatAlertMinutes: positiveNumber(value?.repeatAlertMinutes, DEFAULT_CONFIG.notifications.repeatAlertMinutes),
  };
}

function sanitizeCollectors(value: Partial<CollectorConfig> | undefined): CollectorConfig {
  return {
    probe: typeof value?.probe === "boolean" ? value.probe : DEFAULT_CONFIG.collectors.probe,
    health: typeof value?.health === "boolean" ? value.health : DEFAULT_CONFIG.collectors.health,
    usageCost: typeof value?.usageCost === "boolean" ? value.usageCost : DEFAULT_CONFIG.collectors.usageCost,
    usageCostDays: positiveInteger(value?.usageCostDays, DEFAULT_CONFIG.collectors.usageCostDays),
  };
}

function sanitizeLaunchd(value: Partial<LaunchdConfig> | undefined): LaunchdConfig {
  return {
    label:
      typeof value?.label === "string" && value.label.trim().length > 0 ? value.label : DEFAULT_CONFIG.launchd.label,
    runAtLoad: typeof value?.runAtLoad === "boolean" ? value.runAtLoad : DEFAULT_CONFIG.launchd.runAtLoad,
  };
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

function detectOpenClawBinary(): string {
  const candidates = [
    process.env.OPENCLAW_BIN,
    "/opt/homebrew/bin/openclaw",
    "/usr/local/bin/openclaw",
    "openclaw",
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (candidate === "openclaw" || fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "openclaw";
}
