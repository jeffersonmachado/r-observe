FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

# curl para SSL checks; openssl para inspeção de cert
RUN apk add --no-cache wget curl openssl

WORKDIR /app/r-observe/agent

COPY r-observe/r-observe/agent/package*.json ./
COPY r-observe/packages/auth/ /app/packages/auth/
RUN test -f package-lock.json && npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY r-observe/r-observe/agent/src/   ./src/
COPY r-observe/r-observe/shared/       ./shared/

# O agente precisa ler /var/run/docker.sock para inventariar containers.
# O socket fica montado como :ro no compose, mas o GID varia entre hosts.

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
