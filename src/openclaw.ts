import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MonitorConfig, RecoveryStep } from "./config";

const execFileAsync = promisify(execFile);

export interface GatewayStatus {
  service?: {
    loaded?: boolean;
    runtime?: {
      status?: string;
      state?: string;
      pid?: number;
    };
  };
  rpc?: {
    ok?: boolean;
    url?: string;
  };
  port?: {
    status?: string;
  };
  gateway?: {
    probeUrl?: string;
  };
}

export interface GatewayHealthResult {
  ok: boolean;
  summary: string;
  status?: GatewayStatus;
  command: string[];
  stdout: string;
  stderr: string;
}

export interface CommandResult {
  step: RecoveryStep;
  command: string[];
  stdout: string;
  stderr: string;
}

export interface CollectorSnapshot<T> {
  collectedAt: string;
  sourceId: string;
  label: string;
  category?: string;
  payload: T;
}

export interface GatewayProbeResult {
  ok?: boolean;
  durationMs?: number;
  targets?: Array<{
    id?: string;
    active?: boolean;
    connect?: {
      ok?: boolean;
      latencyMs?: number;
    };
    self?: {
      host?: string;
      version?: string;
      platform?: string;
    };
    summary?: {
      sessions?: {
        count?: number;
      };
    };
  }>;
}

export interface GatewayHealthSnapshot {
  ok?: boolean;
  durationMs?: number;
  channels?: Record<
    string,
    {
      linked?: boolean;
      connected?: boolean;
      running?: boolean;
      lastError?: string | null;
    }
  >;
  agents?: Array<{
    agentId?: string;
    isDefault?: boolean;
    heartbeat?: {
      enabled?: boolean;
      every?: string;
    };
    sessions?: {
      count?: number;
    };
  }>;
  sessions?: {
    count?: number;
  };
}

export interface UsageCostSnapshot {
  updatedAt?: number;
  days?: number;
  daily?: Array<{
    date?: string;
    totalCost?: number;
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  }>;
  totals?: {
    totalCost?: number;
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export async function getGatewayHealth(timeoutMs: number): Promise<GatewayHealthResult> {
  const command = ["gateway", "status", "--json", "--timeout", String(timeoutMs)];
  const { stdout, stderr } = await execOpenClaw(command, timeoutMs + 2_000);
  const status = JSON.parse(stdout) as GatewayStatus;
  const ok = status.service?.runtime?.status === "running" && status.rpc?.ok === true;

  return {
    ok,
    summary: summarizeStatus(status),
    status,
    command: ["openclaw", ...command],
    stdout,
    stderr,
  };
}

export async function runGatewayRecoveryStep(step: RecoveryStep, timeoutMs: number): Promise<CommandResult> {
  const command = ["gateway", step];
  const { stdout, stderr } = await execOpenClaw(command, timeoutMs + 10_000);

  return {
    step,
    command: ["openclaw", ...command],
    stdout,
    stderr,
  };
}

export async function getGatewayProbe(timeoutMs: number): Promise<GatewayProbeResult> {
  return execJson<GatewayProbeResult>(["gateway", "probe", "--json", "--timeout", String(timeoutMs)], timeoutMs + 2_000);
}

export async function getGatewayHealthSnapshot(timeoutMs: number): Promise<GatewayHealthSnapshot> {
  return execJson<GatewayHealthSnapshot>(["gateway", "health", "--json", "--timeout", String(timeoutMs)], timeoutMs + 2_000);
}

export async function getGatewayUsageCost(timeoutMs: number, days: number): Promise<UsageCostSnapshot> {
  return execJson<UsageCostSnapshot>(
    ["gateway", "usage-cost", "--json", "--timeout", String(timeoutMs), "--days", String(days)],
    timeoutMs + 2_000,
  );
}

async function execOpenClaw(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(getOpenClawBinary(), args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PATH: buildPathEnv(),
    },
  });
}

async function execJson<T>(args: string[], timeoutMs: number): Promise<T> {
  const { stdout } = await execOpenClaw(args, timeoutMs);
  return JSON.parse(stdout) as T;
}

function summarizeStatus(status: GatewayStatus): string {
  const serviceStatus = status.service?.runtime?.status ?? "unknown-service";
  const rpcStatus = status.rpc?.ok === true ? "rpc-ok" : "rpc-failed";
  const portStatus = status.port?.status ?? "unknown-port";
  return `${serviceStatus}, ${rpcStatus}, ${portStatus}`;
}

export function primeOpenClawBinary(config: MonitorConfig): void {
  process.env.OPENCLAW_BIN = config.openclawBin;
}

function getOpenClawBinary(): string {
  return process.env.OPENCLAW_BIN || "openclaw";
}

function buildPathEnv(): string {
  const pieces = new Set<string>([
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);

  for (const part of (process.env.PATH ?? "").split(":")) {
    if (part) {
      pieces.add(part);
    }
  }

  return Array.from(pieces).join(":");
}
