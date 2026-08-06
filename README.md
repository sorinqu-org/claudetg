# ClaudeTG

Production-oriented Telegram interface for **Claude Agent SDK / Claude Code**, designed for self-hosting with an Anthropic-compatible custom provider. The example configuration uses `claude-opus-4-8`.

## Features

- Streaming assistant responses by editing Telegram messages instead of sending every token.
- Collapsed tool-use cards using Telegram expandable blockquotes; cards are updated with tool results.
- Interactive permissions: allow once, allow the tool for the local session, deny, or deny and stop.
- Full `AskUserQuestion` support: single select, multi-select, free-text answers, cancellation and timeouts.
- Persistent Agent SDK sessions with `session_id` resume.
- Multiple projects, providers and models from a server-side allowlist.
- Custom endpoint through `ANTHROPIC_BASE_URL`, with Bearer or `X-Api-Key` authentication.
- Permission modes: `default`, `acceptEdits`, `plan`, `dontAsk`, and `auto`.
- Prompt queue, turn cancellation, timeout, max-turn and budget limits.
- Workflow extraction from `TaskCreate`, `TaskUpdate`, and `TodoWrite`.
- Runtime display for tools, MCP servers, skills and Claude slash commands.
- Safe inspection of `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, and `CLAUDE.md`.
- SQLite persistence, interrupted-run recovery and event retention.
- Docker, Docker Compose, systemd unit, health checks and GitHub Actions CI.

## Architecture

```text
Telegram
  -> grammY bot
     -> AgentRunner (queue, abort, sessions)
     -> InteractionBroker (approvals, AskUserQuestion)
     -> Claude Agent SDK query()
     -> AgentMessageRenderer (stream + tool cards + workflow)
     -> SQLite
```

The SDK bundles the Claude Code runtime; a separate global `claude` installation is not required.

## Requirements

- Node.js 22.13+ or Docker.
- Telegram bot token.
- Anthropic-compatible endpoint supporting `/v1/messages`, SSE streaming and tool use.
- Provider API key/token.
- One or more local project directories.

## Docker Compose setup

```bash
cp .env.example .env
cp config/config.example.json config/config.json
mkdir -p data
```

Fill `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_ALLOWED_USER_IDS=123456789
CUSTOM_PROVIDER_API_KEY=provider-key
CONFIG_PATH=/app/config/config.json
DATA_DIR=/app/data
HEALTH_PORT=3000
ALLOW_GROUP_CHATS=false
LOG_LEVEL=info
```

Use immutable numeric Telegram user IDs, not usernames.

Configure `config/config.json`:

```json
{
  "defaultProjectId": "main",
  "providers": [
    {
      "id": "custom",
      "name": "My provider",
      "baseUrl": "https://provider.example.com",
      "auth": { "type": "bearer", "env": "CUSTOM_PROVIDER_API_KEY" },
      "models": [
        { "id": "claude-opus-4-8", "name": "Claude Opus 4.8" }
      ]
    }
  ],
  "projects": [
    {
      "id": "main",
      "name": "Main project",
      "path": "/workspace/main",
      "providerId": "custom",
      "modelId": "claude-opus-4-8",
      "permissionMode": "default",
      "allowedTools": ["Read", "Glob", "Grep"],
      "disallowedTools": ["Bash(sudo *)", "Bash(* /var/run/docker.sock*)"],
      "additionalDirectories": [],
      "settingSources": ["project", "local"],
      "passEnv": [],
      "autoAllowReadTools": true,
      "systemPromptAppend": "Work only inside configured project directories. Ask before destructive or externally visible actions."
    }
  ],
  "agent": {
    "maxTurns": 80,
    "maxBudgetUsd": 25,
    "turnTimeoutMs": 3600000,
    "approvalTimeoutMs": 86400000,
    "streamFlushMs": 900,
    "maxToolDetailChars": 3000,
    "queueLimit": 20,
    "eventRetentionPerSession": 5000
  }
}
```

For a provider expecting `X-Api-Key`, use:

```json
"auth": { "type": "api-key", "env": "CUSTOM_PROVIDER_API_KEY" }
```

The provider URL, credential variable and model IDs are loaded only from the local server configuration. Telegram users cannot supply an arbitrary endpoint.

Mount projects in `docker-compose.yml`. The default mapping is:

```yaml
- /srv/projects:/workspace:rw
```

Therefore `/srv/projects/main` on the host is `/workspace/main` in the container. Do not mount the Docker socket, host root, SSH private keys, or entire home directory.

```bash
sudo chown -R 10001:10001 data /srv/projects/main
docker compose up -d --build
docker compose logs -f claudetg
curl http://127.0.0.1:3000/healthz
```

## Native installation

```bash
npm install
npm run build
cp config/config.example.json config/config.json
cp .env.example .env
node --env-file=.env dist/index.js
```

A hardened systemd template is provided in `deploy/claudetg.service`. Store secrets in `/etc/claudetg/claudetg.env` with mode `0600`.

## Telegram commands

| Command | Purpose |
|---|---|
| `/new [name]` | Create a session |
| `/sessions` | List and switch sessions |
| `/project` | Select project and create a session |
| `/provider` | Select provider and create a session |
| `/model` | Select model and create a session |
| `/mode` | Change permission mode |
| `/status` | Session ID, queue, turns, cost and runtime status |
| `/workflow` | Current tasks/workflow |
| `/tools` | Tools, MCP, skills, slash commands and approval rules |
| `/settings` | App/project/Claude settings with redaction |
| `/history [N]` | Recent events, maximum 100 |
| `/stop` | Abort the active turn and clear the queue |
| `/cancel` | Cancel a pending approval/question |
| `/clearapprovals` | Remove session-level tool approvals |
| `/rename NAME` | Rename the active session |
| `/close` | Archive the active session |

Ordinary text starts a turn. Messages sent while a turn is running are queued. Text sent while `AskUserQuestion` is active is treated as a custom answer.

## Provider and model environment

For each SDK process ClaudeTG supplies:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- the matching family alias such as `ANTHROPIC_DEFAULT_OPUS_MODEL`

For `claude-opus-4-8`, both `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL` are set to that exact model ID.

Only a small safe environment is inherited. Extra variables must be explicitly listed in `project.passEnv`. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is enabled so provider/cloud credentials are removed from Bash, hooks and stdio MCP subprocesses.

## Permission semantics and security

`allowedTools` contains Agent SDK pre-approval rules; it is not a complete tool allowlist. `disallowedTools` blocks configured rules. `bypassPermissions` is intentionally unavailable through Telegram.

Structured file operations are checked before the SDK permission decision. Relative traversal and existing symlink targets are resolved, and paths outside `project.path` plus `additionalDirectories` are denied. `Read`, `Glob`, and `Grep` can be auto-approved only after this host-policy check.

A Telegram approval is not a sandbox. Approved Bash commands run with the service account's filesystem and network access. Container/VM isolation and minimal mounts are the primary security boundary. Read `SECURITY.md` before deployment.

## Validation

```bash
npm run typecheck
npm test
```

Tests cover SQLite sessions/events/workflow and retention, secret redaction, path containment including traversal and symlinks, Telegram formatting limits and tool summaries. CI also builds the Docker image.

A real end-to-end provider/Telegram smoke test requires your bot token, provider key, reachable endpoint and mounted project. After configuration, test ordinary streaming, a `Read`, a `Bash` approval, and an `AskUserQuestion` turn.
