'use strict';

const { inferAsset } = require('../inference/engine');

const HIGH_RISK_CATEGORIES = new Set(['database', 'firewall', 'voice']);
const HIGH_RISK_TECHNOLOGIES = new Set(['rtsp', 'onvif', 'camera', 'sip']);

function inferRisk(inference, metadata) {
  const hostname = String(metadata?.hostname || '').toLowerCase();
  if (HIGH_RISK_CATEGORIES.has(inference.category)) return 'high';
  if (HIGH_RISK_TECHNOLOGIES.has(inference.technology)) return 'high';
  if (hostname.includes('core') || hostname.includes('gw')) return 'high';
  if (inference.confidence_level === 'insufficient') return 'low';
  return 'medium';
}

function compactEvidence(evidence) {
  return evidence.map((item) => {
    const normalized = item.normalized_data || {};
    const label = normalized.product || normalized.technology || normalized.vendor || normalized.port || item.evidence_type;
    return `${item.evidence_type}:${item.evidence_source}:${label}`;
  });
}

function fingerprintAsset(input, traceId) {
  const inference = inferAsset(input || {}, traceId);
  const rawSignals = {
    snmp_sysdescr: input?.snmp_sysdescr || null,
    tls_subject: input?.tls_subject || null,
    tls_issuer: input?.tls_issuer || null,
    http_server: input?.http_server || null,
    http_title: input?.http_title || null,
    ssh_banner: input?.ssh_banner || null,
    smtp_banner: input?.smtp_banner ? String(input.smtp_banner).slice(0, 200) : null,
    dns_name: input?.hostname || null,
    favicon_hash: input?.favicon_hash || null,
    sip_user_agent: input?.sip_user_agent || null,
    rtsp_banner: input?.rtsp_banner || null,
    onvif_model: input?.onvif_model || null,
    topology: input?.topology || null,
    historical: input?.history || input?.historical || null,
  };

  return {
    vendor: inference.vendor,
    product: inference.product,
    category: inference.category,
    service: inference.service,
    technology: inference.technology,
    asset_type: inference.asset_type,
    firmware_hint: input?.snmp_sysdescr || null,
    os_hint: input?.os_hint || null,
    criticality: inferRisk(inference, { hostname: input?.hostname }),
    confidence: inference.confidence_score,
    confidence_score: inference.confidence_score,
    confidence_level: inference.confidence_level,
    evidence_count: inference.evidence_count,
    conflicting_evidence: inference.conflicting_evidence,
    conflicts: inference.conflicts,
    governance: inference.governance,
    evidence: compactEvidence(inference.evidence),
    evidences: compactEvidence(inference.evidence),
    evidence_objects: inference.evidence,
    inference,
    raw_signals: rawSignals,
  };
}

module.exports = { fingerprintAsset };
