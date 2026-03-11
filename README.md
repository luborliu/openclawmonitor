# OpenClaw Monitor

OpenClaw Monitor is a local reliability and observability tool for the OpenClaw gateway. It now covers automatic health checks, recovery, collector snapshots, launchd scheduling, notifications, and a small local dashboard.

## What it does today

- Runs `openclaw gateway status --json` to verify the service and RPC probe.
- Tracks consecutive failures in `data/state.json`.
- Executes configurable recovery steps after the failure threshold is reached.
- Logs health checks and recoveries to `data/events.jsonl`.
- Collects `probe`, `health`, and `usage-cost` snapshots into `data/snapshots/`.
- Sends macOS notifications when downtime or failed recovery crosses your thresholds.
- Installs a `launchd` job so checks run automatically on the Mac mini.
- Serves a local dashboard for restart history, collector data, and usage rollups.
- Prints a local report so you can see how often the gateway was unhealthy or restarted.

## Project layout

- `src/`: monitor implementation
- `openclawmonitor.config.json`: sample configuration
- `data/`: runtime state and event logs (created automatically)

## Commands

```bash
npm install
npm run build
npm run check
npm run collect
npm start
npm run dashboard
npm run report
npm run service:install
npm run service:status
npm run service:uninstall
```

## Configuration

Default config file: `openclawmonitor.config.json`

```json
{
  "checkIntervalMinutes": 5,
  "failureThreshold": 3,
  "recoveryCooldownMinutes": 15,
  "statusTimeoutMs": 10000,
  "dataDir": "./data",
  "openclawBin": "/opt/homebrew/bin/openclaw",
  "dashboardPort": 4317,
  "usageImportDir": "./data/usage-imports",
  "usageGatewayCategory": "gateway",
  "notifications": {
    "enabled": true,
    "title": "OpenClaw Monitor",
    "downtimeAlertMinutes": 15,
    "repeatAlertMinutes": 30
  },
  "collectors": {
    "probe": true,
    "health": true,
    "usageCost": true,
    "usageCostDays": 30
  },
  "launchd": {
    "label": "ai.openclaw.monitor",
    "runAtLoad": true
  },
  "recoverySteps": ["restart", "install", "restart"]
}
```

Field notes:

- `checkIntervalMinutes`: interval for `watch` mode
- `failureThreshold`: number of consecutive failed checks before recovery
- `recoveryCooldownMinutes`: minimum time between recovery runs
- `statusTimeoutMs`: timeout passed to `openclaw gateway status`
- `dataDir`: where state and logs are stored
- `openclawBin`: absolute path to the OpenClaw CLI, recommended for `launchd`
- `dashboardPort`: local port for the web UI
- `usageImportDir`: folder for extra usage source JSON files
- `usageGatewayCategory`: category label for the built-in OpenClaw usage collector
- `notifications`: macOS alert thresholds and title
- `collectors`: enable or disable `probe`, `health`, and `usage-cost`
- `launchd`: label and run-at-load behavior for the installed service
- `recoverySteps`: ordered OpenClaw gateway commands to run when recovery is needed

## Typical usage

Single check for cron or launchd:

```bash
node dist/index.js check
```

Long-running loop:

```bash
node dist/index.js watch
```

Local dashboard:

```bash
node dist/index.js dashboard
```

Launchd install:

```bash
node dist/index.js service install
```

Launchd status:

```bash
node dist/index.js service status
```

Custom config:

```bash
node dist/index.js check --config /absolute/path/to/config.json
```

## Why this structure

This repo is laid out so you can grow it into a more complete observability tool:

- Add richer dashboard views over the existing snapshot files
- Add imported usage snapshots for Codex OAuth and OpenAI API as separate categories
- Add Slack, email, Telegram, or webhook notifications
- Add retention policies and compaction for long-running logs
- Add anomaly detection on repeated restart loops or rising usage spikes

## Imported usage sources

The dashboard already groups usage snapshots by category. The built-in collector writes one source from `openclaw gateway usage-cost`. You can add more by dropping JSON files into `usageImportDir` with this shape:

```json
{
  "sourceId": "openai-api",
  "label": "OpenAI API",
  "category": "openai_api",
  "collectedAt": "2026-03-10T18:00:00.000Z",
  "payload": {
    "totals": {
      "totalCost": 12.34,
      "totalTokens": 123456
    },
    "daily": []
  }
}
```

That gives you separate dashboard rollups immediately, even before wiring a direct collector for that source.
