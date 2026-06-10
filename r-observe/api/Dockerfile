FROM node:20-alpine

RUN apk add --no-cache wget curl

WORKDIR /app

COPY api/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY api/src/        ./src/
COPY migrations/     ./migrations/
COPY api/public/     ./public/
COPY shared/         ./shared/

RUN addgroup -S observe && adduser -S observe -G observe \
    && mkdir -p /app/data/evidence /app/data/replays /app/logs \
    && chown -R observe:observe /app/data /app/logs /app/src /app/migrations package*.json

USER observe

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/observe/api/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
