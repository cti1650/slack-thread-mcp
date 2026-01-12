export const config = {
  name: "slack-thread-mcp",
  version: "0.1.0" as const,
};

export interface EnvConfig {
  slackBotToken: string;
  slackDefaultChannel: string;
  slackMentionUserIds?: string[];
  slackMentionGroupId?: string;
  slackPostPrefix?: string;
  threadStatePath?: string;
}

export function loadEnvConfig(): EnvConfig {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackDefaultChannel = process.env.SLACK_DEFAULT_CHANNEL;

  if (!slackBotToken) {
    throw new Error("SLACK_BOT_TOKEN環境変数が設定されていません");
  }

  if (!slackDefaultChannel) {
    throw new Error("SLACK_DEFAULT_CHANNEL環境変数が設定されていません");
  }

  const mentionUserIdsRaw = process.env.SLACK_MENTION_USER_IDS;
  const slackMentionUserIds = mentionUserIdsRaw
    ? mentionUserIdsRaw.split(",").map((id) => id.trim())
    : undefined;

  return {
    slackBotToken,
    slackDefaultChannel,
    slackMentionUserIds,
    slackMentionGroupId: process.env.SLACK_MENTION_GROUP_ID,
    slackPostPrefix: process.env.SLACK_POST_PREFIX,
    threadStatePath: process.env.THREAD_STATE_PATH,
  };
}
