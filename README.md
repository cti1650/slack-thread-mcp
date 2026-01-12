# Slack Thread Progress Notifier（作成中）

Claude Code / Claude Desktop から Slack スレッドに進捗通知を送信するツールです。

**MCP サーバー** と **CLI** の2つの方法で利用できます。

1つのジョブ（指示）につき1つの Slack スレッドを作成し、開始・進捗・完了/失敗通知を同一スレッドに集約します。

## 特徴

- **2つの利用方法**: MCP サーバーまたは CLI から利用可能
- **スレッド集約**: 1ジョブ = 1スレッドで通知をまとめる
- **メンションポリシー**: 完了/失敗/待機時にメンション（進捗ではメンションしない）
  - デフォルトは `@channel` でチャンネル全体に通知
  - ユーザーID/グループID指定時は個別メンション
- **待機検知**: 権限確認やユーザー入力待ちで処理が停止した場合に自動通知
- **冪等性**: 同一 job_id の重複呼び出しは既存スレッドを再利用
- **状態永続化**: オプションでスレッド状態をファイルに保存

## セットアップ

### 1. Slack Bot の準備

#### 方法A: マニフェストから作成（推奨）

1. [Slack API](https://api.slack.com/apps) で「Create New App」→「From an app manifest」を選択
2. ワークスペースを選択
3. 以下のマニフェストを貼り付け:

```yaml
display_information:
  name: Slack Thread Notifier
  description: Claude Code / Claude Desktop からの進捗通知を Slack スレッドに投稿するBot
  background_color: "#4A154B"
features:
  bot_user:
    display_name: Thread Notifier
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

4. 「Create」→「Install to Workspace」でインストール
5. 「OAuth & Permissions」から Bot User OAuth Token (`xoxb-...`) をコピー

#### 方法B: 手動で作成

1. [Slack API](https://api.slack.com/apps) で「Create New App」→「From scratch」を選択
2. 「OAuth & Permissions」→ Bot Token Scopes に以下を追加:
   - `chat:write`
   - `chat:write.public`（パブリックチャンネルへの投稿用）
3. ワークスペースにインストールし、Bot User OAuth Token を取得

### 2. 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `SLACK_BOT_TOKEN` | ✅ | Slack Bot Token (`xoxb-...`) |
| `SLACK_DEFAULT_CHANNEL` | ✅ | デフォルトの投稿先チャンネル（ID または名前） |
| `SLACK_MENTION_USER_IDS` | | メンションするユーザーID（カンマ区切り）。指定時は `@channel` の代わりに個別メンション |
| `SLACK_MENTION_GROUP_ID` | | メンションするユーザーグループID。指定時は `@channel` の代わりに個別メンション |
| `SLACK_POST_PREFIX` | | 投稿の先頭に付けるプレフィックス（例: `[MyProject]`） |
| `THREAD_STATE_PATH` | | スレッド状態の永続化パス（例: `~/.cache/slack-thread-mcp/threads.json`） |

**メンションの動作:**
- `SLACK_MENTION_USER_IDS` と `SLACK_MENTION_GROUP_ID` が両方とも未指定の場合: `@channel` でチャンネル全体にメンション
- いずれかを指定した場合: 指定されたユーザー/グループのみにメンション

### 3. Claude Code (CLI) への組み込み

```bash
claude mcp add slack-thread -s user -- npx -y github:cti1650/slack-thread-mcp

# 環境変数を設定（~/.claude/.env に追加するか、シェルの環境変数として設定）
export SLACK_BOT_TOKEN="xoxb-your-token"
export SLACK_DEFAULT_CHANNEL="C0123456789"
```

または、環境変数を含めてワンライナーで追加：

```bash
claude mcp add slack-thread -s user \
  -e SLACK_BOT_TOKEN=xoxb-your-token \
  -e SLACK_DEFAULT_CHANNEL=C0123456789 \
  -- npx -y github:cti1650/slack-thread-mcp
```

**スコープオプション:**
- `-s user`: ユーザー全体で有効
- `-s project`: 現在のプロジェクトのみで有効

### 4. Claude Desktop への組み込み

`claude_desktop_config.json` に以下を追加:

**Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "slack-thread": {
      "command": "npx",
      "args": ["-y", "github:cti1650/slack-thread-mcp"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-your-token",
        "SLACK_DEFAULT_CHANNEL": "C0123456789",
        "SLACK_MENTION_USER_IDS": "U0123456789"
      }
    }
  }
}
```

## MCP ツール

### `slack_thread_start`

新しいジョブのスレッドを作成します。

**入力:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Terraform apply",
  "channel": "C0123456789",
  "meta": {
    "repo": "my-infra",
    "branch": "main"
  }
}
```

**出力:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "channel": "C0123456789",
  "thread_ts": "1234567890.123456",
  "permalink": "https://workspace.slack.com/archives/..."
}
```

### `slack_thread_update`

進捗を同スレッドに返信します（メンションなし）。

**入力:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "message": "リソースを作成中... (3/10)",
  "level": "info"
}
```

### `slack_thread_waiting`

処理が一時停止していることを通知します（権限確認やユーザー入力待ちの際に使用）。

**入力:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "reason": "権限確認待ち（YES/NO の入力が必要です）",
  "mention": true
}
```

**自動検知:**
`slack_thread_update` 呼び出し後、30秒間次のツール呼び出しがない場合、自動的に「処理が一時停止しています」と通知されます。この機能は `enable_waiting_monitor: false` で無効化できます。

### `slack_thread_complete`

完了を同スレッドに返信します（メンションあり）。

**入力:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "summary": "10個のリソースを作成しました",
  "next_suggestions": [
    "terraform plan で差分を確認",
    "terraform destroy でクリーンアップ"
  ],
  "mention": true
}
```

### `slack_thread_fail`

失敗を同スレッドに返信します（メンションあり）。

**入力:**
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "error_summary": "S3バケットの作成に失敗しました",
  "logs_hint": "terraform apply 2>&1 | tail -50",
  "mention": true
}
```

## Slack 投稿フォーマット

### 開始（親メッセージ）
```
🚀 *Started:* Terraform apply
• repo: my-infra
• branch: main
```

### 進捗
```
⏳ リソースを作成中... (3/10)
```

### 待機
```
⏸️ *Waiting:* Terraform apply
権限確認待ち（YES/NO の入力が必要です）

@channel
```

### 完了
```
✅ *Done:* Terraform apply
10個のリソースを作成しました

*次の候補:*
• terraform plan で差分を確認
• terraform destroy でクリーンアップ

@channel
```

### 失敗
```
❌ *Failed:* Terraform apply
S3バケットの作成に失敗しました

*ログ:* terraform apply 2>&1 | tail -50

@channel
```

## CLI 利用方法

MCP サーバーの代わりに CLI から直接 Slack に通知を送信できます。Claude Code の Hooks や Bash ツールから呼び出す場合に便利です。

### CLI コマンド

```bash
# スレッド作成
npx slack-thread-mcp start --job-id=<id> --title="タスク名"

# 進捗更新
npx slack-thread-mcp update --job-id=<id> --message="進捗メッセージ"

# 待機通知
npx slack-thread-mcp waiting --job-id=<id> --reason="権限確認待ち"

# 完了通知
npx slack-thread-mcp complete --job-id=<id> --summary="完了サマリ"

# 失敗通知
npx slack-thread-mcp fail --job-id=<id> --error="エラー内容"

# ヘルプ
npx slack-thread-mcp help
```

### CLI オプション

| オプション | 説明 |
|-----------|------|
| `--job-id=<id>` | ジョブID（必須） |
| `--title=<title>` | ジョブタイトル（start時必須） |
| `--message=<msg>` | 進捗メッセージ（update時必須） |
| `--level=<level>` | メッセージレベル: info, warn, debug（デフォルト: info） |
| `--reason=<reason>` | 待機理由（waiting時） |
| `--summary=<text>` | 完了サマリ（complete時） |
| `--error=<text>` | エラー概要（fail時必須） |
| `--logs-hint=<text>` | ログのヒント（fail時） |
| `--channel=<ch>` | チャンネルを上書き |
| `--mention=<bool>` | メンションの有効/無効（デフォルト: true） |
| `--meta=<json>` | 追加メタデータ（JSON形式、start時） |
| `--thread-ts=<ts>` | スレッドタイムスタンプ（job_idでスレッドが見つからない場合） |

### 環境変数の設定（CLI用）

CLI は以下の優先順位で設定を読み込みます:

1. 環境変数
2. カレントディレクトリの `.env` ファイル
3. グローバル設定ファイル (`~/.config/slack-thread-mcp/config.json` または `~/.slack-thread-mcp.json`)

**`.env` ファイルの例:**

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_DEFAULT_CHANNEL=C0123456789
THREAD_STATE_PATH=~/.local/share/slack-thread-mcp/threads.json
```

**グローバル設定ファイルの例:**

```json
{
  "slackBotToken": "xoxb-your-bot-token",
  "slackDefaultChannel": "C0123456789",
  "slackMentionUserIds": ["U0123456789"],
  "threadStatePath": "~/.local/share/slack-thread-mcp/threads.json"
}
```

### Claude Code での CLI 許可設定

`.claude/settings.local.json` に以下を追加して、確認なしで CLI を実行できるようにします:

```json
{
  "permissions": {
    "allow": [
      "Bash(npx slack-thread-mcp *)",
      "Bash(npx slack-notify *)"
    ]
  }
}
```

### Claude Code Hooks での利用

Claude Code の Hooks 機能と組み合わせて、自動的に Slack 通知を送信できます。

**設定例 (`.claude/settings.json`):**

```json
{
  "permissions": {
    "allow": [
      "Bash(npx slack-thread-mcp *)",
      "Bash(npx slack-notify *)"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "SESSION_ID=$(cat | jq -r '.session_id // empty'); if [ -n \"$SESSION_ID\" ]; then echo \"CLAUDE_SESSION_ID=$SESSION_ID\" >> \"$CLAUDE_ENV_FILE\"; fi; if [ -f \"${CLAUDE_PROJECT_DIR}/.env\" ]; then set -a && source \"${CLAUDE_PROJECT_DIR}/.env\" && set +a && env | grep -E '^SLACK_|^THREAD_STATE_PATH=' >> \"$CLAUDE_ENV_FILE\"; fi"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx slack-thread-mcp start --job-id=${CLAUDE_SESSION_ID:-$(uuidgen)} --title=\"Claude Code Task\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "TOOL_NAME=$(cat | jq -r '.tool_name // \"unknown\"'); npx slack-thread-mcp update --job-id=${CLAUDE_SESSION_ID:-default} --message=\"Tool: $TOOL_NAME\""
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "TOOL_NAME=$(cat | jq -r '.tool_name // \"unknown\"'); npx slack-thread-mcp waiting --job-id=${CLAUDE_SESSION_ID:-default} --reason=\"権限確認待ち: $TOOL_NAME\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx slack-thread-mcp update --job-id=${CLAUDE_SESSION_ID:-default} --message=\"応答完了\" --level=debug"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx slack-thread-mcp complete --job-id=${CLAUDE_SESSION_ID:-default} --summary=\"Session completed\""
          }
        ]
      }
    ]
  }
}
```

**ポイント:**
- `SessionStart` フックで stdin から `session_id` を抽出し、`CLAUDE_SESSION_ID` 環境変数として永続化します
- `SessionStart` フックでプロジェクトの `.env` ファイルも読み込み、環境変数をセッション全体で利用可能にします
- `UserPromptSubmit` フックでユーザー入力時にスレッドを作成します（冪等性により同一セッションでは再利用）
  - フォールバックとして `uuidgen` を使用し、並列実行時も一意のジョブIDを保証します
- `PostToolUse` フックでツール実行後に進捗を通知します（`matcher: "*"` で全ツールにマッチ）
  - stdin から `tool_name` を取得して通知メッセージに含めます
- `PermissionRequest` フックで権限確認待ち時にメンション付きで通知します
- `Stop` フックで各応答完了時に進捗更新します（`complete` ではなく `update` を使用）
- `SessionEnd` フックでセッション終了時に完了通知を送信します
- `.env` ファイルには `SLACK_BOT_TOKEN`、`SLACK_DEFAULT_CHANNEL`、`THREAD_STATE_PATH` などを設定してください

**注意:** `jq` コマンドが必要です。macOS では `brew install jq`、Linux では `apt install jq` でインストールできます

## 開発

```bash
# 依存関係のインストール
npm install

# ビルド
npm run build

# MCP サーバーとして実行
npm start

# CLI として実行
npm run cli -- help
```

## ライセンス

ISC
