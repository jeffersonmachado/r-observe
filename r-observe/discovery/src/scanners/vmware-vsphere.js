'use strict';

/**
 * R-Observe Discovery — VMware vSphere Scanner (Enterprise)
 *
 * Descobre recursos VMware via vSphere API (SOAP/REST):
 *   - ESXi hosts
 *   - Virtual machines
 *   - Datastores
 *   - Networks
 *   - vCenter
 *
 * Requer:
 *   - DISCOVERY_VMWARE_ENABLED=true
 *   - DISCOVERY_VMWARE_HOST=vcenter.example.com
 *   - DISCOVERY_VMWARE_USER=administrator@vsphere.local
 *   - DISCOVERY_VMWARE_PASSWORD=***
 */

const { log } = require('../utils/logger');

const VMWARE_ENABLED = process.env.DISCOVERY_VMWARE_ENABLED === 'true';
const VMWARE_HOST = process.env.DISCOVERY_VMWARE_HOST || '';
const VMWARE_USER = process.env.DISCOVERY_VMWARE_USER || '';
const VMWARE_PASSWORD = process.env.DISCOVERY_VMWARE_PASSWORD || '';
const VMWARE_IGNORE_SSL = process.env.DISCOVERY_VMWARE_IGNORE_SSL !== 'false';

function nowIso() { return new Date().toISOString(); }

// ─── vSphere REST API ────────────────────────────────────────────────────────

async function vsphereLogin() {
  if (!VMWARE_ENABLED || !VMWARE_HOST || !VMWARE_USER) return null;

  const baseUrl = `https://${VMWARE_HOST}`;
  try {
    const resp = await fetch(`${baseUrl}/rest/com/vmware/cis/session`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${VMWARE_USER}:${VMWARE_PASSWORD}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      log('warn', 'VMware login failed', { status: resp.status, host: VMWARE_HOST });
      return null;
    }

    const data = await resp.json();
    return { sessionId: data.value, baseUrl };
  } catch (e) {
    log('warn', 'VMware connection failed', { err: e.message, host: VMWARE_HOST });
    return null;
  }
}

async function vsphereGet(session, path) {
  try {
    const resp = await fetch(`${session.baseUrl}${path}`, {
      headers: {
        'vmware-api-session-id': session.sessionId,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return { value: [] };
    return await resp.json();
  } catch (e) {
    return { value: [] };
  }
}

// ─── Discovery ───────────────────────────────────────────────────────────────

async function discoverVMware() {
  if (!VMWARE_ENABLED) return [];

  log('info', 'Starting VMware discovery', { host: VMWARE_HOST });

  const session = await vsphereLogin();
  if (!session) return [];

  const assets = [];

  try {
    // ── Hosts (ESXi) ──────────────────────────────────────────────────
    const hosts = await vsphereGet(session, '/rest/vcenter/host');
    for (const h of (hosts.value || [])) {
      assets.push({
        asset_type: 'hypervisor',
        vendor: 'VMware',
        product: 'ESXi',
        name: h.name,
        host: h.name,
        primary_ip: null, // será resolvido pelo discovery normal
        cloud: 'vmware',
        region: VMWARE_HOST,
        metadata: {
          host_id: h.host,
          connection_state: h.connection_state,
          power_state: h.power_state,
        },
        evidence: [{
          type: 'vmware_api',
          source: 'vsphere-scanner',
          confidence: 0.95,
          timestamp: nowIso(),
        }],
      });
    }

    // ── VMs ────────────────────────────────────────────────────────────
    const vms = await vsphereGet(session, '/rest/vcenter/vm');
    for (const vm of (vms.value || [])) {
      assets.push({
        asset_type: 'virtual_machine',
        vendor: 'VMware',
        product: 'Virtual Machine',
        name: vm.name,
        guest_os: vm.guest_OS || null,
        power_state: vm.power_state,
        cpu_count: vm.cpu_count,
        memory_mb: vm.memory_size_MiB,
        cloud: 'vmware',
        region: VMWARE_HOST,
        metadata: {
          vm_id: vm.vm,
          host: VMWARE_HOST,
        },
        evidence: [{
          type: 'vmware_api',
          source: 'vsphere-scanner',
          confidence: 0.95,
          timestamp: nowIso(),
        }],
      });
    }

    // ── Datastores ─────────────────────────────────────────────────────
    const datastores = await vsphereGet(session, '/rest/vcenter/datastore');
    for (const ds of (datastores.value || [])) {
      assets.push({
        asset_type: 'storage',
        vendor: 'VMware',
        product: 'Datastore',
        name: ds.name,
        type: ds.type,
        capacity_gb: ds.capacity ? Math.round(ds.capacity / (1024 * 1024 * 1024)) : null,
        free_gb: ds.free_space ? Math.round(ds.free_space / (1024 * 1024 * 1024)) : null,
        cloud: 'vmware',
        region: VMWARE_HOST,
        metadata: {
          datastore_id: ds.datastore,
          accessible: ds.accessible,
        },
        evidence: [{
          type: 'vmware_api',
          source: 'vsphere-scanner',
          confidence: 0.95,
          timestamp: nowIso(),
        }],
      });
    }

    // ── Networks ───────────────────────────────────────────────────────
    const networks = await vsphereGet(session, '/rest/vcenter/network');
    for (const net of (networks.value || [])) {
      assets.push({
        asset_type: 'network',
        vendor: 'VMware',
        product: 'Network',
        name: net.name,
        type: net.type,
        cloud: 'vmware',
        region: VMWARE_HOST,
        metadata: {
          network_id: net.network,
        },
        evidence: [{
          type: 'vmware_api',
          source: 'vsphere-scanner',
          confidence: 0.9,
          timestamp: nowIso(),
        }],
      });
    }

    // ── Logout ─────────────────────────────────────────────────────────
    await fetch(`${session.baseUrl}/rest/com/vmware/cis/session`, {
      method: 'DELETE',
      headers: { 'vmware-api-session-id': session.sessionId },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});

    log('info', 'VMware discovery complete', {
      hosts: hosts.value?.length || 0,
      vms: vms.value?.length || 0,
      datastores: datastores.value?.length || 0,
      networks: networks.value?.length || 0,
    });

  } catch (e) {
    log('error', 'VMware discovery error', { err: e.message });
  }

  return assets;
}

module.exports = { discoverVMware };
