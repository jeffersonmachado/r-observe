'use strict';

const https = require('https');
const { log } = require('../utils/logger');

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const icingaApiUrl = process.env.ICINGA_API_URL || 'https://observe-icinga2:5665';
    const icingaApiUser = process.env.ICINGA_API_USER || 'icingaweb2';
    const icingaApiPassword = process.env.ICINGA_API_PASSWORD || '';
    if (!icingaApiPassword) return resolve({ ok: false, status: 0 });
    const parsed = new URL(`${icingaApiUrl}/v1${path}`);
    const auth = Buffer.from(`${icingaApiUser}:${icingaApiPassword}`).toString('base64');
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 5665,
      path: parsed.pathname + parsed.search,
      method,
      rejectUnauthorized: false,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function safeHostName(name) {
  return String(name || 'host-unknown').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 128);
}

function safeServiceName(name) {
  return String(name || 'svc-unknown').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 128);
}

function safeGroupName(name) {
  return String(name || 'grp-unknown').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 128);
}

const IANA_SERVICE_MAP = {
  22:   { name: 'ssh',       check: 'ssh' },
  25:   { name: 'smtp',      check: 'tcp' },
  53:   { name: 'dns',       check: 'dns' },
  80:   { name: 'http',      check: 'http' },
  110:  { name: 'pop3',      check: 'tcp' },
  143:  { name: 'imap',      check: 'tcp' },
  161:  { name: 'snmp',      check: 'snmp' },
  389:  { name: 'ldap',      check: 'tcp' },
  443:  { name: 'https',     check: 'http' },
  465:  { name: 'smtps',     check: 'tcp' },
  587:  { name: 'submission',check: 'tcp' },
  636:  { name: 'ldaps',     check: 'tcp' },
  993:  { name: 'imaps',     check: 'tcp' },
  995:  { name: 'pop3s',     check: 'tcp' },
  1433: { name: 'mssql',     check: 'tcp' },
  1521: { name: 'oracle',    check: 'tcp' },
  3000: { name: 'http-alt',  check: 'http' },
  3306: { name: 'mysql',     check: 'tcp' },
  3389: { name: 'rdp',       check: 'tcp' },
  5432: { name: 'postgres',  check: 'tcp' },
  5672: { name: 'amqp',      check: 'tcp' },
  6379: { name: 'redis',     check: 'tcp' },
  8080: { name: 'http-proxy',check: 'http' },
  8443: { name: 'https-alt', check: 'http' },
  9090: { name: 'prometheus',check: 'http' },
  9092: { name: 'kafka',     check: 'tcp' },
  9200: { name: 'elastic',   check: 'http' },
  27017:{ name: 'mongodb',   check: 'tcp' },
};

function resolveServiceMeta(port, protocol) {
  const proto = (protocol || 'tcp').toLowerCase();
  const svc = IANA_SERVICE_MAP[port];
  if (svc) return { name: svc.name, check: proto === 'udp' ? 'tcp' : svc.check };
  return { name: `${proto}-${port}`, check: 'tcp' };
}

function packageName(tenant) {
  const t = String(tenant?.tenant_id || 'default').replace(/[^a-zA-Z0-9_.-]/g, '-');
  const s = String(tenant?.site_id || 'default-site').replace(/[^a-zA-Z0-9_.-]/g, '-');
  const e = String(tenant?.edge_id || 'central').replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `r-observe-${t}-${s}-${e}`;
}

function renderHostConfig(hosts) {
  const lines = [];
  for (const h of hosts) {
    const host = safeHostName(h.asset_name);
    // Prefer container name (Docker DNS) over IP for Docker-discovered assets
    const dockerName = h.metadata?.docker?.name || h._enrichment?.docker?.name || h._enriched_name;
    const address = dockerName || h.hostname || h.primary_ip || '127.0.0.1';
    lines.push(`object Host \"${host}\" {`);
    lines.push(`  import \"generic-host\"`);
    lines.push(`  address = \"${address}\"`);
    lines.push(`  display_name = \"${(h.display_name || host).replace(/"/g, '\\"')}\"`);
    lines.push(`  vars.discovered = true`);
    lines.push(`  vars.discovery_state = \"${h.lifecycle_state || 'approved'}\"`);
    if (h.vendor)  lines.push(`  vars.vendor = \"${String(h.vendor).replace(/"/g, '\\"')}\"`);
    if (h.product) lines.push(`  vars.product = \"${String(h.product).replace(/"/g, '\\"')}\"`);
    if (h.asset_type) lines.push(`  vars.asset_type = \"${h.asset_type}\"`);
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function renderServiceConfig(hosts) {
  const lines = [];
  const seen = new Set();

  for (const h of hosts) {
    const host = safeHostName(h.asset_name);
    const services = h.services || [];

    for (const svc of services) {
      const port = svc.port;
      if (!port) continue;
      const proto = (svc.protocol || 'tcp').toLowerCase();
      const meta = resolveServiceMeta(port, proto);
      const svcKey = `${host}:${meta.name}`;
      if (seen.has(svcKey)) continue;
      seen.add(svcKey);

      const svcName = safeServiceName(`${meta.name}-${port}`);
      lines.push(`object Service \"${host}-${svcName}\" {`);
      lines.push(`  import \"generic-service\"`);
      lines.push(`  host_name = \"${host}\"`);
      lines.push(`  display_name = \"${meta.name.toUpperCase()} :${port}\"`);
      lines.push(`  vars.discovered = true`);

      if (port === 443) {
        lines.push(`  vars.http_ssl = true`);
        lines.push(`  vars.http_uri = \"/\"`);
      }

      if (proto === 'udp') {
        lines.push(`  vars.check_command = \"tcp\"`);
        lines.push(`  vars.tcp_port = ${port}`);
      } else if (meta.check === 'http') {
        lines.push(`  vars.check_command = \"${port === 443 ? 'http' : 'http'}\"`);
        lines.push(`  vars.http_port = ${port}`);
      } else if (meta.check === 'dns') {
        lines.push(`  vars.check_command = \"dns\"`);
      } else if (meta.check === 'ssh') {
        lines.push(`  vars.check_command = \"ssh\"`);
        lines.push(`  vars.ssh_port = ${port}`);
      } else {
        lines.push(`  vars.check_command = \"tcp\"`);
        lines.push(`  vars.tcp_port = ${port}`);
      }
      lines.push('}');
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderTopologyConfig(hosts, edges) {
  const lines = [];
  const groups = new Map(); // groupName → Set<hostName>

  const hostMap = new Map();
  for (const h of hosts) {
    hostMap.set(h.id, safeHostName(h.asset_name));
  }

  // Agrupa por produto/vendor
  for (const h of hosts) {
    if (h.product) {
      const key = `produto-${safeGroupName(h.product)}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(safeHostName(h.asset_name));
    }
    if (h.vendor && !h.product) {
      const key = `vendor-${safeGroupName(h.vendor)}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(safeHostName(h.asset_name));
    }
  }

  // Agrupa por sub-rede (/24)
  const subnets = new Map();
  for (const h of hosts) {
    const ip = h.primary_ip;
    if (!ip) continue;
    const parts = ip.split('.');
    if (parts.length === 4) {
      const subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0-24`;
      if (!subnets.has(subnet)) subnets.set(subnet, new Set());
      subnets.get(subnet).add(safeHostName(h.asset_name));
    }
  }
  for (const [subnet, members] of subnets) {
    const key = `subnet-${safeGroupName(subnet)}`;
    if (!groups.has(key)) groups.set(key, new Set());
    for (const m of members) groups.get(key).add(m);
  }

  // Agrupa por tipo de asset
  for (const h of hosts) {
    if (h.asset_type && h.asset_type !== 'host') {
      const key = `tipo-${safeGroupName(h.asset_type)}`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(safeHostName(h.asset_name));
    }
  }

  // Topologia: dependencias via edges
  if (Array.isArray(edges) && edges.length > 0) {
    for (const e of edges) {
      const fromHost = hostMap.get(e.from_asset_id);
      if (!fromHost) continue;

      if (e.edge_type === 'service_dependency' && e.to_asset_ref) {
        const ref = e.to_asset_ref; // formato "ip:porta"
        const depPort = ref.split(':')[1];
        if (depPort) {
          const depMeta = resolveServiceMeta(parseInt(depPort, 10), 'tcp');
          const key = `depende-${safeGroupName(depMeta.name)}`;
          if (!groups.has(key)) groups.set(key, new Set());
          groups.get(key).add(fromHost);
        }
      }

      if (e.edge_type === 'host_service') {
        const key = `com-servicos`;
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(fromHost);
      }
    }
  }

  for (const [groupName, members] of groups) {
    if (members.size < 1) continue;
    lines.push(`object HostGroup \"${groupName}\" {`);
    lines.push(`  display_name = \"${groupName}\"`);
    lines.push(`  vars.discovered = true`);
    lines.push('  assign where match(group_name, host)');
    lines.push('}');
    lines.push('');

    // Tambem gera assign filter para cada host
    lines.push(`/* HostGroup ${groupName} members: */`);
    for (const m of members) {
      lines.push(`/*   - ${m} */`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function stageConfigPackage(tenant, hosts, edges) {
  const pkg = '_api'; // Use the existing _api package

  const hostConfig     = renderHostConfig(hosts);
  const serviceConfig  = renderServiceConfig(hosts);
  const topologyConfig = renderTopologyConfig(hosts, edges);

  const fileContent = [
    '// ── Hosts descobertos ───────────────────────────────────────────────',
    hostConfig,
    '// ── Servicos descobertos ────────────────────────────────────────────',
    serviceConfig,
    '// ── Topologia / HostGroups ──────────────────────────────────────────',
    topologyConfig,
  ].join('\n');

  // Icinga2 config staging API: create stage -> upload file -> activate
  const stageRes = await request('POST', `/config/stages/${encodeURIComponent(pkg)}`, {
    files: {
      'conf.d/r-observe-discovery.conf': fileContent,
    },
  });

  if (!stageRes.ok) {
    log('warn', 'Icinga config stage creation failed', { status: stageRes.status, raw: String(stageRes.raw).substring(0, 200) });
    return null;
  }

  // Extract stage name from response
  const stageData = (stageRes.json && stageRes.json.results && stageRes.json.results[0]) || {};
  const stage = stageData.stage || stageData.name || null;
  if (!stage) {
    log('warn', 'Icinga config stage response missing stage identifier', {
      status: stageRes.status,
      raw: String(stageRes.raw).substring(0, 200),
    });
    return null;
  }

  return { pkg, stage, status: stageRes.status };
}

async function deployStage(pkg, stage) {
  if (!stage) return { deployed: false };

  const out = await request('POST',
    `/config/stages/${encodeURIComponent(pkg)}/${encodeURIComponent(stage)}/activate`
  );

  if (!out.ok) {
    log('warn', 'Icinga stage activation failed', { status: out.status, raw: String(out.raw).substring(0, 200) });
    return { deployed: false };
  }

  return { deployed: true, status: out.status };
}

async function listManagedHosts() {
  const out = await request('GET', '/objects/hosts?attrs=name&attrs=address&attrs=vars');
  if (!out.ok || !Array.isArray(out.json?.results)) return [];
  return out.json.results
    .map((r) => ({
      name: r.name,
      address: r.attrs?.address || null,
      discovered: !!r.attrs?.vars?.discovered,
    }))
    .filter((h) => h.discovered);
}

async function listManagedServices() {
  const out = await request('GET', '/objects/services?attrs=name&attrs=host_name&attrs=vars');
  if (!out.ok || !Array.isArray(out.json?.results)) return [];
  return out.json.results
    .map((r) => ({
      name: r.name,
      host_name: r.attrs?.host_name || '',
      discovered: !!r.attrs?.vars?.discovered,
    }))
    .filter((s) => s.discovered);
}

async function listManagedHostGroups() {
  const out = await request('GET', '/objects/hostgroups?attrs=name&attrs=vars');
  if (!out.ok || !Array.isArray(out.json?.results)) return [];
  return out.json.results
    .map((r) => ({
      name: r.name,
      discovered: !!r.attrs?.vars?.discovered,
    }))
    .filter((g) => g.discovered);
}

async function removeHost(name) {
  return request('DELETE', `/objects/hosts/${encodeURIComponent(name)}?cascade=1`);
}

async function removeService(hostName, serviceName) {
  return request('DELETE', `/objects/services/${encodeURIComponent(hostName)}!${encodeURIComponent(serviceName)}?cascade=1`);
}

async function removeHostGroup(name) {
  return request('DELETE', `/objects/hostgroups/${encodeURIComponent(name)}?cascade=1`);
}

async function hostExists(name) {
  const out = await request('GET', `/objects/hosts/${encodeURIComponent(name)}`);
  return out.status === 200;
}

async function serviceExists(hostName, serviceName) {
  const objectName = `${hostName}!${serviceName}`;
  const out = await request('GET', `/objects/services/${encodeURIComponent(objectName)}`);
  return out.status === 200;
}

async function reconcileHosts(discoveredHosts) {
  const existing = await listManagedHosts();
  const wanted = new Set(discoveredHosts.map((h) => safeHostName(h.asset_name)));
  const stale = existing.filter((h) => !wanted.has(h.name));
  let removed = 0;
  for (const s of stale) {
    const out = await removeHost(s.name);
    if (out.ok) removed++;
  }
  return { stale: stale.length, removed };
}

async function reconcileServices(discoveredHosts) {
  const existing = await listManagedServices();
  const wanted = new Set();
  for (const h of discoveredHosts) {
    const host = safeHostName(h.asset_name);
    for (const svc of (h.services || [])) {
      const meta = resolveServiceMeta(svc.port, svc.protocol);
      wanted.add(`${host}!${host}-${safeServiceName(`${meta.name}-${svc.port}`)}`);
    }
  }
  const stale = existing.filter((s) => !wanted.has(`${s.host_name}!${s.name}`));
  let removed = 0;
  for (const s of stale) {
    const out = await removeService(s.host_name, s.name);
    if (out.ok) removed++;
  }
  return { stale: stale.length, removed };
}

async function reconcileHostGroups(discoveredHosts, edges) {
  const existing = await listManagedHostGroups();
  const groups = new Set();

  // Recalcula os mesmos grupos que renderTopologyConfig geraria
  for (const h of discoveredHosts) {
    if (h.product) groups.add(`produto-${safeGroupName(h.product)}`);
    if (h.vendor && !h.product) groups.add(`vendor-${safeGroupName(h.vendor)}`);

    const ip = h.primary_ip;
    if (ip) {
      const parts = ip.split('.');
      if (parts.length === 4) groups.add(`subnet-${safeGroupName(`${parts[0]}.${parts[1]}.${parts[2]}.0-24`)}`);
    }

    if (h.asset_type && h.asset_type !== 'host') groups.add(`tipo-${safeGroupName(h.asset_type)}`);

    if (Array.isArray(h.services) && h.services.length > 0) groups.add('com-servicos');
  }

  if (Array.isArray(edges) && edges.length > 0) {
    const hostMap = new Map();
    for (const h of discoveredHosts) hostMap.set(h.id, safeHostName(h.asset_name));
    for (const e of edges) {
      if (e.edge_type === 'service_dependency' && e.to_asset_ref) {
        const depPort = e.to_asset_ref.split(':')[1];
        if (depPort) {
          const depMeta = resolveServiceMeta(parseInt(depPort, 10), 'tcp');
          groups.add(`depende-${safeGroupName(depMeta.name)}`);
        }
      }
    }
  }

  const stale = existing.filter((g) => !groups.has(g.name));
  let removed = 0;
  for (const s of stale) {
    const out = await removeHostGroup(s.name);
    if (out.ok) removed++;
  }
  return { stale: stale.length, removed };
}

async function registerApprovedAsset(asset) {
  const name = safeHostName(asset.asset_name);
  // Prefer container name (Docker DNS) over IP for Docker-discovered assets
  const dockerName = asset.metadata?.docker?.name || asset._enrichment?.docker?.name || asset._enriched_name;
  const address = dockerName || asset.hostname || asset.primary_ip;
  const attrs = {
    address,
    display_name: asset.display_name || name,
    vars: {
      discovered: true,
      discovery_state: asset.lifecycle_state || 'approved',
      vendor: asset.vendor || null,
      product: asset.product || null,
      asset_type: asset.asset_type || null,
    },
  };
  const exists = await hostExists(name);
  if (exists) {
    return request('POST', `/objects/hosts/${encodeURIComponent(name)}`, {
      attrs,
    });
  }
  return request('PUT', `/objects/hosts/${encodeURIComponent(name)}`, {
    templates: ['generic-host'],
    attrs,
  });
}

async function registerService(hostName, port, protocol) {
  const host = safeHostName(hostName);
  const meta = resolveServiceMeta(port, protocol);
  const svcName = safeServiceName(`${meta.name}-${port}`);
  const fullName = `${host}-${svcName}`;

  const attrs = {
    host_name: host,
    display_name: `${meta.name.toUpperCase()} :${port}`,
    vars: {
      discovered: true,
      check_command: meta.check,
    },
  };

  if (protocol === 'udp') {
    attrs.vars.check_command = 'tcp';
    attrs.vars.tcp_port = port;
  } else if (meta.check === 'http') {
    attrs.vars.http_port = port;
    if (port === 443) attrs.vars.http_ssl = true;
  } else if (meta.check === 'dns') {
    // dns check usa vars padrão
  } else if (meta.check === 'ssh') {
    attrs.vars.ssh_port = port;
  } else {
    attrs.vars.tcp_port = port;
  }

  const exists = await serviceExists(host, fullName);
  if (exists) {
    return request('POST', `/objects/services/${encodeURIComponent(host)}!${encodeURIComponent(fullName)}`, {
      attrs,
    });
  }
  return request('PUT', `/objects/services/${encodeURIComponent(host)}!${encodeURIComponent(fullName)}`, {
    templates: ['generic-service'],
    attrs,
  });
}

async function syncDiscoveredToIcinga({ tenant, assets, edges }) {
  // Include all lifecycle states when syncing (discovered, approved, monitored)
  const approved = (assets || []).filter((a) =>
    a.lifecycle_state === 'approved' || a.lifecycle_state === 'monitored' || a.lifecycle_state === 'discovered'
  );
  if (!approved.length) return { synced: 0, services_synced: 0, staged: false, deployed: false, reconcile: { stale: 0, removed: 0 } };

  log('info', 'Icinga sync: staging config', { assets: approved.length });
  const staged = await stageConfigPackage(tenant, approved, edges || []);
  log('info', 'Icinga sync: deploying config', { staged: !!staged });
  const deployed = staged ? await deployStage(staged.pkg, staged.stage) : { deployed: false };
  log('info', 'Icinga sync: deployed', { deployed: !!deployed.deployed });

  let synced = 0;
  for (const a of approved) {
    const out = await registerApprovedAsset(a);
    if (out.ok) synced++;
  }

  // Sync services
  let servicesSynced = 0;
  for (const a of approved) {
    const services = a.services || [];
    for (const svc of services) {
      if (!svc.port) continue;
      const out = await registerService(a.asset_name, svc.port, svc.protocol);
      if (out.ok) servicesSynced++;
    }
  }

  const hostRec  = await reconcileHosts(approved);
  const svcRec   = await reconcileServices(approved);
  const groupRec = await reconcileHostGroups(approved, edges || []);

  log('info', 'Icinga sync completed', {
    hosts_synced: synced,
    services_synced: servicesSynced,
    staged: !!staged,
    deployed: !!deployed.deployed,
    host_stale: hostRec.stale,
    host_removed: hostRec.removed,
    svc_stale: svcRec.stale,
    svc_removed: svcRec.removed,
    group_stale: groupRec.stale,
    group_removed: groupRec.removed,
  });

  return {
    synced,
    services_synced: servicesSynced,
    staged: !!staged,
    deployed: !!deployed.deployed,
    reconcile: {
      hosts: hostRec,
      services: svcRec,
      groups: groupRec,
    },
    package: staged?.pkg || null,
    stage: staged?.stage || null,
  };
}

module.exports = { registerApprovedAsset, syncDiscoveredToIcinga };
