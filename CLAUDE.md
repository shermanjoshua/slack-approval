# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build

```bash
pnpm install
npx tsc
```

The compiled output goes to `dist/` which is what GitHub Actions runs. The `dist/` directory is checked into the repo.

## What This Is

A GitHub Action that posts approval request messages to Slack with interactive Approve/Reject buttons. It uses Slack Bolt in Socket Mode to listen for button clicks in real time. When a user clicks Approve, the workflow continues. When they click Reject, the workflow exits. On timeout (SIGTERM from GitHub Actions), the Slack message is updated with a timeout notice.

## Architecture

The entire application lives in `src/index.ts` (~287 lines). There are no other source files. The flow is:

1. Read env vars and GitHub Action inputs
2. Initialize Slack Bolt app in Socket Mode on port 3000
3. Post a message with Approve/Reject buttons to the configured Slack channel
4. Register action handlers for `slack-approval-approve` and `slack-approval-reject`
5. Wait for interaction or SIGTERM/SIGINT (timeout)
6. Update the Slack message to reflect the outcome and set the `approval-status` output

## Runtime

- Node >= 24 (managed via `mise.toml`)
- Package manager: pnpm

## Required Environment Variables

- `SLACK_APP_TOKEN` - Slack app-level token (xapp-*)
- `SLACK_BOT_TOKEN` - Slack bot token (xoxb-*)
- `SLACK_SIGNING_SECRET` - Slack signing secret
- `SLACK_CHANNEL_ID` - Target Slack channel ID
- `SLACK_LOG_LEVEL` (optional) - DEBUG, INFO, WARN, or ERROR
- `RUNNER_DEBUG` (optional) - Set to "1" for debug logging (overrides SLACK_LOG_LEVEL)

## GitHub Action Inputs

Defined in `action.yml`:
- `custom-blocks` - Additional Slack Block Kit blocks (JSON string)
- `override-base-blocks` - Replace default workflow info with custom blocks
- `message-header` - Override the header text
- `message-fields` - JSON array of `{label, value}` objects for custom metadata fields

## Output

- `approval-status` - One of: `approved`, `rejected`, `timeout`

## Testing

There are no unit tests. The action is tested via the workflow at `.github/workflows/slack-approval-test.yml` which runs the action against real Slack credentials stored in GitHub Secrets.
