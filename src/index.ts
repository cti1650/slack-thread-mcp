#!/usr/bin/env node

import { FastMCP } from "fastmcp";
import { config, loadEnvConfig } from "./config.js";
import { SlackClient } from "./lib/slack-client.js";
import { ThreadStore } from "./lib/thread-store.js";
import { slackThreadTools } from "./tools/slack-thread.js";

const envConfig = loadEnvConfig();

const slackClient = new SlackClient({
  botToken: envConfig.slackBotToken,
  defaultChannel: envConfig.slackDefaultChannel,
  mentionUserIds: envConfig.slackMentionUserIds,
  mentionGroupId: envConfig.slackMentionGroupId,
  postPrefix: envConfig.slackPostPrefix,
});

const threadStore = new ThreadStore(envConfig.threadStatePath);

const server = new FastMCP(config);

slackThreadTools(server, slackClient, threadStore);

server.start({
  transportType: "stdio",
});
