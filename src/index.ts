import { loadConfig } from "./config";
import { startDashboardServer } from "./dashboard";
import { getLaunchdStatus, installLaunchdService, uninstallLaunchdService } from "./launchd";
import { buildReport, runCheck, runCollectorsOnly, runWatch } from "./monitor";
import { primeOpenClawBinary } from "./openclaw";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "watch";
  const configFlagIndex = process.argv.indexOf("--config");
  const configPath = configFlagIndex >= 0 ? process.argv[configFlagIndex + 1] : undefined;
  const runtime = loadConfig(configPath);
  primeOpenClawBinary(runtime.config);

  if (command === "report") {
    console.log(buildReport(runtime));
    return;
  }

  if (command === "collect") {
    process.exitCode = await runCollectorsOnly(runtime);
    return;
  }

  if (command === "check") {
    process.exitCode = await runCheck(runtime);
    return;
  }

  if (command === "dashboard") {
    startDashboardServer(runtime);
    console.log(`Dashboard listening on http://127.0.0.1:${runtime.config.dashboardPort}`);
    return;
  }

  if (command === "service") {
    const action = process.argv[3];
    if (action === "install") {
      const plistPath = await installLaunchdService(runtime);
      console.log(`Installed launchd service at ${plistPath}`);
      return;
    }
    if (action === "uninstall") {
      const plistPath = await uninstallLaunchdService(runtime.config.launchd.label);
      console.log(`Uninstalled launchd service at ${plistPath}`);
      return;
    }
    if (action === "status") {
      console.log(await getLaunchdStatus(runtime.config.launchd.label));
      return;
    }
  }

  if (command === "watch") {
    await runWatch(runtime);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error(
    "Usage: node dist/index.js [watch|check|collect|report|dashboard|service] [--config path/to/config.json]",
  );
  process.exitCode = 1;
}

void main();
