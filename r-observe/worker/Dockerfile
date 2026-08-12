FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

RUN apk add --no-cache wget

WORKDIR /app/r-observe/worker

COPY r-observe/r-observe/worker/package*.json ./
COPY r-observe/packages/auth/ /app/packages/auth/
RUN test -f package-lock.json && npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY r-observe/r-observe/worker/src/   ./src/
COPY r-observe/r-observe/shared/       ./shared/

RUN mkdir -p /app/data/evidence /app/data/replays /app/logs \
    && chown -R node:node /app/data /app/logs

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
