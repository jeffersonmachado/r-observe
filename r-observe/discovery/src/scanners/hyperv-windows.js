'use strict';

/**
 * R-Observe Discovery — Hyper-V / Windows Server Scanner (Enterprise)
 *
 * Descobre recursos Hyper-V via WinRM/PowerShell:
 *   - Host (Hyper-V server)
 *   - Virtual machines
 *   - Virtual switches
 *
 * Também detecta Windows Server (não-Hyper-V) via:
 *   - SMB (porta 445)
 *   - WinRM (porta 5985/5986)
 *   - RDP (porta 3389)
 *
 * Requer:
 *   - DISCOVERY_HYPERV_ENABLED=true
 *   - DISCOVERY_WINDOWS_ENABLED=true (para scan Windows genérico)
 */

const { log } = require('../utils/logger');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { isValidHost } = require('../validators');
const execFileAsync = promisify(execFile);

const HYPERV_ENABLED = process.env.DISCOVERY_HYPERV_ENABLED === 'true';
const WINDOWS_ENABLED = process.env.DISCOVERY_WINDOWS_ENABLED !== 'false';
const WINDOWS_HIGH_CONFIDENCE_SIGNAL_COUNT = 3;
const WINDOWS_HIGH_CONFIDENCE = 0.9;
const WINDOWS_BASE_CONFIDENCE = 0.7;

function nowIso() { return new Date().toISOString(); }

// ─── TCP Port Check ──────────────────────────────────────────────────────────

function checkPort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    socket.setTimeout(timeout);
    socket.on('connect', () => { resolved = true; resolve(true); socket.destroy(); });
    socket.on('timeout', () => { resolved = true; resolve(false); socket.destroy(); });
    socket.on('error', () => { resolved = true; resolve(false); socket.destroy(); });
    socket.connect(port, host);
  });
}

// ─── SMB Probe ───────────────────────────────────────────────────────────────

async function probeSmb(host) {
  const open = await checkPort(host, 445, 3000);
  if (!open) return null;

  return {
    smb_open: true,
    host,
    detection_method: 'port_scan',
    confidence: 0.7,
    timestamp: nowIso(),
  };
}

// ─── WinRM Probe ─────────────────────────────────────────────────────────────

async function probeWinRm(host) {
  // Try HTTPS first (5986), then HTTP (5985)
  const httpsOpen = await checkPort(host, 5986, 2000);
  const httpOpen = !httpsOpen ? await checkPort(host, 5985, 2000) : false;

  if (!httpsOpen && !httpOpen) return null;

  return {
    winrm_open: true,
    winrm_https: httpsOpen,
    winrm_http: httpOpen,
    host,
    detection_method: 'port_scan',
    confidence: 0.75,
    timestamp: nowIso(),
  };
}

// ─── RDP Probe ───────────────────────────────────────────────────────────────

async function probeRdp(host) {
  const open = await checkPort(host, 3389, 2000);
  if (!open) return null;

  return {
    rdp_open: true,
    host,
    detection_method: 'port_scan',
    confidence: 0.65,
    timestamp: nowIso(),
  };
}

// ─── Hyper-V PowerShell via WinRM ────────────────────────────────────────────

/**
 * Tenta executar PowerShell remotamente via WinRM para descobrir VMs Hyper-V.
 * Requer credenciais WinRM configuradas:
 *   - DISCOVERY_WINRM_USER
 *   - DISCOVERY_WINRM_PASSWORD
 */
async function discoverHyperVviaWinRM(host) {
  const winrmUser = process.env.DISCOVERY_WINRM_USER || '';
  const winrmPass = process.env.DISCOVERY_WINRM_PASSWORD || '';

  if (!HYPERV_ENABLED || !winrmUser || !winrmPass || !isValidHost(host)) return [];

  const commands = [
    // Get Hyper-V host info
    'Get-VMHost | Select-Object Name, LogicalProcessorCount, MemoryCapacity, Version | ConvertTo-Json',
    // Get VMs
    'Get-VM | Select-Object Name, State, CPUUsage, MemoryAssigned, Uptime, Generation, Version | ConvertTo-Json',
    // Get virtual switches
    'Get-VMSwitch | Select-Object Name, SwitchType, NetAdapterInterfaceDescription | ConvertTo-Json',
  ];

  const assets = [];

  try {
    // Try PowerShell Remoting via pwsh or powershell
    for (const cmd of commands) {
      try {
        const script = `
$securePass = ConvertTo-SecureString $env:RO_WINRM_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ($env:RO_WINRM_USER, $securePass)
$session = New-PSSession -ComputerName $env:RO_WINRM_HOST -Credential $cred -ErrorAction Stop
$result = Invoke-Command -Session $session -ScriptBlock { ${cmd} }
Remove-PSSession $session
$result | ConvertTo-Json -Depth 6
`;
        const { stdout } = await execFileAsync(
          'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script],
          {
            timeout: 30000,
            maxBuffer: 8 * 1024 * 1024,
            env: {
              ...process.env,
              RO_WINRM_HOST: host,
              RO_WINRM_USER: winrmUser,
              RO_WINRM_PASSWORD: winrmPass,
            },
          }
        );
        const parsed = JSON.parse(stdout.trim());

        if (parsed && Array.isArray(parsed)) {
          for (const item of parsed) {
            assets.push({
              asset_type: 'virtual_machine',
              vendor: 'Microsoft',
              product: 'Hyper-V VM',
              name: item.Name,
              state: item.State,
              cpu_usage: item.CPUUsage,
              memory_assigned_bytes: item.MemoryAssigned,
              generation: item.Generation,
              host: host,
              metadata: {
                host,
                vm_name: item.Name,
              },
              evidence: [{
                type: 'hyperv_winrm',
                source: 'hyperv-scanner',
                confidence: 0.95,
                timestamp: nowIso(),
              }],
            });
          }
        }
      } catch (_) {
        // WinRM may not be available or credentials wrong — non-fatal
      }
    }
  } catch (_) {
    // PowerShell not available — non-fatal
  }

  return assets;
}

// ─── Main Discovery ──────────────────────────────────────────────────────────

/**
 * @param {object} input
 *   - ip: string (IP do host)
 *   - open_ports: number[] (portas abertas detectadas)
 * @returns {object[]}
 */
async function discoverHyperV(input = {}) {
  const ip = input.ip || input.address;
  if (!ip) return [];

  const assets = [];

  // ── Windows Detection via ports ──────────────────────────────────────
  if (WINDOWS_ENABLED) {
    const smbResult = await probeSmb(ip);
    const rdpResult = await probeRdp(ip);
    const winrmResult = await probeWinRm(ip);

    const windowsSignals = [];
    if (smbResult) windowsSignals.push('smb');
    if (rdpResult) windowsSignals.push('rdp');
    if (winrmResult) windowsSignals.push('winrm');

    if (windowsSignals.length >= 2) {
      assets.push({
        asset_type: 'server',
        vendor: 'Microsoft',
        product: 'Windows Server',
        os_family: 'windows',
        primary_ip: ip,
        services: windowsSignals,
        detection_method: `port_scan:${windowsSignals.join('+')}`,
        confidence_score: windowsSignals.length >= WINDOWS_HIGH_CONFIDENCE_SIGNAL_COUNT
          ? WINDOWS_HIGH_CONFIDENCE
          : WINDOWS_BASE_CONFIDENCE,
        evidence: [
          { type: 'port_scan', source: 'windows-scanner', confidence: 0.7,
            raw: { ports: { smb: !!smbResult, rdp: !!rdpResult, winrm: !!winrmResult } },
            timestamp: nowIso() },
        ],
        timestamp: nowIso(),
      });
    }

    // ── Hyper-V Detection ──────────────────────────────────────────────
    if (HYPERV_ENABLED && winrmResult) {
      const hypervAssets = await discoverHyperVviaWinRM(ip);
      assets.push(...hypervAssets);

      if (hypervAssets.length > 0) {
        assets.push({
          asset_type: 'hypervisor',
          vendor: 'Microsoft',
          product: 'Hyper-V',
          os_family: 'windows',
          primary_ip: ip,
          vm_count: hypervAssets.length,
          detection_method: 'winrm_powershell',
          confidence_score: 0.9,
          evidence: [{
            type: 'hyperv_winrm', source: 'hyperv-scanner', confidence: 0.9,
            raw: { vm_count: hypervAssets.length },
            timestamp: nowIso(),
          }],
          timestamp: nowIso(),
        });
      }
    }
  }

  return assets;
}

module.exports = {
  discoverHyperV,
  probeSmb,
  probeWinRm,
  probeRdp,
};
