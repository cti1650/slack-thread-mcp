#!/usr/bin/env node

import { existsSync, readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SlackClient } from "./lib/slack-client.js";
import { ThreadStore } from "./lib/thread-store.js";

// デバッグモード
const DEBUG = process.env.SLACK_THREAD_DEBUG === "true" || process.env.DEBUG === "true";

// transcript ファイルから最後のアシスタント応答を取得
function getLastAssistantResponse(transcriptPath: string, maxLength: number = 200): string | null {
  try {
    if (!existsSync(transcriptPath)) {
      return null;
    }

    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    // JSONL形式: 各行がJSONオブジェクト
    // 最後からアシスタントのテキスト応答を探す
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        // アシスタントのメッセージを探す
        if (entry.type === "assistant" && entry.message?.content) {
          // contentは配列で、textブロックを探す
          const textBlocks = entry.message.content.filter(
            (block: { type: string; text?: string }) => block.type === "text" && block.text
          );

          if (textBlocks.length > 0) {
            // 最後のテキストブロックを取得
            const lastText = textBlocks[textBlocks.length - 1].text as string;
            // 長すぎる場合は切り詰め
            if (lastText.length > maxLength) {
              return lastText.slice(0, maxLength) + "...";
            }
            return lastText;
          }
        }
      } catch {
        // JSONパースエラーは無視して次の行へ
        continue;
      }
    }

    return null;
  } catch (error) {
    debug("transcript", "Failed to read transcript", { error: String(error) });
    return null;
  }
}

function debug(category: string, message: string, data?: unknown): void {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [DEBUG] [${category}]`;
  if (data !== undefined) {
    console.error(`${prefix} ${message}:`, JSON.stringify(data, null, 2));
  } else {
    console.error(`${prefix} ${message}`);
  }
}

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
  debug("config", "Looking for global config files", GLOBAL_CONFIG_PATHS);
  for (const configPath of GLOBAL_CONFIG_PATHS) {
    debug("config", `Checking config path: ${configPath}`, { exists: existsSync(configPath) });
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        const config = JSON.parse(content) as GlobalConfig;
        debug("config", `Loaded global config from ${configPath}`, {
          hasToken: !!config.slackBotToken,
          hasChannel: !!config.slackDefaultChannel,
          hasMentionUserIds: !!config.slackMentionUserIds,
          hasMentionGroupId: !!config.slackMentionGroupId,
          hasPostPrefix: !!config.slackPostPrefix,
          hasThreadStatePath: !!config.threadStatePath,
        });
        return config;
      } catch (error) {
        debug("config", `Failed to parse config at ${configPath}`, { error: String(error) });
        // Continue to next config path
      }
    }
  }
  debug("config", "No global config found");
  return {};
}

function loadDotEnv(): void {
  // プロジェクトディレクトリの .env を読み込む
  const cwd = process.cwd();
  const envPath = join(cwd, ".env");

  debug("env", "Environment loading context", {
    cwd,
    envPath,
    argv: process.argv,
    execPath: process.execPath,
  });

  debug("env", `Checking .env file`, { path: envPath, exists: existsSync(envPath) });

  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, "utf-8");
      const loadedKeys: string[] = [];
      const skippedKeys: string[] = [];

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const [key, ...valueParts] = trimmed.split("=");
          const value = valueParts.join("=").replace(/^["']|["']$/g, "");
          if (key && !process.env[key]) {
            process.env[key] = value;
            loadedKeys.push(key);
          } else if (key && process.env[key]) {
            skippedKeys.push(key);
          }
        }
      }

      debug("env", "Loaded .env file", {
        loadedKeys,
        skippedKeys,
        skippedReason: "Already set in environment",
      });
    } catch (error) {
      debug("env", "Failed to read .env file", { error: String(error) });
      // Ignore .env read errors
    }
  } else {
    debug("env", ".env file not found, skipping");
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
  debug("resolve", "Starting config resolution");

  // .env ファイルを読み込み
  loadDotEnv();

  // グローバル設定を読み込み
  const globalConfig = loadGlobalConfig();

  // 優先順位: 環境変数 > グローバル設定
  const slackBotToken =
    process.env.SLACK_BOT_TOKEN || globalConfig.slackBotToken;
  const slackDefaultChannel =
    process.env.SLACK_DEFAULT_CHANNEL || globalConfig.slackDefaultChannel;

  debug("resolve", "Token resolution", {
    fromEnv: !!process.env.SLACK_BOT_TOKEN,
    fromGlobalConfig: !!globalConfig.slackBotToken,
    resolved: !!slackBotToken,
  });

  debug("resolve", "Channel resolution", {
    fromEnv: process.env.SLACK_DEFAULT_CHANNEL,
    fromGlobalConfig: globalConfig.slackDefaultChannel,
    resolved: slackDefaultChannel,
  });

  if (!slackBotToken) {
    console.error("Error: SLACK_BOT_TOKEN is not set");
    console.error("Set it via environment variable, .env file, or global config");
    console.error(`Global config paths: ${GLOBAL_CONFIG_PATHS.join(", ")}`);
    debug("resolve", "SLACK_BOT_TOKEN not found - exiting");
    process.exit(1);
  }

  if (!slackDefaultChannel) {
    console.error("Error: SLACK_DEFAULT_CHANNEL is not set");
    debug("resolve", "SLACK_DEFAULT_CHANNEL not found - exiting");
    process.exit(1);
  }

  const mentionUserIdsRaw =
    process.env.SLACK_MENTION_USER_IDS ||
    globalConfig.slackMentionUserIds?.join(",");
  const slackMentionUserIds = mentionUserIdsRaw
    ? mentionUserIdsRaw.split(",").map((id) => id.trim())
    : undefined;

  const resolvedConfig = {
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

  debug("resolve", "Final resolved config", {
    hasToken: !!resolvedConfig.slackBotToken,
    channel: resolvedConfig.slackDefaultChannel,
    mentionUserIds: resolvedConfig.slackMentionUserIds,
    mentionGroupId: resolvedConfig.slackMentionGroupId,
    postPrefix: resolvedConfig.slackPostPrefix,
    threadStatePath: resolvedConfig.threadStatePath,
  });

  return resolvedConfig;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
    // タイムアウト: 100ms以内にデータがなければ空文字を返す
    setTimeout(() => {
      if (data === "") {
        process.stdin.removeAllListeners();
        resolve("");
      }
    }, 100);
  });
}

// Claude Code hooks から渡されるJSONデータの型定義
// https://code.claude.com/docs/en/hooks
interface StdinData {
  // 共通フィールド（すべてのフックイベント）
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: "default" | "plan" | "acceptEdits" | "dontAsk" | "bypassPermissions";
  hook_event_name?: "PreToolUse" | "PostToolUse" | "Notification" | "Stop" | "SubagentStop" | "PreCompact" | "SessionStart" | "SessionEnd" | "UserPromptSubmit";

  // PreToolUse / PostToolUse 固有
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  tool_use_id?: string;

  // Notification 固有
  message?: string;
  notification_type?: "permission_prompt" | "idle_prompt" | "auth_success" | "elicitation_dialog";

  // UserPromptSubmit 固有
  prompt?: string;

  // Stop / SubagentStop 固有
  stop_hook_active?: boolean;

  // SessionStart 固有
  source?: "startup" | "resume" | "clear" | "compact";

  // SessionEnd 固有
  reason?: "clear" | "logout" | "prompt_input_exit" | "other";

  // PreCompact 固有
  trigger?: "manual" | "auto";
  custom_instructions?: string;

  // その他のフィールド
  [key: string]: unknown;
}

async function parseArgs(args: string[]): Promise<{ command: string; options: Record<string, string>; stdinData: StdinData | null }> {
  const command = args[0] || "help";
  const options: Record<string, string> = {};
  let stdinData: StdinData | null = null;

  // --stdinオプションがあるか確認
  const useStdin = args.includes("--stdin");

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && arg !== "--stdin") {
      const [key, ...valueParts] = arg.slice(2).split("=");
      options[key] = valueParts.join("=") || "true";
    }
  }

  // --stdinオプションがある場合、標準入力からJSONを読み取る
  if (useStdin) {
    debug("stdin", "Reading from stdin");
    const stdinContent = await readStdin();
    debug("stdin", "Stdin content (raw)", { content: stdinContent });

    // デバッグ用: 標準入力の内容をファイルに出力
    const debugLogPath = process.env.SLACK_THREAD_STDIN_LOG;
    if (debugLogPath) {
      try {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] command=${command} stdin=${stdinContent}\n`;
        appendFileSync(debugLogPath, logEntry);
      } catch {
        // ログ出力失敗は無視
      }
    }

    if (stdinContent) {
      try {
        stdinData = JSON.parse(stdinContent) as StdinData;
        debug("stdin", "Parsed stdin JSON", stdinData);

        // session_idがあればjob-idとして使用（オプションで上書きされていなければ）
        if (stdinData.session_id && !options["job-id"]) {
          options["job-id"] = stdinData.session_id;
          debug("stdin", "Using session_id as job-id", { jobId: stdinData.session_id });
        }

        // hook_event_nameを内部オプションとして保存
        if (stdinData.hook_event_name) {
          options["_hook_event"] = stdinData.hook_event_name;
        }

        // tool_nameがあれば内部オプションとして保存
        if (stdinData.tool_name) {
          options["_tool_name"] = stdinData.tool_name;
        }

        // notification_typeがあれば内部オプションとして保存
        if (stdinData.notification_type) {
          options["_notification_type"] = stdinData.notification_type;
        }

        // promptがあれば内部オプションとして保存（UserPromptSubmit用）
        if (stdinData.prompt) {
          options["_prompt"] = stdinData.prompt;
        }

        // messageがあれば内部オプションとして保存（Notification用）
        if (stdinData.message) {
          options["_message"] = stdinData.message;
        }

        // transcript_pathがあれば内部オプションとして保存（Stop用）
        if (stdinData.transcript_path) {
          options["_transcript_path"] = stdinData.transcript_path;
        }

        // cwdがあれば内部オプションとして保存
        if (stdinData.cwd) {
          options["_cwd"] = stdinData.cwd;
        }
      } catch (error) {
        debug("stdin", "Failed to parse stdin as JSON", { error: String(error) });
      }
    }
  }

  // --save-envオプションがある場合、環境変数をCLAUDE_ENV_FILEに保存
  const saveEnv = args.includes("--save-env");
  if (saveEnv) {
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile) {
      try {
        const envLines: string[] = [];

        // job-idを保存
        if (options["job-id"]) {
          envLines.push(`SLACK_THREAD_JOB_ID=${options["job-id"]}`);
        }

        // Slack関連の環境変数を保存（既に設定されていれば）
        const slackEnvVars = [
          "SLACK_BOT_TOKEN",
          "SLACK_DEFAULT_CHANNEL",
          "SLACK_MENTION_USER_IDS",
          "SLACK_MENTION_GROUP_ID",
          "SLACK_POST_PREFIX",
          "THREAD_STATE_PATH",
        ];

        for (const varName of slackEnvVars) {
          if (process.env[varName]) {
            envLines.push(`${varName}=${process.env[varName]}`);
          }
        }

        if (envLines.length > 0) {
          appendFileSync(envFile, envLines.join("\n") + "\n");
          debug("save-env", "Saved environment variables to CLAUDE_ENV_FILE", {
            envFile,
            savedVars: envLines.map(l => l.split("=")[0]),
          });
        }
      } catch (error) {
        debug("save-env", "Failed to save to CLAUDE_ENV_FILE", { error: String(error) });
      }
    } else {
      debug("save-env", "CLAUDE_ENV_FILE not set, skipping save");
    }
  }

  return { command, options, stdinData };
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
  --stdin             Read JSON from stdin (for Claude Code hooks)
                      Automatically extracts session_id as job-id
  --save-env          Save job-id and Slack config to CLAUDE_ENV_FILE
  --job-id=<id>       Job identifier (or use --stdin / SLACK_THREAD_JOB_ID)
  --title=<title>     Job title (for start or lazy thread creation)
  --silent            Don't post to Slack (for start: only save env vars)
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
  SLACK_THREAD_JOB_ID     Default job-id (set by --save-env in SessionStart)

Global Config:
  ~/.config/slack-thread-mcp/config.json
  ~/.slack-thread-mcp.json

Examples:
  # Standard usage
  slack-thread-mcp start --job-id=abc123 --title="Deploy to production"
  slack-thread-mcp update --job-id=abc123 --message="Building..."
  slack-thread-mcp complete --job-id=abc123 --summary="Deployed successfully"

  # Claude Code hooks (SessionStart saves job-id, others auto-use it)
  slack-thread-mcp start --stdin --save-env --title="Task"  # SessionStart
  slack-thread-mcp update --message="Running"                # Uses SLACK_THREAD_JOB_ID
  slack-thread-mcp complete --summary="Done"                 # Uses SLACK_THREAD_JOB_ID
`);
}

// 遅延初期化: スレッドがなければ作成する
interface LazyInitResult {
  threadTs: string;
  channel: string;
  title: string;
  created: boolean;
}

async function ensureThread(
  jobId: string,
  threadStore: ThreadStore,
  slackClient: SlackClient,
  channel: string,
  titleOverride?: string,
  cwdHint?: string,
  mention: boolean = true
): Promise<LazyInitResult> {
  const state = threadStore.get(jobId);

  // 既存のスレッドがあり、thread_tsが設定されている場合はそれを返す
  if (state?.threadTs) {
    debug("lazy-init", "Using existing thread", { jobId, threadTs: state.threadTs });
    return {
      threadTs: state.threadTs,
      channel: state.channel,
      title: state.title,
      created: false,
    };
  }

  // スレッドを作成する必要がある
  // タイトルの優先順位: オプション指定 > 既存state > cwdから生成 > デフォルト
  let title = titleOverride || state?.title;
  if (!title && cwdHint) {
    // cwdからディレクトリ名を取得
    const parts = cwdHint.split("/").filter(Boolean);
    title = parts.length > 0 ? parts[parts.length - 1] : "Claude Code Task";
  }
  title = title || "Claude Code Task";

  debug("lazy-init", "Creating thread lazily", { jobId, title, channel });

  const result = await slackClient.postParentMessage(
    channel,
    title,
    undefined,
    mention
  );

  if (!result.ok) {
    throw new Error("Failed to create Slack thread");
  }

  // スレッド状態を作成または更新
  if (state) {
    // 既存のプレースホルダー状態を更新
    threadStore.updateThreadTs(jobId, result.ts, result.permalink);
    debug("lazy-init", "Updated placeholder thread state", { jobId, threadTs: result.ts });
  } else {
    // 新規作成
    threadStore.create(jobId, result.channel, result.ts, title, result.permalink);
    debug("lazy-init", "Created new thread state", { jobId, threadTs: result.ts });
  }

  return {
    threadTs: result.ts,
    channel: result.channel,
    title,
    created: true,
  };
}

async function main(): Promise<void> {
  debug("main", "CLI started", {
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    ppid: process.ppid,
  });

  const args = process.argv.slice(2);
  const { command, options, stdinData } = await parseArgs(args);

  debug("main", "Parsed arguments", { command, options, stdinData, rawArgs: args });

  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const config = resolveConfig();

  debug("main", "Creating SlackClient");
  const slackClient = new SlackClient({
    botToken: config.slackBotToken,
    defaultChannel: config.slackDefaultChannel,
    mentionUserIds: config.slackMentionUserIds,
    mentionGroupId: config.slackMentionGroupId,
    postPrefix: config.slackPostPrefix,
  });

  debug("main", "Creating ThreadStore", { statePath: config.threadStatePath });
  const threadStore = new ThreadStore(config.threadStatePath);

  // job-idの解決: オプション > 環境変数SLACK_THREAD_JOB_ID
  const jobIdResolved = options["job-id"] || process.env.SLACK_THREAD_JOB_ID;
  if (!jobIdResolved && command !== "help") {
    console.error("Error: --job-id is required (or set SLACK_THREAD_JOB_ID)");
    debug("main", "Missing job-id - exiting");
    process.exit(1);
  }
  const jobId = jobIdResolved as string;  // 上記でexitしているため安全
  debug("main", "Resolved job-id", {
    fromOption: options["job-id"],
    fromEnv: process.env.SLACK_THREAD_JOB_ID,
    resolved: jobId,
  });

  const channel = options.channel || config.slackDefaultChannel;
  // メンションのデフォルト:
  // - start: true
  // - update: true（ただしPostToolUseイベントはfalse）
  // - それ以外: false
  const hookEvent = options["_hook_event"];
  const isPostToolUse = hookEvent === "PostToolUse";
  const mentionDefault = command === "start" || (command === "update" && !isPostToolUse);
  const mention = options.mention === "true" ? true : options.mention === "false" ? false : mentionDefault;

  debug("main", "Execution context", { jobId, channel, mention, command });

  try {
    switch (command) {
      case "start": {
        const silent = options.silent === "true" || args.includes("--silent");
        debug("cmd:start", "Processing start command", { jobId, title: options.title, silent });

        const title = options.title || "Claude Code Task";

        // 冪等性: 既存のジョブがあれば再利用
        const existing = threadStore.get(jobId);
        debug("cmd:start", "Checking existing thread", { jobId, exists: !!existing });

        if (existing) {
          debug("cmd:start", "Reusing existing thread", existing);
          console.log(JSON.stringify({
            job_id: existing.jobId,
            channel: existing.channel,
            thread_ts: existing.threadTs,
            permalink: existing.permalink,
            note: "Reused existing thread",
          }));
          break;
        }

        // silentモード: Slack投稿せずにjob-idの保存のみ（遅延初期化用）
        if (silent) {
          debug("cmd:start", "Silent mode - skipping Slack post, only saving job-id");
          // 最低限のスレッド状態を作成（thread_tsは後で遅延初期化時に設定）
          const state = threadStore.create(
            jobId,
            channel,
            "",  // thread_tsは空（未作成）
            title,
            undefined
          );
          debug("cmd:start", "Created placeholder thread state", state);
          console.log(JSON.stringify({
            job_id: state.jobId,
            channel: state.channel,
            thread_ts: "",
            note: "Silent mode - thread will be created lazily",
          }));
          break;
        }

        let meta: Record<string, unknown> | undefined;
        if (options.meta) {
          try {
            meta = JSON.parse(options.meta);
            debug("cmd:start", "Parsed meta", meta);
          } catch {
            console.error("Error: --meta must be valid JSON");
            process.exit(1);
          }
        }

        debug("cmd:start", "Posting parent message to Slack", { channel, title, hasMeta: !!meta, mention });
        const result = await slackClient.postParentMessage(
          channel,
          title,
          meta,
          mention
        );

        debug("cmd:start", "Slack API response", { ok: result.ok, channel: result.channel, ts: result.ts });

        if (!result.ok) {
          console.error("Error: Failed to post to Slack");
          debug("cmd:start", "Failed to post - exiting");
          process.exit(1);
        }

        const state = threadStore.create(
          jobId,
          result.channel,
          result.ts,
          title,
          result.permalink
        );

        debug("cmd:start", "Thread state created", state);

        console.log(JSON.stringify({
          job_id: state.jobId,
          channel: state.channel,
          thread_ts: state.threadTs,
          permalink: state.permalink,
        }));
        break;
      }

      case "update": {
        debug("cmd:update", "Processing update command", { jobId, message: options.message, level: options.level, hookEvent });

        // upsertモード: PostToolUseイベント時のみメッセージを上書き
        // 明示的に--upsert=trueが指定された場合も上書き
        let useUpsert = options.upsert === "true" || isPostToolUse;

        // メッセージの生成: --message > prompt自動生成 > tool詳細自動生成 > エラー
        let message = options.message;

        // UserPromptSubmitイベントでpromptがある場合は自動生成
        // 新しいプロンプトなので新しいメッセージを投稿（上書きしない）
        if (!message && hookEvent === "UserPromptSubmit" && options["_prompt"]) {
          const prompt = options["_prompt"];
          const truncated = prompt.length > 100 ? prompt.slice(0, 100) + "..." : prompt;
          message = `*Prompt:* ${truncated}`;
          debug("cmd:update", "Auto-generated message from prompt", { promptLength: prompt.length });
          // UserPromptSubmitでは新しいメッセージを投稿するため、upsertを無効化しProgressMessageTsをクリア
          useUpsert = false;
          threadStore.clearProgressMessageTs(jobId);
          debug("cmd:update", "Cleared progressMessageTs for new prompt (upsert disabled)");
        }

        // PostToolUseイベントでtool_nameがある場合は詳細情報を含めて自動生成
        if (!message && stdinData?.tool_name) {
          const toolName = stdinData.tool_name;
          const toolInput = stdinData.tool_input;

          // ツール別に詳細情報を生成
          let details = "";
          if (toolInput) {
            if (toolName === "Read" && toolInput.file_path) {
              details = `\`${toolInput.file_path}\``;
            } else if (toolName === "Write" && toolInput.file_path) {
              details = `\`${toolInput.file_path}\``;
            } else if (toolName === "Edit" && toolInput.file_path) {
              details = `\`${toolInput.file_path}\``;
            } else if (toolName === "Bash" && toolInput.command) {
              const cmd = String(toolInput.command);
              details = `\`${cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd}\``;
            } else if (toolName === "Glob" && toolInput.pattern) {
              details = `\`${toolInput.pattern}\``;
            } else if (toolName === "Grep" && toolInput.pattern) {
              details = `\`${toolInput.pattern}\``;
            } else if (toolName === "Task" && toolInput.description) {
              details = String(toolInput.description);
            }
          }

          message = details ? `*${toolName}*: ${details}` : `*${toolName}*`;
          debug("cmd:update", "Auto-generated message from tool details", { toolName, details });
        }

        // Stopイベントでtranscript_pathがある場合は応答内容を取得
        // PostToolUseのメッセージがあれば上書きし、なければ新規投稿
        if (!message && hookEvent === "Stop" && options["_transcript_path"]) {
          const lastResponse = getLastAssistantResponse(options["_transcript_path"]);
          if (lastResponse) {
            message = `*Response:* ${lastResponse}`;
            debug("cmd:update", "Auto-generated message from transcript", { responseLength: lastResponse.length });
          } else {
            message = "応答完了";
            debug("cmd:update", "Using default message (no response found in transcript)");
          }
          // PostToolUseのメッセージがあれば上書き、なければ新規投稿
          const existingTs = threadStore.getProgressMessageTs(jobId);
          if (existingTs) {
            useUpsert = true;
            debug("cmd:update", "Stop event will overwrite PostToolUse message", { existingTs });
          } else {
            useUpsert = false;
            debug("cmd:update", "Stop event will create new message (no PostToolUse message)");
          }
          // Stopイベント後は新しいプロンプトに備えてクリア
          // （upsert後にクリアするため、ここではクリアしない）
        }

        if (!message) {
          console.error("Error: --message is required for update command");
          process.exit(1);
        }

        // 遅延初期化: スレッドがなければ作成
        const thread = await ensureThread(
          jobId,
          threadStore,
          slackClient,
          channel,
          options.title,
          options["_cwd"],
          mention
        );

        debug("cmd:update", "Thread lookup (lazy init)", {
          jobId,
          threadTs: thread.threadTs,
          channel: thread.channel,
          created: thread.created,
          useUpsert,
        });

        if (threadStore.isTerminal(jobId)) {
          debug("cmd:update", "Job already terminated", { status: threadStore.get(jobId)?.status });
          console.log(JSON.stringify({ ok: false, reason: "Job already terminated" }));
          break;
        }

        threadStore.updateStatus(jobId, "in_progress");
        debug("cmd:update", "Updated job status to in_progress");

        const level = (options.level || "info") as "info" | "warn" | "debug";

        // upsertモードの場合は既存メッセージを上書き
        const existingMessageTs = useUpsert ? threadStore.getProgressMessageTs(jobId) : undefined;
        debug("cmd:update", "Posting thread reply", { channel: thread.channel, threadTs: thread.threadTs, level, mention, useUpsert, existingMessageTs });

        const result = await slackClient.upsertThreadReply(
          thread.channel,
          thread.threadTs,
          message,
          level,
          mention,
          existingMessageTs
        );

        // 投稿したメッセージのtsを保存（次回の上書き用）
        // ただしStopイベントの場合は次のプロンプトに備えてクリア
        if (result.ok && result.ts) {
          if (hookEvent === "Stop") {
            threadStore.clearProgressMessageTs(jobId);
            debug("cmd:update", "Cleared progressMessageTs after Stop event");
          } else if (useUpsert) {
            threadStore.updateProgressMessageTs(jobId, result.ts);
            debug("cmd:update", "Saved progress message ts", { ts: result.ts });
          }
        }

        debug("cmd:update", "Slack API response", { ok: result.ok, ts: result.ts });
        console.log(JSON.stringify({ ok: result.ok, ts: result.ts }));
        break;
      }

      case "waiting": {
        debug("cmd:waiting", "Processing waiting command", { jobId, reason: options.reason });

        // 遅延初期化: スレッドがなければ作成
        const thread = await ensureThread(
          jobId,
          threadStore,
          slackClient,
          channel,
          options.title,
          options["_cwd"],
          mention
        );

        debug("cmd:waiting", "Thread lookup (lazy init)", {
          jobId,
          threadTs: thread.threadTs,
          channel: thread.channel,
          title: thread.title,
          created: thread.created,
        });

        if (threadStore.isTerminal(jobId)) {
          debug("cmd:waiting", "Job already terminated", { status: threadStore.get(jobId)?.status });
          console.log(JSON.stringify({ ok: false, reason: "Job already terminated" }));
          break;
        }

        // reasonの生成: --reason > message自動生成 > notification_type自動生成 > デフォルト
        let reason = options.reason;

        // Notificationイベントでmessageがある場合は使用
        if (!reason && options["_message"]) {
          reason = options["_message"];
          debug("cmd:waiting", "Using message from Notification event", { message: reason });
        }

        // notification_typeがある場合はプレフィックスを追加
        if (!reason && options["_notification_type"]) {
          // Notificationイベントでnotification_typeがある場合は自動生成
          const typeMap: Record<string, string> = {
            "permission_prompt": "権限確認待ち",
            "idle_prompt": "アイドル状態",
            "auth_success": "認証成功",
            "elicitation_dialog": "追加情報の入力待ち",
          };
          reason = typeMap[options["_notification_type"]] || options["_notification_type"];
          debug("cmd:waiting", "Auto-generated reason from notification_type", { notificationType: options["_notification_type"] });
        }

        if (!reason) {
          reason = "Waiting for permission or user input";
        }

        // PostToolUseのメッセージがあれば上書き
        const existingMessageTs = threadStore.getProgressMessageTs(jobId);
        debug("cmd:waiting", "Posting waiting message", {
          channel: thread.channel,
          threadTs: thread.threadTs,
          title: thread.title,
          reason,
          mention,
          existingMessageTs,
        });

        const result = await slackClient.postWaiting(
          thread.channel,
          thread.threadTs,
          thread.title,
          reason,
          mention,
          existingMessageTs
        );

        // waiting後は次のプロンプトに備えてクリア
        if (result.ok) {
          threadStore.clearProgressMessageTs(jobId);
          debug("cmd:waiting", "Cleared progressMessageTs after waiting");
        }

        debug("cmd:waiting", "Slack API response", { ok: result.ok });
        console.log(JSON.stringify({ ok: result.ok }));
        break;
      }

      case "complete": {
        debug("cmd:complete", "Processing complete command", { jobId, summary: options.summary });

        // 遅延初期化: スレッドがなければ作成
        const thread = await ensureThread(
          jobId,
          threadStore,
          slackClient,
          channel,
          options.title,
          options["_cwd"],
          mention
        );

        debug("cmd:complete", "Thread lookup (lazy init)", {
          jobId,
          threadTs: thread.threadTs,
          channel: thread.channel,
          title: thread.title,
          created: thread.created,
        });

        // 冪等性: 既に終了済みなら何もしない
        if (threadStore.isTerminal(jobId)) {
          debug("cmd:complete", "Job already terminated (idempotent)", { status: threadStore.get(jobId)?.status });
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
          debug("cmd:complete", "Parsed nextSuggestions", nextSuggestions);
        }

        debug("cmd:complete", "Posting complete message", { channel: thread.channel, threadTs: thread.threadTs, title: thread.title, mention });

        const result = await slackClient.postComplete(
          thread.channel,
          thread.threadTs,
          thread.title,
          options.summary,
          nextSuggestions,
          mention
        );

        debug("cmd:complete", "Slack API response", { ok: result.ok });

        if (result.ok) {
          threadStore.updateStatus(jobId, "completed");
          debug("cmd:complete", "Updated job status to completed");
        }

        console.log(JSON.stringify({ ok: result.ok }));
        break;
      }

      case "fail": {
        debug("cmd:fail", "Processing fail command", { jobId, error: options.error, logsHint: options["logs-hint"] });

        const errorSummary = options.error;
        if (!errorSummary) {
          console.error("Error: --error is required for fail command");
          process.exit(1);
        }

        // 遅延初期化: スレッドがなければ作成
        const thread = await ensureThread(
          jobId,
          threadStore,
          slackClient,
          channel,
          options.title,
          options["_cwd"],
          mention
        );

        debug("cmd:fail", "Thread lookup (lazy init)", {
          jobId,
          threadTs: thread.threadTs,
          channel: thread.channel,
          title: thread.title,
          created: thread.created,
        });

        // 冪等性: 既に終了済みなら何もしない
        if (threadStore.isTerminal(jobId)) {
          debug("cmd:fail", "Job already terminated (idempotent)", { status: threadStore.get(jobId)?.status });
          console.log(JSON.stringify({ ok: true, note: "Job already terminated" }));
          break;
        }

        debug("cmd:fail", "Posting fail message", { channel: thread.channel, threadTs: thread.threadTs, title: thread.title, errorSummary, mention });

        const result = await slackClient.postFail(
          thread.channel,
          thread.threadTs,
          thread.title,
          errorSummary,
          options["logs-hint"],
          mention
        );

        debug("cmd:fail", "Slack API response", { ok: result.ok });

        if (result.ok) {
          threadStore.updateStatus(jobId, "failed");
          debug("cmd:fail", "Updated job status to failed");
        }

        console.log(JSON.stringify({ ok: result.ok }));
        break;
      }

      default:
        debug("main", "Unknown command", { command });
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }

    debug("main", "Command completed successfully", { command });
  } catch (error) {
    debug("main", "Unhandled error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
