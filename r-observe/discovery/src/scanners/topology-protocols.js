'use strict';

/**
 * Topology Protocol Discovery — OSPF, BGP, VRRP via SNMP.
 *
 * Descobre:
 *   - OSPF: router-id, áreas, vizinhos, interfaces
 *   - BGP: AS local, peers, estado, tempo estabelecido
 *   - VRRP: IPs virtuais, prioridade, estado (master/backup)
 *
 * Esses protocolos revelam a topologia de rede que o CDP/LLDP
 * não mostram (relações de camada 3).
 */

const { snmpWalkParsed, snmpGet, snmpWalkIndexed, cleanSnmpValue } = require('../mibs/snmp-walk');
const { OIDS } = require('../mibs/snmp-oids');
const { log } = require('../utils/logger');

// ── Helpers ─────────────────────────────────────────────────────────────────

function match(oid, prefix) {
  return oid.startsWith(prefix);
}

function intVal(v) { const n = parseInt(v); return isNaN(n) ? null : n; }
function floatVal(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

// ── OSPF ────────────────────────────────────────────────────────────────────

/**
 * Estado do vizinho OSPF.
 */
function ospfNbrState(code) {
  const map = { '1': 'down', '2': 'attempt', '3': 'init', '4': 'twoWay',
                '5': 'exchangeStart', '6': 'exchange', '7': 'loading', '8': 'full' };
  return map[String(code)] || `state(${code})`;
}

async function discoverOspf(host, opts = {}) {
  const community = opts.community || 'public';
  const result = {
    enabled: false,
    router_id: null,
    areas: [],
    interfaces: [],
    neighbors: [],
    errors: [],
  };

  try {
    // Router ID
    const routerId = await snmpGet(host, OIDS.ospf.ospfRouterId, { community, timeout: 5000 });
    if (!routerId) return result; // OSPF não ativo

    result.enabled = true;
    result.router_id = routerId;

    // Áreas
    const areaRows = await snmpWalkParsed(host, OIDS.ospf.ospfAreaId, { community });
    for (const r of areaRows) {
      if (r.value) result.areas.push({ area_id: r.value });
    }

    // Interfaces OSPF
    const ifRows = await snmpWalkParsed(host, OIDS.ospf.ospfIfIpAddress, { community });
    const ifTypeRows = await snmpWalkParsed(host, OIDS.ospf.ospfIfType, { community });
    const ifStateRows = await snmpWalkParsed(host, OIDS.ospf.ospfIfState, { community });

    const ifMap = {};
    for (const r of ifRows) {
      if (!r.index) continue;
      ifMap[r.index] = { ip: r.value };
    }
    for (const r of ifTypeRows) {
      if (r.index && ifMap[r.index]) ifMap[r.index].type = r.value;
    }
    for (const r of ifStateRows) {
      if (r.index && ifMap[r.index]) ifMap[r.index].state = r.value;
    }
    result.interfaces = Object.values(ifMap);

    // Vizinhos OSPF
    const nbrIpRows = await snmpWalkParsed(host, OIDS.ospf.ospfNbrIpAddr, { community });
    const nbrRtrRows = await snmpWalkParsed(host, OIDS.ospf.ospfNbrRtrId, { community });
    const nbrStateRows = await snmpWalkParsed(host, OIDS.ospf.ospfNbrState, { community });

    const nbrMap = {};
    for (const r of nbrIpRows) {
      if (!r.index) continue;
      nbrMap[r.index] = { ip: r.value };
    }
    for (const r of nbrRtrRows) {
      if (r.index && nbrMap[r.index]) nbrMap[r.index].router_id = r.value;
    }
    for (const r of nbrStateRows) {
      if (r.index && nbrMap[r.index]) nbrMap[r.index].state = ospfNbrState(r.value);
    }
    result.neighbors = Object.values(nbrMap);

  } catch (e) {
    result.errors.push(`ospf:${e.message}`);
    log('warn', `OSPF discovery failed for ${host}`, { err: e.message });
  }

  return result;
}

// ── BGP ─────────────────────────────────────────────────────────────────────

/**
 * Estado do peer BGP.
 */
function bgpPeerState(code) {
  const map = { '1': 'idle', '2': 'connect', '3': 'active', '4': 'openSent',
                '5': 'openConfirm', '6': 'established' };
  return map[String(code)] || `state(${code})`;
}

async function discoverBgp(host, opts = {}) {
  const community = opts.community || 'public';
  const result = {
    enabled: false,
    local_as: null,
    peers: [],
    errors: [],
  };

  try {
    const localAs = await snmpGet(host, OIDS.bgp.bgpLocalAs, { community, timeout: 5000 });
    if (!localAs) return result; // BGP não ativo

    result.enabled = true;
    result.local_as = intVal(localAs);

    // Peers
    const peerRemoteAs = await snmpWalkIndexed(host, OIDS.bgp.bgpPeerRemoteAs, { community });
    const peerState = await snmpWalkIndexed(host, OIDS.bgp.bgpPeerState, { community });
    const peerAddr = await snmpWalkIndexed(host, OIDS.bgp.bgpPeerRemoteAddr, { community });
    const peerEstTime = await snmpWalkIndexed(host, OIDS.bgp.bgpPeerFsmEstablishedTime, { community });

    const allIndexes = new Set([
      ...Object.keys(peerRemoteAs), ...Object.keys(peerState),
      ...Object.keys(peerAddr), ...Object.keys(peerEstTime),
    ]);

    for (const idx of allIndexes) {
      result.peers.push({
        index: intVal(idx),
        remote_addr: peerAddr[idx] || null,
        remote_as: intVal(peerRemoteAs[idx]),
        state: bgpPeerState(peerState[idx]),
        established_time_sec: intVal(peerEstTime[idx]),
      });
    }

    result.peers.sort((a, b) => a.index - b.index);

  } catch (e) {
    result.errors.push(`bgp:${e.message}`);
    log('warn', `BGP discovery failed for ${host}`, { err: e.message });
  }

  return result;
}

// ── VRRP ────────────────────────────────────────────────────────────────────

/**
 * Estado VRRP.
 */
function vrrpState(code) {
  const map = { '1': 'initialize', '2': 'backup', '3': 'master' };
  return map[String(code)] || `state(${code})`;
}

async function discoverVrrp(host, opts = {}) {
  const community = opts.community || 'public';
  const result = {
    enabled: false,
    instances: [],
    errors: [],
  };

  try {
    const virtIpRows = await snmpWalkParsed(host, OIDS.vrrp.vrrpOperVirtIpAddr, { community });
    if (!virtIpRows.length) return result; // VRRP não ativo

    result.enabled = true;

    const stateRows = await snmpWalkIndexed(host, OIDS.vrrp.vrrpOperState, { community });
    const priorityRows = await snmpWalkIndexed(host, OIDS.vrrp.vrrpOperPriority, { community });
    const macRows = await snmpWalkIndexed(host, OIDS.vrrp.vrrpOperVirtualMacAddr, { community });

    const instMap = {};
    for (const r of virtIpRows) {
      if (!r.index) continue;
      // O índice VRRP é composto: ifIndex.vrId
      const parts = r.index.split('.');
      const ifIndex = parts[0];
      const vrId = parts[1] || r.index;
      const key = `${ifIndex}:${vrId}`;

      if (!instMap[key]) instMap[key] = { if_index: intVal(ifIndex), vr_id: intVal(vrId), ip: null, state: null, priority: null, virtual_mac: null };
      instMap[key].ip = r.value;
    }

    // Preenche estado e prioridade
    for (const [key, inst] of Object.entries(instMap)) {
      // Busca pelo vrId em todas as tabelas
      for (const [idx, val] of Object.entries(stateRows)) {
        if (idx.endsWith(`.${inst.vr_id}`)) { inst.state = vrrpState(val); break; }
      }
      for (const [idx, val] of Object.entries(priorityRows)) {
        if (idx.endsWith(`.${inst.vr_id}`)) { inst.priority = intVal(val); break; }
      }
      for (const [idx, val] of Object.entries(macRows)) {
        if (idx.endsWith(`.${inst.vr_id}`)) { inst.virtual_mac = val; break; }
      }
    }

    result.instances = Object.values(instMap);

  } catch (e) {
    result.errors.push(`vrrp:${e.message}`);
    log('warn', `VRRP discovery failed for ${host}`, { err: e.message });
  }

  return result;
}

// ── Orquestrador ────────────────────────────────────────────────────────────

async function discoverRoutingProtocols(host, opts = {}) {
  const [ospf, bgp, vrrp] = await Promise.all([
    discoverOspf(host, opts),
    discoverBgp(host, opts),
    discoverVrrp(host, opts),
  ]);

  return {
    host,
    collected_at: new Date().toISOString(),
    ospf,
    bgp,
    vrrp,
    summary: {
      ospf_enabled: ospf.enabled,
      bgp_enabled: bgp.enabled,
      vrrp_enabled: vrrp.enabled,
      ospf_neighbor_count: ospf.neighbors.length,
      bgp_peer_count: bgp.peers.length,
      vrrp_instance_count: vrrp.instances.length,
    },
  };
}

module.exports = { discoverRoutingProtocols, discoverOspf, discoverBgp, discoverVrrp };
