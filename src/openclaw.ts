import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RecoveryStep } from "./config";

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

async function execOpenClaw(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("openclaw", args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
}

function summarizeStatus(status: GatewayStatus): string {
  const serviceStatus = status.service?.runtime?.status ?? "unknown-service";
  const rpcStatus = status.rpc?.ok === true ? "rpc-ok" : "rpc-failed";
  const portStatus = status.port?.status ?? "unknown-port";
  return `${serviceStatus}, ${rpcStatus}, ${portStatus}`;
}
