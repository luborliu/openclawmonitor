# OpenClaw Monitor

OpenClaw Monitor is a small external watchdog for the OpenClaw gateway. The first milestone focuses on reliability: run a health check on a configurable interval, track repeated failures, and execute recovery steps when the gateway stays down.

## What it does today

- Runs `openclaw gateway status --json` to verify the service and RPC probe.
- Tracks consecutive failures in `data/state.json`.
- Executes configurable recovery steps after the failure threshold is reached.
- Logs health checks and recoveries to `data/events.jsonl`.
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
npm start
npm run report
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
  "recoverySteps": ["restart", "install", "restart"]
}
```

Field notes:

- `checkIntervalMinutes`: interval for `watch` mode
- `failureThreshold`: number of consecutive failed checks before recovery
- `recoveryCooldownMinutes`: minimum time between recovery runs
- `statusTimeoutMs`: timeout passed to `openclaw gateway status`
- `dataDir`: where state and logs are stored
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

Custom config:

```bash
node dist/index.js check --config /absolute/path/to/config.json
```

## Why this structure

This repo is laid out so you can grow it into a more complete observability tool:

- Add an HTTP API over `data/events.jsonl` and `state.json`
- Add a dashboard for uptime, restart counts, and recovery history
- Add usage aggregation for Codex OAuth vs OpenAI API billing paths
- Add alerting via Slack, email, Telegram, or macOS notifications
- Add more OpenClaw diagnostics, like `probe`, `health`, or usage-cost collection
