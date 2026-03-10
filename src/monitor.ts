import path from "node:path";

import type { MonitorConfig } from "./config";
import { getGatewayHealth, runGatewayRecoveryStep } from "./openclaw";
import { appendEvent, ensureDataDir, loadState, readEvents, saveState, type LogEvent } from "./storage";

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
      saveState(dataDir, state);
      return 0;
    }

    state.consecutiveFailures += 1;
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
