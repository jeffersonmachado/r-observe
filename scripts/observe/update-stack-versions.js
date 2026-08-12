#!/usr/bin/env node
'use strict';

/**
 * Atualiza r-observe/api/src/stack-versions.json a partir das fontes de verdade:
 *   - docker-compose.observe.yml  (tag de imagem dos serviços com `image:`)
 *   - Dockerfiles                 (ARG <...>_VERSION= ou FROM <imagem>:<tag>)
 *   - package.json                (versão dos serviços Node r-observe)
 *
 * Execute após alterar versões de imagem no compose ou nos Dockerfiles:
 *   npm run observe:update-versions
 *
 * O arquivo gerado é carregado pela API (r-observe/api/src/index.js) e exibido
 * na página /observe/versions.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPOSE_FILE = path.join(ROOT, 'docker-compose.observe.yml');
const OUTPUT_FILE = path.join(ROOT, 'r-observe', 'api', 'src', 'stack-versions.json');

const GROUPS = [
  { id: 'core', label: 'Aplicação R-Observe' },
  { id: 'monitoring', label: 'Observabilidade' },
  { id: 'icinga', label: 'Icinga' },
  { id: 'data', label: 'Dados e infraestrutura' },
];

// Catálogo explícito: display name + fonte da versão.
// Para adicionar/remover um componente, edite apenas esta lista.
const CATALOG = [
  // Aplicação R-Observe
  { group: 'core', name: 'r-observe-api', source: { type: 'package', path: 'r-observe/api/package.json' } },
  { group: 'core', name: 'r-observe-worker', source: { type: 'package', path: 'r-observe/worker/package.json' } },
  { group: 'core', name: 'r-observe-ai', source: { type: 'package', path: 'r-observe/ai/package.json' } },
  { group: 'core', name: 'r-observe-agent', source: { type: 'package', path: 'r-observe/agent/package.json' } },
  { group: 'core', name: 'r-observe-discovery', source: { type: 'package', path: 'r-observe/discovery/package.json' } },

  // Observabilidade
  { group: 'monitoring', name: 'Prometheus', source: { type: 'compose', service: 'r-observe-prometheus' } },
  { group: 'monitoring', name: 'Loki', source: { type: 'dockerfile-arg', path: 'observe/loki/Dockerfile', arg: 'LOKI_VERSION' } },
  { group: 'monitoring', name: 'Grafana', source: { type: 'dockerfile-from', path: 'observe/grafana/Dockerfile' } },
  { group: 'monitoring', name: 'Grafana Alloy', source: { type: 'dockerfile-arg', path: 'observe/alloy/Dockerfile', arg: 'ALLOY_VERSION' } },
  { group: 'monitoring', name: 'OpenTelemetry Collector', source: { type: 'compose', service: 'r-observe-otel-collector' } },
  { group: 'monitoring', name: 'postgres-exporter', source: { type: 'dockerfile-arg', path: 'observe/postgres-exporter/Dockerfile', arg: 'POSTGRES_EXPORTER_VERSION' } },
  { group: 'monitoring', name: 'redis-exporter', source: { type: 'compose', service: 'r-observe-redis-exporter' } },
  { group: 'monitoring', name: 'snmp-exporter', source: { type: 'dockerfile-arg', path: 'observe/snmp-exporter/Dockerfile', arg: 'SNMP_EXPORTER_VERSION' } },

  // Icinga
  { group: 'icinga', name: 'Icinga 2', source: { type: 'dockerfile-from', path: 'observe/icinga2/Dockerfile' } },
  { group: 'icinga', name: 'Icinga DB', source: { type: 'dockerfile-arg', path: 'observe/icingadb/Dockerfile', arg: 'ICINGADB_VERSION' } },
  { group: 'icinga', name: 'Icinga Web 2', source: { type: 'dockerfile-from', path: 'observe/icingaweb2/Dockerfile' } },

  // Dados e infraestrutura
  { group: 'data', name: 'PostgreSQL', source: { type: 'dockerfile-from', path: 'observe/postgres/Dockerfile' } },
  { group: 'data', name: 'Redis', source: { type: 'compose', service: 'r-observe-redis' } },
  { group: 'data', name: 'Nginx (proxy)', source: { type: 'compose', service: 'r-observe-proxy' } },
];

function fail(msg) {
  console.error(`[erro] ${msg}`);
  process.exit(1);
}

function readFile(relPath) {
  const abs = path.join(ROOT, relPath);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    fail(`arquivo não encontrado: ${relPath}`);
  }
}

function extractPackageVersion(relPath) {
  const raw = readFile(relPath);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`JSON inválido: ${relPath}`);
  }
  const version = parsed && parsed.version;
  if (!version) fail(`campo "version" ausente em ${relPath}`);
  return version;
}

function extractComposeImageTag(service) {
  const raw = readFile('docker-compose.observe.yml');
  const lines = raw.split(/\r?\n/);
  const serviceRe = new RegExp(`^  ${service}:\\s*$`);
  const idx = lines.findIndex((line) => serviceRe.test(line));
  if (idx < 0) fail(`serviço ${service} não encontrado no compose`);

  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    // fim do bloco: próxima chave de 2 espaços (outro serviço/secrets/volumes/networks)
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) break;
    const m = line.match(/^\s{4}image:\s*(\S+)/);
    if (m) {
      let image = m[1].replace(/@sha256:.*$/, '');
      return image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'latest';
    }
  }
  fail(`"image:" não encontrado no serviço ${service}`);
}

function extractDockerfileArg(relPath, argName) {
  const raw = readFile(relPath);
  const re = new RegExp(`ARG\\s+${argName}=([^\\s]+)`);
  const m = raw.match(re);
  if (!m) fail(`ARG ${argName} não encontrado em ${relPath}`);
  return m[1];
}

function extractDockerfileFrom(relPath) {
  const raw = readFile(relPath);
  const froms = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^FROM\s+([^\s]+)/);
    if (m) froms.push(m[1]);
  }
  if (!froms.length) fail(`nenhuma instrução FROM em ${relPath}`);
  // O estágio de runtime é o último FROM (ex.: icinga/icinga2:2.16.4@sha256:...).
  let image = froms[froms.length - 1].replace(/@sha256:.*$/, '');
  return image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'latest';
}

function resolveVersion(entry) {
  const src = entry.source;
  switch (src.type) {
    case 'package': return extractPackageVersion(src.path);
    case 'compose': return extractComposeImageTag(src.service);
    case 'dockerfile-arg': return extractDockerfileArg(src.path, src.arg);
    case 'dockerfile-from': return extractDockerfileFrom(src.path);
    default: fail(`tipo de fonte desconhecido: ${src.type}`);
  }
}

function extractStackVersion() {
  const raw = readFile('r-observe/package.json');
  try {
    return JSON.parse(raw).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function main() {
  const out = {
    stack: 'r-observe',
    version: extractStackVersion(),
    groups: GROUPS.map((g) => ({
      id: g.id,
      label: g.label,
      components: CATALOG
        .filter((c) => c.group === g.id)
        .map((c) => ({ name: c.name, version: resolveVersion(c) })),
    })),
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2) + '\n');

  const total = out.groups.reduce((acc, g) => acc + g.components.length, 0);
  console.log(`[ok] ${total} componentes gravados em ${path.relative(ROOT, OUTPUT_FILE)}`);
  for (const g of out.groups) {
    console.log(`  ${g.label}:`);
    for (const c of g.components) {
      console.log(`    ${c.name.padEnd(28)} ${c.version}`);
    }
  }
}

main();
