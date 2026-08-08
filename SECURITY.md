# Security

ClaudeTG can authorize an AI coding agent to read, modify and execute code. Treat every worker as privileged automation over the project mounted into that worker.

## Security boundary

ClaudeTG uses two different roles:

- **controller** — Telegram, SQLite, approvals and the real provider credential;
- **worker** — Claude Agent SDK / Claude Code, project filesystem and persistent Claude HOME.

The worker container is the primary execution/isolation boundary. The controller does not mount the project, and the worker does not receive the real provider API key.

This is stronger and more predictable than relying on nested bubblewrap inside Docker. It is still Docker isolation, not a hardware VM or hostile multi-tenant sandbox.

## Provider credential isolation

The worker points Claude Code at an internal Anthropic-compatible proxy in the controller. Claude receives only a fixed non-secret proxy credential.

The controller:

1. accepts only the required Anthropic API paths;
2. validates the configured provider/model;
3. strips worker auth headers;
4. adds the real provider Bearer/API key;
5. streams the provider response back to the worker.

The real provider credential therefore does not exist in the Claude process environment or worker filesystem.

Any process in the worker can still use the internal proxy to make allowed model requests. The proxy hides the credential value; it is not a separate provider quota/security account.

## Controller ↔ worker authentication

Control callbacks use `CLAUDETG_INTERNAL_TOKEN` through `x-claudetg-internal-token`.

Generate a random value, for example:

```bash
openssl rand -hex 32
```

The worker service process needs this token to call the controller approval endpoint, but `worker.ts` deliberately builds a fresh allowlisted environment for Claude Code and does **not** pass `CLAUDETG_INTERNAL_TOKEN` to the agent subprocess.

## Filesystem isolation

The supplied Compose setup gives `worker-main` only:

- one bind-mounted project at `/workspace`;
- one persistent named volume at `/home/claude`;
- temporary `/tmp` and `/run` filesystems;
- the files baked into the worker image.

The controller has no project bind mount.

For multiple projects, use one worker and one HOME volume per project. Do not mount a parent directory containing unrelated repositories into a shared worker.

### Project secrets

Anything inside the mounted project is part of the worker filesystem. For example, host:

```text
/srv/projects/main/.env
```

becomes:

```text
/workspace/.env
```

This is expected and is not a sandbox escape.

If a secret must not be available to Claude, do not store it inside the mounted workspace. Prefer deployment environment variables, an external secret manager, or a non-mounted host path.

The ClaudeTG provider credential already follows this rule and exists only in the controller.

## Persistent `/home/claude`

`/home/claude` is intentionally writable and persistent so Claude can keep:

- `.claude/skills`;
- Claude settings/plugins;
- npm user-level packages;
- Python environments and user CLI tools;
- caches/configuration.

If you authenticate third-party CLIs from inside the worker, their credentials may be stored in this volume. Treat the worker HOME volume as private data and back it up/protect it accordingly.

`docker compose down -v` deletes this volume.

## Container hardening

The supplied worker uses:

- a non-root `claude` user;
- read-only root filesystem;
- `cap_drop: ALL`;
- `no-new-privileges`;
- narrow explicit mounts;
- no Docker socket;
- no host home or host root mount.

The controller is also non-root, read-only and drops Linux capabilities.

Nested Claude Code bubblewrap is intentionally not the security boundary in this architecture. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is disabled in the worker because the sensitive provider credential is not present there in the first place.

## Network boundary

Workers have outbound network access by default. This is necessary for common coding workflows such as package installation, Git access and skill installation.

Consequences:

- code/data visible in `/workspace` can potentially be sent to external services by an approved command;
- package install scripts execute inside the worker;
- Telegram approvals and project tool policies remain important.

For higher-security deployments, add an egress proxy/firewall or allowlist only required destinations.

## Telegram and tool controls

- Keep `TELEGRAM_ALLOWED_USER_IDS` restricted to trusted accounts.
- Private-chat-only mode is enabled by default.
- Provider URL/model selection comes from server-side configuration; Telegram cannot supply arbitrary provider URLs.
- `bypassPermissions` is not exposed.
- Review `allowedTools`/`disallowedTools`; broad session approval of `Bash` applies to later Bash calls in the same session.
- `/clearapprovals` clears session-wide tool approvals.
- Turn timeout, approval timeout, max-turn, budget and queue limits remain enforced by the controller.
- Structured file tools are checked against worker roots before tool approval.

## Required deployment controls

- Never mount `/var/run/docker.sock` into a worker.
- Never mount host `/`, `/home`, `/etc`, SSH key directories or cloud credential directories.
- Prefer one project per worker.
- Keep provider credentials only in controller environment/secret storage.
- Do not put the provider secret in `config.json` or the project repository.
- Use HTTPS for remote provider endpoints.
- Use a strong random `CLAUDETG_INTERNAL_TOKEN`.
- Restrict access to the Docker host itself.

## Stronger isolation

If workers will execute code for mutually untrusted users or adversarial repositories, ordinary containers may not be a sufficient tenant boundary. Use separate VMs/microVMs or equivalent stronger isolation rather than sharing a Docker daemon.

## Reporting

Do not include API keys, Telegram tokens, internal tokens, repository secrets or complete production logs in an issue. Revoke exposed credentials before reporting.
