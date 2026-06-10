'use strict';

const { log } = require('../utils/logger');

const URI = process.env.NEO4J_URI || '';
const USER = process.env.NEO4J_USER || 'neo4j';
const PASSWORD = process.env.NEO4J_PASSWORD || '';

let driver = null;
let neo4jLib = null;
let neo4jLoadFailed = false;

function enabled() {
  return Boolean(URI && PASSWORD);
}

function getNeo4j() {
  if (neo4jLib) return neo4jLib;
  if (neo4jLoadFailed) return null;

  try {
    neo4jLib = require('neo4j-driver');
    return neo4jLib;
  } catch (e) {
    neo4jLoadFailed = true;
    log('warn', 'Neo4j driver unavailable, graph store disabled', { err: e.message });
    return null;
  }
}

function getDriver() {
  if (!enabled()) return null;
  const neo4j = getNeo4j();
  if (!neo4j) return null;
  if (!driver) {
    driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD), {
      disableLosslessIntegers: true,
      maxConnectionPoolSize: 20,
    });
  }
  return driver;
}

async function closeDriver() {
  if (!driver) return;
  try {
    await driver.close();
  } catch (e) {
    log('warn', 'Neo4j close failed', { err: e.message });
  } finally {
    driver = null;
  }
}

function isTransientError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('connection') || msg.includes('session') || msg.includes('service unavailable');
}

async function withSession(mode, fn) {
  const neo4j = getNeo4j();
  if (!neo4j) return null;
  const drv = getDriver();
  if (!drv) return null;
  let attempt = 0;
  while (attempt < 2) {
    const session = drv.session({ defaultAccessMode: mode });
    try {
      return await fn(session);
    } catch (e) {
      attempt += 1;
      if (attempt >= 2 || !isTransientError(e)) throw e;
      await closeDriver();
      getDriver();
      log('warn', 'Neo4j transient failure, retrying', { err: e.message, attempt });
    } finally {
      await session.close();
    }
  }
  return null;
}

async function writeGraph({ tenant, runId, assets, edges }) {
  if (!enabled()) return { enabled: false, written_assets: 0, written_edges: 0 };
  const neo4j = getNeo4j();
  if (!neo4j) return { enabled: false, written_assets: 0, written_edges: 0, reason: 'driver_unavailable' };

  try {
    return await withSession(neo4j.session.WRITE, async (session) => {
      let writtenAssets = 0;
      for (const a of assets || []) {
        await session.run(
          `MERGE (n:Asset {asset_key:$asset_key, tenant_id:$tenant_id, site_id:$site_id, edge_id:$edge_id})
           SET n.asset_name=$asset_name, n.primary_ip=$primary_ip, n.hostname=$hostname,
               n.vendor=$vendor, n.product=$product, n.asset_type=$asset_type,
               n.lifecycle_state=$lifecycle_state, n.updated_at=datetime()` ,
          {
            asset_key: a.asset_key,
            tenant_id: tenant.tenant_id,
            site_id: tenant.site_id,
            edge_id: tenant.edge_id,
            asset_name: a.asset_name || null,
            primary_ip: a.primary_ip || null,
            hostname: a.hostname || null,
            vendor: a.vendor || null,
            product: a.product || null,
            asset_type: a.asset_type || null,
            lifecycle_state: a.lifecycle_state || null,
          }
        );
        writtenAssets++;
      }

      let writtenEdges = 0;
      for (const e of edges || []) {
        await session.run(
          `MATCH (from:Asset {tenant_id:$tenant_id, site_id:$site_id, edge_id:$edge_id})
           WHERE from.id = $from_asset_id OR from.asset_key = $from_asset_key
           MERGE (to:Ref {tenant_id:$tenant_id, site_id:$site_id, edge_id:$edge_id, ref:$to_asset_ref})
           MERGE (from)-[r:REL {edge_type:$edge_type, protocol:$protocol, to_ref:$to_asset_ref}]->(to)
           SET r.source=$source, r.run_id=$run_id, r.observed_at=datetime()`,
          {
            tenant_id: tenant.tenant_id,
            site_id: tenant.site_id,
            edge_id: tenant.edge_id,
            from_asset_id: e.from_asset_id || null,
            from_asset_key: e.from_asset_key || null,
            to_asset_ref: e.to_asset_ref,
            edge_type: e.edge_type,
            protocol: e.protocol || null,
            source: e.source || null,
            run_id: runId,
          }
        );
        writtenEdges++;
      }

      return { enabled: true, written_assets: writtenAssets, written_edges: writtenEdges };
    });
  } catch (e) {
    log('warn', 'Neo4j writeGraph failed', { err: e.message });
    return { enabled: false, written_assets: 0, written_edges: 0, error: e.message };
  }
}

async function shortestPath({ tenant, fromAssetKey, toAssetRef, maxDepth = 8 }) {
  if (!enabled()) return { enabled: false, paths: [] };
  const neo4j = getNeo4j();
  if (!neo4j) return { enabled: false, paths: [], reason: 'driver_unavailable' };

  const r = await withSession(neo4j.session.READ, async (session) => session.run(
      `MATCH (a:Asset {tenant_id:$tenant_id, site_id:$site_id, edge_id:$edge_id, asset_key:$from_asset_key})
       MATCH (b {tenant_id:$tenant_id, site_id:$site_id, edge_id:$edge_id})
       WHERE (b:Asset AND b.asset_key = $to_asset_ref) OR (b:Ref AND b.ref = $to_asset_ref)
       MATCH p = shortestPath((a)-[:REL*..${Math.max(1, Math.min(16, maxDepth))}]-(b))
       RETURN [n IN nodes(p) | coalesce(n.asset_key, n.ref)] AS nodes,
              [r IN relationships(p) | {edge_type:r.edge_type, protocol:r.protocol}] AS rels
       LIMIT 1`,
      {
        tenant_id: tenant.tenant_id,
        site_id: tenant.site_id,
        edge_id: tenant.edge_id,
        from_asset_key: fromAssetKey,
        to_asset_ref: toAssetRef,
      }
    ));
  if (!r) return { enabled: false, paths: [] };
  return { enabled: true, paths: r.records.map((rec) => ({ nodes: rec.get('nodes'), rels: rec.get('rels') })) };
}

async function blastRadius({ tenant, assetKey, depth = 2, limit = 200 }) {
  if (!enabled()) return { enabled: false, affected: [] };
  const neo4j = getNeo4j();
  if (!neo4j) return { enabled: false, affected: [], reason: 'driver_unavailable' };

  const d = Math.max(1, Math.min(6, depth));
  const l = Math.max(1, Math.min(1000, limit));
  const r = await withSession(neo4j.session.READ, async (session) => session.run(
      `MATCH (a:Asset {tenant_id:$tenant_id, site_id:$site_id, edge_id:$edge_id, asset_key:$asset_key})
       MATCH (a)-[:REL*1..${d}]-(x)
       RETURN DISTINCT coalesce(x.asset_key, x.ref) AS id
       LIMIT ${l}`,
      {
        tenant_id: tenant.tenant_id,
        site_id: tenant.site_id,
        edge_id: tenant.edge_id,
        asset_key: assetKey,
      }
    ));
  if (!r) return { enabled: false, affected: [] };
  return { enabled: true, affected: r.records.map((rec) => rec.get('id')).filter(Boolean) };
}

async function dependencyTraversal({ tenant, assetKey, direction = 'both', depth = 3, limit = 500 }) {
  if (!enabled()) return { enabled: false, dependencies: [] };
  const neo4j = getNeo4j();
  if (!neo4j) return { enabled: false, dependencies: [], reason: 'driver_unavailable' };

  const d = Math.max(1, Math.min(8, depth));
  const l = Math.max(1, Math.min(5000, limit));
  const pathPattern = direction === 'out'
    ? `(a)-[:REL*1..${d}]->(x)`
    : direction === 'in'
      ? `(a)<-[:REL*1..${d}]-(x)`
      : `(a)-[:REL*1..${d}]-(x)`;
  const r = await withSession(neo4j.session.READ, async (session) => session.run(
      `MATCH (a:Asset {tenant_id:$tenant_id, site_id:$site_id, edge_id:$edge_id, asset_key:$asset_key})
       MATCH p=${pathPattern}
       RETURN DISTINCT coalesce(x.asset_key, x.ref) AS id
       LIMIT ${l}`,
      {
        tenant_id: tenant.tenant_id,
        site_id: tenant.site_id,
        edge_id: tenant.edge_id,
        asset_key: assetKey,
      }
    ));

  if (!r) return { enabled: false, dependencies: [] };
  return { enabled: true, dependencies: r.records.map((rec) => rec.get('id')).filter(Boolean) };
}

module.exports = {
  enabled,
  writeGraph,
  shortestPath,
  blastRadius,
  dependencyTraversal,
  closeDriver,
};
