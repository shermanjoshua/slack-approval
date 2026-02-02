import * as core from "@actions/core";
import * as github from "@actions/github";
import { App, BlockAction, LogLevel } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { KnownBlock, Block } from "@slack/types";

const token = process.env.SLACK_BOT_TOKEN || "";
const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
const slackAppToken = process.env.SLACK_APP_TOKEN || "";
const channel_id = process.env.SLACK_CHANNEL_ID || "";
const customBlocks = core.getInput("custom-blocks") || "[]";
const overrideBaseBlocks = core.getInput("override-base-blocks") === "true";
const messageHeaderInput = core.getInput("message-header");
const messageFieldsRaw = core.getInput("message-fields");
const githubToken = core.getInput("github-token");

const logLevelMap: { [key: string]: LogLevel } = {
  DEBUG: LogLevel.DEBUG,
  INFO: LogLevel.INFO,
  WARN: LogLevel.WARN,
  ERROR: LogLevel.ERROR,
};

let logLevel = LogLevel.WARN;
if (process.env.RUNNER_DEBUG === "1") {
  logLevel = LogLevel.DEBUG;
} else if (process.env.SLACK_LOG_LEVEL) {
  logLevel =
    logLevelMap[process.env.SLACK_LOG_LEVEL.toUpperCase()] || LogLevel.WARN;
}

const app = new App({
  token: token,
  signingSecret: signingSecret,
  appToken: slackAppToken,
  socketMode: true,
  port: 3000,
  logLevel: logLevel,
});

async function run(): Promise<void> {
  try {
    const web = new WebClient(token);

    const github_server_url = process.env.GITHUB_SERVER_URL || "";
    const github_repos = process.env.GITHUB_REPOSITORY || "";
    const run_id = process.env.GITHUB_RUN_ID || "";
    const actionsUrl = `${github_server_url}/${github_repos}/actions/runs/${run_id}`;
    const workflow = process.env.GITHUB_WORKFLOW || "";
    const actor = process.env.GITHUB_ACTOR || "";

    let messageTs = "";
    let sentMessageBlocks: (KnownBlock | Block)[] = [];
    let isExiting = false;

    let parsedCustomBlocks: (KnownBlock | Block)[] = [];
    try {
      parsedCustomBlocks = JSON.parse(customBlocks);
    } catch (error) {
      console.warn("Failed to parse custom-blocks, using empty array:", error);
    }

    const octokit = github.getOctokit(githubToken);

    const cancelWorkflowRun = async () => {
      await octokit.rest.actions.cancelWorkflowRun({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        run_id: github.context.runId,
      });
      process.exit(0);
    };

    const handleTimeout = async () => {
      if (isExiting) return;
      isExiting = true;

      if (messageTs && sentMessageBlocks.length > 0) {
        try {
          const timestamp = new Date().toISOString();
          console.log(`⏱️ TIMEOUT - No response received at ${timestamp}`);

          const updatedBlocks = [...sentMessageBlocks];
          updatedBlocks.pop();

          const timeoutBlock: KnownBlock | Block = {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "⏱️ *Timeout:* The approval time has expired and the deployment was cancelled",
            },
          };
          updatedBlocks.push(timeoutBlock);

          await web.chat.update({
            channel: channel_id,
            ts: messageTs,
            blocks: updatedBlocks,
            text: "GitHub Actions Approval request - Timeout",
          });
          console.log("Slack message updated with timeout notification");
        } catch (error) {
          console.error("Failed to update Slack message on timeout:", error);
        }
      }
      core.setOutput("approval-status", "timeout");
      await cancelWorkflowRun();
    };

    process.on("SIGTERM", handleTimeout);
    process.on("SIGINT", handleTimeout);

    (async () => {
      const messageHeader = messageHeaderInput || `${workflow} Approval`;

      let baseBlocks: (KnownBlock | Block)[];

      if (messageFieldsRaw) {
        const parsedFields: { label: string; value: string }[] =
          JSON.parse(messageFieldsRaw);
        const fieldElements = parsedFields.map((field) => ({
          type: "mrkdwn" as const,
          text: `*${field.label}:*\n${field.value}`,
        }));
        baseBlocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: messageHeader,
            },
          },
          {
            type: "section",
            fields: fieldElements,
          },
          {
            type: "divider",
          },
        ];
      } else {
        baseBlocks = [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: messageHeader,
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn" as const, text: `*GitHub Actor:*\n${actor}` },
              {
                type: "mrkdwn" as const,
                text: `*Repo:*\n${github_server_url}/${github_repos}`,
              },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Actions URL:*\n${actionsUrl}`,
            },
          },
          {
            type: "divider",
          },
        ];
      }

      const actionBlock: KnownBlock | Block = {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              emoji: true,
              text: "Approve",
            },
            style: "primary",
            value: "approve",
            action_id: "slack-approval-approve",
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              emoji: true,
              text: "Reject",
            },
            style: "danger",
            value: "reject",
            action_id: "slack-approval-reject",
          },
        ],
      };

      const messageBlocks: (KnownBlock | Block)[] = overrideBaseBlocks
        ? [...parsedCustomBlocks, actionBlock]
        : [...baseBlocks, ...parsedCustomBlocks, actionBlock];

      const result = await web.chat.postMessage({
        channel: channel_id,
        text: "GitHub Actions Approval request",
        blocks: messageBlocks,
      });

      messageTs = result.ts || "";
      sentMessageBlocks = messageBlocks;
    })();

    app.action(
      "slack-approval-approve",
      async ({ ack, client, body, logger }) => {
        await ack();
        try {
          const timestamp = new Date().toISOString();
          const userId = body.user.id;
          const user: any = body.user;
          const userName = user.username || user.name || "Unknown";

          console.log(`✅ APPROVED by ${userName} (${userId}) at ${timestamp}`);

          const response_blocks = (<BlockAction>body).message?.blocks;
          response_blocks.pop();
          response_blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Approved by <@${userId}> `,
            },
          });

          await client.chat.update({
            channel: body.channel?.id || "",
            ts: (<BlockAction>body).message?.ts || "",
            blocks: response_blocks,
          });
        } catch (error) {
          logger.error(error);
        }

        core.setOutput("approval-status", "approved");
        process.exit(0);
      },
    );

    app.action(
      "slack-approval-reject",
      async ({ ack, client, body, logger }) => {
        await ack();
        isExiting = true;

        try {
          const timestamp = new Date().toISOString();
          const userId = body.user.id;
          const user: any = body.user;
          const userName = user.username || user.name || "Unknown";

          console.log(`❌ REJECTED by ${userName} (${userId}) at ${timestamp}`);

          const response_blocks = (<BlockAction>body).message?.blocks;
          response_blocks.pop();
          response_blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `Rejected by <@${userId}>`,
            },
          });

          await client.chat.update({
            channel: body.channel?.id || "",
            ts: (<BlockAction>body).message?.ts || "",
            blocks: response_blocks,
          });
        } catch (error) {
          logger.error(error);
        }

        core.setOutput("approval-status", "rejected");
        await cancelWorkflowRun();
      },
    );

    (async () => {
      await app.start(3000);
      console.log("Waiting Approval reaction.....");
    })();
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
}

run();
