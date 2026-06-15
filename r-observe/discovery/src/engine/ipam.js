'use strict';

/**
 * IPAM (IP Address Management) — gestão de sub-redes, IPs e alocação.
 *
 * Funcionalidades:
 *   - Cadastro de subnets com hierarchy
 *   - Scan de IPs em uso (via ARP, SNMP, ping sweep)
 *   - Cálculo de utilização
 *   - Integração com DNS (PowerDNS)
 *   - API REST
 */

const { log } = require('../utils/logger');

// ── Subnet Math ─────────────────────────────────────────────────────────────

/**
 * Calcula informações de uma subnet.
 */
function parseSubnet(cidr) {
  const [ip, bits] = String(cidr).split('/');
  const prefixLen = parseInt(bits, 10);
  const ipInt = ipToInt(ip);
  const mask = prefixLenToMask(prefixLen);
  const networkInt = ipInt & mask;
  const broadcastInt = networkInt | (~mask >>> 0);
  const totalHosts = Math.pow(2, 32 - prefixLen);
  const usableHosts = prefixLen >= 31 ? totalHosts : totalHosts - 2; // - network e broadcast

  return {
    cidr,
    network: intToIp(networkInt),
    broadcast: intToIp(broadcastInt),
    netmask: intToIp(mask),
    prefix_len: prefixLen,
    total_hosts: totalHosts,
    usable_hosts: usableHosts,
    network_int: networkInt,
    broadcast_int: broadcastInt,
  };
}

function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(int) {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join('.');
}

function prefixLenToMask(len) {
  return len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
}

/**
 * Verifica se um IP pertence a uma subnet.
 */
function ipInSubnet(ip, subnet) {
  const ipInt = ipToInt(ip);
  const info = typeof subnet === 'string' ? parseSubnet(subnet) : subnet;
  return ipInt >= info.network_int && ipInt <= info.broadcast_int;
}

/**
 * Lista todos os IPs de uma subnet (para subnets /24 ou menores).
 */
function listSubnetIps(cidr) {
  const info = parseSubnet(cidr);
  const ips = [];
  // Limita a /24 para não explodir
  if (info.prefix_len < 16) return ips;

  const start = info.network_int + 1; // pula network
  const end = info.broadcast_int;     // inclui broadcast (marcado como especial)

  for (let i = start; i <= end && ips.length < 65536; i++) {
    ips.push({
      ip: intToIp(i),
      type: i === end ? 'broadcast' : 'host',
    });
  }
  return ips;
}

// ── Subnet Operations ───────────────────────────────────────────────────────

/**
 * Divide uma subnet em subnets menores.
 */
function splitSubnet(cidr, newPrefixLen) {
  const info = parseSubnet(cidr);
  if (newPrefixLen <= info.prefix_len) return [cidr];

  const count = Math.pow(2, newPrefixLen - info.prefix_len);
  const step = Math.pow(2, 32 - newPrefixLen);
  const subnets = [];

  for (let i = 0; i < count; i++) {
    const netInt = info.network_int + (i * step);
    subnets.push(`${intToIp(netInt)}/${newPrefixLen}`);
  }

  return subnets;
}

/**
 * Encontra a menor subnet que contém um range de IPs.
 */
function findEnclosingSubnet(ips) {
  if (!ips.length) return null;

  let min = ipToInt(ips[0]);
  let max = min;

  for (const ip of ips) {
    const ipInt = ipToInt(ip);
    if (ipInt < min) min = ipInt;
    if (ipInt > max) max = ipInt;
  }

  // Encontra o prefixo comum
  let prefixLen = 32;
  while (prefixLen > 0) {
    const mask = prefixLenToMask(prefixLen);
    if ((min & mask) === (max & mask)) break;
    prefixLen--;
  }

  const network = min & prefixLenToMask(prefixLen);
  return `${intToIp(network)}/${prefixLen}`;
}

// ── IPAM Repository ─────────────────────────────────────────────────────────

/**
 * Operações de DB para IPAM.
 */
class IpamRepository {
  constructor(dbConn) {
    this.db = dbConn;
  }

  async createSubnet({ cidr, name, description, parent_id, site_id, tenant_id, vlan_id, gateway }) {
    const info = parseSubnet(cidr);
    const { rows } = await this.db.query(
      `INSERT INTO observe_ipam_subnets
       (cidr, name, description, network_addr, broadcast_addr, netmask, prefix_len,
        total_hosts, usable_hosts, parent_id, site_id, tenant_id, vlan_id, gateway)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [cidr, name, description, info.network, info.broadcast, info.netmask, info.prefix_len,
       info.total_hosts, info.usable_hosts, parent_id, site_id || 'default-site',
       tenant_id || 'default', vlan_id, gateway]
    );
    return rows[0];
  }

  async getSubnets({ tenant_id, site_id } = {}) {
    const { rows } = await this.db.query(
      `SELECT * FROM observe_ipam_subnets
       WHERE (tenant_id = $1 OR $1 IS NULL)
       AND (site_id = $2 OR $2 IS NULL)
       ORDER BY prefix_len DESC`,
      [tenant_id || null, site_id || null]
    );
    return rows;
  }

  async getSubnetByCidr(cidr) {
    const { rows } = await this.db.query(
      'SELECT * FROM observe_ipam_subnets WHERE cidr = $1', [cidr]
    );
    return rows[0] || null;
  }

  async registerIp({ ip, subnet_cidr, hostname, mac, status, asset_id }) {
    const { rows } = await this.db.query(
      `INSERT INTO observe_ipam_ips (ip, subnet_cidr, hostname, mac, status, asset_id, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (ip) DO UPDATE SET
         hostname = COALESCE($3, observe_ipam_ips.hostname),
         mac = COALESCE($4, observe_ipam_ips.mac),
         status = $5,
         asset_id = COALESCE($6, observe_ipam_ips.asset_id),
         last_seen_at = NOW()`,
      [ip, subnet_cidr, hostname || null, mac || null, status || 'active', asset_id || null]
    );
    return rows[0];
  }

  async getSubnetUtilization(cidr) {
    const info = parseSubnet(cidr);
    const { rows } = await this.db.query(
      `SELECT COUNT(*) as used FROM observe_ipam_ips
       WHERE subnet_cidr = $1 AND status = 'active'`,
      [cidr]
    );
    const used = parseInt(rows[0]?.used || 0, 10);
    return {
      cidr,
      total: info.usable_hosts,
      used,
      free: info.usable_hosts - used,
      pct_used: info.usable_hosts > 0 ? Math.round((used / info.usable_hosts) * 100) : 0,
    };
  }

  async getIpsInSubnet(cidr) {
    const { rows } = await this.db.query(
      `SELECT * FROM observe_ipam_ips WHERE subnet_cidr = $1 ORDER BY ip`,
      [cidr]
    );
    return rows;
  }

  async findSubnetForIp(ip) {
    const { rows } = await this.db.query(
      `SELECT * FROM observe_ipam_subnets
       WHERE network_addr <= $1::inet AND broadcast_addr >= $1::inet
       ORDER BY prefix_len DESC LIMIT 1`,
      [ip]
    );
    return rows[0] || null;
  }

  /**
   * Importa ARP table como IPs no IPAM.
   */
  async importArpTable(arpEntries, tenant_id, site_id) {
    const results = [];
    for (const entry of arpEntries) {
      try {
        const subnet = await this.findSubnetForIp(entry.ip);
        const cidr = subnet?.cidr || await findEnclosingSubnet([entry.ip]) || 'unknown';

        if (subnet) {
          await this.registerIp({
            ip: entry.ip,
            subnet_cidr: cidr,
            mac: entry.mac,
            status: 'active',
          });
          results.push({ ip: entry.ip, mac: entry.mac, subnet: cidr, imported: true });
        }
      } catch (e) {
        results.push({ ip: entry.ip, error: e.message, imported: false });
      }
    }
    return results;
  }
}

// ── DNS Integration ─────────────────────────────────────────────────────────

/**
 * Sincroniza IPs do IPAM com PowerDNS.
 */
async function syncToPowerDNS(ipamRepo, pdnsApiUrl, pdnsApiKey, zone) {
  const https = require('https');

  const ips = await ipamRepo.getIpsInSubnet(null); // todos

  const records = ips
    .filter(ip => ip.hostname)
    .map(ip => ({
      name: `${ip.hostname}.${zone}`,
      type: 'A',
      content: ip.ip,
      ttl: 300,
    }));

  // Upsert via PowerDNS API
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ rrsets: records.map(r => ({
      name: r.name + '.',
      type: r.type,
      ttl: r.ttl,
      changetype: 'REPLACE',
      records: [{ content: r.content, disabled: false }],
    }))});

    const url = new URL(pdnsApiUrl + '/zones/' + zone);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'PATCH',
      headers: {
        'X-API-Key': pdnsApiKey,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  IpamRepository,
  parseSubnet,
  ipInSubnet,
  listSubnetIps,
  splitSubnet,
  findEnclosingSubnet,
  ipToInt,
  intToIp,
  syncToPowerDNS,
};
