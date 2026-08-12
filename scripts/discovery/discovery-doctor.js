#!/usr/bin/env node
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');

const failures = [];
const warnings = [];
const recommendations = [];
const environmentUnavailable = [];
const checks = [];
const commands = [];

function gitCommit() {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 3000 });
    return (r.stdout || '').trim() || 'unknown';
  } catch (_) { return 'unknown'; }
}

function cmd(name, args, options = {}) {
  commands.push([name, ...args].join(' '));
  const r = spawnSync(name, args, { cwd: root, encoding: 'utf8', timeout: options.timeout || 10000 });
  return { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function envFromFile(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return env;
}

function portOpen(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

function check(name, ok, detail = {}) {
  const entry = { name, ok, ...detail };
  checks.push(entry);
  if (!ok) {
    if (detail.environment_unavailable) {
      environmentUnavailable.push({ check: name, ...detail });
    } else {
      failures.push({ check: name, ...detail });
    }
  }
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail.note ? ' — ' + detail.note : ''}`);
  return ok;
}

function warn(message, detail = {}) {
  warnings.push({ message, ...detail });
}

function recommend(message) {
  recommendations.push(message);
}

(async () => {
  const envFile = path.join(root, '.env.observe');
  const fileEnv = envFromFile(envFile);
  const env = { ...fileEnv, ...process.env };
  const dbPort = Number(env.OBSERVE_DB_PORT || env.DB_PORT || 5432);
  const redisPort = Number(env.OBSERVE_REDIS_PORT || env.REDIS_PORT || 6379);
  const mode = env.OBSERVE_MODE || 'host-dev';

  // --- Runtime tools ---
  check('Node available', !!process.version, { version: process.version });

  const npm = cmd('npm', ['--version']);
  if (!npm.ok) recommend('Install npm: https://nodejs.org');
  check('npm available', npm.ok, { version: npm.stdout });

  const docker = cmd('docker', ['--version']);
  if (!docker.ok) {
    warn('Docker not available — local container dependencies (postgres/redis) cannot be started');
    recommend('Install Docker to use dev:up for local dependencies');
  }
  check('Docker available', docker.ok, {
    version: docker.stdout,
    note: docker.ok ? null : 'required for dev:up (local postgres/redis)',
  });

  if (docker.ok) {
    const compose = cmd('docker', ['compose', 'version']);
    if (!compose.ok) recommend('Upgrade Docker to include Compose v2: docker compose');
    check('docker compose available', compose.ok, { version: compose.stdout });
  } else {
    check('docker compose available', false, {
      note: 'Docker not present — compose unavailable',
      environment_unavailable: true,
    });
  }

  // --- Environment variables ---
  const envFile_ = path.join(root, '.env.observe');
  check('.env.observe exists', fs.existsSync(envFile_), {
    path: envFile_,
    note: fs.existsSync(envFile_) ? null : 'create .env.observe from .env.observe.example',
  });
  if (!fs.existsSync(envFile_)) recommend('Copy .env.observe.example to .env.observe and fill in values');

  for (const key of ['OBSERVE_DB_NAME', 'OBSERVE_DB_USER', 'OBSERVE_DB_PASSWORD']) {
    const present = !!env[key];
    if (!present) recommend(`Set ${key} in .env.observe`);
    check(`env ${key}`, present, { required: true });
  }
  for (const service of ['api', 'worker', 'agent', 'discovery', 'automation']) {
    for (const kind of ['private', 'public']) {
      const keyPath = path.join(root, 'secrets', `jwt_${service}_${kind}.pem`);
      check(`JWT ${service} ${kind} key`, fs.existsSync(keyPath), { path: keyPath, required: true });
    }
  }
  check('env OBSERVE_REDIS_PASSWORD optional', true, {
    required: false,
    present: !!env.OBSERVE_REDIS_PASSWORD,
  });

  // --- Connectivity ---
  const pgOk = await portOpen('127.0.0.1', dbPort);
  if (!pgOk) {
    const msg = `PostgreSQL not reachable at 127.0.0.1:${dbPort}`;
    warn(msg, { environment_unavailable: true });
    recommend(`Start dependencies: npm run dev:up  (or docker compose -f docker-compose.observe.yml up -d observe-postgres)`);
  }
  check('PostgreSQL TCP reachable', pgOk, {
    host: '127.0.0.1',
    port: dbPort,
    environment_unavailable: !pgOk,
  });

  const redisOk = await portOpen('127.0.0.1', redisPort);
  if (!redisOk) {
    warn(`Redis not reachable at 127.0.0.1:${redisPort}`, { environment_unavailable: true });
    recommend(`Start dependencies: npm run dev:up  (or docker compose -f docker-compose.observe.yml up -d observe-redis)`);
  }
  check('Redis TCP reachable', redisOk, {
    host: '127.0.0.1',
    port: redisPort,
    environment_unavailable: !redisOk,
  });

  // --- Migrations ---
  const audit = cmd('node', ['./scripts/discovery/discovery-migrations-audit.js']);
  if (!audit.ok) recommend('Run: npm run discovery:migrations:audit to diagnose migration drift');
  check('migrations audit', audit.ok, { status: audit.status });

  // --- Dev ports ---
  const devPorts = [
    { port: 3009, name: 'API' },
    { port: 3010, name: 'Discovery' },
    { port: 3011, name: 'AI mock' },
    { port: 5177, name: 'Frontend' },
  ];
  for (const { port, name } of devPorts) {
    const open = await portOpen('127.0.0.1', port, 400);
    check(`dev port ${port} (${name})`, true, {
      occupied: open,
      note: open ? `${name} appears to be running` : `${name} not running (start with npm run dev)`,
    });
  }

  // --- Network ---
  const ip = cmd('ip', ['addr']);
  let nodeInterfaces = {};
  let nodeInterfaceError = null;
  try {
    nodeInterfaces = os.networkInterfaces();
  } catch (e) {
    nodeInterfaceError = e.message;
  }
  const interfaceNames = Object.keys(nodeInterfaces);
  check('network interfaces readable', ip.ok || interfaceNames.length > 0, {
    sample: ip.ok
      ? ip.stdout.split('\n').slice(0, 3).join('\n')
      : interfaceNames.slice(0, 5).join(', '),
    fallback: ip.ok ? null : 'node os.networkInterfaces',
    error: ip.ok ? null : nodeInterfaceError || ip.stderr,
    environment_unavailable: !ip.ok && interfaceNames.length === 0,
  });
  check('ping/ARP permissions safe-mode', true, {
    note: 'active ping/ARP is optional — only required when DISCOVERY_ALLOW_PING=true',
  });

  // --- Optional services ---
  check('Neo4j optional', true, {
    enabled: !!env.NEO4J_URI,
    note: env.NEO4J_URI ? 'Neo4j configured' : 'Neo4j not configured (graph-store disabled)',
  });

  // --- Prometheus SD path ---
  const sdPath = env.PROMETHEUS_FILE_SD_PATH || path.join(root, 'observe/prometheus/sd/discovery-engine.json');
  const sdDir = path.dirname(sdPath);
  let sdWritable = false;
  try { fs.accessSync(sdDir, fs.constants.W_OK); sdWritable = true; } catch (_) {}
  if (!sdWritable) recommend(`Create and make writable: ${sdDir}`);
  check('Prometheus SD path writable', sdWritable, { path: sdPath });

  // --- Compose file ---
  const composeFile = path.join(root, 'docker-compose.observe.yml');
  check('docker-compose.observe.yml exists', fs.existsSync(composeFile), { path: composeFile });

  // --- Determine status ---
  const realFailures = failures.filter((f) => !f.environment_unavailable);
  const envOnlyFailures = failures.filter((f) => f.environment_unavailable);
  const enterpriseApproved = realFailures.length === 0 && envOnlyFailures.length === 0;
  const status = enterpriseApproved ? 'GO' : 'NO_GO';

  const report = {
    status,
    enterpriseApproved,
    mode,
    generatedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    checks,
    failures: realFailures,
    warnings,
    environmentUnavailable: envOnlyFailures,
    recommendations,
    commands,
  };

  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const out = path.join(root, 'dist/discovery-doctor.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  if (realFailures.length) {
    console.error(`\n[discovery:doctor] FAIL — ${realFailures.length} failure(s):`);
    realFailures.forEach((f) => console.error(`  [FAIL] ${f.check}${f.note ? ': ' + f.note : ''}`));
  }
  if (envOnlyFailures.length) {
    console.warn(`\n[discovery:doctor] WARN — ${envOnlyFailures.length} environment unavailable (not blocking enterprise approval if intentional):`);
    envOnlyFailures.forEach((f) => console.warn(`  [ENV] ${f.check}`));
  }
  if (recommendations.length) {
    console.log('\n[discovery:doctor] Recommendations:');
    recommendations.forEach((r) => console.log(`  → ${r}`));
  }

  console.log(`\n[discovery:doctor] status=${status} enterpriseApproved=${enterpriseApproved} report=dist/discovery-doctor.json`);
  process.exit(realFailures.length ? 1 : 0);
})().catch((e) => {
  console.error('[discovery:doctor] fatal:', e.message);
  process.exit(1);
});
