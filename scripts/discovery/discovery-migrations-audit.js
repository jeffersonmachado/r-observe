#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '../..');
const canonicalDir = path.join(root, 'r-observe/migrations');
const mirrorDir = path.join(root, 'r-observe/migrations');
const required = [
  '001_initial_schema.sql',
  '002_icingaweb_auth.sql',
  '003_ai_catalog.sql',
  '004_discovery_engine.sql',
  '005_discovery_dedupe_indexes.sql',
  '006_discovery_policy_limits.sql',
  '007_ai_settings_persistence.sql',
  '008_fingerprint_dedup.sql',
  '009_topology_evidence.sql',
  '010_rbac_sessions.sql',
];

const mirrorRequired = [
  '001_initial_schema.sql',
  '002_icingaweb_auth.sql',
  '003_ai_catalog.sql',
  '004_discovery_engine.sql',
  '005_discovery_dedupe_indexes.sql',
  '006_discovery_logical_asset_dedupe.sql',
  '007_discovery_policy_limits.sql',
  '008_ai_settings_persistence.sql',
  '009_fingerprint_dedup.sql',
  '010_topology_evidence.sql',
  '011_rbac_sessions.sql',
  '012_audit_log.sql',
  '013_physical_layer.sql',
  '014_scheduler_quotas.sql',
  '015_agents.sql',
];

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readSql(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

const report = {
  generated_at: new Date().toISOString(),
  canonical_dir: path.relative(root, canonicalDir),
  mirror_dir: path.relative(root, mirrorDir),
  checks: [],
  checksums: {},
};

let failed = false;
function check(name, ok, detail = {}) {
  report.checks.push({ name, ok, ...detail });
  if (!ok) failed = true;
}

const canonicalFiles = fs.readdirSync(canonicalDir).filter((f) => f.endsWith('.sql')).sort();
const mirrorFiles = fs.existsSync(mirrorDir) ? fs.readdirSync(mirrorDir).filter((f) => f.endsWith('.sql')).sort() : [];

check('canonical migrations exist', required.every((f) => fs.existsSync(path.join(canonicalDir, f))), {
  required,
  found: canonicalFiles,
});
check('mirror migrations exist', mirrorRequired.every((f) => fs.existsSync(path.join(mirrorDir, f))), {
  required: mirrorRequired,
  found: mirrorFiles,
});
check('sequence has no gaps', canonicalFiles.join('|') === required.join('|'), { found: canonicalFiles });

for (const file of required) {
  const canonicalPath = path.join(canonicalDir, file);
  // Mirror pode ter prefixo numerico diferente; buscar por sufixo comum
  const fileSuffix = file.replace(/^\d+_/, '');
  const mirrorMatch = mirrorFiles.find((f) => f.replace(/^\d+_/, '') === fileSuffix);
  if (!fs.existsSync(canonicalPath) || !mirrorMatch) continue;
  const mirrorPath = path.join(mirrorDir, mirrorMatch);
  const canonicalSha = sha(canonicalPath);
  const mirrorSha = sha(mirrorPath);
  report.checksums[file] = canonicalSha;
  check(`checksum match ${file} -> ${mirrorMatch}`, canonicalSha === mirrorSha, {
    canonical_sha256: canonicalSha,
    mirror_sha256: mirrorSha,
  });
}

const migration008 = readSql(path.join(canonicalDir, '008_fingerprint_dedup.sql'));
check('008 creates fingerprint unique index', /CREATE\s+UNIQUE\s+INDEX[\s\S]+observe_service_fingerprints\s*\([\s\S]*tenant_id[\s\S]*site_id[\s\S]*edge_id[\s\S]*asset_id[\s\S]*service_key/i.test(migration008), {
  index: 'uq_observe_service_fingerprints_key',
});

const engineSql = readSql(path.join(root, 'r-observe/discovery/src/engine/discovery-engine.js')) + readSql(path.join(root, 'r-observe/discovery/src/index.js'));
check('ON CONFLICT has matching fingerprint index', /ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*site_id\s*,\s*edge_id\s*,\s*asset_id\s*,\s*service_key\s*\)/i.test(engineSql), {
  conflict_target: '(tenant_id, site_id, edge_id, asset_id, service_key)',
});

const migrateJs = readSql(path.join(root, 'r-observe/api/src/migrate.js'));
check('migrator prefers canonical monorepo path', migrateJs.includes('../../../migrations') && migrateJs.includes('../migrations'), {
  migrator: 'r-observe/api/src/migrate.js',
});

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const outPath = path.join(root, 'dist/discovery-migrations-audit.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

for (const item of report.checks) {
  console.log(`${item.ok ? '[PASS]' : '[FAIL]'} ${item.name}`);
}
console.log(`[discovery:migrations:audit] report=${path.relative(root, outPath)}`);
if (failed) process.exit(1);
