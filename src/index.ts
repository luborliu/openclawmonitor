import { loadConfig } from "./config";
import { buildReport, runCheck, runWatch } from "./monitor";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "watch";
  const configFlagIndex = process.argv.indexOf("--config");
  const configPath = configFlagIndex >= 0 ? process.argv[configFlagIndex + 1] : undefined;
  const runtime = loadConfig(configPath);

  if (command === "report") {
    console.log(buildReport(runtime));
    return;
  }

  if (command === "check") {
    process.exitCode = await runCheck(runtime);
    return;
  }

  if (command === "watch") {
    await runWatch(runtime);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: node dist/index.js [watch|check|report] [--config path/to/config.json]");
  process.exitCode = 1;
}

void main();
