import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MonitorConfig } from "./config";
import { ensureDataDir } from "./storage";

const execFileAsync = promisify(execFile);

export interface ServiceRuntime {
  config: MonitorConfig;
  configPath: string;
}

export async function installLaunchdService(runtime: ServiceRuntime): Promise<string> {
  ensureMacOS();

  const plistPath = getPlistPath(runtime.config.launchd.label);
  const dataDir = ensureDataDir(path.resolve(runtime.config.dataDir));
  const programArguments = [
    process.execPath,
    path.resolve(process.cwd(), "dist/index.js"),
    "check",
    "--config",
    runtime.configPath,
  ];

  const plist = buildPlist({
    label: runtime.config.launchd.label,
    programArguments,
    workingDirectory: process.cwd(),
    standardOutPath: path.join(dataDir, "launchd.out.log"),
    standardErrorPath: path.join(dataDir, "launchd.err.log"),
    startIntervalSeconds: Math.max(60, Math.round(runtime.config.checkIntervalMinutes * 60)),
    runAtLoad: runtime.config.launchd.runAtLoad,
    environmentVariables: {
      OPENCLAW_BIN: runtime.config.openclawBin,
      PATH: buildLaunchdPathEnv(),
    },
  });

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, "utf8");

  await bootout(runtime.config.launchd.label);
  await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? os.userInfo().uid}`, plistPath]);
  await execFileAsync("launchctl", ["enable", `gui/${process.getuid?.() ?? os.userInfo().uid}/${runtime.config.launchd.label}`]);
  await execFileAsync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? os.userInfo().uid}/${runtime.config.launchd.label}`]);

  return plistPath;
}

export async function uninstallLaunchdService(label: string): Promise<string> {
  ensureMacOS();

  await bootout(label);
  const plistPath = getPlistPath(label);
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
  }
  return plistPath;
}

export async function getLaunchdStatus(label: string): Promise<string> {
  ensureMacOS();

  const plistPath = getPlistPath(label);
  try {
    const { stdout } = await execFileAsync("launchctl", ["list"]);
    const matchingLine = stdout
      .split("\n")
      .find((line) => line.trim().endsWith(`\t${label}`) || line.trim().endsWith(` ${label}`));

    return [
      `plist: ${plistPath}`,
      `loaded: ${matchingLine ? "yes" : "no"}`,
      matchingLine ? `launchctl: ${matchingLine.trim()}` : "launchctl: not listed",
    ].join("\n");
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

function getPlistPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

async function bootout(label: string): Promise<void> {
  const domainTarget = `gui/${process.getuid?.() ?? os.userInfo().uid}/${label}`;
  try {
    await execFileAsync("launchctl", ["bootout", domainTarget]);
  } catch {
    return;
  }
}

function ensureMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("launchd integration is only available on macOS");
  }
}

function buildPlist(input: {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
  startIntervalSeconds: number;
  runAtLoad: boolean;
  environmentVariables: Record<string, string>;
}): string {
  const programArgumentsXml = input.programArguments.map((arg) => `<string>${escapeXml(arg)}</string>`).join("\n    ");
  const environmentVariablesXml = Object.entries(input.environmentVariables)
    .map(
      ([key, value]) => `    <key>${escapeXml(key)}</key>
    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    ${programArgumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(input.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentVariablesXml}
  </dict>
  <key>RunAtLoad</key>
  <${input.runAtLoad ? "true" : "false"}/>
  <key>StartInterval</key>
  <integer>${input.startIntervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.standardErrorPath)}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function buildLaunchdPathEnv(): string {
  return [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}
