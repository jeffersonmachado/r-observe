'use strict';

/**
 * R-Observe Discovery — Proxmox VE Scanner (Enterprise)
 *
 * Descobre recursos Proxmox via REST API:
 *   - Nodes
 *   - QEMU VMs
 *   - LXC containers
 *   - Storage pools
 *
 * Requer:
 *   - DISCOVERY_PROXMOX_ENABLED=true
 *   - DISCOVERY_PROXMOX_HOST=proxmox.example.com:8006
 *   - DISCOVERY_PROXMOX_USER=root@pam
 *   - DISCOVERY_PROXMOX_PASSWORD=***
 *   - DISCOVERY_PROXMOX_TOKEN_NAME (opcional, API token)
 *   - DISCOVERY_PROXMOX_TOKEN_VALUE (opcional)
 */

const { log } = require('../utils/logger');

const PROXMOX_ENABLED = process.env.DISCOVERY_PROXMOX_ENABLED === 'true';
const PROXMOX_HOST = process.env.DISCOVERY_PROXMOX_HOST || '';
const PROXMOX_USER = process.env.DISCOVERY_PROXMOX_USER || 'root@pam';
const PROXMOX_PASSWORD = process.env.DISCOVERY_PROXMOX_PASSWORD || '';
const PROXMOX_TOKEN_NAME = process.env.DISCOVERY_PROXMOX_TOKEN_NAME || '';
const PROXMOX_TOKEN_VALUE = process.env.DISCOVERY_PROXMOX_TOKEN_VALUE || '';

function nowIso() { return new Date().toISOString(); }

// ─── Auth ────────────────────────────────────────────────────────────────────

let _ticket = null;
let _csrfToken = null;

async function proxmoxLogin() {
  if (!PROXMOX_ENABLED || !PROXMOX_HOST) return null;

  const baseUrl = `https://${PROXMOX_HOST}/api2/json`;

  // API Token auth (preferido)
  if (PROXMOX_TOKEN_NAME && PROXMOX_TOKEN_VALUE) {
    _ticket = `${PROXMOX_USER}!${PROXMOX_TOKEN_NAME}=${PROXMOX_TOKEN_VALUE}`;
    return { ticket: _ticket, baseUrl };
  }

  // Password auth
  try {
    const resp = await fetch(`${baseUrl}/access/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: PROXMOX_USER,
        password: PROXMOX_PASSWORD,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      log('warn', 'Proxmox login failed', { status: resp.status, host: PROXMOX_HOST });
      return null;
    }

    const data = await resp.json();
    _ticket = data.data.ticket;
    _csrfToken = data.data.CSRFPreventionToken;

    return { ticket: _ticket, csrfToken: _csrfToken, baseUrl };
  } catch (e) {
    log('warn', 'Proxmox connection failed', { err: e.message });
    return null;
  }
}

async function proxmoxGet(session, path) {
  const headers = {};
  if (_csrfToken) {
    headers.CSRFPreventionToken = _csrfToken;
  }
  headers.Authorization = `PVEAPIToken=${session.ticket}`;

  // Se for password auth
  if (!PROXMOX_TOKEN_NAME) {
    headers.Cookie = `PVEAuthCookie=${session.ticket}`;
    delete headers.Authorization;
  }

  try {
    const resp = await fetch(`${session.baseUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return { data: [] };
    return await resp.json();
  } catch (e) {
    return { data: [] };
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

async function discoverProxmox() {
  if (!PROXMOX_ENABLED) return [];

  log('info', 'Starting Proxmox discovery', { host: PROXMOX_HOST });

  const session = await proxmoxLogin();
  if (!session) return [];

  const assets = [];

  try {
    // ── Nodes ──────────────────────────────────────────────────────────
    const nodesResp = await proxmoxGet(session, '/nodes');
    const nodes = nodesResp.data || [];

    for (const node of nodes) {
      assets.push({
        asset_type: 'hypervisor',
        vendor: 'Proxmox',
        product: 'Proxmox VE',
        name: node.node,
        host: node.node,
        status: node.status,
        cpu_model: node.cpu || null,
        cpu_cores: node.maxcpu || null,
        memory_mb: node.maxmem ? Math.round(node.maxmem / (1024 * 1024)) : null,
        uptime_seconds: node.uptime || null,
        metadata: {
          node_id: node.node,
          pve_version: node.pveversion || null,
        },
        evidence: [{
          type: 'proxmox_api',
          source: 'proxmox-scanner',
          confidence: 0.95,
          timestamp: nowIso(),
        }],
      });

      // ── VMs (QEMU) ─────────────────────────────────────────────────
      const qemuResp = await proxmoxGet(session, `/nodes/${node.node}/qemu`);
      for (const vm of (qemuResp.data || [])) {
        // Get VM config for more details
        const configResp = await proxmoxGet(session, `/nodes/${node.node}/qemu/${vm.vmid}/config`);
        const config = configResp.data || {};

        assets.push({
          asset_type: 'virtual_machine',
          vendor: 'Proxmox',
          product: 'QEMU VM',
          name: vm.name || `vm-${vm.vmid}`,
          vmid: vm.vmid,
          status: vm.status,
          cpu_count: vm.cpus || vm.maxcpu || config.cores || null,
          memory_mb: vm.maxmem ? Math.round(vm.maxmem / (1024 * 1024)) : null,
          guest_os: config.ostype || null,
          node: node.node,
          metadata: {
            vmid: vm.vmid,
            node: node.node,
            template: vm.template || false,
            bootdisk: config.bootdisk || null,
            scsihw: config.scsihw || null,
            net: config.net0 || config.net1 || null,
          },
          evidence: [{
            type: 'proxmox_api',
            source: 'proxmox-scanner',
            confidence: 0.95,
            timestamp: nowIso(),
          }],
        });
      }

      // ── LXC Containers ──────────────────────────────────────────────
      const lxcResp = await proxmoxGet(session, `/nodes/${node.node}/lxc`);
      for (const ct of (lxcResp.data || [])) {
        assets.push({
          asset_type: 'container',
          vendor: 'Proxmox',
          product: 'LXC Container',
          name: ct.name || `ct-${ct.vmid}`,
          vmid: ct.vmid,
          status: ct.status,
          cpu_count: ct.cpus || ct.maxcpu || null,
          memory_mb: ct.maxmem ? Math.round(ct.maxmem / (1024 * 1024)) : null,
          node: node.node,
          metadata: {
            vmid: ct.vmid,
            node: node.node,
            template: ct.template || false,
            ostype: ct.ostype || null,
          },
          evidence: [{
            type: 'proxmox_api',
            source: 'proxmox-scanner',
            confidence: 0.95,
            timestamp: nowIso(),
          }],
        });
      }
    }

    // ── Storage ────────────────────────────────────────────────────────
    const storageResp = await proxmoxGet(session, '/storage');
    for (const store of (storageResp.data || [])) {
      assets.push({
        asset_type: 'storage',
        vendor: 'Proxmox',
        product: `Storage (${store.type})`,
        name: store.storage,
        type: store.type,
        total_gb: store.total ? Math.round(store.total / (1024 * 1024 * 1024)) : null,
        used_gb: store.used ? Math.round(store.used / (1024 * 1024 * 1024)) : null,
        enabled: store.enabled !== false,
        metadata: {
          storage_id: store.storage,
          shared: store.shared || false,
          content: store.content || null,
        },
        evidence: [{
          type: 'proxmox_api',
          source: 'proxmox-scanner',
          confidence: 0.9,
          timestamp: nowIso(),
        }],
      });
    }

    log('info', 'Proxmox discovery complete', {
      nodes: nodes.length,
      assets: assets.length,
    });

  } catch (e) {
    log('error', 'Proxmox discovery error', { err: e.message });
  }

  return assets;
}

module.exports = { discoverProxmox };
