FROM node:20-alpine

# curl para SSL checks; openssl para inspeção de cert
RUN apk add --no-cache wget curl openssl

WORKDIR /app

COPY agent/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY agent/src/   ./src/
COPY shared/       ./shared/

RUN addgroup -S observe && adduser -S observe -G observe

# O agente precisa ler /var/run/docker.sock para inventariar containers.
# O socket fica montado como :ro no compose, mas o GID varia entre hosts.

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
