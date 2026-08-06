FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git openssh-client ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 claudetg \
  && useradd --uid 10001 --gid claudetg --create-home --home-dir /app/data/home --shell /bin/bash claudetg

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
