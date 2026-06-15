'use strict';

const { v4: uuidv4 } = require('uuid');

const WEAK_VENDORS  = new Set(['Não identificado', 'Nao identificado', 'Unknown', null, undefined, '']);
const WEAK_PRODUCTS = new Set(['Sem sinal de serviço', 'Sem sinal de servico', null, undefined, '']);

function isWeakVendor(v)  { return WEAK_VENDORS.has(v ?? null); }
function isWeakProduct(v) { return WEAK_PRODUCTS.has(v ?? null); }
function isIpLike(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

/**
 * Detecta se um IP é endereço de rede (.0) ou broadcast (.255).
 */
function isNetworkOrBroadcast(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return false;
  const last = parseInt(parts[3], 10);
  if (isNaN(last)) return false;
  // /24 networks only — expandir se necessário
  return last === 0 || last === 255;
}

/**
 * Extrai OS hint de banners disponíveis: SNMP sysDescr, SSH banner, HTTP server.
 */
function extractOsHint(row) {
  const scan = row.metadata?.scan || {};
  const fp = row.metadata?.fingerprint || {};

  // SNMP sysDescr — fonte mais confiável
  const sysDescr = row.snmp_sysdescr
    || scan.snmp_sysdescr
    || scan.snmp?.sysDescr
    || fp.raw_signals?.snmp_sysdescr
    || '';
  if (sysDescr) {
    const low = sysDescr.toLowerCase();
    if (low.includes('linux')) return 'Linux';
    if (low.includes('ubuntu')) return 'Linux (Ubuntu)';
    if (low.includes('debian')) return 'Linux (Debian)';
    if (low.includes('alpine')) return 'Linux (Alpine)';
    if (low.includes('centos') || low.includes('rhel') || low.includes('red hat')) return 'Linux (RHEL)';
    if (low.includes('windows')) return 'Windows';
    if (low.includes('mikrotik') || low.includes('routeros')) return 'RouterOS';
    if (low.includes('cisco') && low.includes('ios')) return 'Cisco IOS';
    if (low.includes('freebsd')) return 'FreeBSD';
    if (low.includes('esxi') || low.includes('vmware')) return 'VMware ESXi';
    if (low.includes('synology')) return 'Synology DSM';
    return sysDescr.slice(0, 80);
  }

  // SSH banner
  const ssh = row.ssh_banner
    || scan.ssh_banner
    || fp.raw_signals?.ssh_banner
    || '';
  if (ssh) {
    const m = ssh.match(/SSH-\d+\.\d+-(\S+)/);
    if (m) return m[1];
    return ssh.slice(0, 40);
  }

  // HTTP server header
  const http = row.http_server
    || scan.http_server
    || fp.raw_signals?.http_server
    || '';
  if (http) {
    const m = http.match(/^(\S+)/);
    if (m) return m[1];
    return http.slice(0, 40);
  }

  return null;
}
function isWeakAssetName(value) {
  const name = String(value || '').trim();
  return !name || isIpLike(name) || /^asset-\d{1,3}(?:-\d{1,3}){3}$/.test(name);
}

async function findExistingAsset(db, row) {
  const exact = await db.query(
    `SELECT id, asset_key, asset_name, primary_ip, vendor, product, os_hint, hostname, confidence
     FROM observe_assets
     WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND asset_key = $4 LIMIT 1`,
    [row.tenant_id, row.site_id, row.edge_id, row.asset_key]
  );
  if (exact.rows[0]) return { match: 'asset_key', row: exact.rows[0] };

  const assetName = isWeakAssetName(row.asset_name) ? null : String(row.asset_name || '').trim();
  const hostname = String(row.hostname || '').trim() || null;
  const primaryIp = String(row.primary_ip || '').trim() || null;
  if (!assetName && !hostname && !primaryIp) return { match: null, row: null };

  const logical = await db.query(
    `SELECT id, asset_key, asset_name, primary_ip, vendor, product, os_hint, hostname, confidence
     FROM observe_assets
     WHERE tenant_id = $1
       AND site_id = $2
       AND edge_id = $3
       AND lifecycle_state <> 'disappeared'
       AND (
         ($4::text IS NOT NULL AND lower(asset_name) = lower($4::text))
         OR ($5::text IS NOT NULL AND primary_ip = $5::text)
         OR ($6::text IS NOT NULL AND lower(hostname) = lower($6::text))
       )
     ORDER BY
       CASE WHEN $4::text IS NOT NULL AND lower(asset_name) = lower($4::text) THEN 0 ELSE 1 END,
       CASE WHEN $5::text IS NOT NULL AND primary_ip = $5::text THEN 0 ELSE 1 END,
       CASE WHEN $6::text IS NOT NULL AND lower(hostname) = lower($6::text) THEN 0 ELSE 1 END,
       updated_at DESC
     LIMIT 1`,
    [row.tenant_id, row.site_id, row.edge_id, assetName, primaryIp, hostname]
  );
  return { match: logical.rows[0] ? 'logical_identity' : null, row: logical.rows[0] || null };
}

async function createRun(db, ctx) {
  const r = await db.query(
    `INSERT INTO observe_discovery_runs (id, tenant_id, site_id, edge_id, policy_id, status, started_at, metadata)
     VALUES ($1,$2,$3,$4,$5,'running',NOW(),$6) RETURNING *`,
    [uuidv4(), ctx.tenant_id, ctx.site_id, ctx.edge_id, ctx.policy_id, JSON.stringify(ctx.metadata || {})]
  );
  return r.rows[0];
}

async function completeRun(db, runId, status, summary) {
  await db.query(
    `UPDATE observe_discovery_runs SET status = $2, completed_at = NOW(), summary = $3, updated_at = NOW() WHERE id = $1`,
    [runId, status, JSON.stringify(summary || {})]
  );
}

async function upsertAsset(db, row) {
  // ── Filtro: ignora IPs de rede e broadcast ──────────────────────────────
  const ip = row.primary_ip || '';
  if (ip && isNetworkOrBroadcast(ip)) return null;

  // ── OS hint a partir de banners ─────────────────────────────────────────
  if (!row.os_hint) {
    row.os_hint = extractOsHint(row);
  }

  const existing = await findExistingAsset(db, row);
  const prev = existing.row || {};

  // Preservar o melhor valor conhecido: não sobrescrever dados ricos com fallbacks genéricos
  const vendor     = (!isWeakVendor(row.vendor) ? row.vendor : null) ?? (!isWeakVendor(prev.vendor) ? prev.vendor : null) ?? row.vendor ?? null;
  const product    = (!isWeakProduct(row.product) ? row.product : null) ?? (!isWeakProduct(prev.product) ? prev.product : null) ?? row.product ?? null;
  const os_hint    = row.os_hint ?? prev.os_hint ?? null;
  const hostname   = row.hostname ?? prev.hostname ?? null;
  const confidence = Math.max(Number(row.confidence || 0.5), Number(prev.confidence || 0));
  const values = [
    row.asset_name, row.display_name, row.asset_type || 'host', vendor, product, os_hint,
    row.primary_ip || null, hostname, row.lifecycle_state || 'discovered', row.criticality || 'medium',
    confidence, JSON.stringify(row.metadata || {}),
  ];
  const r = existing.match === 'logical_identity'
    ? await db.query(
        `UPDATE observe_assets
         SET asset_name = $2,
             display_name = $3,
             asset_type = $4,
             vendor = $5,
             product = $6,
             os_hint = $7,
             primary_ip = $8,
             hostname = $9,
             lifecycle_state = COALESCE($10, lifecycle_state),
             criticality = $11,
             confidence = $12,
             metadata = $13,
             last_seen_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.row.id, ...values]
      )
    : await db.query(
        `INSERT INTO observe_assets
          (id, tenant_id, site_id, edge_id, asset_key, asset_name, display_name, asset_type, vendor, product, os_hint,
           primary_ip, hostname, lifecycle_state, criticality, confidence, metadata, first_seen_at, last_seen_at)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,'discovered'),$15,$16,$17,NOW(),NOW())
         ON CONFLICT (tenant_id, site_id, edge_id, asset_key)
         DO UPDATE SET
          asset_name   = EXCLUDED.asset_name,
          display_name = EXCLUDED.display_name,
          asset_type   = EXCLUDED.asset_type,
          vendor       = EXCLUDED.vendor,
          product      = EXCLUDED.product,
          os_hint      = EXCLUDED.os_hint,
          primary_ip   = EXCLUDED.primary_ip,
          hostname     = EXCLUDED.hostname,
          criticality  = EXCLUDED.criticality,
          confidence   = EXCLUDED.confidence,
          metadata     = EXCLUDED.metadata,
          last_seen_at = NOW(),
          updated_at   = NOW()
         RETURNING *`,
        [
          uuidv4(), row.tenant_id, row.site_id, row.edge_id, row.asset_key, ...values,
        ]
      );

  const asset = r.rows[0];

  // Persistir interface de rede (MAC address)
  const mac = row.metadata?.arp?.mac_address || row.metadata?.mac_address || null;
  if (mac) {
    const macNorm = mac.toLowerCase().replace(/-/g, ':');
    const macOui = macNorm.slice(0, 8);
    await db.query(
      `INSERT INTO observe_asset_interfaces
        (id, tenant_id, site_id, edge_id, asset_id, interface_key, mac_address, mac_oui, ip_address, network_cidr,
         first_seen_at, last_seen_at)
       VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (tenant_id, site_id, edge_id, asset_id, interface_key)
       DO UPDATE SET
        mac_address = EXCLUDED.mac_address,
        mac_oui     = EXCLUDED.mac_oui,
        ip_address  = EXCLUDED.ip_address,
        last_seen_at = NOW(),
        updated_at  = NOW()`,
      [
        asset.tenant_id, asset.site_id, asset.edge_id, asset.id,
        `mac:${macNorm}`,
        macNorm,
        macOui,
        asset.primary_ip || null,
        null,
      ]
    );
  }

  // Persistir interfaces SNMP (camada física L1) + métricas históricas
  const snmpIfaces = row.metadata?.snmp_interfaces
    || row.metadata?.scan?.snmp_interfaces
    || row.metadata?.scan?.snmp?.interfaces
    || null;
  if (snmpIfaces?.length) {
    await upsertSnmpInterfaces(db, asset, snmpIfaces);
    await insertInterfaceMetrics(db, asset, snmpIfaces);
  }

  return asset;
}

/**
 * Persiste interfaces SNMP com métricas de camada física (L1).
 */
async function upsertSnmpInterfaces(db, asset, interfaces) {
  // Extrair vizinhos LLDP/CDP do metadata para enriquecer interfaces
  const lldpNeighbors = asset.metadata?.lldp_neighbors
    || asset.metadata?.snmp_neighbors
    || asset.metadata?.scan?.snmp_neighbors
    || [];

  for (const iface of interfaces) {
    const ifKey = `snmp:${iface.index || iface.name || 'unknown'}`;

    // Buscar vizinho LLDP correspondente a esta interface
    const matchingNeighbor = lldpNeighbors.find(n => {
      const neighborStr = typeof n === 'string' ? n : (n.system_name || n.chassis_id || '');
      return neighborStr && (
        (iface.name && neighborStr.includes(iface.name)) ||
        (iface.description && neighborStr.includes(iface.description))
      );
    });

    const lldpPayload = matchingNeighbor
      ? (typeof matchingNeighbor === 'string'
          ? { system_name: matchingNeighbor.replace(/^(lldp:|cdp:)/, ''), protocol: matchingNeighbor.startsWith('cdp:') ? 'cdp' : 'lldp' }
          : matchingNeighbor)
      : null;

    await db.query(
      `INSERT INTO observe_asset_interfaces
        (id, tenant_id, site_id, edge_id, asset_id, interface_key, name,
         if_index, if_type, if_mtu, if_speed_bps, if_admin_status, if_oper_status,
         mac_address, ip_address, lldp_neighbor, metadata, first_seen_at, last_seen_at)
       VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, NOW(), NOW())
       ON CONFLICT (tenant_id, site_id, edge_id, asset_id, interface_key)
       DO UPDATE SET
        name            = EXCLUDED.name,
        if_index        = EXCLUDED.if_index,
        if_type         = EXCLUDED.if_type,
        if_mtu          = EXCLUDED.if_mtu,
        if_speed_bps    = EXCLUDED.if_speed_bps,
        if_admin_status = EXCLUDED.if_admin_status,
        if_oper_status  = EXCLUDED.if_oper_status,
        mac_address     = COALESCE(EXCLUDED.mac_address, observe_asset_interfaces.mac_address),
        lldp_neighbor   = COALESCE(EXCLUDED.lldp_neighbor, observe_asset_interfaces.lldp_neighbor),
        metadata        = EXCLUDED.metadata,
        last_seen_at    = NOW(),
        updated_at      = NOW()`,
      [
        asset.tenant_id, asset.site_id, asset.edge_id, asset.id, ifKey,
        iface.name || iface.description || null,
        iface.index || null,
        iface.type || null,
        iface.mtu || null,
        iface.speed_bps ? String(iface.speed_bps) : null,
        iface.admin_status || null,
        iface.oper_status || null,
        iface.mac_address || null,
        asset.primary_ip || null,
        lldpPayload ? JSON.stringify(lldpPayload) : null,
        JSON.stringify({
          description: iface.description || null,
          in_errors: iface.in_errors ?? null,
          out_errors: iface.out_errors ?? null,
          hc_in_octets: iface.hc_in_octets ?? null,
          hc_out_octets: iface.hc_out_octets ?? null,
        }),
      ]
    );
  }
}

/**
 * Insere snapshot de métricas de interface no histórico.
 * Chamado a cada discovery run para interfaces com dados de contadores.
 */
async function insertInterfaceMetrics(db, asset, interfaces) {
  for (const iface of interfaces) {
    // Só insere se houver pelo menos um contador numérico
    const hasCounters = iface.hc_in_octets != null || iface.hc_out_octets != null
      || iface.in_errors != null || iface.out_errors != null;
    if (!hasCounters) continue;

    const ifKey = `snmp:${iface.index || iface.name || 'unknown'}`;
    await db.query(
      `INSERT INTO observe_interface_metrics
        (id, tenant_id, site_id, edge_id, asset_id, interface_key,
         if_in_octets, if_out_octets, if_in_errors, if_out_errors,
         if_in_discards, if_out_discards, collected_at, metadata)
       VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11, NOW(), $12)`,
      [
        asset.tenant_id, asset.site_id, asset.edge_id, asset.id, ifKey,
        iface.hc_in_octets != null ? String(iface.hc_in_octets) : null,
        iface.hc_out_octets != null ? String(iface.hc_out_octets) : null,
        iface.in_errors != null ? String(iface.in_errors) : null,
        iface.out_errors != null ? String(iface.out_errors) : null,
        null, null,
        JSON.stringify({ source: 'snmp-walk', if_index: iface.index }),
      ]
    );
  }
}

async function listTargets(db, ctx) {
  const r = await db.query(
    `SELECT * FROM observe_discovery_targets
     WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND enabled = true`,
    [ctx.tenant_id, ctx.site_id, ctx.edge_id]
  );
  return r.rows;
}

async function getPolicy(db, policyId, ctx) {
  if (policyId) {
    const p = await db.query(
      `SELECT * FROM observe_discovery_policies
       WHERE id = $1 AND tenant_id = $2 AND site_id = $3 AND edge_id = $4`,
      [policyId, ctx.tenant_id, ctx.site_id, ctx.edge_id]
    );
    return p.rows[0] || null;
  }
  const d = await db.query(
    `SELECT * FROM observe_discovery_policies
     WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND is_default = true
     ORDER BY updated_at DESC LIMIT 1`,
    [ctx.tenant_id, ctx.site_id, ctx.edge_id]
  );
  return d.rows[0] || null;
}

module.exports = { createRun, completeRun, upsertAsset, upsertSnmpInterfaces, insertInterfaceMetrics, listTargets, getPolicy };
