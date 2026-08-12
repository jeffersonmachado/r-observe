'use strict';

const fs = require('fs');

const { log, info } = require('../utils/logger');
const { debug, debugTable, debugObject, isDebug, startTrace, traceStage, endTrace } = require('../utils/logger');
const { activeScanTarget } = require('../scanners/active');
const { discoverArpTable, enrichArpAssets } = require('../scanners/arp-discovery');
const { discoverLocalDocker } = require('../scanners/docker-local');
const { sweepSubnet } = require('../scanners/ping-sweep');
const { discoverAllSubnets } = require('../scanners/subnet-auto');
const { ping6Sweep, discoverNdpTable, discoverIPv6Subnets, activeScan6, expandIPv6Prefix, isValidIPv6 } = require('../scanners/ipv6');
const { discoverKubernetes, isKubectlAvailable } = require('../scanners/k8s');
const { scanWindowsHost } = require('../scanners/windows-smb');
const { discoverCloudResources } = require('../scanners/cloud');
const { discoverBluetooth } = require('../scanners/bluetooth');
const { scanIndustrialHost } = require('../scanners/industrial');
const { discoverLldpCdp } = require('../scanners/lldp-cdp');
const { handleAgentReport } = require('../scanners/agents');
const { nmapServiceScan } = require('../scanners/nmap-sv');
const { fingerprintAsset } = require('../fingerprint/engine');
const { discoverVMware } = require('../scanners/vmware-vsphere');
const { discoverProxmox } = require('../scanners/proxmox-ve');
const { discoverHyperV } = require('../scanners/hyperv-windows');
const { discoverVoip } = require('../scanners/voip-telephony');
const { classifyInfrastructure } = require('../classifiers/infrastructure-classifier');
const { classifyDatabase } = require('../classifiers/database-classifier');

// ── Port change detection ─────────────────────────────────────────────────
const PORT_CHANGE_ENABLED = process.env.DISCOVERY_PORT_CHANGE_DETECTION !== 'false';
const PORT_DISAPPEARED_GRACE_SCANS = parseInt(process.env.DISCOVERY_PORT_DISAPPEARED_GRACE || '2', 10); // quantos scans antes de alertar
const { buildTopologyEdges } = require('../topology/engine');
const { writeGraph: writeNeo4jGraph, enabled: neo4jEnabled } = require('../topology/graph-store');
const { writeFileSd } = require('../exporters/prometheus-sd');
const { registerApprovedAsset, syncDiscoveredToIcinga } = require('../integrations/icinga');
const { emitEvent } = require('../queues/events');
const { createRun, completeRun, upsertAsset, listTargets, getPolicy } = require('./repository');
const { autoDiscoverTargets } = require('../scanners/target-auto');
const { normalizePolicy, validateTarget } = require('../security/guardrails');
const { expandTargets, chunkTargets } = require('../scanners/target-expansion');
const { validateTargets, validateExpansionSize: ves } = require('../validators');
const { normalizeAsset } = require('../normalizers/asset-normalizer');
const { detectGateway } = require('../utils/gateway-detector');
const { classifyService: aiClassifyService } = require('../classifiers/ai-classifier');
const kb = require('../knowledge/loader');
const metrics = require('../metrics');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function keyFromTarget(t) {
  return `${t.discovery_type || 'ip'}:${t.address}`;
}

function industrialVendor(protocol) {
  const vendors = { 'modbus-tcp': 'Schneider/Siemens/Allen-Bradley', 'bacnet-ip': 'Johnson/Honeywell/Siemens',
    'profinet': 'Siemens', 'profinet-dcp': 'Siemens', 'ethernet-ip': 'Rockwell/Allen-Bradley',
    'opc-ua': 'Various', 'mqtt': 'Various' };
  return vendors[protocol] || null;
}

async function saveFindings(db, runId, tenant, finding) {
  await db.query(
    `INSERT INTO observe_discovery_findings
      (id, run_id, tenant_id, site_id, edge_id, finding_type, severity, source, asset_key, payload)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [runId, tenant.tenant_id, tenant.site_id, tenant.edge_id, finding.type, finding.severity || 'info', finding.source, finding.asset_key, JSON.stringify(finding.payload || {})]
  );
}

async function storeAssetServices(db, asset, scan) {
  const services = [];
  const allServices = kb.getServices();

  for (const port of scan.open_ports || []) {
    const proto = [53, 67, 68, 123, 161, 5060].includes(port) ? 'udp' : 'tcp';

    // Exporter detection via knowledge base
    const svcMatch = allServices.find(s => (s.ports || []).includes(port) && s.exporter_job);
    let exporter = !!svcMatch?.exporter_job;
    let exporterPort = svcMatch?.exporter_port || port;
    let job = svcMatch?.exporter_job || (port === 9100 ? 'node-exporter' : port === 9187 ? 'postgres-exporter' : port === 9090 ? 'prometheus' : 'generic-metrics');

    // ── Validação via IA: confirma se o mapeamento KB está correto ──────
    if (exporter) {
      const aiResult = await aiClassifyService(asset.primary_ip, port, job, {
        http_banner: scan.http_server || null,
        hostname: asset.hostname || null,
      });
      if (aiResult && aiResult.confidence > 0.7) {
        // IA discorda da knowledge base? Desclassifica o exporter
        if (aiResult.is_exporter === false) {
          exporter = false;
          job = null;
          exporterPort = port;
          debug(`ai-classify:overrule ${asset.primary_ip}:${port} KB=${svcMatch.exporter_job} AI=${aiResult.service} reason=${aiResult.reason}`);
        } else if (aiResult.exporter_job && aiResult.exporter_job !== job) {
          // IA sugere um exporter diferente
          job = aiResult.exporter_job;
          debug(`ai-classify:refine ${asset.primary_ip}:${port} KB=${svcMatch.exporter_job} AI=${aiResult.exporter_job}`);
        }
      }
    }

    // Dependency detection via knowledge base
    const depMatch = allServices.find(s => (s.ports || []).includes(port) && s.dependency_type);
    const dependencyTarget = depMatch ? `${asset.primary_ip}:${port}` : null;

    // ── Per-port fingerprint: banner + KB hints ────────────────────────
    const portBanner = scan.port_banners?.[port] || null;
    const portSpecificBanner = port === 22 ? scan.ssh_banner : port === 25 || port === 587 || port === 465 ? scan.smtp_banner : null;
    const serviceBanner = portBanner || portSpecificBanner || null;
    const portHint = kb.getPortHints()?.[port] || {};

    await db.query(
      `INSERT INTO observe_asset_services
        (id, tenant_id, site_id, edge_id, asset_id, service_key, service_name, protocol, port, status, fingerprint, first_seen_at, last_seen_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'open',$9,NOW(),NOW())
       ON CONFLICT (tenant_id, site_id, edge_id, asset_id, service_key)
       DO UPDATE SET status = 'open', fingerprint = EXCLUDED.fingerprint, last_seen_at = NOW(), updated_at = NOW()`,
      [
        asset.tenant_id, asset.site_id, asset.edge_id, asset.id,
        `${proto}:${port}`,
        `port-${port}`,
        proto,
        port,
        JSON.stringify({
          protocol: proto,
          port,
          http_server: scan.http_server || null,
          banner: serviceBanner,
          technology: portHint.technology || null,
          product_hint: portHint.product || null,
          category: portHint.category || null,
        }),
      ]
    );
    services.push({
      protocol: proto,
      port,
      exporter_target: exporter ? `${asset.primary_ip}:${exporterPort}` : null,
      job: exporter ? job : null,
      dependency_target: dependencyTarget,
    });
  }

  // ── Nmap -sV: fingerprint de versão para todos os serviços ──────────
  if (scan.open_ports && scan.open_ports.length > 0) {
    try {
      const svResults = await nmapServiceScan(asset.primary_ip, scan.open_ports);
      for (const sv of svResults) {
        const svcName = sv.version 
          ? `${sv.service} ${sv.version}`
          : sv.service;
        const svcKey = `${sv.protocol}:${sv.port}`;
        await db.query(
          `UPDATE observe_asset_services SET
             service_name = $1,
             fingerprint = COALESCE(fingerprint, '{}'::jsonb) || $2::jsonb,
             last_seen_at = NOW()
           WHERE asset_id = $3 AND service_key = $4`,
          [svcName, JSON.stringify({ version: sv.version, product: sv.product, nmap_raw: sv.raw }), asset.id, svcKey]
        ).catch(() => {});
      }
    } catch (_) { /* Nmap -sV pode falhar, segue */ }
  }

  return services;
}

// ── Port change detection (Gap #8 + #9) ──────────────────────────────────
async function detectPortChanges(db, tenant, asset, previousServices = null) {
  if (!PORT_CHANGE_ENABLED) return [];

  try {
    const prevResult = previousServices ? null : await db.query(
      `SELECT service_key, service_name, port, protocol, status, fingerprint
       FROM observe_asset_services
       WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND asset_id = $4`,
      [tenant.tenant_id, tenant.site_id, tenant.edge_id, asset.id]
    );
    const prevServices = previousServices || prevResult?.rows || [];
    const prevOpenKeys = new Set(prevServices.filter(s => s.status === 'open').map(s => s.service_key));
    const currentKeys = new Set((asset.services || []).map(s => `${s.protocol || 'tcp'}:${s.port}`));

    const changes = [];

    for (const s of (asset.services || [])) {
      const key = `${s.protocol || 'tcp'}:${s.port}`;
      if (!prevOpenKeys.has(key)) {
        changes.push({
          type: 'port_opened', severity: [22, 3389].includes(s.port) ? 'critical' : [3306, 5432, 6379, 27017].includes(s.port) ? 'warning' : 'info',
          source: 'port-change-detection', asset_key: asset.asset_key,
          payload: { port: s.port, protocol: s.protocol || 'tcp', direction: 'opened', exporter_job: s.job || null },
        });
      }
    }

    for (const prev of prevServices.filter(s => s.status === 'open' || s.status === 'closed')) {
      if (!currentKeys.has(prev.service_key)) {
        const fingerprint = typeof prev.fingerprint === 'string' ? JSON.parse(prev.fingerprint || '{}') : (prev.fingerprint || {});
        const missed = parseInt(fingerprint.missed_scans || 0, 10);
        if (missed >= PORT_DISAPPEARED_GRACE_SCANS - 1) {
          changes.push({
            type: 'port_closed', severity: [22, 80, 443, 3306, 5432, 6379, 9090].includes(prev.port) ? 'critical' : [25, 53, 161, 9100].includes(prev.port) ? 'warning' : 'info',
            source: 'port-change-detection', asset_key: asset.asset_key,
            payload: { port: prev.port, protocol: prev.protocol, direction: 'closed', service_name: prev.service_name, consecutive_misses: missed + 1 },
          });
        }
        await db.query(
          `UPDATE observe_asset_services SET status='closed',
             fingerprint=COALESCE(fingerprint,'{}'::jsonb) || $6::jsonb, updated_at=NOW()
           WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 AND asset_id=$4 AND service_key=$5`,
          [tenant.tenant_id, tenant.site_id, tenant.edge_id, asset.id, prev.service_key, JSON.stringify({ missed_scans: missed + 1 })]
        );
      }
    }

    if (changes.length) log('info', 'Port changes detected', { asset: asset.asset_name, changes: changes.map(c => `${c.payload.direction}:${c.payload.port}`) });
    return changes;
  } catch (e) { log('warn', 'Port change detection failed', { asset: asset.asset_name, err: e.message }); return []; }
}

async function persistDependencies(db, tenant, fromAssetId, services) {
  const allServices = kb.getServices();

  for (const svc of services) {
    // Dependency type via knowledge base
    const depMatch = allServices.find(s => (s.ports || []).includes(svc.port) && s.dependency_type);
    const depType = depMatch?.dependency_type || null;

    // Exporter type via knowledge base
    const expMatch = allServices.find(s => (s.ports || []).includes(svc.port) && s.exporter_job);
    const expType = expMatch ? 'service_exporter' : null;

    const type = depType || expType;
    if (!type) continue;
    const metadata = { port: svc.port, protocol: svc.protocol };
    const updated = await db.query(
      `UPDATE observe_dependencies SET confidence=$6, metadata=$7, last_seen_at=NOW()
       WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 AND upstream_asset_id=$4
         AND downstream_asset_id IS NULL AND dependency_type=$5
         AND metadata->>'port'=$8 AND metadata->>'protocol'=$9`,
      [tenant.tenant_id, tenant.site_id, tenant.edge_id, fromAssetId, type, 0.7, JSON.stringify(metadata), String(svc.port), String(svc.protocol || '')]
    );
    if (updated.rowCount) continue;
    await db.query(
      `INSERT INTO observe_dependencies
        (id, tenant_id, site_id, edge_id, upstream_asset_id, downstream_asset_id, dependency_type, confidence, metadata, first_seen_at, last_seen_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,NULL,$5,$6,$7,NOW(),NOW())
       ON CONFLICT DO NOTHING`,
      [tenant.tenant_id, tenant.site_id, tenant.edge_id, fromAssetId, type, 0.7, JSON.stringify(metadata)]
    );
  }
}

async function detectDrift(db, runId, asset) {
  const prev = await db.query(
    `SELECT id, primary_ip, hostname, product, vendor, confidence FROM observe_assets
     WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3 AND asset_key = $4 LIMIT 1`,
    [asset.tenant_id, asset.site_id, asset.edge_id, asset.asset_key]
  );
  if (!prev.rowCount) return [];
  const p = prev.rows[0];
  const changes = [];
  const maybe = (field, oldVal, newVal) => {
    if ((oldVal || null) !== (newVal || null)) changes.push({ field, old_value: oldVal, new_value: newVal });
  };
  maybe('primary_ip', p.primary_ip, asset.primary_ip);
  maybe('hostname', p.hostname, asset.hostname);
  maybe('product', p.product, asset.product);
  maybe('vendor', p.vendor, asset.vendor);

  for (const c of changes) {
    await db.query(
      `INSERT INTO observe_asset_changes
        (id, tenant_id, site_id, edge_id, asset_id, run_id, change_type, field_name, old_value, new_value, changed_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'attribute_changed',$6,$7,$8,NOW())`,
      [asset.tenant_id, asset.site_id, asset.edge_id, p.id, runId, c.field, String(c.old_value || ''), String(c.new_value || '')]
    );
  }
  return changes;
}

async function getHistoricalContext(db, tenant, assetKey, scan) {
  const cert = scan?.tls_sha256 || null;
  const prev = await db.query(
    `SELECT asset_key, asset_type, vendor, product, confidence, metadata, last_seen_at
     FROM observe_assets
     WHERE tenant_id = $1 AND site_id = $2 AND edge_id = $3
       AND (asset_key = $4 OR ($5::text IS NOT NULL AND metadata->'scan'->>'tls_sha256' = $5))
     ORDER BY updated_at DESC
     LIMIT 1`,
    [tenant.tenant_id, tenant.site_id, tenant.edge_id, assetKey, cert]
  );
  if (!prev.rowCount) return null;
  const row = prev.rows[0];
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : Date.now();
  const ageDays = Math.max(0, (Date.now() - lastSeen) / 86400000);
  const previousFp = row.metadata?.fingerprint || {};
  return {
    asset_key_match: row.asset_key === assetKey,
    cert_match: !!cert && row.metadata?.scan?.tls_sha256 === cert,
    previous_asset_type: row.asset_type || previousFp.asset_type || null,
    previous_technology: previousFp.technology || null,
    previous_product: row.product || previousFp.product || null,
    previous_vendor: row.vendor || previousFp.vendor || null,
    previous_confidence: row.confidence || previousFp.confidence || null,
    age_days: Number(ageDays.toFixed(2)),
  };
}

function lifecycleFromGovernance(fp) {
  if (fp.governance?.auto_approve) return 'approved';
  return 'discovered';
}

async function runDiscovery({ db, redis, input, onProgress }) {
  const report = (update) => { try { if (onProgress) onProgress(update); } catch (_) {} };
  let run = null;

  const tenant = {
    tenant_id: input.tenant_id || 'default',
    site_id: input.site_id || 'default-site',
    edge_id: input.edge_id || 'central',
  };

  const traceId = startTrace('discovery');

  if (isDebug()) {
    debugObject('discovery:input', {
      tenant,
      profile: input.profile || 'safe',
      targets_count: input.targets?.length || 0,
      arp_enabled: input.arp_discovery_enabled,
      ping_enabled: input.ping_sweep_enabled,
      trigger: input.trigger || 'manual',
    }, traceId);
  }

  try {
	  report({ stage: 'policy', status: 'running' });
	  const policyRow = await getPolicy(db, input.policy_id || null, tenant);
	  if (input.policy_id && !policyRow) throw new Error('Policy not found in discovery scope');
	  const policy = normalizePolicy(policyRow || { scan_profile: input.profile || 'safe' });
  report({ stage: 'policy', status: 'done' });
  traceStage(traceId, 'policy');

  report({ stage: 'run_create', status: 'running' });
  run = await createRun(db, { ...tenant, policy_id: policyRow?.id || null, metadata: { trigger: input.trigger || 'manual' } });
  report({ stage: 'run_create', status: 'done', run_id: run.id });
  traceStage(traceId, 'run_create');

  if (isDebug()) {
    debug(`discovery:run-created run_id=${run.id}`, { trace_id: traceId, run_id: run.id, policy_id: policyRow?.id });
  }

  await emitEvent(redis, 'observe.discovery.started', { run_id: run.id, ...tenant, profile: policy.profile });

  report({ stage: 'targets', status: 'running' });
  let targets = input.targets?.length ? input.targets : await listTargets(db, tenant);

  // Auto-discovery de targets CIDR — sempre habilitado.
  // Em Docker, usa as subnets detectadas automaticamente (capped).
  const isDocker = isDockerEnvironment();
  const autoDiscoverEnabled = true; // generalista: sempre tenta auto-detectar

  // Feedback para a UI: mostra o ambiente detectado e o resultado da decisão
  report({
    stage: 'environment',
    status: 'done',
    docker_detected: isDocker,
    auto_discover_cidr: autoDiscoverEnabled,
    reason: isDocker
      ? 'Docker detectado — auto-discovery via targets do banco e subnets do host'
      : 'Bare-metal detectado — auto-discovery CIDR habilitado',
  });

  if ((!targets || targets.length === 0) && autoDiscoverEnabled) {
    const knownIps = []; // será populado na primeira run pelo ARP
    const auto = autoDiscoverTargets(knownIps);
    if (auto.targets.length > 0) {
      targets = auto.targets;
      info('Auto-discovered targets', { count: auto.targets.length, subnets: auto.subnets.length });
    }
  }

  report({ stage: 'targets', status: 'done', total_targets: targets.length });
  traceStage(traceId, 'targets');

  // Pre-scan validation
  const { validateTargets: vt, validateExpansionSize: ves, validatePolicy: vp } = require('../validators');
  const policyValidation = vp(policy);
  if (!policyValidation.ok) {
    log('warn', 'Policy validation warnings', { errors: policyValidation.errors });
  }
  const targetValidation = vt(targets);
  if (!targetValidation.ok) {
    log('warn', 'Target validation warnings', { count: targetValidation.errors.length, sample: targetValidation.errors.slice(0, 5) });
  }
  const sizeLimit = policy.max_hosts || 65536;
  const sizeCheck = ves(targets, sizeLimit);
  if (!sizeCheck.ok) {
    metrics.expansionExceeded.inc();
    // Generalista: em vez de abortar, trunca os targets para um subconjunto seguro.
    // Ambientes com muitas redes (Docker, Kubernetes) geram CIDRs amplos que
    // precisam ser domados, nao recusados.
    log('warn', 'Target expansion too large, capping to max_scan_targets', {
      estimated: sizeCheck.estimated,
      maxHosts: sizeLimit,
      original_count: targets.length,
    });
    // Pega apenas os primeiros /24 menores (mais especificos = mais seguros)
    const sorted = [...targets].sort((a, b) => {
      const addrA = String(a.address || a || '').trim();
      const addrB = String(b.address || b || '').trim();
      const maskA = addrA.includes('/') ? parseInt(addrA.split('/')[1], 10) : 32;
      const maskB = addrB.includes('/') ? parseInt(addrB.split('/')[1], 10) : 32;
      return maskB - maskA; // mascaras maiores (/24, /32) primeiro
    });
    const maxTargets = policy.max_scan_targets || 512;
    targets = sorted.slice(0, Math.min(maxTargets, 25)); // cap em 25 CIDRs no maximo
    await saveFindings(db, run.id, tenant, {
      type: 'targets_capped',
      severity: 'warning',
      source: 'policy',
      asset_key: 'targets',
      payload: {
        estimated: sizeCheck.estimated,
        maxHosts: sizeLimit,
        original_count: sorted.length,
        capped_to: targets.length,
      },
    });
  }

  // Expand targets (CIDR, ranges, hostnames) → individual IPs
  const expandOptions = {
    maxHosts: policy.max_hosts || 999999,
    maxScanTargets: policy.max_scan_targets || 512,
    excludeRanges: policy.blocked_ranges || [],
    includeRanges: policy.allowed_ranges || [],
  };
  
	  let expandedTargets = targets;
	  let blockedTargets = 0;

	  // Skip expansion if all targets are already single IPs (avoids DNS hangs)
	  const allAreSingleIPs = targets.every(t => {
	    const addr = (t.address || t).trim();
	    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
	  });

	  if (!allAreSingleIPs) {
	    try {
	      const targetSpecs = targets.map(t => t.address || t);
	      const expansion = await expandTargets(targetSpecs, expandOptions);
	      expandedTargets = expansion.targets;
	      const filteredOut = expansion.filteredOut || [];
	      blockedTargets += filteredOut.length;
	      for (const filtered of filteredOut.slice(0, 500)) {
	        await saveFindings(db, run.id, tenant, {
	          type: 'target_blocked',
	          severity: 'warning',
	          source: 'policy',
	          asset_key: keyFromTarget(filtered),
	          payload: { reason: filtered.reason, target: { address: filtered.address, discovery_type: filtered.discovery_type || 'ip' } },
	        });
	      }
	      if (filteredOut.length > 500) {
	        await saveFindings(db, run.id, tenant, {
	          type: 'target_blocked_summary',
	          severity: 'warning',
	          source: 'policy',
	          asset_key: 'targets',
	          payload: {
	            total_blocked: filteredOut.length,
	            persisted_sample: 500,
	            reasons: filteredOut.reduce((acc, item) => {
	              acc[item.reason] = (acc[item.reason] || 0) + 1;
	              return acc;
	            }, {}),
	          },
	        });
	      }

	      report({ stage: 'targets', status: 'done',
	        input_targets: targets.length,
	        expanded_targets: expansion.totalExpanded,
	        unique_targets: expansion.totalUnique,
	        filtered_targets: expansion.totalFiltered,
	      });
	    } catch (e) {
	      await saveFindings(db, run.id, tenant, {
	        type: 'target_expansion_error',
	        severity: 'error',
	        source: 'target-expansion',
	        asset_key: 'system',
	        payload: { message: e.message },
	      });
	      throw new Error(`Target expansion failed: ${e.message}`);
	    }
	  } else {
	    // All targets are already single IPs, skip expansion
	    report({ stage: 'targets', status: 'done',
	      input_targets: targets.length,
	      expanded_targets: targets.length,
	      unique_targets: targets.length,
	      filtered_targets: 0,
	    });
	  }

	  const assets = [];
	  let scanned = 0;

  // ── Canary check: scan first 5 targets, abort if >80% unreachable ──
  if (expandedTargets.length > 10) {
    const canaryTargets = expandedTargets.slice(0, 5);
    report({ stage: 'canary', status: 'running', canary_count: canaryTargets.length });
    const canaryResults = [];
    for (const t of canaryTargets) {
      try {
        const result = await activeScanTarget(t, { timeoutMs: policy.canary_timeout_ms || 2000, maxRetries: 1 });
        canaryResults.push({ target: t, reachable: !!result });
      } catch (_) {
        canaryResults.push({ target: t, reachable: false });
      }
    }
    const unreachableCount = canaryResults.filter(r => !r.reachable).length;
    const unreachablePct = (unreachableCount / canaryTargets.length) * 100;
    report({ stage: 'canary', status: 'done', reachable: canaryTargets.length - unreachableCount, unreachable: unreachableCount });

    if (unreachablePct > 80) {
      await saveFindings(db, run.id, tenant, {
        type: 'canary_abort',
        severity: 'warning',
        source: 'canary',
        asset_key: 'system',
        payload: { canary_results: canaryResults, unreachable_pct: unreachablePct },
      });
      await completeRun(db, run.id, tenant, 'failed', { error: `Canary: ${unreachableCount}/${canaryTargets.length} targets unreachable (${unreachablePct.toFixed(0)}%)` });
      report({ stage: 'done', status: 'error', summary: { error: 'canary_abort', unreachable_pct: unreachablePct } });
      return { run_id: run.id, scanned, assets, edges: [], sd: { total: 0 }, status: 'canary_abort' };
    }
  }

  report({ stage: 'scanning', status: 'running', scanned: 0, discovered: 0, total_targets: expandedTargets.length });

  const scanResults = [];
  let targetFailures = 0;
  const maxConc = Math.max(1, Math.min(50, policy.max_concurrency || 5));
  const throttlePerTargetMs = Math.floor(60000 / Math.max(1, policy.max_rate_per_minute || 300));

  // Use chunked processing for large target sets
  const targetChunks = chunkTargets(expandedTargets, 256);
  let totalProcessed = 0;
  const processTarget = async (t) => {
    const addr = typeof t === 'string' ? t : (t.address || t);
    const target = { address: addr, discovery_type: (typeof t !== 'string' && t.discovery_type) || 'ip' };
    const guard = validateTarget(target, policy);
    if (!guard.ok) {
      blockedTargets++;
      await saveFindings(db, run.id, tenant, {
        type: 'target_blocked',
        severity: 'warning',
        source: 'policy',
        asset_key: keyFromTarget(target),
        payload: { reason: guard.reason, target },
      });
      return null;
    }

    scanned++;
    const scan = policy.active_enabled ? await activeScanTarget(target, policy) : { address: target.address, open_ports: [] };
    report({ stage: 'scanning', status: 'running', scanned, discovered: assets.length, total_targets: expandedTargets.length });
    scanResults.push({
      name: scan.hostname || `host-${target.address.replace(/\./g, '-')}`,
      address: target.address,
      ports: scan.open_ports || [],
      display_name: scan.hostname || target.address,
    });
    const assetKey = keyFromTarget(target);
    const history = await getHistoricalContext(db, tenant, assetKey, scan);

    // ── Multi-run learning: confiança acumulativa ────────────────────────
    const historicalConfidence = history?.previous_confidence || 0;
    const historicalAssetType = history?.previous_asset_type || null;
    const historyAgeDays = history?.age_days || 999;

    // ── Normalização do asset com ARP + Scan + Gateway/Localhost ──
    const gw = detectGateway();
    const normalized = normalizeAsset(
      null, // ARP raw — será preenchido na etapa ARP separada
      { ...scan, address: target.address },
      { isGateway: gw.isGateway(target.address), isLocalhost: gw.isLocalhost(target.address) }
    );

    if (isDebug()) {
      debug(`discovery:scan-complete target=${target.address}`, {
        trace_id: traceId,
        ip: target.address,
        open_ports: (scan.open_ports || []).length,
        hostname: scan.hostname || null,
        is_gateway: normalized.is_gateway,
        is_localhost: normalized.is_localhost,
        normalized_evidence: normalized.evidence.length,
      });
    }

    // Passar dados normalizados completos para o fingerprint engine
    const fp = fingerprintAsset({
      ...scan,
      history,
      mac: normalized.mac,
      hostname: normalized.hostname,
      // Passar evidências normalizadas + flags de topology
      evidence: normalized.evidence,
      open_ports: normalized.open_ports,
      filtered_ports: normalized.filtered_ports,
      is_gateway: normalized.is_gateway,
      is_localhost: normalized.is_localhost,
      topology: {
        ...(scan.topology || {}),
        gateway: normalized.is_gateway || undefined,
        localhost: normalized.is_localhost || undefined,
      },
    }, traceId);

    if (isDebug()) {
      debug(`discovery:fp-result target=${target.address}`, {
        trace_id: traceId,
        ip: target.address,
        asset_type: fp.asset_type,
        confidence: fp.confidence,
        confidence_level: fp.confidence_level,
        vendor: fp.vendor,
        product: fp.product,
        technology: fp.technology,
        evidence_count: fp.evidence_count,
        conflicts: fp.conflicting_evidence,
        governance: fp.governance?.decision,
      });
    }

    const row = {
      ...tenant,
      asset_key: assetKey,
      asset_name: scan.hostname || `asset-${target.address.replace(/\./g, '-')}`,
      display_name: scan.hostname || target.address,
      primary_ip: target.address,
      hostname: scan.hostname,
      asset_type: fp.asset_type || 'host',
      vendor: fp.vendor,
      product: fp.product,
      os_hint: fp.os_hint,
      criticality: fp.criticality,
      confidence: fp.confidence,
      lifecycle_state: lifecycleFromGovernance(fp),
      metadata: {
        scan,
        fingerprint: fp,
        inference: fp.inference,
        governance: fp.governance,
        historical_context: history,
        lifecycle: lifecycleFromGovernance(fp),
      },
    };

    const drift = await detectDrift(db, run.id, row);
    const asset = await upsertAsset(db, row);
    if (!asset) {
      report({ stage: 'scanning', status: 'skipped', target: target.address, reason: 'network_or_broadcast_address' });
      return null;
    }
    const previousServicesResult = await db.query(
      `SELECT service_key, service_name, port, protocol, status, fingerprint
       FROM observe_asset_services WHERE tenant_id=$1 AND site_id=$2 AND edge_id=$3 AND asset_id=$4`,
      [tenant.tenant_id, tenant.site_id, tenant.edge_id, asset.id]
    );
    asset.services = await storeAssetServices(db, asset, scan);

    // ── OS-Driven monitoring: injeta exporters implícitos baseados no SO detectado ──
    const kb = require('../knowledge/loader');
    const osProfile = kb.getOsDefaults(fp.technology || row.technology || asset.technology);
    if (osProfile) {
      const existingPorts = new Set((asset.services || []).map(s => s.port));
      const injected = [];
      for (const exp of (osProfile.exporters || [])) {
        if (!existingPorts.has(exp.port)) {
          injected.push(exp);
          asset.services.push({
            port: exp.port,
            protocol: exp.protocol || 'tcp',
            exporter_job: exp.job,
            service_key: `${exp.protocol || 'tcp'}:${exp.port}`,
            service_name: exp.job || `port-${exp.port}`,
            status: 'inferred',
            source: 'os-inference',
            reason: exp.reason || `Inferido por detecção de SO: ${fp.technology || 'desconhecido'}`,
          });
        }
      }
      if (injected.length) {
        info(`OS-driven: ${row.asset_name} (${fp.technology}) → ${injected.map(e => e.job).join(', ')}`);
      }
    }

    // ── Detect port changes (opened/closed) ──
    const portChanges = await detectPortChanges(db, tenant, asset, previousServicesResult.rows || []);
    for (const change of portChanges) {
      await storeFinding(db, run.id, tenant, change);
      if (redis) {
        await emitEvent(redis, 'observe.discovery.port_changed', {
          run_id: run.id, ...tenant, asset_id: asset.id, ...change,
        });
      }
    }

    // ── TLS Certificate expiry check (Gap #7) ──
    if (scan.tls_valid_to) {
      try {
        const expiryDate = new Date(scan.tls_valid_to);
        const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
        if (daysLeft <= 30) {
          const severity = daysLeft <= 7 ? 'critical' : daysLeft <= 14 ? 'warning' : 'info';
          const certFinding = {
            type: 'tls_cert_expiring',
            severity,
            source: 'cert-expiry-check',
            asset_key: asset.asset_key || asset.asset_name,
            payload: {
              subject: scan.tls_subject,
              issuer: scan.tls_issuer,
              valid_to: scan.tls_valid_to,
              days_remaining: daysLeft,
              port: 443,
            },
          };
          await storeFinding(db, run.id, tenant, certFinding);
          if (redis) {
            await emitEvent(redis, 'observe.discovery.cert_expiring', {
              run_id: run.id, ...tenant, asset_id: asset.id,
              days_remaining: daysLeft, subject: scan.tls_subject,
            });
          }
        }
      } catch (_) { /* data inválida, ignora */ }
    }

    await db.query(
      `INSERT INTO observe_service_fingerprints
       (id, tenant_id, site_id, edge_id, asset_id, service_key, fingerprint, confidence, observed_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (tenant_id, site_id, edge_id, asset_id, service_key)
       DO UPDATE SET fingerprint = EXCLUDED.fingerprint, confidence = EXCLUDED.confidence, observed_at = NOW()`,
      [asset.tenant_id, asset.site_id, asset.edge_id, asset.id, 'asset', JSON.stringify(fp), fp.confidence]
    );

    assets.push({ ...asset, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: row.asset_name, primary_ip: row.primary_ip, services: asset.services });

    await persistDependencies(db, tenant, asset.id, asset.services);
    await db.query(
      `INSERT INTO observe_asset_history
        (id, tenant_id, site_id, edge_id, asset_id, snapshot, captured_at, snapshot_type)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,NOW(),'discovery-run')`,
      [tenant.tenant_id, tenant.site_id, tenant.edge_id, asset.id, JSON.stringify({ asset: row, fingerprint: fp, services: asset.services })]
    );

    await emitEvent(redis, drift.length ? 'observe.discovery.asset_changed' : 'observe.discovery.asset_found', {
      run_id: run.id,
      ...tenant,
      asset_id: asset.id,
      asset_key: asset.asset_key,
      changes: drift,
    });
    if (throttlePerTargetMs > 0) await sleep(throttlePerTargetMs);
    return asset;
  };

  for (const chunk_data of targetChunks) {
    for (const group of chunk(chunk_data, maxConc)) {
      await Promise.all(group.map(async (target) => {
        try {
          return await processTarget(target);
        } catch (e) {
          targetFailures++;
          metrics.targetFailures.inc({ source: 'active-scan' });
          const address = typeof target === 'string' ? target : target?.address;
          log('warn', 'Discovery target failed', { address, err: e.message, run_id: run.id });
          await saveFindings(db, run.id, tenant, {
            type: 'target_scan_error', severity: 'error', source: 'active-scan',
            asset_key: `ip:${address || 'unknown'}`, payload: { address, message: e.message },
          }).catch(() => {});
          return null;
        }
      }));
    }
    totalProcessed += chunk_data.length;
    report({ stage: 'scanning', status: 'running', scanned, discovered: assets.length, total_targets: expandedTargets.length, processed_chunks: Math.ceil(totalProcessed / 256) });
  }
  report({ stage: 'scanning', status: 'done', scanned, discovered: assets.length, total_targets: expandedTargets.length });
  traceStage(traceId, 'scanning');

  const arpEnabled = input.arp_discovery_enabled === true || process.env.DISCOVERY_ARP_ENABLED === 'true';
  report({ stage: 'arp', status: arpEnabled ? 'running' : 'skipped' });
  traceStage(traceId, 'arp');

  // ── Coletar fontes de enriquecimento (Docker, k8s, cloud) ────────────────
  const enrichmentSources = [];

  const dockerEnabled = input.docker_discovery_enabled === true || process.env.DISCOVERY_DOCKER_ENABLED === 'true';
  let dockerAssets = [];
  if (dockerEnabled) {
    dockerAssets = await discoverLocalDocker();
    if (dockerAssets.length) {
      enrichmentSources.push({ type: 'docker', data: dockerAssets, keyFn: (item) => item.ips?.[0] || null,
        // Busca por qualquer IP do container, não só o primeiro
        matchIp: (item, ip) => (item.ips || []).includes(ip) });
      for (const c of dockerAssets) {
        await saveFindings(db, run.id, tenant, {
          type: 'docker_container_discovered',
          source: 'docker-local',
          asset_key: `docker:${c.container_id}`,
          payload: c,
        });
      }
    }
  }
  report({ stage: 'docker', status: dockerEnabled ? 'done' : 'skipped', docker_found: dockerAssets.length });

  // ── Função de enriquecimento genérica ────────────────────────────────────
  function enrichAssetWithSources(asset) {
    const enriched = { ...asset };
    const ip = enriched.primary_ip;
    for (const source of enrichmentSources) {
      const match = source.data.find(item => {
        if (source.matchIp) return source.matchIp(item, ip);
        const key = source.keyFn(item);
        return key && key === ip;
      });
      if (match) {
        enriched._enrichment = enriched._enrichment || {};
        enriched._enrichment[source.type] = match;
        if (match.name) enriched._enriched_name = match.name;
        if (match.image) enriched._enriched_image = match.image;
      }
    }
    return enriched;
  }

  // ── ARP discovery + enriquecimento + auto-scan ───────────────────────────
  const arpAutoScanEnabled = process.env.DISCOVERY_ARP_AUTOSCAN_ENABLED !== 'false';
  const arpAutoScanMax = parseInt(process.env.DISCOVERY_ARP_AUTOSCAN_MAX || '50', 10);
  let arpAssets = [];

  if (arpEnabled) {
    arpAssets = enrichArpAssets(await discoverArpTable());
    const gw = detectGateway();
    let arpScanned = 0;

    for (const a of arpAssets) {
      // Enriquecer com fontes externas (Docker, etc.)
      const enriched = enrichAssetWithSources(a);

      // Normalizar asset ARP com detecção de gateway/localhost
      const normalized = normalizeAsset(enriched, null, {
        isGateway: gw.isGateway(enriched.primary_ip),
        isLocalhost: gw.isLocalhost(enriched.primary_ip),
      });

      const displayName = enriched._enriched_name || enriched.device_name || enriched.primary_ip;

      const arpRow = {
        ...tenant,
        asset_key: enriched.mac_address ? `mac:${enriched.mac_address}` : `ip:${enriched.primary_ip}`,
        asset_name: displayName,
        display_name: displayName,
        primary_ip: enriched.primary_ip,
        hostname: null,
        asset_type: normalized.is_gateway ? 'gateway' : normalized.is_localhost ? 'local_host' : (enriched.device_type || 'host'),
        vendor: enriched.vendor || null,
        product: enriched._enriched_image || enriched.device_name || null,
        os_hint: null,
        criticality: normalized.is_gateway ? 'high' : 'medium',
        confidence: enriched.confidence || 0.9,
        metadata: {
          arp: enriched,
          enriched: enriched._enrichment || null,
          normalized,
          lifecycle: 'discovered',
          mac_type: enriched.mac_type || 'unknown',
          vendor_reliable: enriched.vendor_reliable !== undefined ? enriched.vendor_reliable : false,
          is_gateway: normalized.is_gateway,
          is_localhost: normalized.is_localhost,
        },
      };

      // ── Persistir primeiro ──────────────────────────────────────────────
      const saved = await upsertAsset(db, arpRow);
      assets.push({ ...saved, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: arpRow.asset_name, primary_ip: arpRow.primary_ip, services: [] });
      await saveFindings(db, run.id, tenant, {
        type: 'arp_asset_discovered',
        source: 'arp',
        asset_key: arpRow.asset_key,
        payload: { ...enriched, normalized: { is_gateway: normalized.is_gateway, is_localhost: normalized.is_localhost, mac_type: enriched.mac_type, vendor_reliable: enriched.vendor_reliable }, enriched: !!enriched._enrichment },
      });

      // ── Auto-scan IPs ARP (não gateway, não localhost, não já escaneados) ──
      const alreadyScanned = false; // ARP sempre é primeiro
      const shouldAutoScan = arpAutoScanEnabled
        && !normalized.is_gateway
        && !normalized.is_localhost
        && !alreadyScanned
        && arpScanned < arpAutoScanMax
        && policy.active_enabled !== false;

      if (shouldAutoScan) {
        arpScanned++;
        try {
          const scan = await activeScanTarget(
            { address: enriched.primary_ip, discovery_type: 'ip' },
            policy
          );
          if (scan.open_ports?.length > 0) {
            const fp = fingerprintAsset({
              ...scan,
              mac: normalized.mac,
              hostname: normalized.hostname,
              evidence: normalized.evidence,
              open_ports: scan.open_ports.map(p => typeof p === 'number' ? { port: p, protocol: 'tcp', service: null, state: 'open' } : p),
              filtered_ports: [],
              is_gateway: normalized.is_gateway,
              is_localhost: normalized.is_localhost,
            }, traceId);

            // Atualizar o asset com fingerprint + serviços
            arpRow.asset_type = fp.asset_type || arpRow.asset_type;
            arpRow.vendor = fp.vendor || arpRow.vendor;
            arpRow.product = fp.product || arpRow.product;
            arpRow.confidence = fp.confidence;
            arpRow.metadata = { ...arpRow.metadata, fingerprint: fp, scan };

            const updated = await upsertAsset(db, arpRow);
            const svcs = await storeAssetServices(db, updated, scan);
            await persistDependencies(db, tenant, updated.id, svcs);

            // Atualizar o asset no array global com os serviços (exporter_target)
            const assetInList = assets.find(a => a.id === updated.id);
            if (assetInList) assetInList.services = svcs;

            if (isDebug()) {
              debug(`discovery:arp-autoscan ip=${enriched.primary_ip}`, {
                trace_id: traceId,
                ip: enriched.primary_ip,
                open_ports: scan.open_ports,
                asset_type: fp.asset_type,
                confidence: fp.confidence,
              });
            }
          }
        } catch (e) {
          if (isDebug()) {
            debug(`discovery:arp-autoscan-failed ip=${enriched.primary_ip}`, {
              trace_id: traceId, error: e.message,
            });
          }
        }
      }
    }
    report({ stage: 'arp', status: 'done', arp_discovered: arpAssets.length, arp_autoscanned: arpScanned });
  }

  // ── Assets via Docker que não apareceram no ARP ──────────────────────────
  let dockerScanned = 0;
  for (const c of dockerAssets) {
    for (const ip of (c.ips || [])) {
      if (!ip || ip === '127.0.0.1') continue;
      const alreadyExists = assets.some(as => as.primary_ip === ip)
        || arpAssets?.some(a => a.primary_ip === ip);
      if (alreadyExists) continue;

      const dockerRow = {
        ...tenant,
        asset_key: `docker:${c.container_id}`,
        asset_name: c.name,
        display_name: c.name,
        primary_ip: ip,
        hostname: c.name,
        asset_type: 'host',
        vendor: c.image?.split(':')[0] || null,
        product: c.image || null,
        confidence: 0.8,
        criticality: 'medium',
        metadata: {
          docker: c,
          lifecycle: 'discovered',
          ports: c.ports,
          labels: c.labels,
        },
      };

      // ── Auto-scan Docker IPs (mesmo limite do ARP) ─────────────────────
      if (arpAutoScanEnabled && dockerScanned < arpAutoScanMax && policy.active_enabled !== false) {
        dockerScanned++;
        try {
          const scan = await activeScanTarget({ address: ip, discovery_type: 'ip' }, policy);
          if (scan.open_ports?.length > 0) {
            const fp = fingerprintAsset({
              ...scan,
              open_ports: scan.open_ports.map(p => typeof p === 'number' ? { port: p, protocol: 'tcp', service: null, state: 'open' } : p),
              filtered_ports: [],
            }, traceId);

            dockerRow.asset_type = fp.asset_type || dockerRow.asset_type;
            dockerRow.vendor = fp.vendor || dockerRow.vendor;
            dockerRow.product = fp.product || dockerRow.product;
            dockerRow.confidence = fp.confidence;
            dockerRow.metadata = { ...dockerRow.metadata, fingerprint: fp, scan };
          }
        } catch (_) {}
      }

      const saved = await upsertAsset(db, dockerRow);

      // Persistir serviços do auto-scan e enriquecer asset com exporter_target
      let dockerServices = [];
      if (dockerRow.metadata?.scan?.open_ports?.length > 0) {
        dockerServices = await storeAssetServices(db, saved, dockerRow.metadata.scan);
      }

      assets.push({ ...saved, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: dockerRow.asset_name, primary_ip: dockerRow.primary_ip, services: dockerServices });
      await saveFindings(db, run.id, tenant, {
        type: 'docker_ip_asset',
        source: 'docker-local',
        asset_key: `docker:${c.container_id}`,
        payload: { container: c.name, ip, image: c.image },
      });
    }
  }

  // ── Ping Sweep (Enterprise) ──────────────────────────────────────────────
  const pingEnabled = input.ping_sweep_enabled === true || process.env.DISCOVERY_PING_SWEEP_ENABLED === 'true';
  report({ stage: 'ping_sweep', status: pingEnabled ? 'running' : 'skipped' });
  let pingAliveHosts = [];
  if (pingEnabled) {
    // Sweep das subnets dos targets existentes
    const targetSubnets = new Set();
    for (const t of expandedTargets) {
      const parts = String(t.address || '').split('.');
      if (parts.length === 4) {
        targetSubnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
      }
    }
    for (const cidr of targetSubnets) {
      try {
        const alive = await sweepSubnet(cidr, { maxParallel: 30 });
        pingAliveHosts.push(...alive);
        for (const h of alive) {
          // Registra como finding (não como asset completo - o scan TCP vai classificar)
          await saveFindings(db, run.id, tenant, {
            type: 'icmp_host_discovered',
            severity: 'info',
            source: 'ping-sweep',
            asset_key: `ip:${h.host}`,
            payload: { host: h.host, latency_ms: h.latency_ms, method: 'icmp' },
          });
        }
      } catch (e) {
        log('warn', 'Ping sweep failed for subnet', { cidr, err: e.message });
      }
    }
    report({ stage: 'ping_sweep', status: 'done', icmp_alive: pingAliveHosts.length });
  }

  // ── Subnet Auto-Discovery (Enterprise) ────────────────────────────────────
  // Desabilitado em Docker (persiste CIDRs que explodem), habilitado em bare-metal.
  const isDockerSubnet = isDockerEnvironment();
  const subnetDiscoveryEnabled = input.subnet_discovery_enabled === true || !isDockerSubnet;
  report({
    stage: 'subnet_discovery',
    status: subnetDiscoveryEnabled ? 'running' : 'skipped',
    docker_detected: isDockerSubnet,
    reason: isDockerSubnet
      ? 'Docker detectado — subnet auto-discovery desabilitado'
      : 'Bare-metal detectado — subnet auto-discovery habilitado',
  });
  let discoveredSubnets = [];
  if (subnetDiscoveryEnabled) {
    try {
      const result = await discoverAllSubnets(assets);
      discoveredSubnets = result.merged;
      for (const subnet of discoveredSubnets) {
        await saveFindings(db, run.id, tenant, {
          type: 'subnet_discovered',
          severity: 'info',
          source: 'subnet-auto',
          asset_key: `subnet:${subnet.cidr}`,
          payload: { cidr: subnet.cidr, source: subnet.source },
        });
        // Registra como target automatico para scans futuros
        await db.query(
          `INSERT INTO observe_discovery_targets
            (id, tenant_id, site_id, edge_id, discovery_type, address, label, enabled, metadata)
           VALUES (gen_random_uuid(),$1,$2,$3,'cidr',$4,$5,true,$6)
           ON CONFLICT (tenant_id, site_id, edge_id, discovery_type, address) DO NOTHING`,
          [tenant.tenant_id, tenant.site_id, tenant.edge_id, subnet.cidr,
           `auto-discovered: ${subnet.source}`,
           JSON.stringify({ auto_discovered: true, source: subnet.source })]
        );
      }
    } catch (e) {
      log('warn', 'Subnet auto-discovery failed', { err: e.message });
    }
    report({ stage: 'subnet_discovery', status: 'done', subnets_found: discoveredSubnets.length });
  }

  // ── IPv6 Discovery ─────────────────────────────────────────────────────
  const ipv6Enabled = input.ipv6_enabled === true || process.env.DISCOVERY_IPV6_ENABLED === 'true';
  report({ stage: 'ipv6', status: ipv6Enabled ? 'running' : 'skipped' });
  if (ipv6Enabled) {
    try {
      const ipv6Subnets = await discoverIPv6Subnets();
      const ndpEntries = await discoverNdpTable();
      for (const entry of ndpEntries) {
        await saveFindings(db, run.id, tenant, {
          type: 'ipv6_ndp_discovered',
          severity: 'info',
          source: 'ipv6-ndp',
          asset_key: `ipv6:${entry.ip}`,
          payload: { ip: entry.ip, mac: entry.mac, state: entry.state },
        });
      }
      for (const subnet of ipv6Subnets) {
        // Sweep apenas prefixos /120 ou maiores
        const hosts = expandIPv6Prefix(subnet.cidr);
        if (hosts.length > 0 && hosts.length <= 64) {
          const alive = await ping6Sweep(hosts, { maxParallel: 20 });
          for (const h of alive) {
            const scan = await activeScan6(h.host);
            if (scan.alive && scan.open_ports.length > 0) {
              const row = {
                ...tenant,
                asset_key: `ipv6:${h.host}`,
                asset_name: scan.hostname || `host-${h.host.replace(/:/g, '-').slice(0, 30)}`,
                display_name: scan.hostname || h.host.slice(0, 30),
                primary_ip: h.host,
                hostname: scan.hostname,
                asset_type: 'host',
                vendor: null,
                product: null,
                confidence: 0.5,
                criticality: 'medium',
                metadata: { ipv6: true, scan, lifecycle: 'discovered' },
              };
              const asset = await upsertAsset(db, row);
              assets.push({ ...asset, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: row.asset_name, primary_ip: row.primary_ip, services: [] });
              await saveFindings(db, run.id, tenant, {
                type: 'ipv6_host_discovered',
                severity: 'info',
                source: 'ipv6-scan',
                asset_key: `ipv6:${h.host}`,
                payload: { host: h.host, ports: scan.open_ports, hostname: scan.hostname },
              });
            }
          }
        }
      }
    } catch (e) {
      log('warn', 'IPv6 discovery failed', { err: e.message });
    }
    report({ stage: 'ipv6', status: 'done', ndp_entries: 0, ipv6_subnets: 0 });
  }

  // ── Windows / SMB Discovery ─────────────────────────────────────────────
  const windowsEnabled = input.windows_enabled === true || process.env.DISCOVERY_WINDOWS_ENABLED === 'true';
  report({ stage: 'windows', status: windowsEnabled ? 'running' : 'skipped' });
  if (windowsEnabled) {
    try {
      const windowsTargets = expandedTargets.filter(t => !String(t.address).includes(':'));
      let winCount = 0;
      for (const t of windowsTargets.slice(0, 100)) {
        const result = await scanWindowsHost(t.address);
        if (result.is_windows) {
          winCount++;
          const row = {
            ...tenant,
            asset_key: `ip:${t.address}`,
            asset_name: result.hostname || `windows-${t.address}`,
            display_name: result.hostname || t.address,
            primary_ip: t.address,
            hostname: result.hostname,
            asset_type: 'host',
            vendor: 'Microsoft',
            product: result.os_version || 'Windows',
            os_hint: result.os_version || 'Windows',
            confidence: 0.75,
            criticality: result.domain ? 'high' : 'medium',
            metadata: { windows: result, lifecycle: 'discovered' },
          };
          const asset = await upsertAsset(db, row);
          assets.push({ ...asset, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: row.asset_name, primary_ip: row.primary_ip, services: [] });
          await saveFindings(db, run.id, tenant, {
            type: 'windows_host_discovered',
            severity: 'info',
            source: 'windows-smb',
            asset_key: `ip:${t.address}`,
            payload: { ...result, smb: !!result.smb, netbios: !!result.netbios, rdp: !!result.rdp },
          });
        }
      }
    } catch (e) {
      log('warn', 'Windows discovery failed', { err: e.message });
    }
    report({ stage: 'windows', status: 'done', windows_hosts: 0 });
  }

  // ── Kubernetes Discovery ────────────────────────────────────────────────
  const k8sEnabled = input.k8s_enabled === true || process.env.DISCOVERY_K8S_ENABLED === 'true';
  report({ stage: 'k8s', status: k8sEnabled ? 'running' : 'skipped' });
  if (k8sEnabled) {
    try {
      const available = await isKubectlAvailable();
      if (available) {
        const k8s = await discoverKubernetes();
        for (const node of k8s.nodes) {
          await saveFindings(db, run.id, tenant, {
            type: 'k8s_node_discovered',
            severity: 'info',
            source: 'k8s',
            asset_key: `k8s:node:${node.name}`,
            payload: node,
          });
          if (node.internal_ip) {
            const row = {
              ...tenant,
              asset_key: `ip:${node.internal_ip}`,
              asset_name: node.name,
              display_name: `k8s-node:${node.name}`,
              primary_ip: node.internal_ip,
              hostname: node.name,
              asset_type: 'host',
              vendor: 'Kubernetes',
              product: `Node (${node.os || 'Linux'})`,
              os_hint: node.os,
              confidence: 0.8,
              metadata: { k8s: node, lifecycle: 'discovered' },
            };
            const asset = await upsertAsset(db, row);
            assets.push({ ...asset, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: row.asset_name, primary_ip: row.primary_ip, services: [] });
          }
        }
        for (const svc of k8s.services) {
          await saveFindings(db, run.id, tenant, {
            type: 'k8s_service_discovered',
            severity: 'info',
            source: 'k8s',
            asset_key: `k8s:svc:${svc.namespace}:${svc.name}`,
            payload: svc,
          });
        }
        for (const pod of k8s.pods) {
          if (pod.pod_ip) {
            await saveFindings(db, run.id, tenant, {
              type: 'k8s_pod_discovered',
              severity: 'info',
              source: 'k8s',
              asset_key: `ip:${pod.pod_ip}`,
              payload: pod,
            });
          }
        }
      }
    } catch (e) {
      log('warn', 'Kubernetes discovery failed', { err: e.message });
    }
    report({ stage: 'k8s', status: 'done', k8s_nodes: 0 });
  }

  // ── Cloud APIs ──────────────────────────────────────────────────────────
  const cloudEnabled = input.cloud_enabled === true || process.env.DISCOVERY_CLOUD_ENABLED === 'true';
  report({ stage: 'cloud', status: cloudEnabled ? 'running' : 'skipped' });
  if (cloudEnabled) {
    try {
      const cloudResources = await discoverCloudResources();
      for (const res of cloudResources) {
        const assetKey = `${res.cloud}:${res.service}:${res.instance_id || res.name}`;
        await saveFindings(db, run.id, tenant, {
          type: 'cloud_resource_discovered',
          severity: 'info',
          source: `cloud-${res.cloud}`,
          asset_key: assetKey,
          payload: res,
        });
        if (res.private_ip) {
          const row = {
            ...tenant,
            asset_key: assetKey,
            asset_name: res.name || res.instance_id,
            display_name: `${res.cloud}/${res.service}: ${res.name || res.instance_id}`,
            primary_ip: res.private_ip,
            hostname: res.name || null,
            asset_type: res.service === 'rds' ? 'database' : 'host',
            vendor: res.cloud.toUpperCase(),
            product: `${res.service} ${res.instance_type || res.instance_class || ''}`.trim(),
            confidence: 0.7,
            metadata: { cloud: res, lifecycle: 'discovered' },
          };
          const asset = await upsertAsset(db, row);
          assets.push({ ...asset, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: row.asset_name, primary_ip: row.primary_ip, services: [] });
        }
      }
    } catch (e) {
      log('warn', 'Cloud discovery failed', { err: e.message });
    }
    report({ stage: 'cloud', status: 'done', cloud_resources: 0 });
  }

  // ── VMware vSphere ──────────────────────────────────────────────────────
  const vmwareEnabled = process.env.DISCOVERY_VMWARE_ENABLED === 'true';
  report({ stage: 'vmware', status: vmwareEnabled ? 'running' : 'skipped' });
  if (vmwareEnabled) {
    try {
      const vmwareResources = await discoverVMware();
      for (const res of vmwareResources) {
        await saveFindings(db, run.id, tenant, {
          type: 'vmware_resource_discovered',
          severity: 'info',
          source: 'vmware-vsphere',
          asset_key: `vmware:${res.name}`,
          payload: res,
        });
      }
      report({ stage: 'vmware', status: 'done', vmware_resources: vmwareResources.length });
    } catch (e) {
      log('warn', 'VMware discovery failed', { err: e.message });
      report({ stage: 'vmware', status: 'error' });
    }
  }

  // ── Proxmox VE ─────────────────────────────────────────────────────────
  const proxmoxEnabled = process.env.DISCOVERY_PROXMOX_ENABLED === 'true';
  report({ stage: 'proxmox', status: proxmoxEnabled ? 'running' : 'skipped' });
  if (proxmoxEnabled) {
    try {
      const proxmoxResources = await discoverProxmox();
      for (const res of proxmoxResources) {
        await saveFindings(db, run.id, tenant, {
          type: 'proxmox_resource_discovered',
          severity: 'info',
          source: 'proxmox-ve',
          asset_key: `proxmox:${res.name}`,
          payload: res,
        });
      }
      report({ stage: 'proxmox', status: 'done', proxmox_resources: proxmoxResources.length });
    } catch (e) {
      log('warn', 'Proxmox discovery failed', { err: e.message });
      report({ stage: 'proxmox', status: 'error' });
    }
  }

  // ── LLDP/CDP Active ───────────────────────────────────────────────────
  const lldpEnabled = input.lldp_enabled === true || process.env.DISCOVERY_LLDP_ENABLED === 'true';
  report({ stage: 'lldp_cdp', status: lldpEnabled ? 'running' : 'skipped' });
  if (lldpEnabled) {
    try {
      const lldpNeighbors = await discoverLldpCdp();
      for (const n of lldpNeighbors) {
        await saveFindings(db, run.id, tenant, {
          type: 'lldp_neighbor_discovered',
          severity: 'info',
          source: 'lldp-active',
          asset_key: `lldp:${n.chassis_id?.value || n.source_mac || 'unknown'}`,
          payload: n,
        });

        // Enriquecer asset local com vizinho LLDP na interface correspondente
        if (n.local_interface || n.source_mac) {
          const localAsset = assets.find(a =>
            a.primary_ip && (n.management_addresses || []).includes(a.primary_ip) === false
          );
          // Buscar asset do host local (onde o LLDP foi capturado)
          const hostAsset = assets.find(a => a.metadata?.is_localhost || a.asset_type === 'local_host');
          if (hostAsset) {
            hostAsset.metadata = hostAsset.metadata || {};
            hostAsset.metadata.lldp_neighbors = hostAsset.metadata.lldp_neighbors || [];
            hostAsset.metadata.lldp_neighbors.push({
              local_interface: n.local_interface || null,
              chassis_id: n.chassis_id?.value || null,
              chassis_name: n.chassis_name || null,
              port_id: n.port_id?.value || n.port_description || null,
              system_name: n.system_name || null,
              management_addresses: n.management_addresses || [],
              protocol: n.protocol || 'lldp',
              source_mac: n.source_mac || null,
            });
          }
        }

        if (n.management_addresses?.length) {
          for (const ip of n.management_addresses) {
            await saveFindings(db, run.id, tenant, {
              type: 'lldp_managed_device',
              severity: 'info',
              source: 'lldp-active',
              asset_key: `ip:${ip}`,
              payload: { ip, chassis: n.chassis_name || n.chassis_id?.value, protocol: n.protocol },
            });
          }
        }
      }
      report({ stage: 'lldp_cdp', status: 'done', lldp_neighbors: lldpNeighbors.length });
    } catch (e) {
      log('warn', 'LLDP/CDP active discovery failed', { err: e.message });
      report({ stage: 'lldp_cdp', status: 'done', lldp_neighbors: 0 });
    }
  }

  // ── Bluetooth/BLE ─────────────────────────────────────────────────────
  const btEnabled = input.bluetooth_enabled === true || process.env.DISCOVERY_BLUETOOTH_ENABLED === 'true';
  report({ stage: 'bluetooth', status: btEnabled ? 'running' : 'skipped' });
  if (btEnabled) {
    try {
      const btDevices = await discoverBluetooth();
      for (const dev of btDevices) {
        await saveFindings(db, run.id, tenant, {
          type: 'bluetooth_device_discovered',
          severity: 'info',
          source: 'bluetooth',
          asset_key: `bt:${dev.mac}`,
          payload: dev,
        });
        const row = {
          ...tenant,
          asset_key: `bt:${dev.mac}`,
          asset_name: dev.name || dev.mac,
          display_name: dev.name || `BT ${dev.mac.slice(-5)}`,
          primary_ip: null,
          hostname: dev.name,
          asset_type: dev.device_type || 'iot',
          vendor: dev.vendor,
          product: dev.name,
          confidence: 0.6,
          metadata: { bluetooth: dev, lifecycle: 'discovered' },
        };
        const asset = await upsertAsset(db, row);
        assets.push({ ...asset, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: row.asset_name, primary_ip: null, services: [] });
      }
    } catch (e) {
      log('warn', 'Bluetooth discovery failed', { err: e.message });
    }
    report({ stage: 'bluetooth', status: 'done', bt_devices: 0 });
  }

  // ── Industrial Protocols ───────────────────────────────────────────────
  const industrialEnabled = input.industrial_enabled === true || process.env.DISCOVERY_INDUSTRIAL_ENABLED === 'true';
  report({ stage: 'industrial', status: industrialEnabled ? 'running' : 'skipped' });
  if (industrialEnabled) {
    try {
      const industrialTargets = expandedTargets.filter(t => !String(t.address).includes(':'));
      for (const t of industrialTargets.slice(0, 100)) {
        const results = await scanIndustrialHost(t.address, { timeout: 2000 });
        for (const r of results) {
          await saveFindings(db, run.id, tenant, {
            type: 'industrial_protocol_detected',
            severity: 'info',
            source: `industrial-${r.protocol}`,
            asset_key: `ip:${t.address}`,
            payload: r,
          });
          if (!assets.find(a => a.primary_ip === t.address && a.metadata?.industrial)) {
            const row = {
              ...tenant,
              asset_key: `ip:${t.address}`,
              asset_name: `industrial-${t.address}`,
              display_name: `${r.protocol.toUpperCase()} @ ${t.address}`,
              primary_ip: t.address,
              asset_type: r.protocol === 'bacnet-ip' ? 'iot' : 'network_device',
              vendor: industrialVendor(r.protocol),
              product: r.protocol,
              confidence: 0.65,
              metadata: { industrial: results, lifecycle: 'discovered' },
            };
            const asset = await upsertAsset(db, row);
            assets.push({ ...asset, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: row.asset_name, primary_ip: row.primary_ip, services: [] });
          }
        }
      }
    } catch (e) {
      log('warn', 'Industrial protocol discovery failed', { err: e.message });
    }
    report({ stage: 'industrial', status: 'done' });
  }

  // ── SNMP Sweep — descobre hosts SNMP-only e coleta sysDescr/OS ─────────
  const snmpEnabled = input.snmp_enabled !== false 
    && (policy?.metadata?.snmp_enabled === true || policy?.metadata?.snmp_enabled === 'true' || process.env.DISCOVERY_SNMP_ENABLED === 'true');
  report({ stage: 'snmp', status: snmpEnabled ? 'running' : 'skipped' });
  let snmpScanned = 0;
  if (snmpEnabled) {
    const community = policy?.metadata?.snmp_community || process.env.SNMP_COMMUNITY || 'public';
    // Coleta subnets unicas dos targets expandidos
    const snmpSubnets = new Set();
    for (const t of expandedTargets) {
      const parts = String(t.address || '').split('.');
      if (parts.length === 4) snmpSubnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.0/24`);
    }
    // Tambem adiciona subnets de targets CIDR
    for (const t of targets) {
      const addr = String(t.address || t || '');
      if (addr.includes('/')) snmpSubnets.add(addr);
    }

    for (const cidr of snmpSubnets) {
      const parts = cidr.split('/')[0].split('.');
      if (parts.length !== 4) continue;
      const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const prefixLen = parseInt(cidr.split('/')[1] || '24', 10);
      // Limitar a /24 para performance
      if (prefixLen < 24) continue;
      const start = prefixLen === 32 ? parseInt(parts[3], 10) : 1;
      const end = prefixLen === 32 ? parseInt(parts[3], 10) : 254;

      // SNMP sweep em lotes de 10 IPs
      for (let i = start; i <= end; i += 10) {
        const batch = [];
        for (let j = i; j < i + 10 && j <= end; j++) {
          const ip = `${base}.${j}`;
          // Pula se ja existe no assets
          if (assets.some(a => a.primary_ip === ip)) continue;
          batch.push(ip);
        }
        if (batch.length === 0) continue;

        const results = await Promise.allSettled(
          batch.map(ip => snmpDeepDiscover(ip, { community }))
        );

        for (let k = 0; k < batch.length; k++) {
          const ip = batch[k];
          const result = results[k];
          if (result.status !== 'fulfilled' || !result.value?.reachable) continue;
          snmpScanned++;

          const snmp = result.value;
          const sysDescr = snmp.sysDescr || '';
          const osClass = snmp.classification || {};
          const osHint = osClass.os || (sysDescr.includes('Linux') ? 'Linux' : sysDescr.includes('Windows') ? 'Windows' : null);

          const snmpRow = {
            ...tenant,
            asset_key: `ip:${ip}`,
            asset_name: snmp.sysName || `snmp-${ip.replace(/\./g, '-')}`,
            display_name: snmp.sysName || ip,
            primary_ip: ip,
            hostname: snmp.sysName || null,
            asset_type: 'host',
            vendor: osClass.vendor || null,
            product: osClass.os || osHint || null,
            os_hint: osHint,
            confidence: 0.7,
            criticality: 'medium',
            metadata: { snmp: { sysDescr, sysObjectID: snmp.sysObjectID, sysName: snmp.sysName, sysContact: snmp.sysContact, sysLocation: snmp.sysLocation, interfaces: (snmp.interfaces || []).length, os_class: osClass }, lifecycle: 'discovered' },
          };

          const saved = await upsertAsset(db, snmpRow);
          assets.push({ ...saved, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id, asset_name: snmpRow.asset_name, primary_ip: ip, services: [] });
          await saveFindings(db, run.id, tenant, { type: 'snmp_host_discovered', severity: 'info', source: 'snmp-sweep', asset_key: `ip:${ip}`, payload: { ip, sysDescr, sysName: snmp.sysName, osHint } });
        }
      }
    }
    report({ stage: 'snmp', status: 'done', snmp_scanned: snmpScanned });
  }

  // ── Enriquecer assets existentes com dados SNMP ────────────────────────
  for (const asset of assets) {
    if (!asset.primary_ip || asset.metadata?.snmp) continue;
    // Pula Docker bridge IPs que nao estao em 10.10.2.x
    if (!asset.primary_ip.startsWith('10.10.2.')) continue;
    if (asset.os_hint) continue;

    try {
      const community = process.env.SNMP_COMMUNITY || 'public';
      const snmp = await snmpDeepDiscover(asset.primary_ip, { community });
      if (snmp?.reachable && snmp?.sysDescr) {
        const sysDescr = snmp.sysDescr || '';
        const osClass = snmp.classification || {};
        const osHint = osClass.os || (sysDescr.includes('Linux') ? 'Linux' : sysDescr.includes('Windows') ? 'Windows' : null);

        await db.query(
          `UPDATE observe_assets
           SET os_hint = COALESCE($2, os_hint), vendor = COALESCE($3, vendor), product = COALESCE($4, product),
               metadata = metadata || '{}'::jsonb, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $5 AND site_id = $6 AND edge_id = $7`,
          [asset.id, osHint, osClass.vendor || null, osClass.os || osHint || null,
            tenant.tenant_id, tenant.site_id, tenant.edge_id]
        );
        asset.os_hint = osHint || asset.os_hint;
        asset.vendor = osClass.vendor || asset.vendor;
        asset.product = osClass.os || osHint || asset.product;
        asset.metadata = { ...(asset.metadata || {}), snmp: { sysDescr, sysObjectID: snmp.system.sysObjectID, os_class: osClass } };

        await saveFindings(db, run.id, tenant, { type: 'snmp_enriched', severity: 'info', source: 'snmp-sweep', asset_key: asset.asset_key, payload: { ip: asset.primary_ip, sysDescr, osHint } });
      }
    } catch (_) { /* SNMP pode falhar, segue */ }
  }

  report({ stage: 'topology', status: 'running' });
  const edges = buildTopologyEdges(run.id, assets);
  for (const e of edges) {
    await db.query(
      `INSERT INTO observe_topology_edges
        (id, tenant_id, site_id, edge_id, run_id, from_asset_id, to_asset_ref, edge_type, protocol, source, confidence, evidence, last_seen, observed_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       ON CONFLICT (tenant_id, site_id, edge_id, from_asset_id, to_asset_ref, edge_type, protocol)
       DO UPDATE SET observed_at = NOW(), source = EXCLUDED.source,
                     confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence, last_seen = NOW()`,
      [tenant.tenant_id, tenant.site_id, tenant.edge_id, run.id,
       e.from_asset_id, e.to_asset_ref, e.edge_type, e.protocol, e.source,
       e.confidence ?? 0.5, JSON.stringify(e.evidence ?? [])]
    );
  }

  report({ stage: 'topology', status: 'done', topology_edges: edges.length });

  if (neo4jEnabled()) {
    try {
      await writeNeo4jGraph({ tenant, runId: run.id, assets, edges });
      await emitEvent(redis, 'observe.discovery.graph.updated', { run_id: run.id, ...tenant, nodes: assets.length, edges: edges.length });
    } catch (e) {
      await saveFindings(db, run.id, tenant, {
        type: 'neo4j_write_error',
        severity: 'warning',
        source: 'neo4j',
        asset_key: 'neo4j:graph',
        payload: { message: e.message },
      });
    }
  }

  report({ stage: 'prometheus_sd', status: policy.auto_prometheus_sd ? 'running' : 'skipped' });
  let sd = { path: null, total: 0 };
  if (policy.auto_prometheus_sd) {
    try {
      sd = await writeFileSd(assets);
    } catch (e) {
      await saveFindings(db, run.id, tenant, {
        type: 'prometheus_sd_write_error',
        severity: 'warning',
        source: 'prometheus-sd',
        asset_key: 'prometheus:http-sd',
        payload: { message: e.message },
      });
      await emitEvent(redis, 'observe.discovery.prometheus_sd_error', {
        run_id: run.id,
        ...tenant,
        message: e.message,
      });
    }
  }

  report({ stage: 'prometheus_sd', status: 'done' });

  report({ stage: 'icinga', status: policy.auto_icinga_sync ? 'running' : 'skipped' });
  if (policy.auto_icinga_sync) {
    try {
      const sync = await syncDiscoveredToIcinga({ tenant, assets, edges });
      metrics.icingaSyncTotal.inc({ status: 'success' });
      metrics.icingaHostsSynced.set(sync.synced || 0);
      metrics.icingaServicesSynced.set(sync.services_synced || 0);
      await emitEvent(redis, 'observe.discovery.icinga_sync_completed', {
        run_id: run.id,
        ...tenant,
        synced: sync.synced,
        services_synced: sync.services_synced || 0,
        staged: sync.staged,
        deployed: sync.deployed,
        host_stale: sync.reconcile?.hosts?.stale || 0,
        host_removed: sync.reconcile?.hosts?.removed || 0,
        svc_stale: sync.reconcile?.services?.stale || 0,
        svc_removed: sync.reconcile?.services?.removed || 0,
        group_stale: sync.reconcile?.groups?.stale || 0,
        group_removed: sync.reconcile?.groups?.removed || 0,
      });
    } catch (e) {
      metrics.icingaSyncTotal.inc({ status: 'error' });
      await saveFindings(db, run.id, tenant, {
        type: 'icinga_sync_error',
        severity: 'warning',
        source: 'icinga',
        asset_key: 'icinga:sync',
        payload: { message: e.message },
      });
      await emitEvent(redis, 'observe.discovery.icinga_error', {
        run_id: run.id,
        ...tenant,
        message: e.message,
      });
    }
  } else {
    metrics.icingaSyncTotal.inc({ status: 'skipped' });
  }

  report({ stage: 'icinga', status: 'done' });

	  const summary = { scanned_targets: scanned, failed_targets: targetFailures, blocked_targets: blockedTargets, discovered_assets: assets.length, topology_edges: edges.length, file_sd_targets: sd.total };
  await completeRun(db, run.id, tenant, 'completed', summary);

  // Update gauges
  metrics.scanTargetsTotal.set(targets.length);
  metrics.scanDiscoveredTotal.set(assets.length);
  metrics.scanTopologyEdges.set(edges.length);

  report({ stage: 'done', status: 'done', summary });

  if (targets.length === 0) {
    log('warn', 'Discovery run completed without targets', { run_id: run.id, tenant_id: tenant.tenant_id, site_id: tenant.site_id, edge_id: tenant.edge_id });
	  } else if (blockedTargets > 0 && expandedTargets.length === 0) {
	    log('warn', 'Discovery run completed with all targets blocked by policy', {
	      run_id: run.id,
	      tenant_id: tenant.tenant_id,
	      site_id: tenant.site_id,
	      edge_id: tenant.edge_id,
	      total_targets: targets.length,
	      blocked_targets: blockedTargets,
	    });
  }

  await emitEvent(redis, 'observe.discovery.topology.updated', { run_id: run.id, ...tenant, edges: edges.length });
  await emitEvent(redis, 'observe.discovery.completed', { run_id: run.id, ...tenant, summary });

  if (redis) {
    const resultEvt = JSON.stringify({
      type: 'scan:results',
      queue_job_id: input.queue_job_id || null,
      run_id: run.id,
      tenant_id: tenant.tenant_id,
      site_id: tenant.site_id,
      edge_id: tenant.edge_id,
      hosts: scanResults,
      created_at: new Date().toISOString(),
    });
    await redis.rpush('observe:scan:results', resultEvt);
    await redis.publish('observe:scan:results', resultEvt);
  }

  log('info', 'Discovery run completed', { run_id: run.id, total_targets: targets.length, blocked_targets: blockedTargets, ...summary });

  if (isDebug()) {
    endTrace(traceId, {
      run_id: run.id,
      total_targets: targets.length,
      scanned,
      blocked: blockedTargets,
      discovered: assets.length,
      edges: edges.length,
      status: 'completed',
    });
  }

  return { run_id: run.id, summary };
  } catch (e) {
    if (isDebug()) {
      debug(`discovery:error ${e.message}`, { trace_id: traceId, error: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
      endTrace(traceId, { status: 'error', error: e.message });
    }
    const summary = { error: e.message, stage: _safeStage(onProgress) };
    if (run?.id) {
      try {
        await completeRun(db, run.id, tenant, 'failed', summary);
        await saveFindings(db, run.id, tenant, {
          type: 'discovery_run_failed',
          severity: 'error',
          source: 'discovery-engine',
          asset_key: 'run',
          payload: summary,
        });
      } catch (persistErr) {
        log('error', 'Failed to persist discovery failure state', { run_id: run.id, err: persistErr.message });
      }
      await emitEvent(redis, 'observe.discovery.failed', { run_id: run.id, ...tenant, summary });
    }
    report({ stage: 'done', status: 'error', summary });
    log('error', 'Discovery run failed', { run_id: run?.id || null, err: e.message });
    throw e;
  }
}

function _safeStage() {
  return 'unknown';
}

/**
 * Detecta se estamos rodando dentro de um container Docker.
 * Em Docker, a auto-descoberta de CIDRs é desabilitada
 * porque multi-rede gera subnets /16 que explodem o scan.
 */
function isDockerEnvironment() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch (_) {}
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/docker/i.test(cgroup)) return true;
  } catch (_) {}
  return false;
}

module.exports = { runDiscovery, detectPortChanges };
