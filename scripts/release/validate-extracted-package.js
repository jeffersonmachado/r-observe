#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const moduleBuiltin = require('module');
const crypto = require('crypto');

const BUILTINS = new Set(moduleBuiltin.builtinModules.concat(moduleBuiltin.builtinModules.map((m) => `node:${m}`)));
const JS_EXTS = ['.js', '.cjs', '.mjs', '.json', '/index.js', '/index.cjs', '/index.mjs'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);

function parseArgs(argv) {
  const args = { runInstall: false, runTests: false, runSmoke: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') args.root = argv[++i];
    else if (token === '--run-install') args.runInstall = true;
    else if (token === '--run-tests') args.runTests = true;
    else if (token === '--run-smoke') args.runSmoke = true;
    else throw new Error(`Argumento desconhecido: ${token}`);
  }
  if (!args.root) throw new Error('Uso: --root <pacote-extraido> [--run-install] [--run-tests] [--run-smoke]');
  return args;
}

function run(cmd, args, options = {}) {
  const res = cp.spawnSync(cmd, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });
  return res;
}

function cmdLabel(cmd, args, cwd) {
  return `${cwd || process.cwd()}$ ${cmd} ${args.join(' ')}`;
}

function appendCannotFindModuleErrors(output, context, errors) {
  const text = output || '';
  const hits = text.match(/Cannot find module\s+['"][^'"]+['"]/gi) || [];
  for (const hit of hits) {
    errors.push(`${context}: ${hit}`);
  }
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function findPackageDirs(rootDir) {
  return walk(rootDir)
    .filter((file) => path.basename(file) === 'package.json')
    .map((file) => path.dirname(file))
    .sort();
}

function nearestPackageDir(filePath, packageDirs) {
  let best = null;
  for (const dir of packageDirs) {
    if (filePath === dir || filePath.startsWith(`${dir}${path.sep}`)) {
      if (!best || dir.length > best.length) best = dir;
    }
  }
  return best;
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

function fileExistsWithExt(basePath) {
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) return true;
  for (const ext of JS_EXTS) {
    if (fs.existsSync(`${basePath}${ext}`) && fs.statSync(`${basePath}${ext}`).isFile()) return true;
  }
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of JS_EXTS.filter((v) => v.startsWith('/'))) {
      if (fs.existsSync(`${basePath}${ext}`)) return true;
    }
    const pkgPath = path.join(basePath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg.main && fs.existsSync(path.join(basePath, pkg.main))) return true;
    }
  }
  return false;
}

function extractImports(source) {
  const specs = [];
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specs.push(match[1]);
  }
  return specs;
}

function validateLocks(packageDirs, errors) {
  for (const dir of packageDirs) {
    const pkgPath = path.join(dir, 'package.json');
    const lockPath = path.join(dir, 'package-lock.json');
    const pkg = readJson(pkgPath);
    if (!pkg.dependencies && !pkg.devDependencies && !pkg.peerDependencies) continue;
    if (!fs.existsSync(lockPath)) {
      errors.push(`package-lock ausente para ${path.relative(process.cwd(), dir)}`);
      continue;
    }
    const lock = readJson(lockPath);
    const rootLock = lock.packages && lock.packages[''];
    if (!rootLock) {
      errors.push(`package-lock sem packages[""] em ${path.relative(process.cwd(), lockPath)}`);
      continue;
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, version] of Object.entries(pkg[field] || {})) {
        const locked = rootLock[field] && rootLock[field][name];
        if (locked !== version) {
          errors.push(`lock divergente ${path.relative(process.cwd(), pkgPath)} ${field}.${name}: ${locked || '<ausente>'} != ${version}`);
        }
      }
    }
  }
}

function validateImports(rootDir, errors, options = {}) {
  const checkResolution = options.checkResolution === true;
  const packageDirs = findPackageDirs(rootDir);
  const packageMeta = new Map(packageDirs.map((dir) => [dir, readJson(path.join(dir, 'package.json'))]));
  const scanRoots = ['scripts', 'r-observe', 'tests']
    .map((dir) => path.join(rootDir, dir))
    .filter((dir) => fs.existsSync(dir));
  const jsFiles = scanRoots.flatMap((dir) => walk(dir)).filter((file) => /\.(js|cjs|mjs)$/.test(file));

  for (const file of jsFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const ownerDir = nearestPackageDir(file, packageDirs) || rootDir;
    const ownerPkg = packageMeta.get(ownerDir) || {};
    const req = checkResolution ? moduleBuiltin.createRequire(file) : null;
    const declared = new Set([
      ...Object.keys(ownerPkg.dependencies || {}),
      ...Object.keys(ownerPkg.devDependencies || {}),
      ...Object.keys(ownerPkg.peerDependencies || {}),
      ...Object.keys(ownerPkg.optionalDependencies || {}),
      ownerPkg.name,
    ].filter(Boolean));

    for (const spec of extractImports(source)) {
      if (BUILTINS.has(spec) || spec.startsWith('node:')) continue;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = spec.startsWith('/') ? path.join(rootDir, spec.slice(1)) : path.resolve(path.dirname(file), spec);
        if (!fileExistsWithExt(target)) {
          errors.push(`import relativo quebrado: ${path.relative(rootDir, file)} -> ${spec}`);
        }
        continue;
      }
      const bare = packageName(spec);
      if (!declared.has(bare)) {
        errors.push(`dependencia nao declarada: ${path.relative(rootDir, file)} -> ${bare}`);
        continue;
      }

      if (!checkResolution) {
        continue;
      }

      try {
        req.resolve(spec);
      } catch (err) {
        errors.push(`Cannot find module '${spec}' em ${path.relative(rootDir, file)} (${err.message})`);
      }
    }
  }

  validateLocks(packageDirs, errors);
  return { packageDirs: packageDirs.map((dir) => path.relative(rootDir, dir)), filesChecked: jsFiles.length };
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(args.root);
  const errors = [];
  const summary = { root: rootDir };
  const packageDirs = findPackageDirs(rootDir);

  if (!fs.existsSync(path.join(rootDir, 'package.json'))) errors.push('package.json raiz ausente no pacote extraido');
  if (!fs.existsSync(path.join(rootDir, 'r-observe/discovery/package.json'))) errors.push('r-observe/discovery/package.json ausente no pacote extraido');

  if (args.runInstall) {
    const installDirs = packageDirs
      .filter((dir) => fs.existsSync(path.join(dir, 'package-lock.json')))
      .sort((a, b) => a.length - b.length);

    for (const dir of installDirs) {
      const lockPath = path.join(dir, 'package-lock.json');
      const relDir = path.relative(rootDir, dir) || '.';
      const beforeLock = fs.existsSync(lockPath) ? sha256File(lockPath) : '';
      const installCmd = 'ci';
      const res = run('npm', [installCmd, '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: dir });
      process.stdout.write(res.stdout || '');
      process.stderr.write(res.stderr || '');
      appendCannotFindModuleErrors(`${res.stdout}\n${res.stderr}`, `npm ci (${relDir})`, errors);
      if (res.status !== 0) {
        errors.push(`npm ${installCmd} falhou em ${relDir}`);
      }

      const treeRes = run('npm', ['ls', '--all', '--json'], { cwd: dir });
      const treeText = `${treeRes.stdout || ''}\n${treeRes.stderr || ''}`;
      appendCannotFindModuleErrors(treeText, `npm ls (${relDir})`, errors);
      let tree = {};
      try {
        tree = JSON.parse(treeRes.stdout || '{}');
      } catch (err) {
        errors.push(`npm ls retornou JSON invalido em ${relDir}`);
      }
      const problems = Array.isArray(tree.problems) ? tree.problems : [];
      for (const problem of problems) {
        if (/peer|missing|invalid|extraneous|unmet/i.test(problem)) {
          errors.push(`dependency issue (${relDir}): ${problem}`);
        }
      }

      if (fs.existsSync(lockPath)) {
        const installCheck = run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: dir });
        process.stdout.write(installCheck.stdout || '');
        process.stderr.write(installCheck.stderr || '');
        appendCannotFindModuleErrors(`${installCheck.stdout}\n${installCheck.stderr}`, `npm install --package-lock-only (${relDir})`, errors);
        if (installCheck.status !== 0) {
          errors.push(`npm install --package-lock-only falhou em ${relDir}`);
        } else {
          const afterLock = sha256File(lockPath);
          if (beforeLock !== afterLock) errors.push(`npm install alterou package-lock em ${relDir}`);
        }
      }
    }

    Object.assign(summary, validateImports(rootDir, errors, { checkResolution: true }));
  } else {
    Object.assign(summary, validateImports(rootDir, errors, { checkResolution: false }));
  }

  if (args.runTests) {
    const testsDir = path.join(rootDir, 'r-observe/discovery');
    const res = run('npm', ['test'], { cwd: testsDir });
    process.stdout.write(res.stdout || '');
    process.stderr.write(res.stderr || '');
    appendCannotFindModuleErrors(`${res.stdout}\n${res.stderr}`, cmdLabel('npm', ['test'], testsDir), errors);
    if (res.status !== 0) errors.push('npm test falhou em r-observe/discovery extraido');
  }

  if (args.runSmoke) {
    for (const script of [
      'scripts/discovery/discovery-lint.sh',
      'scripts/discovery/discovery-audit.sh',
      'scripts/discovery/discovery-enterprise-smoke.sh',
    ]) {
      const scriptEnv = script.endsWith('discovery-enterprise-smoke.sh')
        ? { DISCOVERY_ENTERPRISE_SMOKE_MODE: 'isolated' }
        : {};
      const res = run('bash', [script], { cwd: rootDir, env: scriptEnv });
      process.stdout.write(res.stdout || '');
      process.stderr.write(res.stderr || '');
      appendCannotFindModuleErrors(`${res.stdout}\n${res.stderr}`, cmdLabel('bash', [script], rootDir), errors);
      if (res.status !== 0) errors.push(`${script} falhou no pacote extraido`);
    }
  }

  const result = { status: errors.length ? 'red' : 'green', summary, errors };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
}

main();
