FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS controller

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 claudetg \
  && useradd --uid 10001 --gid claudetg --create-home --home-dir /app/data/home --shell /usr/sbin/nologin claudetg

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config/config.example.json ./config/config.example.json

RUN mkdir -p /app/data/home /app/config \
  && chown -R claudetg:claudetg /app/data /app/config

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    CONFIG_PATH=/app/config/config.json \
    HOME=/app/data/home \
    HEALTH_PORT=3000

USER claudetg
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/index.js"]

FROM node:22-bookworm-slim AS worker

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git openssh-client ripgrep jq universal-ctags \
       python3 python3-pip python3-venv \
  && python3 -m venv /opt/serena \
  && /opt/serena/bin/pip install --no-cache-dir serena-agent==1.6.1 \
  && python3 -m venv /opt/semble \
  && /opt/semble/bin/pip install --no-cache-dir semble==0.5.2 \
  && ln -s /opt/serena/bin/serena /usr/local/bin/serena \
  && ln -s /opt/semble/bin/semble /usr/local/bin/semble \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 claude \
  && useradd --uid 10001 --gid claude --create-home --home-dir /home/claude --shell /bin/bash claude \
  && mkdir -p /workspace /home/claude/.local/bin /home/claude/.cache /home/claude/.config /home/claude/.npm \
  && chown -R claude:claude /home/claude /workspace

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY plugins ./plugins

ENV NODE_ENV=production \
    HOME=/home/claude \
    USER=claude \
    LOGNAME=claude \
    SHELL=/bin/bash \
    WORKER_PORT=3100 \
    WORKSPACE_PATH=/workspace \
    NPM_CONFIG_PREFIX=/home/claude/.local \
    NPM_CONFIG_CACHE=/home/claude/.npm \
    XDG_CACHE_HOME=/home/claude/.cache \
    XDG_CONFIG_HOME=/home/claude/.config \
    CTX7_TELEMETRY_DISABLED=1 \
    PATH=/home/claude/.local/bin:/app/node_modules/.bin:/opt/serena/bin:/opt/semble/bin:${PATH}

USER claude
EXPOSE 3100
CMD ["node", "--enable-source-maps", "dist/worker.js"]
