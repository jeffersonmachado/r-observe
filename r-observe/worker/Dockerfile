FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# Chrome for Testing 146.0.7680.153 para o canal WhatsApp QR (whatsapp-web.js
# → puppeteer) — mesma versão oficial usada pelo r-agent2, que pareia em prod
# na mesma máquina. O Chromium de distribuição (Alpine/Debian) falhava no
# pareamento do WA Web (celular fica "conectando" e nenhum evento chega).
#
# Base Debian (não Alpine): o Chrome for Testing oficial só tem build glibc.
# Libs de runtime do Chrome via apt; PUPPETEER_SKIP_DOWNLOAD evita baixar
# browser no npm ci (o download explícito e pinado é feito abaixo).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates wget fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
    libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
    libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_CACHE_DIR=/opt/puppeteer-cache

WORKDIR /app/r-observe/worker

COPY r-observe/r-observe/worker/package*.json ./
COPY r-observe/packages/auth/ /app/packages/auth/
# file:../../../packages/whatsapp-qr-bridge resolve para /packages/... no container
COPY packages/whatsapp-qr-bridge/ /packages/whatsapp-qr-bridge/
RUN test -f package-lock.json && npm ci --omit=dev && npm cache clean --force

# Download do Chrome for Testing na versão exata (pinada) num cache dir fixo.
# Usa o CLI do pacote `puppeteer` (dependência do whatsapp-web.js), então precisa
# rodar ANTES da remoção do npm/npx da imagem. O cache dir fica legível pelo
# usuário `node` (runtime).
RUN npm exec -- puppeteer browsers install chrome@146.0.7680.153 \
    && chmod -R a+rX /opt/puppeteer-cache \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

# O puppeteer resolve o binário pelo PUPPETEER_CACHE_DIR apenas quando a versão
# instalada é a que ele espera; como fixamos 146.0.7680.153 (diferente do pin
# do puppeteer 24.x), apontamos o executável explicitamente — o puppeteer
# honra PUPPETEER_EXECUTABLE_PATH como override de configuração.
ENV PUPPETEER_EXECUTABLE_PATH=/opt/puppeteer-cache/chrome/linux-146.0.7680.153/chrome-linux64/chrome

COPY r-observe/r-observe/worker/src/   ./src/
COPY r-observe/r-observe/shared/       ./shared/

RUN mkdir -p /app/data/evidence /app/data/replays /app/logs /var/lib/r-observe/whatsapp-auth \
    && chown -R node:node /app/data /app/logs /var/lib/r-observe/whatsapp-auth

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "--require", "./src/tracing.js", "src/index.js"]
