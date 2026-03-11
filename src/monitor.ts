import path from "node:path";

import type { MonitorConfig } from "./config";
import {
  getGatewayHealth,
  getGatewayHealthSnapshot,
  getGatewayProbe,
  getGatewayUsageCost,
  runGatewayRecoveryStep,
  type CollectorSnapshot,
  type GatewayHealthSnapshot,
  type GatewayProbeResult,
  type UsageCostSnapshot,
} from "./openclaw";
import { sendNotification } from "./notifier";
import {
  appendEvent,
  ensureDataDir,
  loadState,
  readEvents,
  saveState,
  writeSnapshot,
  type LogEvent,
} from "./storage";

export interface RunOptions {
  config: MonitorConfig;
  configPath: string;
}

export async function runCheck(options: RunOptions): Promise<number> {
  const dataDir = ensureDataDir(path.resolve(options.config.dataDir));
  const state = loadState(dataDir);
  state.totalChecks += 1;

  let shouldPersistState = true;

  try {
    const health = await getGatewayHealth(options.config.statusTimeoutMs);
    const now = new Date().toISOString();

    if (health.ok) {
      state.consecutiveFailures = 0;
      delete state.failureStreakStartedAt;
      state.lastSuccessAt = now;
      appendAndPrint(dataDir, {
        timestamp: now,
        type: "health_check",
        level: "info",
        message: `Gateway healthy: ${health.summary}`,
        details: {
          command: health.command.join(" "),
          probeUrl: health.status?.gateway?.probeUrl ?? health.status?.rpc?.url,
        },
      });
      await collectSnapshots(dataDir, options);
      saveState(dataDir, state);
      return 0;
    }

    state.consecutiveFailures += 1;
    state.failureStreakStartedAt ??= now;
    state.lastFailureAt = now;
    appendAndPrint(dataDir, {
      timestamp: now,
      type: "health_check",
      level: "warn",
      message: `Gateway unhealthy: ${health.summary}`,
      details: {
        consecutiveFailures: state.consecutiveFailures,
        command: health.command.join(" "),
        },
      });

    await maybeSendDowntimeNotification(dataDir, state, options, now);

    if (shouldAttemptRecovery(state, options.config, now)) {
      const recoveryResult = await attemptRecovery(dataDir, options, state);
      saveState(dataDir, recoveryResult.state);
      return recoveryResult.exitCode;
    }

    saveState(dataDir, state);
    return 1;
  } catch (error) {
    const now = new Date().toISOString();
    state.consecutiveFailures += 1;
    state.failureStreakStartedAt ??= now;
    state.lastFailureAt = now;

    appendAndPrint(dataDir, {
      timestamp: now,
      type: "health_check_error",
      level: "error",
      message: "Failed to execute gateway health check",
      details: {
        consecutiveFailures: state.consecutiveFailures,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    await maybeSendDowntimeNotification(dataDir, state, options, now);

    if (shouldAttemptRecovery(state, options.config, now)) {
      const recoveryResult = await attemptRecovery(dataDir, options, state);
      saveState(dataDir, recoveryResult.state);
      shouldPersistState = false;
      return recoveryResult.exitCode;
    }

    if (shouldPersistState) {
      saveState(dataDir, state);
    }
    return 1;
  }
}

export async function runWatch(options: RunOptions): Promise<void> {
  await runCheck(options);

  const intervalMs = options.config.checkIntervalMinutes * 60_000;
  setInterval(() => {
    void runCheck(options);
  }, intervalMs);
}

export function buildReport(options: RunOptions): string {
  const dataDir = ensureDataDir(path.resolve(options.config.dataDir));
  const state = loadState(dataDir);
  const events = readEvents(dataDir);
  const unhealthyChecks = events.filter((event) => event.type === "health_check" && event.level !== "info").length;
  const recoveryAttempts = events.filter((event) => event.type === "recovery_step").length;
  const lastTen = events.slice(-10);

  return [
    `Config: ${options.configPath}`,
    `Data directory: ${dataDir}`,
    `Total checks: ${state.totalChecks}`,
    `Consecutive failures: ${state.consecutiveFailures}`,
    `Total recoveries: ${state.totalRecoveries}`,
    `Unhealthy checks logged: ${unhealthyChecks}`,
    `Recovery steps executed: ${recoveryAttempts}`,
    `Last success: ${state.lastSuccessAt ?? "never"}`,
    `Last failure: ${state.lastFailureAt ?? "never"}`,
    `Last recovery: ${state.lastRecoveryAt ?? "never"}`,
    "",
    "Recent events:",
    ...lastTen.map((event) => `${event.timestamp} [${event.level}] ${event.type} ${event.message}`),
  ].join("\n");
}

export async function runCollectorsOnly(options: RunOptions): Promise<number> {
  const dataDir = ensureDataDir(path.resolve(options.config.dataDir));
  await collectSnapshots(dataDir, options);
  return 0;
}

async function attemptRecovery(
  dataDir: string,
  options: RunOptions,
  state: ReturnType<typeof loadState>,
): Promise<{ state: ReturnType<typeof loadState>; exitCode: number }> {
  const startedAt = new Date().toISOString();

  for (const step of options.config.recoverySteps) {
    try {
      const result = await runGatewayRecoveryStep(step, options.config.statusTimeoutMs);
      appendAndPrint(dataDir, {
        timestamp: new Date().toISOString(),
        type: "recovery_step",
        level: "warn",
        message: `Executed recovery step: ${step}`,
        details: {
          command: result.command.join(" "),
          stdout: cleanOutput(result.stdout),
          stderr: cleanOutput(result.stderr),
        },
      });
    } catch (error) {
      appendAndPrint(dataDir, {
        timestamp: new Date().toISOString(),
        type: "recovery_step_error",
        level: "error",
        message: `Recovery step failed: ${step}`,
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      state.lastRecoveryAt = startedAt;
      state.totalRecoveries += 1;
      return { state, exitCode: 1 };
    }
  }

  state.lastRecoveryAt = startedAt;
  state.totalRecoveries += 1;

  const verification = await getGatewayHealth(options.config.statusTimeoutMs);
  if (verification.ok) {
    state.consecutiveFailures = 0;
    delete state.failureStreakStartedAt;
    state.lastSuccessAt = new Date().toISOString();
    appendAndPrint(dataDir, {
      timestamp: new Date().toISOString(),
      type: "recovery_result",
      level: "info",
      message: "Recovery completed and gateway is healthy again",
      details: {
        summary: verification.summary,
      },
    });
    await collectSnapshots(dataDir, options);
    return { state, exitCode: 0 };
  }

  appendAndPrint(dataDir, {
    timestamp: new Date().toISOString(),
    type: "recovery_result",
    level: "error",
    message: "Recovery ran but gateway is still unhealthy",
    details: {
      summary: verification.summary,
    },
  });

  await maybeSendRecoveryFailureNotification(dataDir, state, options, verification.summary);

  return { state, exitCode: 1 };
}

function shouldAttemptRecovery(state: ReturnType<typeof loadState>, config: MonitorConfig, nowIso: string): boolean {
  if (state.consecutiveFailures < config.failureThreshold) {
    return false;
  }

  if (!state.lastRecoveryAt) {
    return true;
  }

  const elapsedMs = Date.parse(nowIso) - Date.parse(state.lastRecoveryAt);
  return elapsedMs >= config.recoveryCooldownMinutes * 60_000;
}

function appendAndPrint(dataDir: string, event: LogEvent): void {
  appendEvent(dataDir, event);
  const prefix = event.level.toUpperCase();
  console.log(`${event.timestamp} ${prefix} ${event.message}`);
}

function cleanOutput(output: string): string | undefined {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function collectSnapshots(dataDir: string, options: RunOptions): Promise<void> {
  const tasks: Array<Promise<void>> = [];

  if (options.config.collectors.probe) {
    tasks.push(
      collectOne<GatewayProbeResult>(dataDir, "probe", {
        sourceId: "openclaw-gateway-probe",
        label: "OpenClaw Gateway Probe",
        payload: awaitable(() => getGatewayProbe(options.config.statusTimeoutMs)),
      }),
    );
  }

  if (options.config.collectors.health) {
    tasks.push(
      collectOne<GatewayHealthSnapshot>(dataDir, "health", {
        sourceId: "openclaw-gateway-health",
        label: "OpenClaw Gateway Health",
        payload: awaitable(() => getGatewayHealthSnapshot(options.config.statusTimeoutMs)),
      }),
    );
  }

  if (options.config.collectors.usageCost) {
    tasks.push(
      collectOne<UsageCostSnapshot>(dataDir, "usage-cost", {
        sourceId: "openclaw-gateway-usage-cost",
        label: "OpenClaw Gateway Usage Cost",
        category: options.config.usageGatewayCategory,
        payload: awaitable(() =>
          getGatewayUsageCost(options.config.statusTimeoutMs, options.config.collectors.usageCostDays),
        ),
      }),
    );
  }

  await Promise.all(tasks);
}

async function collectOne<T>(
  dataDir: string,
  name: string,
  input: {
    sourceId: string;
    label: string;
    category?: string;
    payload: Promise<T>;
  },
): Promise<void> {
  try {
    const payload = await input.payload;
    const snapshot: CollectorSnapshot<T> = {
      collectedAt: new Date().toISOString(),
      sourceId: input.sourceId,
      label: input.label,
      payload,
    };
    if (input.category) {
      snapshot.category = input.category;
    }
    writeSnapshot(dataDir, name, snapshot);
    appendAndPrint(dataDir, {
      timestamp: snapshot.collectedAt,
      type: "collector_snapshot",
      level: "info",
      message: `Collected ${name} snapshot`,
    });
  } catch (error) {
    appendAndPrint(dataDir, {
      timestamp: new Date().toISOString(),
      type: "collector_error",
      level: "error",
      message: `Failed to collect ${name} snapshot`,
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function maybeSendDowntimeNotification(
  dataDir: string,
  state: ReturnType<typeof loadState>,
  options: RunOptions,
  nowIso: string,
): Promise<void> {
  if (!options.config.notifications.enabled || !state.failureStreakStartedAt) {
    return;
  }

  const downtimeMinutes = (Date.parse(nowIso) - Date.parse(state.failureStreakStartedAt)) / 60_000;
  if (downtimeMinutes < options.config.notifications.downtimeAlertMinutes) {
    return;
  }

  if (state.lastDowntimeAlertAt) {
    const minutesSinceAlert = (Date.parse(nowIso) - Date.parse(state.lastDowntimeAlertAt)) / 60_000;
    if (minutesSinceAlert < options.config.notifications.repeatAlertMinutes) {
      return;
    }
  }

  await sendNotification(
    options.config.notifications,
    "Gateway downtime",
    `OpenClaw has been unhealthy for ${Math.round(downtimeMinutes)} minutes.`,
  );
  state.lastDowntimeAlertAt = nowIso;
  appendAndPrint(dataDir, {
    timestamp: nowIso,
    type: "notification",
    level: "warn",
    message: `Sent downtime alert after ${Math.round(downtimeMinutes)} minutes`,
  });
}

async function maybeSendRecoveryFailureNotification(
  dataDir: string,
  state: ReturnType<typeof loadState>,
  options: RunOptions,
  summary: string,
): Promise<void> {
  if (!options.config.notifications.enabled) {
    return;
  }

  const nowIso = new Date().toISOString();
  if (state.lastRecoveryFailureAlertAt) {
    const minutesSinceAlert = (Date.parse(nowIso) - Date.parse(state.lastRecoveryFailureAlertAt)) / 60_000;
    if (minutesSinceAlert < options.config.notifications.repeatAlertMinutes) {
      return;
    }
  }

  await sendNotification(
    options.config.notifications,
    "Recovery failed",
    `OpenClaw is still unhealthy after recovery steps. ${summary}`,
  );
  state.lastRecoveryFailureAlertAt = nowIso;
  appendAndPrint(dataDir, {
    timestamp: nowIso,
    type: "notification",
    level: "error",
    message: "Sent recovery failure alert",
  });
}

function awaitable<T>(factory: () => Promise<T>): Promise<T> {
  return factory();
}
