'use strict';

const { lookupMacVendor } = require('../fingerprint/oui');
const { resolveFromMdnsServices, lookupSsdpServer } = require('../fingerprint/mdns-db');
const { debug, debugTable, debugObject, isDebug } = require('../utils/logger');
const kb = require('../knowledge/loader');
const { probeToEvidence } = require('../scanners/deep-probe');

const UNKNOWN_VENDOR = 'Não identificado';
const UNKNOWN_PRODUCT = 'Sem sinal de serviço';
const GENERIC_PRODUCTS = new Set([
  'HTTP Service',
  'HTTPS Service',
  'RTSP Service',
  'SIP Endpoint',
  'Database Service',
  'Observability Service',
  'Network Device',
  'IoT Device',
  'Host',
]);

const INFERENCE_REGISTRY = kb.getRules();
const THRESHOLDS = kb.getThresholds();
const TEXT_PATTERNS = () => kb.getTextPatterns(); // lazy — recarrega a cada uso

function getPortHints() {
  return kb.getPortHints();
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n));
}

function makeEvidence(type, source, confidence, raw, normalized) {
  return {
    evidence_type: type,
    evidence_source: source,
    confidence: clamp(confidence),
    raw_data: raw ?? null,
    normalized_data: normalized || {},
    timestamp: nowIso(),
  };
}

function asTextParts(input) {
  return [
    ['http_header', 'active-http', input.http_server],
    ['http_title', 'active-http', input.http_title],
    ['snmp_sysdescr', 'active-snmp', input.snmp_sysdescr],
    ['tls_certificate', 'active-tls', input.tls_subject],
    ['tls_certificate', 'active-tls', input.tls_issuer],
    ['ssh_banner', 'active-ssh', input.ssh_banner],
    ['service_banner', 'active-smtp', input.smtp_banner],
    ['service_banner', 'active-sip', input.sip_user_agent || input.sip_probe?.user_agent || input.sip_probe?.server],
    ['service_banner', 'active-rtsp', input.rtsp_banner || input.rtsp_probe?.server],
    ['reverse_dns', 'dns', input.hostname],
    ['onvif_device_info', 'active-onvif', input.onvif_model || input.onvif_probe?.model || input.onvif_probe?.manufacturer],
  ].filter(([, , value]) => value);
}

function patternSignals(value) {
  const out = [];
  for (const pattern of TEXT_PATTERNS()) {
    if (pattern.re.test(String(value || ''))) out.push({
      vendor: pattern.vendor || null,
      product: pattern.product,
      technology: pattern.technology,
      category: pattern.category,
    });
  }
  return out;
}

function extractTopologyEvidence(input) {
  const topology = input.topology || {};
  const evidence = [];
  const flags = [];
  if (topology.poe === true || topology.power === 'poe') flags.push('poe');
  if (topology.edge_port === true || topology.port_role === 'edge') flags.push('edge_port');
  if (String(topology.vlan_role || topology.vlan || '').toLowerCase().includes('voice')) flags.push('voice_vlan');
  if (topology.gateway === true) flags.push('gateway');
  if (topology.uplink === true || topology.port_role === 'uplink') flags.push('uplink');

  // Suporte a flags do normalizer: is_gateway / is_localhost
  if (input.is_gateway === true) {
    if (!flags.includes('gateway')) flags.push('gateway');
    // Se não existe evidência topology_context com gateway, criar
    const hasGatewayEvidence = evidence.some(e =>
      e.evidence_type === 'topology_context' &&
      (e.normalized_data?.topology_flags || []).includes('gateway')
    );
    if (!hasGatewayEvidence) {
      evidence.push(makeEvidence('topology_context', 'gateway-detector', 0.95,
        { ip: input.ip || input.address, role: 'default_gateway' },
        { topology_flags: ['gateway'], role: 'default_gateway' }
      ));
    }
  }

  if (input.is_localhost === true) {
    if (!flags.includes('localhost')) flags.push('localhost');
    const hasLocalhostEvidence = evidence.some(e =>
      e.evidence_type === 'topology_context' &&
      (e.normalized_data?.topology_flags || []).includes('localhost')
    );
    if (!hasLocalhostEvidence) {
      evidence.push(makeEvidence('topology_context', 'localhost-detector', 0.99,
        { ip: input.ip || input.address, role: 'scanner' },
        { topology_flags: ['localhost'], role: 'scanner' }
      ));
    }
  }

  if (flags.length) {
    evidence.push(makeEvidence('topology_context', 'topology', 0.68, topology, { topology_flags: flags }));
  }
  for (const n of topology.lldp_neighbors || []) {
    evidence.push(makeEvidence('lldp_neighbor', 'topology-lldp', 0.72, n, { neighbor: n, topology_flags: flags }));
  }
  return evidence;
}

function extractHistoricalEvidence(input) {
  const history = input.history || input.historical || null;
  if (!history) return [];
  const stable = [];
  if (history.asset_key_match || history.mac_match) stable.push('asset_key');
  if (history.tls_sha256_match || history.cert_match) stable.push('certificate');
  if (history.fingerprint_match) stable.push('fingerprint');
  if (history.previous_asset_type || history.previous_technology) stable.push('previous_classification');
  if (!stable.length) return [];
  const age = Number(history.age_days ?? history.last_seen_days ?? 0);
  const decay = clamp(1 - (age / 90), 0.25, 1);
  return [makeEvidence('historical_identity', 'asset-history', 0.78 * decay, history, {
    stable_identifiers: stable,
    previous_asset_type: history.previous_asset_type || null,
    previous_technology: history.previous_technology || null,
    confidence_decay: Number((1 - decay).toFixed(3)),
  })];
}

function extractPassiveEvidence(input) {
  const events = input.passive_events || input.passive || [];
  const list = Array.isArray(events) ? events : [events];
  const evidence = [];
  for (const evt of list.filter(Boolean)) {
    const type = String(evt.type || evt.source || 'passive_signal').toLowerCase();
    const text = [evt.hostname, evt.protocol, evt.message, evt.payload?.message, evt.payload?.raw].filter(Boolean).join(' ');
    const signals = patternSignals(text);
    const services = evt.mdns_services || evt.payload?.mdns_services || [];
    for (const svc of services) {
      const match = resolveFromMdnsServices([svc]);
      if (match) evidence.push(makeEvidence('mdns_service', 'passive-mdns', 0.82, svc, match));
    }
    if (type.includes('mdns')) evidence.push(makeEvidence('passive_behavior', 'passive-mdns', 0.55, evt, { signals }));
    if (type.includes('ssdp')) evidence.push(makeEvidence('ssdp_response', 'passive-ssdp', 0.72, evt, { signals }));
    if (type.includes('dhcp')) evidence.push(makeEvidence('passive_behavior', 'passive-dhcp', 0.55, evt, { hostname: evt.hostname || null, signals }));
    if (type.includes('arp')) evidence.push(makeEvidence('passive_behavior', 'passive-arp', 0.5, evt, { mac: evt.mac || null }));
  }
  return evidence;
}

/**
 * Normaliza um port entry para número (compatível com formato antigo e novo).
 */
function portNumber(p) {
  if (typeof p === 'number') return p;
  if (typeof p === 'object' && p !== null) return p.port || 0;
  return 0;
}

/**
 * Extrai evidências de portas abertas (suporta formato plano e objetos).
 */
function extractPortEvidence(input) {
  const evidence = [];
  const PORT_HINTS = getPortHints();

  // Open ports (suporta tanto array de números quanto array de objetos)
  const openPorts = input.open_ports || [];
  const seenPorts = new Set();

  for (const p of openPorts) {
    const port = portNumber(p);
    if (!port || seenPorts.has(port)) continue;
    seenPorts.add(port);

    const hint = PORT_HINTS[port] || { technology: 'unknown', category: 'unknown', product: `port-${port}` };
    const hintConfidence = 0.12;
    const protocol = typeof p === 'object' ? (p.protocol || 'tcp') : ([53, 67, 68, 123, 161, 5060].includes(port) ? 'udp' : 'tcp');
    const service = typeof p === 'object' ? (p.service || null) : null;

    evidence.push(makeEvidence(
      protocol === 'udp' ? 'udp_open_port' : 'tcp_open_port',
      'active-scan',
      hintConfidence,
      { port, protocol, service, state: 'open' },
      { port, protocol, signal_strength: 'weak', service, ...hint }
    ));

    // Porta 8009 AJP = evidência forte de Tomcat/Java (fingerprint específico, não porta genérica)
    if (port === 8009) {
      evidence.push(makeEvidence('text_fingerprint', 'port-inference', 0.72,
        { port: 8009, service: 'ajp13' },
        { product: 'Apache Tomcat AJP Connector', technology: 'tomcat', category: 'application', vendor: 'Apache Software Foundation' }
      ));
    }

    // Portas 8008 + 8443 combinadas sugerem Tomcat (fingerprint específico)
    if (port === 8008) {
      evidence.push(makeEvidence('text_fingerprint', 'port-inference', 0.60,
        { port: 8008, service: 'http' },
        { product: 'Apache Tomcat HTTP', technology: 'tomcat', category: 'application', vendor: 'Apache Software Foundation' }
      ));
    }
    if (port === 8443) {
      evidence.push(makeEvidence('text_fingerprint', 'port-inference', 0.60,
        { port: 8443, service: 'https-alt' },
        { product: 'Apache Tomcat HTTPS', technology: 'tomcat', category: 'application', vendor: 'Apache Software Foundation' }
      ));
    }
  }

  // Filtered ports — armazenados separadamente
  const filteredPorts = input.filtered_ports || [];
  for (const p of filteredPorts) {
    const portNum = portNumber(p);
    if (!portNum || seenPorts.has(portNum)) continue;
    seenPorts.add(portNum);

    const service = typeof p === 'object' ? (p.service || null) : null;
    evidence.push(makeEvidence('tcp_filtered_port', 'nmap-scan', 0.08,
      { port: portNum, protocol: 'tcp', service, state: 'filtered' },
      { port: portNum, protocol: 'tcp', service, state: 'filtered', signal_strength: 'weak' }
    ));
  }

  return evidence;
}

function extractEvidence(input) {
  // Se o input já vem do normalizer com evidence pré-construída, usar como base
  const evidence = Array.isArray(input.evidence) ? [...input.evidence] : [];

  // Extrair evidências de portas (open + filtered)
  evidence.push(...extractPortEvidence(input));

  for (const [type, source, value] of asTextParts(input)) {
    const signals = patternSignals(value);
    evidence.push(makeEvidence(type, source, signals.length ? 0.72 : 0.5, value, { signals }));
    for (const signal of signals) evidence.push(makeEvidence('text_fingerprint', source, 0.66, value, signal));
  }

  if (input.favicon_hash) evidence.push(makeEvidence('favicon_hash', 'active-http', 0.62, input.favicon_hash, { hash: input.favicon_hash }));
  if (input.sip_probe?.responded) {
    evidence.push(makeEvidence('sip_options_response', 'active-sip', 0.82, input.sip_probe, { technology: 'sip', product: 'SIP Endpoint', status: input.sip_probe.status || null }));
  }
  if (input.rtsp_probe?.responded) {
    evidence.push(makeEvidence('rtsp_response', 'active-rtsp', 0.82, input.rtsp_probe, { technology: 'rtsp', product: input.rtsp_probe.server || 'RTSP Service', status: input.rtsp_probe.status || null }));
  }
  if (input.onvif_probe?.responded) {
    const product = input.onvif_probe.model || input.onvif_model || 'ONVIF Device';
    evidence.push(makeEvidence('onvif_device_info', 'active-onvif', input.onvif_probe.device_info ? 0.86 : 0.7, input.onvif_probe, { technology: 'onvif', product, vendor: input.onvif_probe.manufacturer || null }));
  }
  if (input.tls_sha256) evidence.push(makeEvidence('tls_certificate', 'active-tls', 0.66, input.tls_sha256, { sha256: input.tls_sha256 }));

  const mdnsMatch = resolveFromMdnsServices(input.mdns_services || []);
  if (mdnsMatch) evidence.push(makeEvidence('mdns_service', 'passive-mdns', 0.84, input.mdns_services, mdnsMatch));

  const ssdpMatch = lookupSsdpServer(input.http_server || input.ssdp_server || '');
  if (ssdpMatch) evidence.push(makeEvidence('ssdp_response', 'passive-ssdp', 0.7, input.http_server || input.ssdp_server, ssdpMatch));

  // Vendor identity — se já vier do normalizer com vendor_reliable, usar esse valor
  const preExistingVendorEvidence = evidence.filter(e => e.evidence_type === 'vendor_identity');
  if (preExistingVendorEvidence.length === 0) {
    const macVendor = input.mac ? lookupMacVendor(input.mac) : null;
    const explicitOuiVendor = input.mac_oui_vendor || input.oui_vendor || null;
    const txtVendor = input.txt_manufacturer || null;
    const vendor = macVendor || explicitOuiVendor || txtVendor;
    if (vendor) {
      evidence.push(makeEvidence('vendor_identity', macVendor ? 'oui-database' : 'metadata', macVendor ? 0.74 : 0.62, input.mac || input.mac_oui || vendor, { vendor, vendor_reliable: !!macVendor }));
    }
  }
  if (input.txt_model) evidence.push(makeEvidence('text_fingerprint', 'metadata-txt', 0.68, input.txt_model, { product: input.txt_model }));

  // Deep protocol probes — evidência de alta confiança
  for (const probe of input.deep_probes || []) {
    const ev = probeToEvidence(input.ip || input.address || 'unknown', probe.port, probe);
    if (ev) evidence.push(ev);
  }

  evidence.push(...extractTopologyEvidence(input));
  evidence.push(...extractHistoricalEvidence(input));
  evidence.push(...extractPassiveEvidence(input));

  // Deduplicate by evidence_type + source key to avoid double-counting
  // Also add timestamps to evidence that came from the normalizer
  const seenKeys = new Set();
  const deduped = [];
  const ts = nowIso();
  for (const ev of evidence) {
    const key = `${ev.evidence_type}:${ev.evidence_source}:${JSON.stringify(ev.raw_data).slice(0, 80)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      // Garantir que toda evidência tenha timestamp
      if (!ev.timestamp) ev.timestamp = ts;
      deduped.push(ev);
    }
  }

  if (!deduped.length) deduped.push(makeEvidence('minimal_signal', 'discovery', 0.05, null, {}));
  return deduped;
}

function evidenceTechnologies(evidence) {
  const values = new Set();
  const add = (v) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(add);
    else values.add(String(v).toLowerCase());
  };
  for (const ev of evidence) {
    const n = ev.normalized_data || {};
    add(n.technology);
    add(n.technologies);
    for (const sig of n.signals || []) add(sig.technology);
    for (const flag of n.topology_flags || []) add(flag);
    add(n.previous_technology);
  }
  return values;
}

function scoreRule(rule, evidence) {
  const techs = evidenceTechnologies(evidence);
  let score = 0;
  let count = 0;
  const matched = [];
  for (const ev of evidence) {
    const base = rule.weights[ev.evidence_type] || 0;
    if (!base) continue;
    const n = ev.normalized_data || {};
    const evTechs = [n.technology, ...(n.signals || []).map((s) => s.technology), n.previous_technology].filter(Boolean).map((v) => String(v).toLowerCase());

    // Match por tecnologia: evidência tem technology que casa com as technologies da regra
    const techMatch = evTechs.some((t) => rule.technologies.includes(t));

    // Match por topology flags: evidência tem topology_flags que casam com a regra
    const topologyMatch = (n.topology_flags || []).some((f) => (rule.topology || []).includes(f));

    // Tipos de evidência genéricos que não precisam de tech/topology match
    // NOTA: topology_context NÃO é genérico — requer topology flags matching
    const genericMatch = ['historical_identity', 'vendor_identity', 'lldp_neighbor'].includes(ev.evidence_type);

    // topology_context precisa de topologyMatch OU techMatch
    if (ev.evidence_type === 'topology_context') {
      if (!topologyMatch) continue;
    } else if (!techMatch && !genericMatch) {
      continue;
    }

    score += base * ev.confidence;
    count++;
    matched.push(ev);
  }
  for (const t of rule.technologies) {
    if (techs.has(t)) score += 0.06;
  }
  return { score: clamp(score, 0, 0.98), count, evidence: matched };
}

function strongestSignal(evidence, field, preferredTechnologies = []) {
  let best = null;
  const preferred = new Set((preferredTechnologies || []).map((item) => String(item).toLowerCase()));
  const rank = (candidate) => {
    let value = candidate.confidence;
    const technology = String(candidate.technology || '').toLowerCase();
    if (preferred.has(technology)) value += 0.2;
    if (field === 'product' && GENERIC_PRODUCTS.has(candidate.value)) value -= 0.12;
    return value;
  };
  for (const ev of evidence) {
    const candidates = [];
    if (ev.normalized_data?.[field]) candidates.push({ value: ev.normalized_data[field], confidence: ev.confidence, technology: ev.normalized_data.technology });
    for (const sig of ev.normalized_data?.signals || []) {
      if (sig[field]) candidates.push({ value: sig[field], confidence: ev.confidence, technology: sig.technology });
    }
    for (const c of candidates) {
      const cRank = rank(c);
      if (!best || cRank > best.rank) best = { ...c, rank: cRank };
    }
  }
  return best?.value || null;
}

function findConflicts(scored) {
  const top = scored[0];
  if (!top) return [];
  // Só conflita categorias fundamentalmente incompatíveis (ex: camera vs router)
  const INCOMPATIBLE_PAIRS = new Set([
    'iot:router', 'router:iot',
    'iot:voice', 'voice:iot',
    'iot:mobile', 'mobile:iot',
    'camera:router', 'router:camera',
    'camera:voice', 'voice:camera',
    'mobile:router', 'router:mobile',
    'mobile:voice', 'voice:mobile',
  ]);
  return scored
    .slice(1)
    .filter((item) => {
      if (item.score < (THRESHOLDS.conflict ?? 0.45)) return false;
      if (item.rule.category === top.rule.category) return false;
      // Web e application são compatíveis (Apache/Nginx são ambos)
      if ((top.rule.category === 'web' && item.rule.category === 'application') ||
          (top.rule.category === 'application' && item.rule.category === 'web')) return false;
      const pair = `${top.rule.category}:${item.rule.category}`;
      const pairRev = `${item.rule.category}:${top.rule.category}`;
      if (INCOMPATIBLE_PAIRS.has(pair) || INCOMPATIBLE_PAIRS.has(pairRev)) return true;
      // Se não está na lista de incompatíveis, não conflita
      return false;
    })
    .map((item) => ({
      asset_type: item.rule.asset_type,
      category: item.rule.category,
      confidence_score: Number(item.score.toFixed(3)),
    }));
}

function confidenceLevel(score) {
  if (score >= (THRESHOLDS.auto_approve ?? 0.85)) return 'high';
  if (score >= (THRESHOLDS.medium ?? 0.6)) return 'medium';
  if (score >= (THRESHOLDS.low ?? 0.35)) return 'low';
  return 'insufficient';
}

function governanceDecision(score, conflicts) {
  if (conflicts.length > 0) return 'REVIEW_PENDING';
  if (score >= (THRESHOLDS.auto_approve ?? 0.85)) return 'APPROVED';
  if (score >= (THRESHOLDS.medium ?? 0.6)) return 'REVIEW_OPTIONAL';
  return 'REVIEW_PENDING';
}

function inferAsset(input, traceId) {
  const evidence = extractEvidence(input);
  const assetIp = input.ip || input.address || 'unknown';

  if (isDebug()) {
    debug(`inference:start para ${assetIp}`, { trace_id: traceId, ip: assetIp, evidence_count: evidence.length });
    debugTable(`inference:evidence:${assetIp}`, evidence.map(e => ({
      type: e.evidence_type,
      source: e.evidence_source,
      confidence: e.confidence,
      technology: e.normalized_data?.technology || null,
      topology_flags: (e.normalized_data?.topology_flags || []).join(','),
      vendor: e.normalized_data?.vendor || null,
      mac_type: e.normalized_data?.mac_type || null,
    })), traceId);
  }

  const scored = INFERENCE_REGISTRY
    .map((rule) => ({ rule, ...scoreRule(rule, evidence) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.score - a.score);

  if (isDebug()) {
    debugTable(`inference:scoring:${assetIp}`, scored.map(s => ({
      asset_type: s.rule.asset_type,
      category: s.rule.category,
      score: Number(s.score.toFixed(4)),
      evidence_matched: s.count,
      threshold: s.rule.threshold,
    })), traceId);
  }

  const top = scored[0] || { rule: { asset_type: 'host', product: UNKNOWN_PRODUCT, category: 'unknown', technology: 'unknown', threshold: 1 }, score: 0, evidence: [] };
  const conflicts = findConflicts(scored);
  const classified = top.score >= top.rule.threshold && top.evidence.length >= (THRESHOLDS.minimum_evidence_to_classify ?? 2) && conflicts.length === 0;
  const score = classified ? top.score : Math.min(top.score, 0.49);
  const vendor = strongestSignal(evidence, 'vendor') || UNKNOWN_VENDOR;
  const productSignal = strongestSignal(evidence, 'product', top.rule.technologies || []);
  const product = classified ? (productSignal || top.rule.product) : UNKNOWN_PRODUCT;
  const technology = classified ? (strongestSignal(evidence, 'technology', top.rule.technologies || []) || top.rule.technology) : 'unknown';
  const category = classified ? (strongestSignal(evidence, 'category', top.rule.technologies || []) || top.rule.category) : 'unknown';

  const result = {
    asset_type: classified ? top.rule.asset_type : 'host',
    vendor,
    product,
    service: product,
    category,
    technology,
    confidence_score: Number(score.toFixed(3)),
    confidence_level: confidenceLevel(score),
    evidence_count: evidence.length,
    conflicting_evidence: conflicts.length,
    conflicts,
    governance: {
      decision: governanceDecision(score, conflicts),
      auto_approve: governanceDecision(score, conflicts) === 'APPROVED',
    },
    evidence,
    matched_rule: classified ? top.rule.asset_type : null,
    candidate_scores: scored.slice(0, 5).map((item) => ({
      asset_type: item.rule.asset_type,
      confidence_score: Number(item.score.toFixed(3)),
      evidence_count: item.evidence.length,
    })),
  };

  if (isDebug()) {
    debug(`inference:result:${assetIp}`, {
      trace_id: traceId,
      ip: assetIp,
      asset_type: result.asset_type,
      confidence: result.confidence_score,
      confidence_level: result.confidence_level,
      technology: result.technology,
      vendor: result.vendor,
      classified,
      conflicts: result.conflicts.length,
      matched_rule: result.matched_rule,
      top_score: Number(top.score.toFixed(4)),
      top_threshold: top.rule.threshold,
    });
  }

  return result;
}

module.exports = {
  inferAsset,
  extractEvidence,
  confidenceLevel,
  governanceDecision,
  INFERENCE_REGISTRY,
  registry: kb.getInferenceRegistry(),
};
