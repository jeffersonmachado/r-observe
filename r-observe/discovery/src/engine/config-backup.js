'use strict';

/**
 * Config Backup Engine — faz backup de configuração de switches/roteadores
 * via SSH (SCP/TFTP/CLI) e armazena com diff tracking.
 *
 * Inspirado no Oxidized, mas integrado ao r-observe.
 *
 * Suporta:
 *   - SSH + SCP para transferência de arquivos
 *   - CLI (show running-config / export) para roteadores
 *   - Diff entre versões
 *   - Armazenamento em disco + metadata no PostgreSQL
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logger');

const execAsync = promisify(exec);

// ── Configuração ────────────────────────────────────────────────────────────

const BACKUP_DIR = process.env.CONFIG_BACKUP_DIR || '/opt/results/r-observe/data/config-backups';
const SSH_TIMEOUT = parseInt(process.env.CONFIG_BACKUP_SSH_TIMEOUT || '30000', 10);

// ── Vendor-specific CLI commands ────────────────────────────────────────────

const CLI_COMMANDS = {
  cisco:          'show running-config',
  mikrotik:       'export',
  juniper:        'show configuration | display set',
  fortinet:       'show full-configuration',
  hp:             'show running-config',
  aruba:          'show running-config',
  paloalto:       'show config running',
  ubiquiti:       'show configuration',
  huawei:         'display current-configuration',
  arista:         'show running-config',
  dell:           'show running-config',
  brocade:        'show running-config',
  extreme:        'show configuration',
  zte:            'show running-config',
  pfsense:        'cat /cf/conf/config.xml',
  opnsense:       'cat /conf/config.xml',
  generic_linux:  'cat /etc/hostname',
};

/**
 * Detecta vendor baseado em classificação SNMP ou fingerprint.
 */
function detectVendor(asset) {
  const vendor = (asset?.classification?.vendor || asset?.vendor || '').toLowerCase();
  const tech = (asset?.classification?.technology || asset?.technology || '').toLowerCase();

  if (vendor.includes('cisco')) return 'cisco';
  if (vendor.includes('mikrotik')) return 'mikrotik';
  if (vendor.includes('juniper')) return 'juniper';
  if (vendor.includes('fortinet')) return 'fortinet';
  if (vendor.includes('hp') || vendor.includes('hpe') || vendor.includes('aruba')) return 'aruba';
  if (vendor.includes('palo') || vendor.includes('alto')) return 'paloalto';
  if (vendor.includes('ubiquiti') || vendor.includes('unifi')) return 'ubiquiti';
  if (vendor.includes('huawei')) return 'huawei';
  if (vendor.includes('arista')) return 'arista';
  if (vendor.includes('dell')) return 'dell';
  if (vendor.includes('brocade')) return 'brocade';
  if (vendor.includes('extreme')) return 'extreme';
  if (vendor.includes('zte')) return 'zte';
  if (vendor.includes('pfsense')) return 'pfsense';
  if (vendor.includes('opnsense')) return 'opnsense';

  // Network device genérico: tenta show running-config
  if (tech.includes('router') || tech.includes('switch') || tech.includes('firewall')) return 'generic_network';

  // Linux genérico
  return 'generic_linux';
}

function getCliCommand(vendor) {
  return CLI_COMMANDS[vendor] || 'show running-config';
}

/**
 * Determina método de coleta.
 */
function getMethod(vendor) {
  // Dispositivos que suportam SCP direto
  if (['mikrotik', 'ubiquiti', 'pfsense', 'opnsense'].includes(vendor)) return 'scp';
  // Linux genérico: SCP
  if (vendor === 'generic_linux') return 'scp';
  // Dispositivos de rede: CLI via SSH
  return 'ssh_cli';
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Executa backup de configuração de um asset.
 *
 * @param {object} asset - { host, vendor?, classification?, ssh_user?, ssh_password?, ssh_port? }
 * @param {object} dbConn - conexão PostgreSQL
 * @returns {object} resultado do backup
 */
async function backupConfig(asset, dbConn) {
  const host = asset.host || asset.primary_ip;
  const sshUser = asset.ssh_user || process.env.CONFIG_BACKUP_SSH_USER || 'admin';
  const sshPass = asset.ssh_password || process.env.SSH_PASSWORD;
  const sshPort = asset.ssh_port || 22;
  const vendor = detectVendor(asset);
  const method = getMethod(vendor);

  const result = {
    host,
    vendor,
    method,
    success: false,
    sha256: null,
    lines: 0,
    error: null,
    timestamp: new Date().toISOString(),
  };

  let config = null;

  try {
    switch (method) {
      case 'ssh_cli': {
        const cmd = getCliCommand(vendor);
        config = await collectViaCli(host, cmd, sshUser, sshPass, sshPort);
        break;
      }
      case 'scp': {
        config = await collectViaScp(host, vendor, sshUser, sshPass, sshPort);
        break;
      }
      default:
        throw new Error(`Unknown backup method: ${method}`);
    }

    if (!config || config.trim().length === 0) {
      result.error = 'empty_config';
      return result;
    }

    result.success = true;
    result.lines = config.split('\n').length;
    result.sha256 = crypto.createHash('sha256').update(config).digest('hex');

    // Salva em disco
    const filePath = path.join(BACKUP_DIR, host, `${result.timestamp.replace(/[:.]/g, '-')}.cfg`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, config);

    // Persiste metadata no DB
    if (dbConn) {
      await persistBackupMetadata(dbConn, asset, result, config);
    }

    // Detecta diff com versão anterior
    const diffResult = await computeDiff(host, config, dbConn);
    result.diff = diffResult;

  } catch (e) {
    result.error = e.message;
    log('error', `Config backup failed for ${host}`, { err: e.message });
  }

  return result;
}

// ── Collectors ──────────────────────────────────────────────────────────────

async function collectViaCli(host, command, user, password, port) {
  const sshCmd = `sshpass -p '${password.replace(/'/g, `'"'"'`)}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${user}@${host} '${command}' 2>/dev/null`;

  try {
    const { stdout } = await execAsync(sshCmd, { timeout: SSH_TIMEOUT });
    return stdout;
  } catch (e) {
    // Tenta com -tt para devices que precisam de PTY
    const ttyCmd = `sshpass -p '${password.replace(/'/g, `'"'"'`)}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -tt -p ${port} ${user}@${host} '${command}' 2>/dev/null`;
    try {
      const { stdout } = await execAsync(ttyCmd, { timeout: SSH_TIMEOUT });
      return stdout;
    } catch (ee) {
      throw new Error(`CLI collection failed: ${ee.message}`);
    }
  }
}

async function collectViaScp(host, vendor, user, password, port) {
  const remotePath = vendorScpPath(vendor);
  const tmpFile = `/tmp/r-observe-config-${host}-${Date.now()}.cfg`;

  const scpCmd = `sshpass -p '${password.replace(/'/g, `'"'"'`)}' scp -o StrictHostKeyChecking=no -o ConnectTimeout=10 -P ${port} ${user}@${host}:${remotePath} ${tmpFile} 2>/dev/null`;

  try {
    await execAsync(scpCmd, { timeout: SSH_TIMEOUT });
    const config = fs.readFileSync(tmpFile, 'utf8');
    fs.unlinkSync(tmpFile);
    return config;
  } catch (e) {
    throw new Error(`SCP collection failed: ${e.message}`);
  }
}

function vendorScpPath(vendor) {
  const paths = {
    pfsense: '/cf/conf/config.xml',
    opnsense: '/conf/config.xml',
    mikrotik: '/flash/rsc/export.rsc',
    ubiquiti: '/tmp/system.cfg',
    generic_linux: '/etc/hostname',
  };
  return paths[vendor] || '/config.cfg';
}

// ── Diff Engine ─────────────────────────────────────────────────────────────

async function computeDiff(host, currentConfig, dbConn) {
  if (!dbConn) return { changes: 0, added: 0, removed: 0 };

  try {
    const { rows } = await dbConn.query(
      `SELECT config_text, sha256 FROM observe_config_backups
       WHERE host = $1 ORDER BY collected_at DESC LIMIT 1`,
      [host]
    );

    if (!rows.length) return { changes: 0, added: 0, removed: 0 };

    const prev = rows[0];
    if (prev.sha256 === crypto.createHash('sha256').update(currentConfig).digest('hex')) {
      return { changes: 0, added: 0, removed: 0, unchanged: true };
    }

    // Diff simples linha-a-linha
    const prevLines = new Set(prev.config_text.split('\n').map(l => l.trim()).filter(Boolean));
    const currLines = new Set(currentConfig.split('\n').map(l => l.trim()).filter(Boolean));

    let added = 0, removed = 0;
    for (const l of currLines) { if (!prevLines.has(l)) added++; }
    for (const l of prevLines) { if (!currLines.has(l)) removed++; }

    return { changes: added + removed, added, removed, unchanged: false };
  } catch (e) {
    log('warn', `Diff compute failed for ${host}`, { err: e.message });
    return { changes: -1, error: e.message };
  }
}

async function persistBackupMetadata(dbConn, asset, result, config) {
  try {
    await dbConn.query(
      `INSERT INTO observe_config_backups
       (host, asset_id, vendor, method, success, sha256, lines, error, config_text, collected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        result.host,
        asset.id || null,
        result.vendor,
        result.method,
        result.success,
        result.sha256,
        result.lines,
        result.error,
        result.success ? config : null,
        result.timestamp,
      ]
    );
  } catch (e) {
    log('warn', `Failed to persist backup metadata for ${result.host}`, { err: e.message });
  }
}

module.exports = { backupConfig, detectVendor, getCliCommand, computeDiff };
