FROM node:20-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY ai/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY ai/src/   ./src/
COPY shared/   ./shared/

RUN addgroup -S observe && adduser -S observe -G observe \
    && chown -R observe:observe /app

USER observe

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
