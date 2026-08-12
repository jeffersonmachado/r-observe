FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

RUN apk add --no-cache \
    wget iputils bind-tools busybox-extras \
    nmap net-snmp-tools arp-scan \
    openssh-client sshpass

WORKDIR /app/r-observe/discovery

COPY r-observe/r-observe/discovery/package*.json ./
COPY r-observe/packages/auth/ /app/packages/auth/
RUN test -f package-lock.json && npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY r-observe/r-observe/discovery/src/       ./src/
COPY r-observe/r-observe/discovery/knowledge/ ./knowledge/
COPY r-observe/r-observe/discovery/tests/     ./tests/
COPY r-observe/r-observe/discovery/public/    ./public/
COPY r-observe/r-observe/shared/              ./shared/
# As migrations sao compartilhadas com a API em r-observe/migrations/.
# O migrate.js usa findMigrationsDir() que resolve via caminhos relativos.
# No container: nao temos migrations/ proprio, mas a API ja as executou.
# No monorepo local: resolve para ../../migrations.

RUN mkdir -p /app/data \
  && chown -R node:node /app/data ./src ./knowledge ./tests package*.json

USER node

EXPOSE 3010

CMD ["node", "--require", "./src/telemetry/tracing.js", "src/index.js"]
