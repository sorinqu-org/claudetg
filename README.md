# ClaudeTG

ClaudeTG запускает Claude Agent SDK на вашем сервере, а Telegram использует как интерфейс. Можно писать задачи с телефона, следить за ответом, подтверждать команды и продолжать старые сессии без подключения к терминалу.

Проект рассчитан на самостоятельное развёртывание. Он работает с Anthropic-совместимыми API-шлюзами, поэтому endpoint, ключ и название модели задаются в конфигурации. В примере используется `claude-opus-4-8`.

## Что умеет бот

- передаёт ответы Claude в Telegram по мере генерации;
- показывает вызовы инструментов в компактном виде и обновляет карточку после выполнения;
- спрашивает разрешение перед действиями, которые не были разрешены заранее;
- поддерживает `AskUserQuestion`, включая выбор нескольких вариантов и свободный ответ;
- хранит сессии в SQLite и продолжает их через Agent SDK;
- работает с несколькими проектами, провайдерами и моделями;
- позволяет менять модель и permission mode из Telegram;
- показывает текущие задачи, историю, настройки, tools, MCP-серверы и skills;
- ставит новые сообщения в очередь, пока Claude занят;
- умеет остановить текущий turn;
- запускается через Docker Compose или как обычное Node.js-приложение.

Claude Code отдельно устанавливать не нужно: нужный runtime поставляется вместе с Claude Agent SDK.

## Что потребуется

- Telegram-бот, созданный через BotFather;
- числовой Telegram user ID пользователя, которому разрешён доступ;
- API-ключ провайдера;
- Anthropic-совместимый endpoint с `/v1/messages`, streaming и tool use;
- каталог с проектом на сервере;
- Docker Compose или Node.js 22.13+.

## Быстрый запуск через Docker Compose

Клонируйте репозиторий и создайте локальные файлы конфигурации:

```bash
git clone https://github.com/sorinqu-org/claudetg.git
cd claudetg

cp .env.example .env
cp config/config.example.json config/config.json
mkdir -p data
```

### 1. Заполните `.env`

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
SERENA_ENABLED=false
MCP_TIMEOUT=60000
```

В `TELEGRAM_ALLOWED_USER_IDS` указываются числовые ID, а не usernames. Несколько ID можно перечислить через запятую.

Не добавляйте настоящий `.env` в Git.

### 2. Настройте провайдера и проект

Откройте `config/config.json`:

```json
{
  "defaultProjectId": "main",
  "providers": [
    {
      "id": "custom",
      "name": "Мой провайдер",
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
      "name": "Основной проект",
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

`baseUrl` должен указывать на корень Anthropic-совместимого API. Для Bearer-токена оставьте:

```json
"auth": { "type": "bearer", "env": "CUSTOM_PROVIDER_API_KEY" }
```

Если сервис ожидает заголовок `X-Api-Key`, используйте:

```json
"auth": { "type": "api-key", "env": "CUSTOM_PROVIDER_API_KEY" }
```

Название переменной из поля `env` должно совпадать с переменной в `.env`.

### 3. Подключите каталог с проектами

По умолчанию `docker-compose.yml` монтирует:

```yaml
- /srv/projects:/workspace:rw
```

Значит каталог `/srv/projects/main` на хосте будет доступен внутри контейнера как `/workspace/main` — именно этот путь указан в примере конфигурации.

Создайте каталог и дайте контейнеру права на запись:

```bash
sudo mkdir -p /srv/projects/main
sudo chown -R 10001:10001 /srv/projects/main data
```

Можно заменить mount на свой, но путь внутри контейнера должен совпадать с `projects[].path`.

### 4. Запустите бот

```bash
docker compose up -d --build
```

Логи:

```bash
docker compose logs -f claudetg
```

Проверка состояния:

```bash
curl http://127.0.0.1:3000/healthz
```

После запуска откройте бота в Telegram и отправьте `/start`.

## Команды Telegram

| Команда | Что делает |
| --- | --- |
| `/new [название]` | создаёт новую сессию |
| `/sessions` | показывает сессии и позволяет переключиться |
| `/project` | выбирает проект и создаёт новую сессию |
| `/provider` | выбирает провайдера |
| `/model` | выбирает модель |
| `/mode` | меняет permission mode |
| `/status` | показывает статус, очередь, расходы и SDK session ID |
| `/workflow` | показывает текущие задачи Claude |
| `/tools` | показывает tools, MCP, skills и правила разрешений |
| `/settings` | показывает настройки приложения и проекта |
| `/history [N]` | показывает последние события сессии |
| `/stop` | останавливает активный turn и очищает очередь |
| `/cancel` | отменяет ожидающее подтверждение или вопрос |
| `/clearapprovals` | сбрасывает разрешения, выданные до конца сессии |
| `/rename название` | переименовывает активную сессию |
| `/close` | архивирует активную сессию |

Обычное текстовое сообщение отправляется Claude как новый запрос. Если turn уже выполняется, сообщение попадёт в очередь. Когда Claude ожидает ответ на `AskUserQuestion`, обычный текст считается ответом на этот вопрос.

## Инструменты для экономного контекста

В образ уже входят `ripgrep`, `ast-grep` и Repomix. Вместе с ними загружается небольшой Agent SDK plugin, который учит Claude сначала находить нужные символы и участки кода, а уже потом читать файлы. Skills подгружаются по необходимости, поэтому их полные инструкции не занимают контекст каждого запроса.

### ast-grep

Команда `sg` ищет код по структуре AST. Она полезнее обычного текста, когда нужно найти конкретный вызов, импорт, объявление, JSX-элемент или выполнить синтаксически точную замену. Для обычных строк, ключей конфигурации и имён файлов Claude по-прежнему использует `rg`.

### Repomix

Repomix используется только для компактной карты незнакомого репозитория и аудита самых тяжёлых каталогов. Skill требует сначала смотреть `--token-count-tree`, затем задавать узкий `--include` и включать `--compress`.

Полный репозиторий автоматически в prompt не упаковывается. На больших проектах это часто не экономит, а расходует больше токенов. Сжатая карта тоже не используется как источник истины перед изменением кода — Claude должен открыть оригинальный файл.

### Serena

Serena даёт symbol-level navigation через MCP: обзор символов, поиск определений, references и точечное редактирование. Она установлена в Docker-образ, но по умолчанию выключена:

```dotenv
SERENA_ENABLED=false
```

Для среднего или большого проекта можно включить:

```dotenv
SERENA_ENABLED=true
```

После изменения `.env` пересоздайте контейнер:

```bash
docker compose up -d --build
```

На маленьком проекте Serena может дать лишнюю задержку на запуск и индексацию, поэтому включать её для всех задач не стоит. При нативном запуске её нужно установить отдельно:

```bash
python3 -m venv .venv-serena
.venv-serena/bin/pip install serena-agent==1.6.1
```

и добавить `.venv-serena/bin` в `PATH` процесса ClaudeTG.

`TOKEN_EFFICIENCY_ENABLED=false` отключает базовый plugin целиком. `MCP_TIMEOUT` задаёт время подключения MCP-сервера в миллисекундах.

Фиксированной экономии в 70–80% проект не обещает. Результат зависит от размера репозитория, задачи, качества поискового запроса, длины сессии и реализации prompt caching у провайдера. Измерять эффект лучше по `modelUsage`, стоимости одинаковых задач и token tree для фактически выбранных файлов.

## Как работают подтверждения

Когда Claude хочет вызвать инструмент, бот либо разрешает действие по настроенным правилам, либо присылает карточку с кнопками:

- разрешить один раз;
- разрешить этот инструмент до конца сессии;
- отклонить;
- отклонить и остановить turn.

`allowedTools` — это правила предварительного разрешения, а не полный список доступных инструментов. `disallowedTools` блокирует совпавшие правила. Режим `bypassPermissions` намеренно недоступен из Telegram.

Доступные permission modes:

- `default` — спрашивать разрешение при необходимости;
- `acceptEdits` — автоматически принимать файловые изменения;
- `plan` — работать в режиме планирования;
- `dontAsk` — отклонять действия, которые нельзя выполнить без вопроса;
- `auto` — использовать автоматическое решение SDK.

## Сессии и данные

Состояние хранится в SQLite внутри каталога `data`. После перезапуска бот видит прежние сессии и может продолжать их по сохранённому SDK session ID.

В базе также хранятся события, workflow и выданные на время сессии разрешения. Количество событий ограничивается параметром `eventRetentionPerSession`.

Сам API-ключ в SQLite не записывается.

## Безопасность

Этот бот получает право изменять ваши файлы и запускать команды. Относиться к нему нужно как к удалённому доступу к серверу, а не как к обычному чат-боту.

Перед запуском стоит проверить следующее:

- в allowlist указан только ваш Telegram ID;
- контейнеру смонтированы только нужные каталоги;
- не подключён `/var/run/docker.sock`;
- не подключены корень хоста, домашний каталог и SSH-ключи;
- сервис работает от отдельного пользователя;
- опасные команды добавлены в `disallowedTools`;
- лимиты turns, времени и бюджета подходят вашему провайдеру.

Файловые инструменты дополнительно проверяются на выход за разрешённые каталоги. Проверка учитывает `..` и существующие symlink. Но это не заменяет контейнерную или виртуальную изоляцию.

Одобренная Bash-команда выполняется с правами пользователя сервиса и с его сетевым доступом. Подробнее — в [`SECURITY.md`](SECURITY.md).

## Запуск без Docker

```bash
npm install
npm run build

cp .env.example .env
cp config/config.example.json config/config.json

node --env-file=.env dist/index.js
```

При нативном запуске пути в `config/config.json` должны существовать на самом хосте. Готовый unit-файл systemd лежит в `deploy/claudetg.service`.

Секреты для systemd лучше хранить в `/etc/claudetg/claudetg.env` с правами `0600`.

## Разработка и проверки

```bash
npm install
npm run typecheck
npm test
```

Тесты проверяют работу SQLite, хранение workflow и событий, redaction секретов, ограничения путей, symlink/traversal, лимиты Telegram-сообщений, форматирование tool use и загрузку efficiency plugins.

GitHub Actions запускает typecheck, тесты и сборку Docker-образа.

## Ограничения

ClaudeTG не преобразует OpenAI API в Anthropic API. Провайдер должен сам поддерживать формат Anthropic Messages API, streaming и tool use.

Автоматические тесты не могут проверить ваш конкретный endpoint без настоящего ключа. После развёртывания стоит вручную проверить четыре сценария:

1. обычный текстовый ответ;
2. чтение файла;
3. Bash-команду с подтверждением;
4. вопрос через `AskUserQuestion`.

## Лицензия

Apache License 2.0.
