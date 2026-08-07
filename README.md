# ClaudeTG

ClaudeTG запускает Claude Agent SDK на вашем сервере и использует Telegram как интерфейс. Можно отправлять задачи с телефона, получать потоковый ответ, видеть tool use, подтверждать действия, отвечать на `AskUserQuestion`, переключать модели и продолжать сохранённые Claude-сессии.

Проект рассчитан на self-hosted установку и работает с Anthropic-compatible API providers. В примерах ниже используется `claude-opus-4-8`.

## Возможности

- streaming ответов Claude в Telegram;
- компактные карточки tool use и tool result;
- интерактивные approvals;
- поддержка `AskUserQuestion`;
- сохранение и resume сессий через SQLite;
- несколько проектов, провайдеров и моделей;
- выбор permission mode и effort из Telegram;
- очередь запросов;
- просмотр workflow, tools, skills, MCP и истории;
- token-efficient поиск через `rg`, `ast-grep`, Semble, Repomix и Universal Ctags;
- опциональные Serena MCP и Context7;
- Docker Compose и обычный Node.js запуск.

Claude Code отдельно устанавливать не требуется: нужный runtime поставляется вместе с Claude Agent SDK.

## Требования

- Telegram bot token от BotFather;
- числовой Telegram user ID;
- API-ключ Anthropic-compatible провайдера;
- endpoint с Messages API, streaming и tool use;
- Docker Compose либо Node.js 22.13+;
- каталог проекта на сервере.

## Быстрый запуск через Docker Compose

```bash
git clone https://github.com/sorinqu-org/claudetg.git
cd claudetg

cp .env.example .env
cp config/config.example.json config/config.json
mkdir -p data
```

### 1. `.env`

Минимальный пример:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:telegram-bot-token
TELEGRAM_ALLOWED_USER_IDS=123456789
CUSTOM_PROVIDER_API_KEY=provider-api-key

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

# Только если используете Context7 и хотите передавать ключ агенту.
CONTEXT7_API_KEY=
```

`TELEGRAM_ALLOWED_USER_IDS` содержит числовые ID, а не usernames. Несколько ID указываются через запятую.

Не коммитьте настоящий `.env`.

### 2. Провайдер и проект

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
      "path": "/workspace/main",
      "providerId": "custom",
      "modelId": "claude-opus-4-8",
      "permissionMode": "default",
      "allowedTools": ["Read", "Glob", "Grep"],
      "disallowedTools": [
        "Bash(sudo *)",
        "Bash(* /var/run/docker.sock*)"
      ],
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

### Важно: `auth.env` — это имя переменной, а не API-ключ

Правильно:

```json
"auth": {
  "type": "bearer",
  "env": "CUSTOM_PROVIDER_API_KEY"
}
```

и в `.env`:

```dotenv
CUSTOM_PROVIDER_API_KEY=sk-your-real-key
```

Неправильно:

```json
"auth": {
  "type": "bearer",
  "env": "sk-your-real-key"
}
```

Поле `env` говорит ClaudeTG, из какой переменной окружения взять секрет. Сам ключ в `config.json` хранить не нужно.

Для Bearer authentication используется `auth.type = "bearer"`. Если провайдер ожидает `X-Api-Key`, используйте `auth.type = "api-key"`.

### AgentRouter

Для AgentRouter конфигурация выглядит так:

`.env`:

```dotenv
AGENTROUTER_API_KEY=your-agentrouter-key
```

`config/config.json`:

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

Для Anthropic/Claude Code совместимого маршрута используется `https://co.agentrouter.org`, без `/v1`.

### 3. Каталог проекта

По умолчанию `docker-compose.yml` монтирует:

```yaml
- /srv/projects:/workspace:rw
```

Значит `/srv/projects/main` на хосте соответствует `/workspace/main` внутри контейнера.

```bash
sudo mkdir -p /srv/projects/main
sudo chown -R 10001:10001 /srv/projects/main data
```

Если меняете mount, обновите и `projects[].path`.

### 4. Запуск

```bash
docker compose up -d --build
```

Логи:

```bash
docker compose logs -f claudetg
```

Healthcheck:

```bash
curl http://127.0.0.1:3000/healthz
```

После запуска отправьте боту `/start`.

## Telegram-команды

| Команда | Назначение |
| --- | --- |
| `/new [название]` | новая сессия |
| `/sessions` | список и переключение сессий |
| `/project` | выбрать проект |
| `/provider` | выбрать provider |
| `/model` | выбрать модель |
| `/mode` | permission mode |
| `/effort` | effort для текущей сессии |
| `/status` | состояние, очередь, cost, SDK session ID и effort |
| `/workflow` | workflow/task состояние |
| `/tools` | tools, MCP, skills и permissions |
| `/settings` | конфигурация приложения и проекта |
| `/history [N]` | последние события |
| `/stop` | остановить turn и очистить очередь |
| `/cancel` | отменить ожидающий approval/question |
| `/clearapprovals` | очистить session approvals |
| `/rename название` | переименовать сессию |
| `/close` | архивировать сессию |

Обычный текст запускает новый turn. Если Claude уже работает, сообщение попадает в очередь.

## Effort и output tokens

`/effort` меняет уровень только для активной Telegram-сессии. Выбор сохраняется в SQLite и применяется со следующего turn.

Доступны:

- `auto`;
- `low`;
- `medium`;
- `high`;
- `xhigh`;
- `max`.

Значение по умолчанию:

```dotenv
CLAUDE_CODE_EFFORT_LEVEL=medium
```

`medium` подходит для обычной разработки. `low` дешевле на простых задачах, но может увеличить число повторных попыток. `high` и выше имеет смысл использовать для сложной отладки и архитектурных изменений.

Prompt suggestions и progress summaries отключены, потому что Telegram-интерфейс уже показывает ход работы. Встроенный skill также просит Claude не генерировать лишние преамбулы, полный diff и длинные логи.

Агрессивный вариант:

```dotenv
CLAUDE_CODE_DISABLE_THINKING=true
```

Он может сократить output tokens, но способен ухудшить сложные многошаговые задачи.

## Инструменты экономии контекста

### `rg`

Быстрый точный поиск строк, имён и конфигурационных ключей.

### `ast-grep` (`sg`)

Структурный поиск по AST: вызовы функций, импорты, объявления, JSX и синтаксически точные замены.

### Semble

Включён по умолчанию:

```dotenv
SEMBLE_ENABLED=true
```

Используется для semantic code search, когда точное имя символа неизвестно. Работает локально. На первом запуске может потребоваться инициализация локальной модели/индекса.

### Universal Ctags + `jq`

Ctags создаёт дешёвый индекс символов, `jq` позволяет получать из больших JSON только нужные поля вместо передачи всего файла в контекст.

### Repomix

Используется только для ограниченной карты репозитория. Агент должен сначала смотреть token tree, затем выбирать узкий `--include` и при необходимости `--compress`. Полный repository pack автоматически не отправляется модели.

### Serena

По умолчанию выключена:

```dotenv
SERENA_ENABLED=false
```

Для средних и больших проектов можно включить symbol-level navigation и references:

```dotenv
SERENA_ENABLED=true
```

### Context7

По умолчанию выключен, потому что использует внешний сервис:

```dotenv
CONTEXT7_ENABLED=false
```

Он полезен для точечных запросов к актуальной публичной документации библиотек. Не отправляйте через него приватный исходный код.

Подробнее: `docs/token-efficiency.md` и `docs/search-tools.md`.

## Permissions

Если действие не разрешено заранее, Telegram показывает approval-кнопки. Можно разрешить один раз, разрешить инструмент до конца сессии, отклонить либо отклонить и остановить turn.

`allowedTools` — предварительные правила разрешения. `disallowedTools` блокирует совпавшие действия. `bypassPermissions` из Telegram недоступен.

Permission modes:

- `default`;
- `acceptEdits`;
- `plan`;
- `dontAsk`;
- `auto`.

## Сессии и данные

Сессии, workflow, история и временные approvals хранятся в SQLite в каталоге `data`. API-ключи в SQLite не записываются.

После перезапуска ClaudeTG может продолжить сохранённую SDK session по её ID.

Предупреждение Node.js про experimental SQLite само по себе не означает ошибку приложения.

## Если бот отвечает на `/new`, но молчит на обычное сообщение

Сначала смотрите:

```bash
docker compose logs -f claudetg
```

Частая ошибка конфигурации:

```text
Provider credential environment variable is missing: ...
```

Проверьте две вещи:

1. `providers[].auth.env` содержит **имя** переменной, например `AGENTROUTER_API_KEY`;
2. в `.env` действительно есть `AGENTROUTER_API_KEY=...`.

После изменения `.env` или `config/config.json` пересоздайте контейнер:

```bash
docker compose up -d --build --force-recreate
```

Проверить, что переменная попала в контейнер, можно без вывода самого секрета:

```bash
docker compose exec claudetg sh -lc 'test -n "$AGENTROUTER_API_KEY" && echo configured || echo missing'
```

Новые версии ClaudeTG также отправляют startup/config errors прямо в Telegram, вместо того чтобы только писать их в Docker log.

## Безопасность

- ограничьте `TELEGRAM_ALLOWED_USER_IDS`;
- не монтируйте `/var/run/docker.sock`;
- не монтируйте корень хоста, домашний каталог и SSH-ключи;
- запускайте сервис отдельным пользователем;
- держите реальные API keys только в `.env`/secret store;
- настройте `disallowedTools`, timeout, max turns и budget;
- не публикуйте логи, в которых случайно оказался действующий ключ.

Если ключ попал в публичный лог, issue, чат или скриншот, считайте его скомпрометированным и выпустите новый.

Подробнее: [`SECURITY.md`](SECURITY.md).

## Запуск без Docker

```bash
npm install
npm run build

cp .env.example .env
cp config/config.example.json config/config.json

node --env-file=.env dist/index.js
```

При нативном запуске пути из `config/config.json` должны существовать на хосте. Unit для systemd находится в `deploy/claudetg.service`.

## Разработка

```bash
npm install
npm run typecheck
npm test
```

GitHub Actions выполняет typecheck, unit tests и сборку Docker image.

## Ограничения

ClaudeTG не конвертирует OpenAI API в Anthropic API. Provider должен сам поддерживать Anthropic Messages API, streaming и tool use.

Автотесты не проверяют ваш конкретный provider endpoint без настоящего API key. После развёртывания рекомендуется вручную проверить:

1. обычный текстовый ответ;
2. чтение файла;
3. Bash с approval;
4. `AskUserQuestion`.

## Лицензия

Apache License 2.0.
