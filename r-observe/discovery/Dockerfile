FROM node:20-alpine

RUN apk add --no-cache wget iputils bind-tools busybox-extras

WORKDIR /app

COPY discovery/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY discovery/src/       ./src/
COPY discovery/knowledge/ ./knowledge/
COPY discovery/tests/     ./tests/
COPY discovery/public/    ./public/
COPY shared/              ./shared/
# As migrations sao compartilhadas com a API em r-observe/migrations/.
# O migrate.js usa findMigrationsDir() que resolve via caminhos relativos.
# No container: nao temos migrations/ proprio, mas a API ja as executou.
# No monorepo local: resolve para ../../migrations.

RUN addgroup -S observe && adduser -S observe -G observe \
  && mkdir -p /app/data \
  && chown -R observe:observe /app/data /app/src /app/knowledge /app/tests package*.json

USER observe

EXPOSE 3010

CMD ["node", "--require", "./src/telemetry/tracing.js", "src/index.js"]
