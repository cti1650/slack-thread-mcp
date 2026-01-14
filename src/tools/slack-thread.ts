import { FastMCP } from "fastmcp";
import { z } from "zod";
import { SlackClient } from "../lib/slack-client.js";
import { ThreadStore } from "../lib/thread-store.js";

export function slackThreadTools(
  server: FastMCP,
  slackClient: SlackClient,
  threadStore: ThreadStore
): void {
  // slack_thread_start
  server.addTool({
    name: "slack_thread_start",
    description:
      "新しいジョブのスレッドを作成し、Slackに親メッセージを投稿します。同一job_idで再度呼ばれた場合は既存のスレッド情報を返します（冪等性）。",
    parameters: z.object({
      job_id: z.string().describe("ジョブの一意識別子（UUID推奨）"),
      title: z.string().describe("短い作業名（例：Terraform apply）"),
      channel: z
        .string()
        .optional()
        .describe("投稿先チャンネル（省略時はデフォルトチャンネル）"),
      meta: z
        .record(z.unknown())
        .optional()
        .describe("追加情報（repo名、branch、cwdなど）"),
      mention: z
        .boolean()
        .optional()
        .describe("メンションを行うか（デフォルト: true）"),
    }),
    execute: async ({ job_id, title, channel, meta, mention }) => {
      // 冪等性: 既存のジョブがあれば再利用
      const existing = threadStore.get(job_id);
      if (existing) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                job_id: existing.jobId,
                channel: existing.channel,
                thread_ts: existing.threadTs,
                permalink: existing.permalink,
                note: "既存のスレッドを再利用しました",
              }),
            },
          ],
        };
      }

      const targetChannel = channel || slackClient.getDefaultChannel();

      const result = await slackClient.postParentMessage(
        targetChannel,
        title,
        meta,
        mention !== false
      );

      if (!result.ok) {
        throw new Error("Slack投稿に失敗しました");
      }

      const state = threadStore.create(
        job_id,
        result.channel,
        result.ts,
        title,
        result.permalink
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              job_id: state.jobId,
              channel: state.channel,
              thread_ts: state.threadTs,
              permalink: state.permalink,
            }),
          },
        ],
      };
    },
  });

  // slack_thread_update
  server.addTool({
    name: "slack_thread_update",
    description:
      "進捗を同スレッドに返信します。メンションは行いません。連投防止のため、短時間の連続呼び出しはまとめられます。",
    parameters: z.object({
      job_id: z.string().describe("ジョブの一意識別子"),
      message: z.string().describe("進捗メッセージ"),
      thread_ts: z
        .string()
        .optional()
        .describe("スレッドのタイムスタンプ（job_idでスレッドが見つからない場合に使用）"),
      level: z
        .enum(["info", "warn", "debug"])
        .optional()
        .describe("メッセージレベル（デフォルト: info）"),
      mention: z
        .boolean()
        .optional()
        .describe("メンションを行うか（デフォルト: false）"),
      enable_waiting_monitor: z
        .boolean()
        .optional()
        .describe("権限確認待ち監視を有効にするか（デフォルト: true）"),
      waiting_timeout_ms: z
        .number()
        .optional()
        .describe("権限確認待ち通知までの時間（ミリ秒、デフォルト: 30000）"),
    }),
    execute: async ({ job_id, message, thread_ts, level, mention, enable_waiting_monitor, waiting_timeout_ms }) => {
      const state = threadStore.get(job_id);

      // thread_ts が指定されていればそちらを優先、なければ state から取得
      const targetThreadTs = thread_ts || state?.threadTs;
      const targetChannel = state?.channel || slackClient.getDefaultChannel();

      if (!targetThreadTs) {
        throw new Error(`スレッドが見つかりません: job_id=${job_id}, thread_ts=${thread_ts}`);
      }

      if (state && threadStore.isTerminal(job_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "ジョブは既に終了しています",
              }),
            },
          ],
        };
      }

      // 前回の監視をキャンセル
      slackClient.cancelWaitingMonitor(job_id);

      if (state) {
        threadStore.updateStatus(job_id, "in_progress");
      }

      // debounce処理（即時実行版）
      // 実際のdebounceはthreadStoreのscheduleUpdateで可能だが、
      // MCPツールは同期的に結果を返す必要があるため、ここでは即時投稿
      const result = await slackClient.postThreadReply(
        targetChannel,
        targetThreadTs,
        message,
        level || "info",
        mention === true
      );

      // 権限確認待ち監視を開始（デフォルトで有効）
      if (enable_waiting_monitor !== false) {
        slackClient.startWaitingMonitor(
          job_id,
          targetChannel,
          targetThreadTs,
          waiting_timeout_ms
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: result.ok }),
          },
        ],
      };
    },
  });

  // slack_thread_waiting
  server.addTool({
    name: "slack_thread_waiting",
    description:
      "処理が一時停止していることを通知します。権限確認やユーザー入力待ちの際に使用してください。",
    parameters: z.object({
      job_id: z.string().describe("ジョブの一意識別子"),
      thread_ts: z
        .string()
        .optional()
        .describe("スレッドのタイムスタンプ（job_idでスレッドが見つからない場合に使用）"),
      reason: z
        .string()
        .optional()
        .describe("停止理由（例：権限確認待ち、ユーザー入力待ち）"),
      mention: z
        .boolean()
        .optional()
        .describe("メンションを行うか（デフォルト: true）"),
    }),
    execute: async ({ job_id, thread_ts, reason, mention }) => {
      const state = threadStore.get(job_id);

      // thread_ts が指定されていればそちらを優先、なければ state から取得
      const targetThreadTs = thread_ts || state?.threadTs;
      const targetChannel = state?.channel || slackClient.getDefaultChannel();
      const title = state?.title || job_id;

      if (!targetThreadTs) {
        throw new Error(`スレッドが見つかりません: job_id=${job_id}, thread_ts=${thread_ts}`);
      }

      if (state && threadStore.isTerminal(job_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                reason: "ジョブは既に終了しています",
              }),
            },
          ],
        };
      }

      const reasonText = reason || "権限確認またはユーザー入力待ち";
      const result = await slackClient.postWaiting(
        targetChannel,
        targetThreadTs,
        title,
        reasonText,
        mention !== false
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: result.ok }),
          },
        ],
      };
    },
  });

  // slack_thread_complete
  server.addTool({
    name: "slack_thread_complete",
    description:
      "ジョブの完了を同スレッドに返信します。デフォルトでメンションを行います。",
    parameters: z.object({
      job_id: z.string().describe("ジョブの一意識別子"),
      thread_ts: z
        .string()
        .optional()
        .describe("スレッドのタイムスタンプ（job_idでスレッドが見つからない場合に使用）"),
      summary: z.string().optional().describe("完了サマリ"),
      next_suggestions: z
        .array(z.string())
        .optional()
        .describe("次のアクション候補（提案のみ）"),
      mention: z
        .boolean()
        .optional()
        .describe("メンションを行うか（デフォルト: true）"),
    }),
    execute: async ({ job_id, thread_ts, summary, next_suggestions, mention }) => {
      const state = threadStore.get(job_id);

      // thread_ts が指定されていればそちらを優先、なければ state から取得
      const targetThreadTs = thread_ts || state?.threadTs;
      const targetChannel = state?.channel || slackClient.getDefaultChannel();
      const title = state?.title || job_id;

      if (!targetThreadTs) {
        throw new Error(`スレッドが見つかりません: job_id=${job_id}, thread_ts=${thread_ts}`);
      }

      // 権限確認待ち監視をキャンセル
      slackClient.cancelWaitingMonitor(job_id);

      // 冪等性: 既に完了/失敗なら何もしない
      if (state && threadStore.isTerminal(job_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                note: "ジョブは既に終了済みです",
              }),
            },
          ],
        };
      }

      const result = await slackClient.postComplete(
        targetChannel,
        targetThreadTs,
        title,
        summary,
        next_suggestions,
        mention !== false
      );

      if (result.ok && state) {
        threadStore.updateStatus(job_id, "completed");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: result.ok }),
          },
        ],
      };
    },
  });

  // slack_thread_fail
  server.addTool({
    name: "slack_thread_fail",
    description:
      "ジョブの失敗を同スレッドに返信します。デフォルトでメンションを行います。",
    parameters: z.object({
      job_id: z.string().describe("ジョブの一意識別子"),
      thread_ts: z
        .string()
        .optional()
        .describe("スレッドのタイムスタンプ（job_idでスレッドが見つからない場合に使用）"),
      error_summary: z.string().describe("エラーの概要"),
      logs_hint: z
        .string()
        .optional()
        .describe("ログの場所やコマンドのヒント"),
      mention: z
        .boolean()
        .optional()
        .describe("メンションを行うか（デフォルト: true）"),
    }),
    execute: async ({ job_id, thread_ts, error_summary, logs_hint, mention }) => {
      const state = threadStore.get(job_id);

      // thread_ts が指定されていればそちらを優先、なければ state から取得
      const targetThreadTs = thread_ts || state?.threadTs;
      const targetChannel = state?.channel || slackClient.getDefaultChannel();
      const title = state?.title || job_id;

      if (!targetThreadTs) {
        throw new Error(`スレッドが見つかりません: job_id=${job_id}, thread_ts=${thread_ts}`);
      }

      // 権限確認待ち監視をキャンセル
      slackClient.cancelWaitingMonitor(job_id);

      // 冪等性: 既に完了/失敗なら何もしない
      if (state && threadStore.isTerminal(job_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: true,
                note: "ジョブは既に終了済みです",
              }),
            },
          ],
        };
      }

      const result = await slackClient.postFail(
        targetChannel,
        targetThreadTs,
        title,
        error_summary,
        logs_hint,
        mention !== false
      );

      if (result.ok && state) {
        threadStore.updateStatus(job_id, "failed");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: result.ok }),
          },
        ],
      };
    },
  });
}
