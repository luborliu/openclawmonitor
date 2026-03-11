import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { NotificationConfig } from "./config";

const execFileAsync = promisify(execFile);

export async function sendNotification(config: NotificationConfig, subtitle: string, message: string): Promise<void> {
  if (!config.enabled) {
    return;
  }

  await execFileAsync("osascript", [
    "-e",
    `display notification ${escapeAppleScript(message)} with title ${escapeAppleScript(config.title)} subtitle ${escapeAppleScript(subtitle)}`,
  ]);
}

function escapeAppleScript(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
