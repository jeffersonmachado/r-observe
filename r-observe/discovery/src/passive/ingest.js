'use strict';

/**
 * Ingestão de eventos passivos de descoberta (MDNS, SSDP, DHCP, LLDP, etc).
 * Extraído de index.js para reduzir o tamanho do arquivo principal.
 */

const { normalizePassiveEvent } = require('./parser');
const { buildTopologyEdges } = require('../topology/engine');
const { fingerprintAsset } = require('../fingerprint/engine');
const { writeGraph: writeNeo4jGraph, enabled: neo4jEnabled } = require('../topology/graph-store');
const { emitEvent } = require('../queues/events');
const { upsertAsset } = require('../engine/repository');
const metrics = require('../metrics');

function passiveAssetKey(evt) {
  if (evt.mac) return `mac:${evt.mac}`;
  if (evt.source_ip) return `ip:${evt.source_ip}`;
  if (evt.hostname) return `host:${evt.hostname}`;
  return `passive:${evt.type}:${Date.now()}`;
}

function passiveAssetName(evt) {
  return evt.hostname || evt.source_ip || evt.mac || `passive-${evt.type}`;
}

function passiveAssetType(evt) {
  if (evt.type === 'snmp_trap') return 'network_device';
  if (evt.type === 'lldp' || evt.type === 'cdp') return 'network_device';
  if (evt.type === 'ssdp' || evt.type === 'mdns') return 'iot';
  if (evt.type === 'dhcp' || evt.type === 'arp_change') return 'host';
  return 'host';
}

function protocolForPassiveType(type) {
  if (['mdns', 'ssdp', 'snmp_trap', 'dhcp'].includes(type)) return 'udp';
  return 'tcp';
}

function inferPassivePorts(evt) {
  const ports = new Set();
  const addIfValid = (port) => {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0 && n <= 65535) ports.add(n);
  };

  addIfValid(evt?.payload?.port);

  const byType = {
    mdns: [5353],
    ssdp: [1900],
    snmp_trap: [162],
    dhcp: [67],
  };
  for (const p of byType[evt?.type] || []) addIfValid(p);

  return Array.from(ports).sort((a, b) => a - b);
}

async function storePassiveServices({ dbConn, asset, tenant, parsed, ports, fingerprint }) {
  const protocol = protocolForPassiveType(parsed.type);
  const services = [];

  for (const port of ports) {
    const serviceKey = `${protocol}:${port}`;
    await dbConn.query(
      `INSERT INTO observe_asset_services
        (id, tenant_id, site_id, edge_id, asset_id, service_key, service_name, protocol, port, status, fingerprint, first_seen_at, last_seen_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'open',$9,NOW(),NOW())
       ON CONFLICT (tenant_id, site_id, edge_id, asset_id, service_key)
       DO UPDATE SET
         service_name = EXCLUDED.service_name,
         protocol = EXCLUDED.protocol,
         port = EXCLUDED.port,
         status = 'open',
         fingerprint = EXCLUDED.fingerprint,
         last_seen_at = NOW(),
         updated_at = NOW()`,
      [
        tenant.tenant_id,
        tenant.site_id,
        tenant.edge_id,
        asset.id,
        serviceKey,
        `passive-${parsed.type}-${port}`,
        protocol,
        port,
        JSON.stringify({ passive_type: parsed.type, fingerprint }),
      ]
    );

    services.push({
      protocol,
      port,
      dependency_target: [53, 3306, 5432].includes(port) ? `${asset.primary_ip || 'unknown'}:${port}` : null,
    });
  }

  return services;
}

async function persistPassiveTopology({ dbConn, tenant, asset, services }) {
  if (!services.length) return 0;
  const edges = buildTopologyEdges(null, [{ ...asset, services }]);
  for (const edge of edges) {
    await dbConn.query(
      `INSERT INTO observe_topology_edges
        (id, tenant_id, site_id, edge_id, run_id, from_asset_id, to_asset_ref, edge_type, protocol, source, observed_at, metadata)
       VALUES (gen_random_uuid(),$1,$2,$3,NULL,$4,$5,$6,$7,'passive-discovery',NOW(),$8)
       ON CONFLICT (tenant_id, site_id, edge_id, from_asset_id, to_asset_ref, edge_type, protocol)
       DO UPDATE SET
         observed_at = NOW(),
         source = EXCLUDED.source,
         metadata = EXCLUDED.metadata`,
      [
        tenant.tenant_id,
        tenant.site_id,
        tenant.edge_id,
        asset.id,
        edge.to_asset_ref,
        edge.edge_type,
        edge.protocol || null,
        JSON.stringify({ passive: true }),
      ]
    );
  }
  return edges.length;
}

/**
 * Cria o ingest de eventos passivos com dependências injetadas.
 */
function createPassiveIngest({ db, redis, log, parseScope }) {
  async function ingestPassiveEvents(events) {
    const list = Array.isArray(events) ? events : [events];
    if (list.length > 100) {
      metrics.passiveRejected.inc({ reason: 'batch_limit' });
      throw new Error('passive event batch exceeds limit (100)');
    }
    let accepted = 0;

    for (const evt of list) {
      const parsed = normalizePassiveEvent(evt);
      if (!parsed) continue;
      const tenant = parseScope(evt || {});
      const assetKey = passiveAssetKey(parsed);
      const dbConn = await db.connect();
      let asset;
      let services;
      let writtenEdges;
      let fp;
      let row;

      try {
      await dbConn.query('BEGIN');
      await dbConn.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`passive:${tenant.tenant_id}:${tenant.site_id}:${tenant.edge_id}`]
      );

      const existing = await dbConn.query(
        `SELECT 1 FROM observe_assets WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 AND asset_key=$4 LIMIT 1`,
        [tenant.tenant_id, tenant.site_id, tenant.edge_id, assetKey]
      );
      if (!existing.rows.length) {
        const maxPassiveAssets = Math.max(1, parseInt(process.env.DISCOVERY_PASSIVE_MAX_ASSETS || '5000', 10));
        const count = await dbConn.query(
          `SELECT COUNT(*)::int AS count FROM observe_assets
           WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 AND metadata ? 'passive'`,
          [tenant.tenant_id, tenant.site_id, tenant.edge_id]
        );
        if ((count.rows[0]?.count || 0) >= maxPassiveAssets) {
          metrics.passiveRejected.inc({ reason: 'cardinality_limit' });
          log('warn', 'Passive asset cardinality limit reached', { ...tenant, max: maxPassiveAssets });
          await dbConn.query('ROLLBACK');
          continue;
        }
      }

      await dbConn.query(
        `INSERT INTO observe_discovery_findings
          (id, run_id, tenant_id, site_id, edge_id, finding_type, severity, source, asset_key, payload, observed_at)
         VALUES (gen_random_uuid(),NULL,$1,$2,$3,'passive_signal','info',$4,$5,$6,NOW())`,
        [
          tenant.tenant_id,
          tenant.site_id,
          tenant.edge_id,
          `passive:${parsed.type}`,
          assetKey,
          JSON.stringify(parsed),
        ]
      );

      const passivePorts = inferPassivePorts(parsed);
      fp = fingerprintAsset({
        hostname: parsed.hostname || null,
        open_ports: passivePorts,
        snmp_sysdescr: parsed.type === 'snmp_trap' ? (parsed.payload?.raw_text || null) : null,
        http_server: parsed.payload?.server || null,
        http_title: parsed.payload?.st || null,
        smtp_banner: parsed.payload?.message || null,
        os_hint: parsed.payload?.os_hint || null,
      });

      row = {
        ...tenant,
        asset_key: assetKey,
        asset_name: passiveAssetName(parsed),
        display_name: passiveAssetName(parsed),
        primary_ip: parsed.source_ip || null,
        hostname: parsed.hostname || null,
        asset_type: passiveAssetType(parsed),
        vendor: fp.vendor || null,
        product: fp.product || parsed.type,
        os_hint: null,
        criticality: 'medium',
        confidence: Math.max(0.6, Number(fp.confidence || 0.7)),
        metadata: { passive: parsed, fingerprint: fp, lifecycle: 'discovered' },
      };
      asset = await upsertAsset(dbConn, row);
      services = await storePassiveServices({ dbConn, asset, tenant, parsed, ports: passivePorts, fingerprint: fp });

      await dbConn.query(
        `INSERT INTO observe_service_fingerprints
         (id, tenant_id, site_id, edge_id, asset_id, service_key, fingerprint, confidence, observed_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (tenant_id, site_id, edge_id, asset_id, service_key)
         DO UPDATE SET fingerprint = EXCLUDED.fingerprint, confidence = EXCLUDED.confidence, observed_at = NOW()`,
        [tenant.tenant_id, tenant.site_id, tenant.edge_id, asset.id, `passive:${parsed.type}`, JSON.stringify(fp), fp.confidence || 0.7]
      );

      await dbConn.query(
        `INSERT INTO observe_asset_history
          (id, tenant_id, site_id, edge_id, asset_id, snapshot, captured_at, snapshot_type)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,NOW(),'passive-event')`,
        [tenant.tenant_id, tenant.site_id, tenant.edge_id, asset.id, JSON.stringify({ asset: row, fingerprint: fp, services, passive: parsed })]
      );

      writtenEdges = await persistPassiveTopology({ dbConn, tenant, asset: { ...asset, primary_ip: row.primary_ip }, services });
      await dbConn.query('COMMIT');
      } catch (error) {
        try { await dbConn.query('ROLLBACK'); } catch (_) { /* preserva o erro original */ }
        throw error;
      } finally {
        dbConn.release();
      }

      if (neo4jEnabled() && writtenEdges > 0) {
        try {
          const neoEdges = buildTopologyEdges(null, [{ ...asset, primary_ip: row.primary_ip, services }]);
          await writeNeo4jGraph({ tenant, runId: null, assets: [{ ...asset, asset_name: row.asset_name, primary_ip: row.primary_ip }], edges: neoEdges });
        } catch (e) {
          log('warn', 'Passive Neo4j write failed', { err: e.message, asset_key: asset.asset_key });
        }
      }

      await emitEvent(redis, 'observe.discovery.asset_found', {
        passive: true,
        tenant_id: tenant.tenant_id,
        site_id: tenant.site_id,
        edge_id: tenant.edge_id,
        asset_id: asset.id,
        asset_key: asset.asset_key,
        type: parsed.type,
        topology_edges: writtenEdges,
        confidence: fp.confidence || 0.7,
      });

      accepted++;
    }

    return accepted;
  }

  return { ingestPassiveEvents };
}

module.exports = { createPassiveIngest, passiveAssetKey, passiveAssetName, passiveAssetType, protocolForPassiveType, inferPassivePorts, storePassiveServices, persistPassiveTopology };
