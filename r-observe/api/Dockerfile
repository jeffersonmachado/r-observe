FROM node:20-alpine

RUN apk add --no-cache wget curl

WORKDIR /app

# O context eh /opt/results/ (parent de r-observe)
COPY r-observe/r-observe/api/package*.json ./
# Prepara @results/auth como tgz (nao pode usar file: via npm ci direto)
COPY packages/auth/  /tmp/auth-src/
RUN mkdir -p /tmp/auth-pkg && cd /tmp/auth-src && npm pack --pack-destination /tmp/auth-pkg && \
    cp /tmp/auth-pkg/results-auth-*.tgz /tmp/auth.tgz && \
    rm -rf /tmp/auth-src /tmp/auth-pkg

# Remove a dependencia file do package.json e apaga lock (sera regenerado)
RUN sed -i '/"@results\/auth"/d' /app/package.json && rm -f /app/package-lock.json

RUN npm install --omit=dev && npm install --omit=dev /tmp/auth.tgz && npm cache clean --force && rm -f /tmp/auth.tgz

COPY r-observe/r-observe/api/src/        ./src/
COPY r-observe/r-observe/migrations/     ./migrations/
COPY r-observe/r-observe/api/public/     ./public/
COPY r-observe/r-observe/shared/         ./shared/

RUN addgroup -S observe && adduser -S observe -G observe \
    && mkdir -p /app/data/evidence /app/data/replays /app/logs \
    && chown -R observe:observe /app/data /app/logs /app/src /app/migrations package*.json

USER observe

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/observe/api/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
