# Security

ClaudeTG can authorize an AI coding agent to read, modify and execute code. Treat the process as privileged automation even when Telegram approvals are enabled.

## Required deployment controls

- Keep `TELEGRAM_ALLOWED_USER_IDS` restricted to trusted accounts.
- Run the service as a dedicated unprivileged OS user or inside the supplied container.
- Mount only explicitly approved project directories.
- Never mount `/var/run/docker.sock`, host SSH private keys, cloud credential directories, or the host root filesystem.
- Keep provider keys in environment variables or a secret manager. Never place them in `config.json`, Telegram messages or repository files.
- Use HTTPS for remote provider endpoints.
- Keep `bypassPermissions` disabled. ClaudeTG intentionally does not expose it in the Telegram UI.
- Review `allowedTools` and `disallowedTools` per project. `allowedTools` pre-approves tools; it is not a tool allowlist by itself.
- Prefer container or VM isolation for untrusted repositories.

## Built-in controls

- Telegram user allowlist and private-chat-only mode by default.
- Provider and model allowlists loaded from server-side configuration.
- Provider URL cannot be changed from Telegram.
- Secrets are not inherited into the agent subprocess unless listed in a project's `passEnv`. SSH/Git environment such as `SSH_AUTH_SOCK` is also opt-in.
- Provider credentials are redacted from logs and rendered tool output.
- Structured file paths outside configured project roots are denied by a `PreToolUse` hook before permission-mode and Telegram decisions. Relative traversal and existing symlink targets are resolved before containment checks.
- `Read`, `Glob` and `Grep` may be auto-approved only after that host-policy check when `autoAllowReadTools` is enabled.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips Anthropic and cloud credentials from Bash, hook and stdio MCP child processes.
- Tool approvals can be granted once or for the current local session. Session-wide approval is keyed by the complete tool name: approving `Bash` permits every later `Bash` request in that session until `/clearapprovals` or session closure.
- Turn timeout, approval timeout, maximum turns, budget cap and queue cap.
- SQLite persistence with interrupted-run recovery and per-session event retention.
- Docker hardening: non-root user, read-only root filesystem, dropped capabilities and `no-new-privileges`.

## Important boundary

A confirmed `Bash` command can still access anything visible to the service account or container. The path policy protects structured path fields; it is not a shell sandbox. OS/container isolation is the primary security boundary.

## Reporting

Do not include API keys, Telegram tokens, repository secrets or complete production logs in an issue. Revoke exposed credentials before reporting.
