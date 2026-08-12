FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

RUN apk add --no-cache wget curl

WORKDIR /app/r-observe/api

# O context eh /opt/results/ria/ (parent de r-observe)
COPY r-observe/r-observe/api/package*.json ./
# Preserva a topologia usada pelo link file:../../packages/auth do lockfile.
COPY r-observe/packages/auth/ /app/packages/auth/
RUN test -f package-lock.json && npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY r-observe/r-observe/api/src/        ./src/
COPY r-observe/r-observe/migrations/     ./migrations/
COPY r-observe/r-observe/api/public/     ./public/
COPY r-observe/r-observe/shared/         ./shared/

RUN mkdir -p /app/data/evidence /app/data/replays /app/logs \
    && chown -R node:node /app/data /app/logs ./src ./migrations package*.json

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/observe/api/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
