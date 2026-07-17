FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    HEALTH_HOST=127.0.0.1 \
    HEALTH_PORT=3032

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY LICENSE NOTICE ./
COPY src ./src

RUN mkdir -p /app/data /app/logs \
    && chown -R node:node /app

USER node

EXPOSE 3032

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3032/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
