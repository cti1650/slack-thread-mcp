import { WebClient } from "@slack/web-api";

export interface SlackConfig {
  botToken: string;
  defaultChannel: string;
  mentionUserIds?: string[];
  mentionGroupId?: string;
  postPrefix?: string;
  useChannelMention?: boolean; // @channel をデフォルトで使用するか
}

export interface PostResult {
  ok: boolean;
  channel: string;
  ts: string;
  permalink?: string;
}

export interface ReplyResult {
  ok: boolean;
  ts?: string;
}

export interface WaitingNotification {
  jobId: string;
  timeout: NodeJS.Timeout;
  notified: boolean;
}

export class SlackClient {
  private client: WebClient;
  private config: SlackConfig;
  private waitingNotifications: Map<string, WaitingNotification> = new Map();
  private defaultWaitingTimeoutMs: number = 30000; // 30秒

  constructor(config: SlackConfig) {
    this.config = config;
    this.client = new WebClient(config.botToken);
  }

  /**
   * 権限確認待ち状態の監視を開始
   * 指定時間後に応答がない場合、Slackに「確認待ち」通知を送信
   */
  startWaitingMonitor(
    jobId: string,
    channel: string,
    threadTs: string,
    timeoutMs?: number
  ): void {
    // 既存の監視があればキャンセル
    this.cancelWaitingMonitor(jobId);

    const timeout = setTimeout(async () => {
      const notification = this.waitingNotifications.get(jobId);
      if (notification && !notification.notified) {
        notification.notified = true;
        await this.postThreadReply(
          channel,
          threadTs,
          "⏸️ 処理が一時停止しています（権限確認やユーザー入力待ちの可能性があります）",
          "warn"
        );
      }
    }, timeoutMs || this.defaultWaitingTimeoutMs);

    this.waitingNotifications.set(jobId, {
      jobId,
      timeout,
      notified: false,
    });
  }

  /**
   * 権限確認待ち状態の監視をキャンセル
   */
  cancelWaitingMonitor(jobId: string): void {
    const notification = this.waitingNotifications.get(jobId);
    if (notification) {
      clearTimeout(notification.timeout);
      this.waitingNotifications.delete(jobId);
    }
  }

  /**
   * 監視が通知済みかどうか確認
   */
  wasWaitingNotified(jobId: string): boolean {
    const notification = this.waitingNotifications.get(jobId);
    return notification?.notified ?? false;
  }

  private formatPrefix(text: string): string {
    if (this.config.postPrefix) {
      return `${this.config.postPrefix} ${text}`;
    }
    return text;
  }

  private formatMention(): string {
    const mentions: string[] = [];

    // ユーザーIDまたはグループIDが指定されている場合はそちらを優先
    if (this.config.mentionUserIds && this.config.mentionUserIds.length > 0) {
      mentions.push(
        ...this.config.mentionUserIds.map((id) => `<@${id}>`)
      );
    }

    if (this.config.mentionGroupId) {
      mentions.push(`<!subteam^${this.config.mentionGroupId}>`);
    }

    // 個別メンション先が指定されていない場合は @channel を使用（デフォルト動作）
    if (mentions.length === 0 && this.config.useChannelMention !== false) {
      return "<!channel>";
    }

    return mentions.length > 0 ? mentions.join(" ") : "";
  }

  async postParentMessage(
    channel: string,
    title: string,
    meta?: Record<string, unknown>,
    mention: boolean = true
  ): Promise<PostResult> {
    const metaText = meta
      ? Object.entries(meta)
          .map(([k, v]) => `• ${k}: ${v}`)
          .join("\n")
      : "";

    const mentionText = mention ? this.formatMention() : "";
    const text = this.formatPrefix(
      `🚀 *Started:* ${title}${metaText ? `\n${metaText}` : ""}${mentionText ? `\n\n${mentionText}` : ""}`
    );

    const result = await this.client.chat.postMessage({
      channel,
      text,
      mrkdwn: true,
    });

    let permalink: string | undefined;
    if (result.ok && result.ts) {
      try {
        const linkResult = await this.client.chat.getPermalink({
          channel: result.channel as string,
          message_ts: result.ts,
        });
        permalink = linkResult.permalink;
      } catch {
        // permalink is optional
      }
    }

    return {
      ok: result.ok ?? false,
      channel: result.channel as string,
      ts: result.ts as string,
      permalink,
    };
  }

  async postThreadReply(
    channel: string,
    threadTs: string,
    message: string,
    level: "info" | "warn" | "debug" = "info",
    mention: boolean = false
  ): Promise<ReplyResult> {
    const emoji =
      level === "warn" ? "⚠️" : level === "debug" ? "🔍" : "⏳";
    const mentionText = mention ? this.formatMention() : "";
    const text = `${emoji} ${message}${mentionText ? `\n\n${mentionText}` : ""}`;

    const result = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      mrkdwn: true,
    });

    return {
      ok: result.ok ?? false,
      ts: result.ts,
    };
  }

  async postComplete(
    channel: string,
    threadTs: string,
    title: string,
    summary?: string,
    nextSuggestions?: string[],
    mention: boolean = true
  ): Promise<ReplyResult> {
    const mentionText = mention ? this.formatMention() : "";
    const summaryText = summary ? `\n${summary}` : "";
    const suggestionsText =
      nextSuggestions && nextSuggestions.length > 0
        ? `\n\n*次の候補:*\n${nextSuggestions.map((s) => `• ${s}`).join("\n")}`
        : "";

    const text = this.formatPrefix(
      `✅ *Done:* ${title}${summaryText}${suggestionsText}${mentionText ? `\n\n${mentionText}` : ""}`
    );

    const result = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      mrkdwn: true,
    });

    return {
      ok: result.ok ?? false,
      ts: result.ts,
    };
  }

  async postFail(
    channel: string,
    threadTs: string,
    title: string,
    errorSummary: string,
    logsHint?: string,
    mention: boolean = true
  ): Promise<ReplyResult> {
    const mentionText = mention ? this.formatMention() : "";
    const logsText = logsHint ? `\n\n*ログ:* ${logsHint}` : "";

    const text = this.formatPrefix(
      `❌ *Failed:* ${title}\n${errorSummary}${logsText}${mentionText ? `\n\n${mentionText}` : ""}`
    );

    const result = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      mrkdwn: true,
    });

    return {
      ok: result.ok ?? false,
      ts: result.ts,
    };
  }

  async postWaiting(
    channel: string,
    threadTs: string,
    title: string,
    reason: string,
    mention: boolean = true
  ): Promise<ReplyResult> {
    const mentionText = mention ? this.formatMention() : "";

    const text = this.formatPrefix(
      `⏸️ *Waiting:* ${title}\n${reason}${mentionText ? `\n\n${mentionText}` : ""}`
    );

    const result = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      mrkdwn: true,
    });

    return {
      ok: result.ok ?? false,
      ts: result.ts,
    };
  }

  getDefaultChannel(): string {
    return this.config.defaultChannel;
  }
}
