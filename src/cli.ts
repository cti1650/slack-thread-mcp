#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SlackClient } from "./lib/slack-client.js";
import { ThreadStore } from "./lib/thread-store.js";

// グローバル設定ファイルのパス
const GLOBAL_CONFIG_PATHS = [
  join(homedir(), ".config", "slack-thread-mcp", "config.json"),
  join(homedir(), ".slack-thread-mcp.json"),
];

interface GlobalConfig {
  slackBotToken?: string;
  slackDefaultChannel?: string;
  slackMentionUserIds?: string[];
  slackMentionGroupId?: string;
  slackPostPrefix?: string;
  threadStatePath?: string;
}

function loadGlobalConfig(): GlobalConfig {
  for (const configPath of GLOBAL_CONFIG_PATHS) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        return JSON.parse(content) as GlobalConfig;
      } catch {
        // Continue to next config path
      }
    }
  }
  return {};
}

function loadDotEnv(): void {
  // プロジェクトディレクトリの .env を読み込む
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, ...valueParts] = trimmed.split("=");
          const value = valueParts.join("=").replace(/^["']|["']$/g, "");
          if (key && !process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    } catch {
      // Ignore .env read errors
    }
  }
}

interface Config {
  slackBotToken: string;
  slackDefaultChannel: string;
  slackMentionUserIds?: string[];
  slackMentionGroupId?: string;
  slackPostPrefix?: string;
  threadStatePath?: string;
}

function resolveConfig(): Config {
  // .env ファイルを読み込み
  loadDotEnv();

  // グローバル設定を読み込み
  const globalConfig = loadGlobalConfig();

  // 優先順位: 環境変数 > グローバル設定
  const slackBotToken =
    process.env.SLACK_BOT_TOKEN || globalConfig.slackBotToken;
  const slackDefaultChannel =
    process.env.SLACK_DEFAULT_CHANNEL || globalConfig.slackDefaultChannel;

  if (!slackBotToken) {
    console.error("Error: SLACK_BOT_TOKEN is not set");
    console.error("Set it via environment variable, .env file, or global config");
    console.error(`Global config paths: ${GLOBAL_CONFIG_PATHS.join(", ")}`);
    process.exit(1);
  }

  if (!slackDefaultChannel) {
    console.error("Error: SLACK_DEFAULT_CHANNEL is not set");
    process.exit(1);
  }

  const mentionUserIdsRaw =
    process.env.SLACK_MENTION_USER_IDS ||
    globalConfig.slackMentionUserIds?.join(",");
  const slackMentionUserIds = mentionUserIdsRaw
    ? mentionUserIdsRaw.split(",").map((id) => id.trim())
    : undefined;

  return {
    slackBotToken,
    slackDefaultChannel,
    slackMentionUserIds,
    slackMentionGroupId:
      process.env.SLACK_MENTION_GROUP_ID || globalConfig.slackMentionGroupId,
    slackPostPrefix:
      process.env.SLACK_POST_PREFIX || globalConfig.slackPostPrefix,
    threadStatePath:
      process.env.THREAD_STATE_PATH || globalConfig.threadStatePath,
  };
}

function parseArgs(args: string[]): { command: string; options: Record<string, string> } {
  const command = args[0] || "help";
  const options: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [key, ...valueParts] = arg.slice(2).split("=");
      options[key] = valueParts.join("=") || "true";
    }
  }

  return { command, options };
}

function printUsage(): void {
  console.log(`
Usage: slack-thread-mcp <command> [options]

Commands:
  start     Create a new thread for a job
  update    Post a progress update to the thread
  waiting   Notify that the process is waiting
  complete  Mark the job as completed
  fail      Mark the job as failed
  help      Show this help message

Options:
  --job-id=<id>       Job identifier (required for all commands)
  --title=<title>     Job title (required for start)
  --message=<msg>     Progress message (required for update)
  --level=<level>     Message level: info, warn, debug (default: info)
  --reason=<reason>   Waiting reason (for waiting command)
  --summary=<text>    Completion summary (for complete command)
  --error=<text>      Error summary (required for fail)
  --logs-hint=<text>  Logs location hint (for fail command)
  --channel=<ch>      Override default channel
  --mention=<bool>    Enable/disable mention (default: true)
  --meta=<json>       Additional metadata as JSON (for start)

Environment Variables:
  SLACK_BOT_TOKEN         Slack Bot Token (required)
  SLACK_DEFAULT_CHANNEL   Default channel ID (required)
  SLACK_MENTION_USER_IDS  Comma-separated user IDs to mention
  SLACK_MENTION_GROUP_ID  Group ID to mention
  SLACK_POST_PREFIX       Prefix for all messages
  THREAD_STATE_PATH       Path to persist thread state

Global Config:
  ~/.config/slack-thread-mcp/config.json
  ~/.slack-thread-mcp.json

Examples:
  slack-thread-mcp start --job-id=abc123 --title="Deploy to production"
  slack-thread-mcp update --job-id=abc123 --message="Building..."
  slack-thread-mcp complete --job-id=abc123 --summary="Deployed successfully"
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const config = resolveConfig();

  const slackClient = new SlackClient({
    botToken: config.slackBotToken,
    defaultChannel: config.slackDefaultChannel,
    mentionUserIds: config.slackMentionUserIds,
    mentionGroupId: config.slackMentionGroupId,
    postPrefix: config.slackPostPrefix,
  });

  const threadStore = new ThreadStore(config.threadStatePath);

  const jobId = options["job-id"];
  if (!jobId && command !== "help") {
    console.error("Error: --job-id is required");
    process.exit(1);
  }

  const channel = options.channel || config.slackDefaultChannel;
  const mention = options.mention !== "false";

  try {
    switch (command) {
      case "start": {
        const title = options.title;
        if (!title) {
          console.error("Error: --title is required for start command");
          process.exit(1);
        }

        // 冪等性: 既存のジョブがあれば再利用
        const existing = threadStore.get(jobId);
        if (existing) {
          console.log(JSON.stringify({
            job_id: existing.jobId,
            channel: existing.channel,
            thread_ts: existing.threadTs,
            permalink: existing.permalink,
            note: "Reused existing thread",
          }));
          break;
        }

        let meta: Record<string, unknown> | undefined;
        if (options.meta) {
          try {
            meta = JSON.parse(options.meta);
          } catch {
            console.error("Error: --meta must be valid JSON");
            process.exit(1);
          }
        }

        const result = await slackClient.postParentMessage(
          channel,
          title,
          meta,
          mention
        );

        if (!result.ok) {
          console.error("Error: Failed to post to Slack");
          process.exit(1);
        }

        const state = threadStore.create(
          jobId,
          result.channel,
          result.ts,
          title,
          result.permalink
        );

        console.log(JSON.stringify({
          job_id: state.jobId,
          channel: state.channel,
          thread_ts: state.threadTs,
          permalink: state.permalink,
        }));
        break;
      }

      case "update": {
        const message = options.message;
        if (!message) {
          console.error("Error: --message is required for update command");
          process.exit(1);
        }

        const state = threadStore.get(jobId);
        const targetThreadTs = options["thread-ts"] || state?.threadTs;
        const targetChannel = state?.channel || channel;

        if (!targetThreadTs) {
          console.error(`Error: Thread not found for job_id=${jobId}`);
          process.exit(1);
        }

        if (state && threadStore.isTerminal(jobId)) {
          console.log(JSON.stringify({ ok: false, reason: "Job already terminated" }));
          break;
        }

        if (state) {
          threadStore.updateStatus(jobId, "in_progress");
        }

        const level = (options.level || "info") as "info" | "warn" | "debug";
        const result = await slackClient.postThreadReply(
          targetChannel,
          targetThreadTs,
          message,
          level
        );

        console.log(JSON.stringify({ ok: result.ok }));
        break;
      }

      case "waiting": {
        const state = threadStore.get(jobId);
        const targetThreadTs = options["thread-ts"] || state?.threadTs;
        const targetChannel = state?.channel || channel;
        const title = state?.title || jobId;

        if (!targetThreadTs) {
          console.error(`Error: Thread not found for job_id=${jobId}`);
          process.exit(1);
        }

        if (state && threadStore.isTerminal(jobId)) {
          console.log(JSON.stringify({ ok: false, reason: "Job already terminated" }));
          break;
        }

        const reason = options.reason || "Waiting for permission or user input";
        const result = await slackClient.postWaiting(
          targetChannel,
          targetThreadTs,
          title,
          reason,
          mention
        );

        console.log(JSON.stringify({ ok: result.ok }));
        break;
      }

      case "complete": {
        const state = threadStore.get(jobId);
        const targetThreadTs = options["thread-ts"] || state?.threadTs;
        const targetChannel = state?.channel || channel;
        const title = state?.title || jobId;

        if (!targetThreadTs) {
          console.error(`Error: Thread not found for job_id=${jobId}`);
          process.exit(1);
        }

        // 冪等性: 既に終了済みなら何もしない
        if (state && threadStore.isTerminal(jobId)) {
          console.log(JSON.stringify({ ok: true, note: "Job already terminated" }));
          break;
        }

        let nextSuggestions: string[] | undefined;
        if (options["next-suggestions"]) {
          try {
            nextSuggestions = JSON.parse(options["next-suggestions"]);
          } catch {
            nextSuggestions = options["next-suggestions"].split(",");
          }
        }

        const result = await slackClient.postComplete(
          targetChannel,
          targetThreadTs,
          title,
          options.summary,
          nextSuggestions,
          mention
        );

        if (result.ok && state) {
          threadStore.updateStatus(jobId, "completed");
        }

        console.log(JSON.stringify({ ok: result.ok }));
        break;
      }

      case "fail": {
        const errorSummary = options.error;
        if (!errorSummary) {
          console.error("Error: --error is required for fail command");
          process.exit(1);
        }

        const state = threadStore.get(jobId);
        const targetThreadTs = options["thread-ts"] || state?.threadTs;
        const targetChannel = state?.channel || channel;
        const title = state?.title || jobId;

        if (!targetThreadTs) {
          console.error(`Error: Thread not found for job_id=${jobId}`);
          process.exit(1);
        }

        // 冪等性: 既に終了済みなら何もしない
        if (state && threadStore.isTerminal(jobId)) {
          console.log(JSON.stringify({ ok: true, note: "Job already terminated" }));
          break;
        }

        const result = await slackClient.postFail(
          targetChannel,
          targetThreadTs,
          title,
          errorSummary,
          options["logs-hint"],
          mention
        );

        if (result.ok && state) {
          threadStore.updateStatus(jobId, "failed");
        }

        console.log(JSON.stringify({ ok: result.ok }));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
