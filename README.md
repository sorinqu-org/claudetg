# ClaudeTG

ClaudeTG — self-hosted Telegram-интерфейс для Claude Agent SDK. Бот принимает задачи, показывает streaming-ответы и tool use, передаёт approvals и `AskUserQuestion`, хранит сессии и позволяет переключать модель, permission mode и effort.

Claude запускается не в контейнере Telegram-бота, а в отдельном **worker-контейнере для проекта**. Это сделано специально: worker получает только нужный workspace и собственный persistent HOME, а API-ключ провайдера остаётся в controller и никогда не передаётся Claude Code.

## Как это устроено

```text
Telegram
   │
   ▼
claudetg controller
├── Telegram Bot API
├── SQLite / sessions / approvals
├── provider credential
└── Anthropic-compatible proxy
        │
        │ internal Docker network
        ▼
worker-main
├── Claude Agent SDK / Claude Code
├── /workspace        ← только выбранный проект
├── /home/claude      ← persistent Docker volume
│   └── .claude/
├── npm / Python / Git / curl
└── нет настоящего provider API key
        │
        ▼
controller proxy
        │ real API key is added here
        ▼
Anthropic-compatible provider
```

Controller **не монтирует проект**. Worker **не получает provider secret**.

`/home/claude` — обычный Docker named volume. Поэтому установленные skills, plugins, npm CLI, настройки Claude и кэши переживают restart и rebuild контейнера.

## Возможности

- streaming ответов Claude в Telegram;
- compact tool-use/tool-result cards;
- интерактивные approvals;
- полный `AskUserQuestion` flow;
- persistent/resumable Claude sessions;
- отдельный Docker worker для проекта;
- persistent `/home/claude` для skills и пользовательских CLI;
- provider proxy, скрывающий настоящий API key от worker;
- проекты, провайдеры и модели;
- `/effort` на уровне сессии;
- workflow, history, tools, skills и MCP status;
- `rg`, `ast-grep`, Semble, Repomix, Universal Ctags и `jq`;
- опциональные Serena и Context7;
- Docker Compose deployment.

## Требования

- Docker + Docker Compose;
- Telegram bot token;
- числовой Telegram user ID;
- Anthropic-compatible provider с Messages API, streaming и tool use;
- каталог проекта на сервере.

Claude Code отдельно на хост устанавливать не нужно.

## Быстрый запуск

```bash
git clone https://github.com/sorinqu-org/claudetg.git
cd claudetg

cp .env.example .env
cp config/config.example.json config/config.json
mkdir -p data
```

### 1. `.env`

Пример:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:telegram-bot-token
TELEGRAM_ALLOWED_USER_IDS=123456789

CUSTOM_PROVIDER_API_KEY=provider-api-key

# Отдельный случайный секрет только для связи controller <-> worker.
# Он не передаётся процессу Claude Code.
CLAUDETG_INTERNAL_TOKEN=replace-with-random-value

# На host. Только этот каталог будет mounted в worker-main.
CLAUDETG_PROJECT_PATH=/srv/projects/main

CONFIG_PATH=/app/config/config.json
DATA_DIR=/app/data
HEALTH_PORT=3000
ALLOW_GROUP_CHATS=false
LOG_LEVEL=info

TOKEN_EFFICIENCY_ENABLED=true
SEMBLE_ENABLED=true
SERENA_ENABLED=false
CONTEXT7_ENABLED=false
MCP_TIMEOUT=60000

CLAUDE_CODE_EFFORT_LEVEL=medium
CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false
CLAUDE_CODE_DISABLE_THINKING=false
```

Для internal token удобно использовать:

```bash
openssl rand -hex 32
```

`TELEGRAM_ALLOWED_USER_IDS` содержит числовые Telegram ID, а не usernames.

Настоящий `.env` не коммитьте.

### 2. Provider и worker

`config/config.json`:

```json
{
  "defaultProjectId": "main",
  "providers": [
    {
      "id": "custom",
      "name": "Custom provider",
      "baseUrl": "https://provider.example.com",
      "auth": {
        "type": "bearer",
        "env": "CUSTOM_PROVIDER_API_KEY"
      },
      "models": [
        {
          "id": "claude-opus-4-8",
          "name": "Claude Opus 4.8"
        }
      ]
    }
  ],
  "projects": [
    {
      "id": "main",
      "name": "Main project",
      "path": "/workspace",
      "workerUrl": "http://worker-main:3100",
      "providerId": "custom",
      "modelId": "claude-opus-4-8",
      "permissionMode": "default",
      "allowedTools": ["Read", "Glob", "Grep"],
      "disallowedTools": [
        "Bash(sudo *)",
        "Bash(* /var/run/docker.sock*)"
      ],
      "additionalDirectories": [],
      "settingSources": ["user", "project", "local"],
      "passEnv": [],
      "autoAllowReadTools": true,
      "systemPromptAppend": "You are running inside an isolated per-project Docker worker. /workspace is the project and /home/claude is your persistent private home."
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

`projects[].path` — путь **внутри worker**, а не путь на host. В стандартном Compose это `/workspace`.

`projects[].workerUrl` — внутренний адрес worker в Docker network.

### 3. Важно: `auth.env` — имя переменной

Правильно:

```json
"auth": {
  "type": "bearer",
  "env": "CUSTOM_PROVIDER_API_KEY"
}
```

и в `.env`:

```dotenv
CUSTOM_PROVIDER_API_KEY=real-secret
```

Неправильно:

```json
"env": "sk-real-secret"
```

Provider secret читается controller-контейнером. Worker его не получает.

### AgentRouter

Для AgentRouter:

```dotenv
AGENTROUTER_API_KEY=your-key
```

```json
{
  "id": "agentrouter",
  "name": "AgentRouter",
  "baseUrl": "https://co.agentrouter.org",
  "auth": {
    "type": "bearer",
    "env": "AGENTROUTER_API_KEY"
  },
  "models": [
    {
      "id": "claude-opus-4-8",
      "name": "Claude Opus 4.8"
    }
  ]
}
```

Для Anthropic-compatible Claude Code route используется `https://co.agentrouter.org`, без `/v1` в `baseUrl`.

### 4. Подготовьте проект

```bash
sudo mkdir -p /srv/projects/main
sudo chown -R 10001:10001 /srv/projects/main
```

Или поменяйте:

```dotenv
CLAUDETG_PROJECT_PATH=/другой/путь
```

Controller этот каталог не видит. Он смонтирован только в `worker-main`.

### 5. Запуск

```bash
docker compose build --no-cache
docker compose up -d
```

Статус:

```bash
docker compose ps
```

Логи controller:

```bash
docker compose logs -f claudetg
```

Логи Claude worker:

```bash
docker compose logs -f worker-main
```

После запуска отправьте боту `/start`.

## Что находится в worker

Worker выглядит для Claude как отдельная маленькая Linux-система:

```text
/
├── app/                 runtime ClaudeTG
├── workspace/           project mount
├── home/claude/         persistent named volume
│   ├── .claude/
│   ├── .config/
│   ├── .cache/
│   ├── .local/
│   └── .npm/
└── tmp/                 temporary filesystem
```

Claude запускается как non-root user `claude`.

У worker нет:

- host `/home`;
- host `/etc`;
- Docker socket;
- соседних проектов, если вы их отдельно не mounted;
- настоящего API key провайдера.

## Persistent Claude HOME

В Compose:

```yaml
volumes:
  - claude_home_main:/home/claude
```

Поэтому, например:

```text
/home/claude/.claude/skills
/home/claude/.claude/plugins
/home/claude/.local/bin
```

не исчезают после:

```bash
docker compose restart worker-main
```

или rebuild image.

Проверить:

```bash
docker compose exec worker-main bash

echo "$HOME"
ls -la ~/.claude
```

Ожидаемый HOME:

```text
/home/claude
```

### Установка skills и CLI

Можно дать Claude задачу установить skill самостоятельно либо открыть shell worker:

```bash
docker compose exec worker-main bash
```

Например:

```bash
npx skills add https://github.com/tavily-ai/skills
```

User-level npm packages устанавливаются в `/home/claude/.local`, потому что `NPM_CONFIG_PREFIX` уже настроен.

Python virtualenvs, конфиги и user-level tools тоже можно хранить в `/home/claude`.

> Не используйте `docker compose down -v`, если хотите сохранить worker HOME. Ключ `-v` удалит named volume вместе со skills и пользовательскими настройками.

Для намеренного полного сброса worker HOME:

```bash
docker compose down -v
```

## Provider proxy и секреты

Worker получает:

```text
ANTHROPIC_BASE_URL=http://claudetg:3000/provider-proxy/<provider>
```

и технический фиктивный credential. Настоящий provider key находится только в controller.

Когда Claude Agent SDK делает запрос:

```text
worker -> controller proxy -> provider
```

controller удаляет worker auth header и добавляет реальный Bearer/API key непосредственно перед запросом к provider.

Proxy пропускает только необходимые Anthropic endpoints:

```text
/v1/messages
/v1/messages/count_tokens
/v1/models
```

Это скрывает значение API key от Claude и от Bash subprocesses в worker.

Важно: worker всё равно может пользоваться provider через proxy, иначе Claude не смог бы работать. То есть изоляция защищает **значение секрета**, но не является отдельной системой квотирования provider usage.

## Проектные `.env`

Docker изоляция не делает файлы внутри `/workspace` невидимыми для Claude.

Если на host:

```text
/srv/projects/main/.env
```

то worker получает:

```text
/workspace/.env
```

потому что это часть самого проекта.

Это **не sandbox escape**.

Если project `.env` содержит секреты, которые Claude не должен видеть, лучше не хранить их в mounted workspace: используйте host secret store, отдельный runtime deployment env или другой каталог, который не mounted в worker.

Provider key ClaudeTG уже вынесен из workspace полностью и worker его не получает.

## Почему больше нет nested bubblewrap

Раньше ClaudeTG запускал Claude Code в том же контейнере и пытался дополнительно использовать bubblewrap sandbox. На некоторых Docker hosts это ломалось на user namespaces:

```text
bwrap: No permissions to create new namespace
```

Теперь isolation boundary — сам `worker-main` контейнер:

- отдельная filesystem namespace;
- narrow project mount;
- non-root user;
- `cap_drop: ALL`;
- `no-new-privileges`;
- read-only root filesystem;
- отдельный HOME volume;
- provider key отсутствует.

Поэтому nested bubblewrap не требуется для защиты provider credential.

## Telegram-команды

| Команда | Назначение |
| --- | --- |
| `/new [название]` | новая сессия |
| `/sessions` | список и переключение сессий |
| `/project` | выбрать проект/worker |
| `/provider` | выбрать provider |
| `/model` | выбрать модель |
| `/mode` | permission mode |
| `/effort` | effort текущей сессии |
| `/status` | worker, session, model, cost и queue |
| `/workflow` | workflow/task state |
| `/tools` | tools, skills, MCP и permissions |
| `/settings` | controller + worker settings |
| `/history [N]` | последние события |
| `/stop` | остановить turn и очистить очередь |
| `/cancel` | отменить ожидающий approval/question |
| `/clearapprovals` | очистить session approvals |
| `/rename название` | переименовать сессию |
| `/close` | архивировать сессию |

Обычный текст запускает turn. Если turn уже выполняется, сообщение попадает в очередь.

## Effort и стоимость

`/effort` сохраняется отдельно для каждой Claude-сессии.

Доступны:

- `auto`;
- `low`;
- `medium`;
- `high`;
- `xhigh`;
- `max`.

По умолчанию:

```dotenv
CLAUDE_CODE_EFFORT_LEVEL=medium
```

`low` подходит для простых дешёвых задач; `high` и выше — для сложной отладки и архитектурных изменений.

## Token-efficient tools

Worker image содержит:

- `rg`;
- `ast-grep` (`sg`);
- Semble;
- Repomix;
- Universal Ctags;
- `jq`;
- Serena (опционально);
- Context7 (опционально).

Настройки:

```dotenv
TOKEN_EFFICIENCY_ENABLED=true
SEMBLE_ENABLED=true
SERENA_ENABLED=false
CONTEXT7_ENABLED=false
```

## Несколько проектов

Для настоящей filesystem isolation лучше использовать **отдельный worker на каждый проект**, а не монтировать несколько репозиториев в один контейнер.

Например:

```yaml
worker-api:
  # ... worker target
  environment:
    WORKER_PROJECT_ID: api
  volumes:
    - /srv/projects/api:/workspace:rw
    - claude_home_api:/home/claude

worker-web:
  # ... worker target
  environment:
    WORKER_PROJECT_ID: web
  volumes:
    - /srv/projects/web:/workspace:rw
    - claude_home_web:/home/claude
```

А в config:

```json
{
  "id": "api",
  "path": "/workspace",
  "workerUrl": "http://worker-api:3100"
}
```

и:

```json
{
  "id": "web",
  "path": "/workspace",
  "workerUrl": "http://worker-web:3100"
}
```

Так project A физически отсутствует в filesystem worker B.

## Миграция со старой схемы

В старой версии controller сам имел mount `/srv/projects:/workspace` и запускал Claude Code внутри себя.

После обновления:

1. добавьте `CLAUDETG_INTERNAL_TOKEN` в `.env`;
2. добавьте `CLAUDETG_PROJECT_PATH`;
3. поменяйте project path в config на `/workspace`;
4. добавьте `workerUrl: "http://worker-main:3100"`;
5. пересоберите оба image targets;
6. убедитесь, что `worker-main` healthy.

Команды:

```bash
git pull
cp .env.example .env.example.new   # только если хотите сравнить новые поля

docker compose down
docker compose build --no-cache
docker compose up -d

docker compose ps
```

Не добавляйте `-v` к `down`, если уже используете persistent Claude HOME.

## Диагностика

### Worker недоступен

```bash
docker compose ps
docker compose logs worker-main
curl http://127.0.0.1:3000/healthz
```

Worker health из Docker network:

```bash
docker compose exec claudetg node -e \
  "fetch('http://worker-main:3100/healthz').then(r=>r.text()).then(console.log)"
```

### Проверка, что provider key не попал в worker

Для AgentRouter:

```bash
docker compose exec worker-main sh -lc \
  'test -z "$AGENTROUTER_API_KEY" && echo hidden || echo LEAKED'
```

Должно быть:

```text
hidden
```

В controller ключ, наоборот, должен существовать:

```bash
docker compose exec claudetg sh -lc \
  'test -n "$AGENTROUTER_API_KEY" && echo configured || echo missing'
```

### Проверка persistent HOME

```bash
docker compose exec worker-main sh -lc \
  'echo "$HOME"; mkdir -p ~/.claude/skills/test-persist; echo ok > ~/.claude/skills/test-persist/check'

docker compose restart worker-main

docker compose exec worker-main cat /home/claude/.claude/skills/test-persist/check
```

Должно вывести `ok`.

## Security notes

- никогда не монтируйте Docker socket в worker;
- не монтируйте host `/`, `/home` или `/etc`;
- один project — один worker предпочтительнее;
- `CLAUDETG_INTERNAL_TOKEN` должен быть случайным;
- worker имеет network access, потому что coding agent должен уметь устанавливать зависимости и skills;
- network access означает, что tool approvals и политика команд всё ещё имеют значение;
- persistent worker HOME может содержать токены сторонних CLI, если вы сами туда залогинились — относитесь к этому volume как к приватным данным;
- controller provider key не хранится в SQLite и не передаётся worker.

## Разработка

```bash
npm install
npm run typecheck
npm test
```

CI отдельно собирает:

- controller image;
- worker image;
- TypeScript + unit tests.

## Ограничения

ClaudeTG не преобразует OpenAI API в Anthropic API. Provider должен поддерживать Anthropic Messages API, streaming и tool use.

Worker isolation — это Docker container isolation, а не полноценная аппаратная VM. Если нужен более сильный tenant boundary для недоверенных пользователей, используйте отдельные VM/microVM, а не общий Docker daemon.

## Лицензия

Apache License 2.0.
