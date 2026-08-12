#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const os = require('os');

function run(cmd, args, options = {}) {
  const res = cp.spawnSync(cmd, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const detail = `${res.stderr || ''}\n${res.stdout || ''}`.trim();
    throw new Error(`${cmd} ${args.join(' ')} failed: ${detail || `exit ${res.status}`}`);
  }
  return res.stdout;
}

function parseArgs(argv) {
  const args = { root: process.cwd(), runtime: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--zip') args.zip = argv[++i];
    else if (token === '--root') args.root = argv[++i];
    else if (token === '--report') args.report = argv[++i];
    else if (token === '--hash-file') args.hashFile = argv[++i];
    else if (token === '--runtime') args.runtime = true;
    else throw new Error(`Argumento desconhecido: ${token}`);
  }
  if (!args.zip) throw new Error('Uso: --zip <dist/r-observe.zip> [--root <workspace>] [--report <json>]');
  return args;
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function sha256Text(text) {
  const h = crypto.createHash('sha256');
  h.update(text, 'utf8');
  return h.digest('hex');
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readZipEntries(zipPath) {
  return run('zipinfo', ['-1', zipPath])
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, '').trim())
    .filter(Boolean);
}

function readZipText(zipPath, entry) {
  return run('unzip', ['-p', zipPath, entry]);
}

function extractZip(zipPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-observe-validate-extract-'));
  run('unzip', ['-q', zipPath, '-d', dir]);
  return dir;
}

function parseManifestText(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function diff(left, right) {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return {
    onlyLeft: left.filter((entry) => !rightSet.has(entry)),
    onlyRight: right.filter((entry) => !leftSet.has(entry)),
  };
}

function loadRequired(rootDir) {
  const requiredPath = path.join(rootDir, 'scripts/package/required-enterprise-files.txt');
  if (!fs.existsSync(requiredPath)) throw new Error(`Arquivo obrigatorio ausente: ${requiredPath}`);
  return fs.readFileSync(requiredPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function loadExpectedPackageEntries(rootDir) {
  const out = run('bash', ['scripts/package/package-file-list.sh', 'scripts/package/required-enterprise-files.txt'], { cwd: rootDir });
  return sortedUnique(
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function assertExecutableInZip(zipPath, entry, errors) {
  const listing = run('zipinfo', ['-l', zipPath, entry]).split(/\r?\n/).find((line) => line.includes(entry));
  if (!listing) {
    errors.push(`Nao foi possivel ler modo no ZIP: ${entry}`);
    return;
  }
  const mode = listing.trim().split(/\s+/)[0] || '';
  if (!/^[-dl]?..x..x..x/.test(mode) && !/^[-dl]?.{2}x.{2}x.{2}x/.test(mode)) {
    errors.push(`Arquivo sem permissao executavel no ZIP: ${entry} (${mode})`);
  }
}

function writeReport(reportPath, result) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(args.root);
  const zipPath = path.resolve(rootDir, args.zip);
  const distDir = path.dirname(zipPath);
  const zipBase = path.basename(zipPath, '.zip');
  const manifestTxtPath = path.join(distDir, `${zipBase}-manifest.txt`);
  const manifestJsonPath = path.join(distDir, `${zipBase}-manifest.json`);
  const hashFile = args.hashFile
    ? path.resolve(rootDir, args.hashFile)
    : path.join(distDir, `${path.basename(zipPath)}.sha256`);
  const reportPath = args.report
    ? path.resolve(rootDir, args.report)
    : path.join(distDir, `${zipBase}-enterprise-validate.json`);
  const provenancePath = path.join(distDir, `${zipBase}-provenance.json`);
  const attestationPath = path.join(distDir, `${zipBase}-attestation.json`);

  const errors = [];
  const warnings = [];
  const result = {
    zip: path.relative(rootDir, zipPath),
    checked_at: new Date().toISOString(),
    status: 'green',
    summary: {},
    errors,
    warnings,
  };

  if (!fs.existsSync(zipPath)) errors.push(`r-observe.zip ausente: ${path.relative(rootDir, zipPath)}`);
  if (!fs.existsSync(manifestTxtPath)) errors.push(`r-observe-manifest.txt ausente: ${path.relative(rootDir, manifestTxtPath)}`);
  if (!fs.existsSync(manifestJsonPath)) errors.push(`r-observe-manifest.json ausente: ${path.relative(rootDir, manifestJsonPath)}`);
  if (errors.length > 0) {
    result.status = 'red';
    writeReport(reportPath, result);
    for (const err of errors) console.error(` - ${err}`);
    process.exit(1);
  }

  const zipEntriesRaw = readZipEntries(zipPath);
  const zipEntries = sortedUnique(zipEntriesRaw);
  const duplicateEntries = sortedUnique(zipEntriesRaw.filter((entry, index) => zipEntriesRaw.indexOf(entry) !== index));
  if (duplicateEntries.length > 0) errors.push(`ZIP contem entradas duplicadas: ${duplicateEntries.slice(0, 30).join(', ')}`);

  const manifestLines = sortedUnique(parseManifestText(manifestTxtPath));
  const manifestRawLines = parseManifestText(manifestTxtPath);
  if (manifestLines.length !== manifestRawLines.length) errors.push('r-observe-manifest.txt contem linhas duplicadas');

  const manifestJson = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
  const zipSha = sha256File(zipPath);
  const manifestTxt = `${manifestLines.join('\n')}\n`;
  const manifestTxtSha = sha256Text(manifestTxt);

  const staleInside = zipEntries.filter((entry) => {
    const base = path.basename(entry);
    return /^r-observe(-release)?-manifest\.(txt|json)$/i.test(base)
      || /^release-(gate|audit|smoke)-report\.json$/i.test(base)
      || /enterprise-validate\.json$/i.test(base);
  });
  if (staleInside.length > 0) errors.push(`Manifestos/relatorios dentro do ZIP: ${staleInside.slice(0, 30).join(', ')}`);

  const forbiddenInside = zipEntries.filter((entry) => {
    const base = path.basename(entry);
    if (entry === '.gitignore' || entry.startsWith('.git/') || entry.includes('/.git/')) return true;
    if (entry.startsWith('node_modules/') || entry.includes('/node_modules/')) return true;
    if (base === '.env' || (base.startsWith('.env.') && !base.endsWith('.example'))) return true;
    if (/\.token\.env$/i.test(base)) return true;
    if (/\.(pem|key|p12|pfx|kdbx)$/i.test(base)) return true;
    return false;
  });
  if (forbiddenInside.length > 0) errors.push(`Arquivos proibidos dentro do ZIP: ${forbiddenInside.slice(0, 30).join(', ')}`);

  const allowedMetadata = new Set();
  const zipManifestDiff = diff(manifestLines, zipEntries.filter((entry) => !allowedMetadata.has(entry)));
  if (zipManifestDiff.onlyLeft.length > 0) {
    errors.push(`TXT lista arquivos ausentes no ZIP: ${zipManifestDiff.onlyLeft.slice(0, 30).join(', ')}`);
  }
  if (zipManifestDiff.onlyRight.length > 0) {
    errors.push(`ZIP contem arquivos fora do TXT: ${zipManifestDiff.onlyRight.slice(0, 30).join(', ')}`);
  }

  if (Number(manifestJson.file_count) !== zipEntries.length) {
    errors.push(`file_count do JSON diverge do ZIP real: ${manifestJson.file_count} != ${zipEntries.length}`);
  }
  if (manifestJson.manifest_sha256 !== manifestTxtSha) {
    errors.push(`manifest_sha256 nao bate com SHA256 real do manifesto TXT: ${manifestJson.manifest_sha256} != ${manifestTxtSha}`);
  }
  if (manifestJson.zip_sha256 && manifestJson.zip_sha256 !== zipSha) {
    errors.push(`zip_sha256 nao bate com SHA256 real do ZIP: ${manifestJson.zip_sha256} != ${zipSha}`);
  }
  if (manifestJson.manifest_txt_sha256 && manifestJson.manifest_txt_sha256 !== manifestTxtSha) {
    errors.push(`manifest_txt_sha256 invalido: ${manifestJson.manifest_txt_sha256} != ${manifestTxtSha}`);
  }

  if (fs.existsSync(hashFile)) {
    const hashContent = fs.readFileSync(hashFile, 'utf8').trim();
    const expectedBase = path.basename(zipPath);
    if (!/^[a-f0-9]{64}\s{2}[^\s]+$/.test(hashContent)) {
      errors.push(`Formato invalido de .sha256: esperado '<sha256>  <arquivo>' em ${path.relative(rootDir, hashFile)}`);
    }
    const hashParts = hashContent.split(/\s+/);
    if (hashParts[1] && hashParts[1] !== expectedBase) {
      errors.push(`Arquivo .sha256 aponta para nome incorreto: ${hashParts[1]} != ${expectedBase}`);
    }
    const hashFromFile = hashParts[0];
    if (hashFromFile !== zipSha) errors.push(`Arquivo .sha256 diverge do ZIP real: ${hashFromFile} != ${zipSha}`);
  } else {
    errors.push(`Arquivo .sha256 ausente: ${path.relative(rootDir, hashFile)}`);
  }

  const expectedEntries = loadExpectedPackageEntries(rootDir);
  const workspaceZipDiff = diff(expectedEntries, zipEntries);
  if (workspaceZipDiff.onlyLeft.length > 0) {
    errors.push(`Drift workspace->ZIP (faltando no ZIP): ${workspaceZipDiff.onlyLeft.slice(0, 30).join(', ')}`);
  }
  if (workspaceZipDiff.onlyRight.length > 0) {
    errors.push(`Drift workspace->ZIP (orfao no ZIP): ${workspaceZipDiff.onlyRight.slice(0, 30).join(', ')}`);
  }

  for (const governanceFile of [provenancePath, attestationPath]) {
    if (!fs.existsSync(governanceFile)) errors.push(`Governanca de release ausente: ${path.relative(rootDir, governanceFile)}`);
  }
  if (fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    if (provenance.zip_sha256 !== zipSha) errors.push(`provenance zip_sha256 diverge: ${provenance.zip_sha256} != ${zipSha}`);
    if (Number(provenance.file_count) !== zipEntries.length) errors.push(`provenance file_count diverge: ${provenance.file_count} != ${zipEntries.length}`);
  }
  if (fs.existsSync(attestationPath)) {
    const attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
    if (attestation.artifact_sha256 !== zipSha) errors.push(`attestation artifact_sha256 diverge: ${attestation.artifact_sha256} != ${zipSha}`);
  }

  const requiredFiles = loadRequired(rootDir);
  const zipSet = new Set(zipEntries);
  for (const req of requiredFiles) {
    if (!fs.existsSync(path.join(rootDir, req))) errors.push(`Arquivo obrigatorio ausente no workspace: ${req}`);
    if (!zipSet.has(req)) errors.push(`Arquivo obrigatorio ausente no ZIP: ${req}`);
  }

  const enterpriseFiles = [
    'docs/observe/discovery-enterprise-engine.md',
    'r-observe/discovery/src/passive/receivers.js',
    'r-observe/discovery/src/scanners/arp-discovery.js',
    'r-observe/discovery/src/scanners/snmp-discovery.js',
    'r-observe/discovery/src/scanners/target-expansion.js',
    'r-observe/discovery/src/topology/graph-store.js',
    'r-observe/discovery/tests/unit/arp-discovery.test.js',
    'r-observe/discovery/tests/unit/graph-store.test.js',
    'r-observe/discovery/tests/unit/icinga-sync.test.js',
    'r-observe/discovery/tests/unit/passive-parser.test.js',
    'r-observe/discovery/tests/unit/snmp-discovery.test.js',
    'r-observe/discovery/tests/unit/target-expansion.test.js',
    'scripts/discovery/discovery-enterprise-smoke.sh',
  ];
  for (const entry of enterpriseFiles) {
    if (!zipSet.has(entry)) errors.push(`Discovery Enterprise ausente no ZIP: ${entry}`);
  }
  assertExecutableInZip(zipPath, 'scripts/discovery/discovery-enterprise-smoke.sh', errors);

  const internalManifestEntries = zipEntries.filter((entry) => /(^|\/)r-observe(-release)?-manifest\.(txt|json)$/i.test(entry));
  for (const entry of internalManifestEntries) {
    if (entry.endsWith('.txt')) {
      const internal = readZipText(zipPath, entry);
      const external = fs.readFileSync(manifestTxtPath, 'utf8');
      if (internal !== external) errors.push(`Manifesto interno diverge do externo: ${entry}`);
    }
    if (entry.endsWith('.json')) {
      const internal = readZipText(zipPath, entry);
      const external = fs.readFileSync(manifestJsonPath, 'utf8');
      if (internal !== external) errors.push(`Manifesto interno diverge do externo: ${entry}`);
    }
  }

  let extractedDir = '';
  try {
    extractedDir = extractZip(zipPath);
    const extractedEntries = sortedUnique(run('find', ['.', '-type', 'f', '-printf', '%P\n'], { cwd: extractedDir }).split(/\r?\n/).filter(Boolean));
    const extractedDiff = diff(zipEntries, extractedEntries);
    if (extractedDiff.onlyLeft.length > 0 || extractedDiff.onlyRight.length > 0) {
      errors.push(`Extracao diverge do ZIP: missing=${extractedDiff.onlyLeft.slice(0, 10).join(', ')} extra=${extractedDiff.onlyRight.slice(0, 10).join(', ')}`);
    }
    const depArgs = ['scripts/release/validate-extracted-package.js', '--root', extractedDir];
    if (args.runtime) depArgs.push('--run-install', '--run-tests', '--run-smoke');
    run('node', depArgs, { cwd: extractedDir });
  } catch (err) {
    errors.push(`Validacao do pacote extraido falhou: ${err.message}`);
  } finally {
    if (extractedDir) fs.rmSync(extractedDir, { recursive: true, force: true });
  }

  const allowedDist = new Set([
    'r-observe.zip',
    'r-observe.zip.sha256',
    'r-observe-manifest.txt',
    'r-observe-manifest.json',
    'r-observe-provenance.json',
    'r-observe-attestation.json',
    'r-observe-zip.log',
    'r-observe-validate.log',
    'r-observe-enterprise-validate.json',
    'r-observe-release.zip',
    'r-observe-release.zip.sha256',
    'r-observe-release-manifest.txt',
    'r-observe-release-manifest.json',
    'r-observe-release-provenance.json',
    'r-observe-release-attestation.json',
    'r-observe-release-zip.log',
    'r-observe-release-validate.log',
    'r-observe-release-enterprise-validate.json',
    'zip-timing.log',
    'release-timing.log',
    'release-gate-report.json',
    'release-audit-report.json',
    'release-smoke-report.json',
    'discovery-gate-timing.log',
    'discovery-smoke-real.json',
    'discovery-doctor.json',
    'discovery-audit-fingerprints.json',
    'discovery-audit-anti-hardcode.json',
    'discovery-migrations-audit.json',
    'discovery-validation',
  ]);
  const distContamination = fs.readdirSync(distDir).filter((name) => !allowedDist.has(name));
  if (distContamination.length > 0) errors.push(`dist contaminado com artefatos nao permitidos: ${distContamination.slice(0, 30).join(', ')}`);

  result.summary = {
    zip_file_count: zipEntries.length,
    manifest_file_count: manifestLines.length,
    required_files_checked: requiredFiles.length,
    enterprise_files_checked: enterpriseFiles.length,
    zip_sha256: zipSha,
    manifest_txt_sha256: manifestTxtSha,
    manifest_txt: path.relative(rootDir, manifestTxtPath),
    manifest_json: path.relative(rootDir, manifestJsonPath),
    hash_file: path.relative(rootDir, hashFile),
    stale_inside_count: staleInside.length,
    forbidden_inside_count: forbiddenInside.length,
    provenance: path.relative(rootDir, provenancePath),
    attestation: path.relative(rootDir, attestationPath),
    runtime_validation: args.runtime,
    expected_workspace_file_count: expectedEntries.length,
  };

  if (errors.length > 0) result.status = 'red';
  writeReport(reportPath, result);

  if (result.status !== 'green') {
    console.error(`[validate-enterprise-package] FAIL: ${path.relative(rootDir, zipPath)}`);
    for (const err of errors) console.error(` - ${err}`);
    process.exit(1);
  }

  console.log(`[validate-enterprise-package] OK: ${path.relative(rootDir, zipPath)}`);
  console.log(`[validate-enterprise-package] file_count=${zipEntries.length} sha256=${zipSha}`);
}

main();
